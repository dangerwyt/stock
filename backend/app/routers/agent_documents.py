"""Document upload + asynchronous profile extraction for user-created agents.

Extraction takes ~16s per document set, which is far too slow to hold a request
open. So the flow is:

    POST .../documents  → parse synchronously (fast), return stats
    POST .../extract    → kick off a background task, return immediately
    GET  .../profile    → poll for {extraction.status, profile}

The LLM call runs in a worker thread via ``asyncio.to_thread`` so it never
blocks the event loop (httpx here is the sync client).
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile

from app import agent_docs, agent_extract, agent_scoring, agents, top50_engine, tushare_client
from app.llm import LlmError

logger = logging.getLogger(__name__)

router = APIRouter()

# Strong references so in-flight tasks aren't garbage-collected mid-run.
_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def _require_custom_agent(agent_id: str) -> dict:
    if not agents.is_custom(agent_id):
        raise HTTPException(status_code=404, detail="角色不存在或为内置角色，不能修改")
    found = agents.find(agent_id)
    if not found:
        raise HTTPException(status_code=404, detail="角色不存在")
    return found


@router.post("/api/agents/{agent_id}/documents")
async def upload_document(agent_id: str, file: UploadFile = File(...)):
    _require_custom_agent(agent_id)
    data = await file.read()
    try:
        record = await asyncio.to_thread(agent_docs.add_document, agent_id, file.filename, data)
    except ValueError as exc:  # DocumentError subclasses ValueError
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "status": "ready",
        "document": record,
        "documents": agent_docs.list_documents(agent_id),
    }


@router.get("/api/agents/{agent_id}/documents")
def list_documents(agent_id: str):
    _require_custom_agent(agent_id)
    return {"status": "ready", "documents": agent_docs.list_documents(agent_id)}


@router.delete("/api/agents/{agent_id}/documents/{doc_id}")
def delete_document(agent_id: str, doc_id: str):
    _require_custom_agent(agent_id)
    if not agent_docs.remove_document(agent_id, doc_id):
        raise HTTPException(status_code=404, detail="资料不存在")
    return {"status": "ready", "documents": agent_docs.list_documents(agent_id)}


@router.post("/api/agents/{agent_id}/extract")
async def start_extraction(agent_id: str, clientId: str = ""):
    # Must stay `async`: ``asyncio.create_task`` needs a running loop, and a sync
    # endpoint runs in a worker thread where there is none.
    found = _require_custom_agent(agent_id)
    # 只算有效资料：被相关性闸门判为不相关的不会参与提炼，也就不该解锁提炼按钮。
    documents = agent_docs.effective_documents(agent_id)
    if not documents:
        if agent_docs.list_documents(agent_id):
            raise HTTPException(
                status_code=400,
                detail="已上传的资料均被判定为与股票财经无关，请更换资料后重试",
            )
        raise HTTPException(status_code=400, detail="请先上传至少一份资料")

    if not agent_docs.begin_extraction(agent_id):
        return {"status": "running", "message": "提炼任务正在进行中"}

    try:
        _spawn(
            agent_extract.run_extraction(agent_id, found.get("name") or "未命名角色", clientId)
        )
    except Exception as exc:  # noqa: BLE001 - never leave the state stuck on "running"
        logger.exception("failed to schedule extraction for %s", agent_id)
        agent_docs.finish_extraction(agent_id, None, f"任务启动失败：{exc}")
        raise HTTPException(status_code=500, detail="提炼任务启动失败")

    return {
        "status": "accepted",
        "extraction": agent_docs.extraction_state(agent_id),
        "documentCount": len(documents),
    }


@router.get("/api/agents/{agent_id}/profile")
def get_profile(agent_id: str):
    """Polling endpoint: extraction state + profile + documents + scores."""
    found = _require_custom_agent(agent_id)
    return {
        "status": "ready",
        "agentId": agent_id,
        "agentName": found.get("name"),
        "extraction": agent_docs.extraction_state(agent_id),
        "profile": agent_docs.profile(agent_id),
        "scores": agent_docs.scores(agent_id),
        "documents": agent_docs.list_documents(agent_id),
    }


@router.post("/api/agents/{agent_id}/score")
async def score_agent(agent_id: str, cycle: str = "波段"):
    """给该角色生成一份「评分 + 理由」（一次 LLM 调用，约 10s，同步）。

    ⚠️ 这份分**不参与榜单排名** —— 排名用的是引擎按 ``factorWeights`` 算出的确定性分数。
    这里只补自然语言理由。候选股票取自**实时** TOP50 快照，行情不可用即 503，不糊假数据。
    """
    found = _require_custom_agent(agent_id)
    profile_data = agent_docs.profile(agent_id)
    if not profile_data:
        raise HTTPException(status_code=400, detail="请先上传资料并完成画像提炼，再生成评分")

    try:
        snapshot = await top50_engine.get_top50_snapshot()
    except tushare_client.TushareError as exc:
        raise HTTPException(status_code=503, detail=f"实时行情不可用，无法取得评分候选：{exc}")

    subject = {**found, **(profile_data or {})}
    try:
        result = await asyncio.to_thread(agent_scoring.score_agent, subject, cycle, 10, snapshot)
    except LlmError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    result["agentId"] = agent_id
    result["agentName"] = found.get("name")
    agent_docs.save_scores(agent_id, result)
    return {"status": "ready", "scores": result}


@router.get("/api/agents/{agent_id}/scores")
def get_scores(agent_id: str):
    _require_custom_agent(agent_id)
    return {"status": "ready", "scores": agent_docs.scores(agent_id)}
