"""画像提炼的核心流程 —— 手动触发与定时任务共用。

从 ``routers/agent_documents.py`` 抽出来，是因为 T4 的调度器要跑同一条链路
（读资料 → 捞该角色的历史会话 → LLM 提炼 → 落库 + 同步回角色记录）。
留在路由里的话，``scheduler`` 就得反过来 import 一个 router 模块，既别扭又容易漂移。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from app import agent_docs, agent_profile, agents, threads, top50_engine

logger = logging.getLogger(__name__)


async def run_extraction(agent_id: str, agent_name: str, client_id: str = "") -> bool:
    """跑一次完整的画像提炼。返回是否成功。

    ``client_id`` 为空时会把该角色名下**所有**客户端的会话都捞进来 —— 定时任务没有
    请求上下文，只能用这个口径；单机 demo 只有一个 clientId，两者等价。
    """
    history: list[dict] = []
    try:
        documents = agent_docs.read_documents(agent_id)
        if not documents:
            agent_docs.finish_extraction(agent_id, None, "没有可用于提炼的资料")
            return False
        # Session Q&A is a supplementary hint; the documents stay primary.
        history = await asyncio.to_thread(threads.history_for_agent, agent_name, client_id)
        profile_data = await asyncio.to_thread(
            agent_profile.extract_profile, agent_name, documents, history
        )
    except Exception as exc:  # noqa: BLE001 - surface any failure to the poller
        logger.warning("extraction failed for agent %s: %s", agent_id, exc)
        agent_docs.finish_extraction(agent_id, None, str(exc))
        return False

    agent_docs.finish_extraction(agent_id, profile_data, None, history_count=len(history))
    agents.update(
        agent_id,
        {
            "style": profile_data.get("style"),
            "subtitle": profile_data.get("subtitle"),
            "horizon": profile_data.get("horizon"),
            "decision": profile_data.get("decision"),
            "select": profile_data.get("select"),
            "risk": profile_data.get("risk"),
            "factorWeights": profile_data.get("factorWeights"),
            "evidence": profile_data.get("evidence"),
            "materialCount": len(documents),
            "productionVersion": {"id": "agent-custom-v1"},
            "profileUpdatedAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    # 画像变了 → 因子权重就变了 → 排名必须跟着重算。
    # 原项目靠「量化权重冻结」保证 AI 不改分；本项目是有意反向：学习结果直接参与加权。
    # 这里只标过期，不在这里同步重算 —— 重算要拉全市场（~90s），不能阻塞提炼请求。
    # 引擎侧的画像指纹会自动发现变化，下次请求即用新 snapshotId 重新冻结。
    top50_engine.invalidate_cache()
    return True
