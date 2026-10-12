"""调度 job 实现 + 分发（对齐 reference-react ``runJob``）。

每个 job 返回 ``{"status": ..., ...}``。状态词表与 v1 对齐：
``completed`` / ``pending`` / ``failed`` / ``partial`` / ``degraded`` / ``unavailable``，
外加本项目新增的 ``stubbed`` —— 表示"这个 job 还没移植，本轮只是占位登记"。
**stubbed 不算失败**，但会在结果里明确写出来，绝不假装跑过。

首批已落地（用户选定）：``top50`` / ``global-news`` / ``intraday-news`` / ``market-close``，
外加把 v2 已有的画像巡回复用为 ``teacher-distillation``。

⚠️ 口径提醒：这里只**搬运数据到各自模块的缓存**（TOP50 快照、资讯快照、最近交易日全市场
行情），job 之间不共享中间结果。``market-close`` 目前只做"最近交易日行情可用性校验"，
尚未把结果灌进 ``/api/market``（那还是 fixtures）—— 属于后续任务。
"""
from __future__ import annotations

import logging
import time

from app import news_aggregate, tushare_client, top50_engine

logger = logging.getLogger(__name__)

# 已经真实实现的 job。
PORTED = ("top50", "global-news", "intraday-news", "market-close", "teacher-distillation")

# job 名 → 运行记录里的 component（对齐 v1 runJob 的归类，便于运维侧按板块聚合）。
COMPONENT = {
    "us-etf-map": "market",
    "top50": "market",
    "accuracy": "market",
    "opening-auction": "market",
    "market-pulse": "market",
    "market-close": "market",
    "intraday-news": "news",
    "global-news": "news",
    "teacher-distillation": "ai",
}


def component_of(name: str) -> str:
    return COMPONENT.get(name, "scheduler")


async def _job_top50() -> dict:
    snapshot = await top50_engine.get_top50_snapshot(force=True)
    meta = snapshot.get("meta") or {}
    return {
        "status": "completed",
        "snapshotId": meta.get("snapshotId"),
        "marketDataDate": meta.get("marketDataDate"),
        "selectedCount": meta.get("selectedCount"),
        "sourceMode": meta.get("sourceMode"),
    }


async def _job_news() -> dict:
    snapshot = await news_aggregate.build_news_snapshot(force=True)
    meta = snapshot.get("meta") or {}
    items = snapshot.get("items") or []
    # 一条都没有 = 实时源与 fixtures 都没给东西，按失败记（否则会静默"成功"）。
    return {
        "status": "completed" if items else "failed",
        "itemCount": len(items),
        "sourceMode": meta.get("sourceMode"),
        "providers": meta.get("providers") or [],
        "generatedAt": meta.get("generatedAt"),
        "error": None if items else "资讯聚合未返回任何条目",
    }


async def _job_market_close() -> dict:
    """收盘刷新：确认最近一个交易日的全市场行情可取，并记录交易日与标的数。

    ⚠️ 目前只做可用性校验 + 记录，**不写回** ``/api/market``（那仍是 fixtures 快照）。
    """
    trade_date, rows = await tushare_client._latest_market_trade_date()
    return {
        "status": "completed" if len(rows) >= 50 else "partial",
        "tradeDate": trade_date,
        "universe": len(rows),
    }


async def _job_teacher_distillation() -> dict:
    """画像蒸馏：直接复用 v2 既有的画像巡回复用（有指纹变更检测，不会空烧额度）。"""
    from app import scheduler

    stats = await scheduler.refresh_all()
    return {"status": "completed", "stats": stats}


async def _job_stub(name: str) -> dict:
    return {"status": "stubbed", "reason": f"job「{name}」尚未移植，本轮仅登记"}


async def run_job(name: str) -> dict:
    """执行单个 job。**不吞异常** —— 由调用方（``market_schedule``）统一记账并写锁。"""
    started = time.time()
    logger.info("调度任务开始：%s（component=%s）", name, component_of(name))
    if name == "top50":
        result = await _job_top50()
    elif name in ("global-news", "intraday-news"):
        result = await _job_news()
    elif name == "market-close":
        result = await _job_market_close()
    elif name == "teacher-distillation":
        result = await _job_teacher_distillation()
    else:
        result = await _job_stub(name)
    result = {**result, "durationMs": int((time.time() - started) * 1000)}
    logger.info("调度任务结束：%s → %s（%sms）", name, result.get("status"), result.get("durationMs"))
    return result
