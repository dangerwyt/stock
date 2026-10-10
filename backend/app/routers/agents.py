"""Agent (老师) persona endpoints.

``GET /api/agents`` is the single shared source of truth for both the AI
research page and the strategy page. 它只返回**用户自己创建的角色** —— 内置
12 位原版 mock 人设已从产品里去掉（见 ``agents.visible_agents``）。
``POST`` / ``DELETE`` mutate the same user-created store.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app import agent_docs, agents, threads

router = APIRouter()


@router.get("/api/agents")
def list_agents():
    return {"status": "ready", "items": agents.visible_agents()}


@router.post("/api/agents")
async def create_agent(request: Request):
    payload = await request.json() if request.headers.get("content-type") else {}
    if not isinstance(payload, dict):
        payload = {}
    try:
        agent = agents.create(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "ready", "agent": agent}


@router.delete("/api/agents/{agent_id}")
def delete_agent(agent_id: str):
    found = agents.find(agent_id)
    removed = agents.remove(agent_id)
    if not removed:
        raise HTTPException(status_code=404, detail="角色不存在或为内置角色")
    # Drop the persona's uploaded documents and extracted artifacts too.
    agent_docs.purge(agent_id)
    # …and any research sessions opened for it, so the list doesn't show ghosts.
    if found:
        threads.purge_for_agent(found.get("name") or "")
    return {"status": "ready", "removed": True}
