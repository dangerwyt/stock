"""调度 job 实现 + 分发（对齐 reference-react ``runJob``）。

每个 job 返回 ``{"status": ..., ...}``。状态词表与 v1 对齐：
``completed`` / ``pending`` / ``failed`` / ``partial`` / ``degraded`` / ``unavailable``，
外加本项目新增的 ``stubbed`` —— 表示"这个 job 还没移植，本轮只是占位登记"。
**stubbed 不算失败**，但会在结果里明确写出来，绝不假装跑过。

首批已落地（用户选定）：``top50`` / ``global-news`` / ``intraday-news`` / ``market-close``，
外加把 v2 已有的画像巡回复用为 ``teacher-distillation``。

本轮补上 3 个此前 ``stubbed`` 的 job：``us-etf-map`` / ``post-close`` / ``accuracy``。

⚠️ 口径提醒：这些 job 把数据搬进各自模块的缓存（TOP50 快照、资讯快照、最近交易日
全市场行情）。**「最近交易日全市场行情」是多 job 共用的**：``top50`` 与 ``market-close``
拉的是同一份数据，统一走 ``tushare_client._latest_market_trade_date()`` 的「数据窗口」
缓存，一天只真拉 2 次（收盘前后各一次），不再各自重拉。``post-close`` 也复用这份缓存，
把校验通过后的真实行情落盘成 ``market_snapshot.json`` 供 ``/api/market`` 优先服务。

⚠️ 不伪造实时数据：``us-etf-map``（需 Yahoo Finance EOD）与 ``accuracy``（需已到期的
prediction evidence）在 v2 里都还没有实时源，所以这两个 job **只审计入库的缓存快照**，
给出真实汇总 + 新鲜度判定，并诚实标 ``sourceMode: cached``，绝不假装跑过实时重算。
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from app import fixtures, news_aggregate, tushare_client, top50_engine

logger = logging.getLogger(__name__)

# 已经真实实现的 job。
PORTED = (
    "top50",
    "global-news",
    "intraday-news",
    "market-close",
    "teacher-distillation",
    "us-etf-map",
    "post-close",
    "accuracy",
)

# job 名 → 运行记录里的 component（对齐 v1 runJob 的归类，便于运维侧按板块聚合）。
COMPONENT = {
    "us-etf-map": "market",
    "top50": "market",
    "accuracy": "market",
    "opening-auction": "market",
    "market-pulse": "market",
    "market-close": "market",
    "post-close": "market",
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

    与 ``top50`` job 共用 ``_latest_market_trade_date()`` 的数据窗口缓存 —— 同一轮里
    先跑谁都不会重复拉取（07:20 轮次的执行顺序是 market-close 在前、top50 在后）。

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


# ----------------------------------------------------------------- 落盘辅助
_DATA_DIR = Path(__file__).resolve().parent / "data"
_MARKET_SNAPSHOT = _DATA_DIR / "market_snapshot.json"


def _load_fixture_safe(name: str) -> dict:
    """读 fixture（read-only 缓存对象），读不到/结构不对都返回空 dict，绝不打挂 job。"""
    try:
        payload = fixtures.load(name)
    except Exception:  # noqa: BLE001 - fixture 缺失不该让调度任务崩
        return {}
    return payload if isinstance(payload, dict) else {}


def _num(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _persist_market_snapshot(snapshot: dict) -> None:
    """原子写收盘行情快照（临时文件 + replace），与 top50_snapshot 同策略。"""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _MARKET_SNAPSHOT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(_MARKET_SNAPSHOT)


async def _job_us_etf_map() -> dict:
    """隔夜美股 ETF → A 股行业映射：审计缓存快照，给出真实汇总 + 新鲜度判定。

    真实重算需要 Yahoo Finance EOD（原 Cloudflare Worker 的实时源），v2 尚未接入；
    所以这里**不伪造**实时抓取，只审计入库的缓存快照：汇总方向分布、对照最近交易日
    判断新鲜度，诚实标 ``sourceMode: cached``。
    """
    payload = _load_fixture_safe("us-etf-map")
    items = payload.get("items") or []
    if not items:
        return {"status": "unavailable", "sourceMode": "none",
                "reason": "us-etf-map 缓存快照为空"}
    summary = {"bullish": 0, "neutral": 0, "bearish": 0}
    for item in items:
        direction = str(item.get("direction") or "neutral").lower()
        if direction in summary:
            summary[direction] += 1
    meta = payload.get("meta") or {}
    # 新鲜度：对照最近一个有行情的交易日（命中窗口缓存，无额外额度消耗）。
    # 行情源不可用时降级为「unverified」，不把审计本身判失败。
    latest = None
    try:
        latest, _ = await tushare_client._latest_market_trade_date()
    except tushare_client.TushareError:
        latest = None
    if latest is None:
        freshness, reason = "unverified", "新鲜度未核验：行情源不可用"
    else:
        # fixture 的 ``marketDate`` 是 ``YYYY-MM-DD``，而 ``_latest_market_trade_date``
        # 返回紧凑 ``YYYYMMDD``，先归一化再比，否则永远判 stale。
        market_date_norm = str(meta.get("marketDate") or "").replace("-", "")
        if market_date_norm == latest:
            freshness, reason = "fresh", None
        else:
            freshness, reason = "stale", "缓存快照的 marketDate 已旧于最近交易日，需接入 Yahoo EOD 重算"
    return {
        "status": "completed",
        "sourceMode": "cached",
        "freshness": freshness,
        "marketDate": meta.get("marketDate"),
        "latestTradeDate": latest,
        "itemCount": len(items),
        "summary": summary,
        "reason": reason,
    }


async def _job_accuracy() -> dict:
    """准确率统计：审计缓存快照，给出真实样本量与命中率（不伪造实时验证）。

    真实命中率需基于「已到期且证据完整的冻结预测」（predictionId 有 evidence），
    v2 当前 fixtures 无 evidence，所以这里只审计入库的准确率快照并诚实标注
    ``sourceMode: cached``。
    """
    payload = _load_fixture_safe("accuracy")
    if not payload:
        return {"status": "unavailable", "sourceMode": "none",
                "reason": "accuracy 缓存快照缺失"}
    overall = payload.get("overall") or {}
    minimum = payload.get("minimumSample") or 30
    sample_count = int(overall.get("sampleCount") or 0)
    hit_rate = overall.get("hitRate")
    mature = sample_count >= minimum
    return {
        "status": "completed" if sample_count > 0 else "unavailable",
        "sourceMode": "cached",
        "sampleCount": sample_count,
        "hitRate": hit_rate,
        "minimumSample": minimum,
        "mature": mature,
        "reason": None if mature else "样本量未达披露阈值，不公开命中率（与前端口径一致）",
    }


async def _job_post_close() -> dict:
    """收盘后处理：拉真实全市场行情（窗口缓存复用，零额外额度），落盘收盘快照。

    与 ``market-close`` 的区别：market-close 只做可用性校验，post-close 把校验通过的
    真实行情**写进 ``market_snapshot.json``**，供 ``/api/market`` 在新鲜时直接服务真实数据
    （否则回落 fixtures）。这样收盘后市场页看到的不再是静态样例。

    ⚠️ 行情不可用时（额度耗尽 / 非交易日）诚实标 ``unavailable``，**不**用旧值或样例冒充。
    """
    try:
        trade_date, rows = await tushare_client._latest_market_trade_date()
    except tushare_client.TushareError as exc:
        return {"status": "unavailable", "sourceMode": "none",
                "reason": f"收盘行情不可用：{exc}"}
    if not rows:
        return {"status": "unavailable", "sourceMode": "none", "reason": "收盘行情为空"}

    quotes = []
    for row in rows:
        ts_code = str(row.get("ts_code") or "")
        quotes.append({
            "tsCode": ts_code,
            "code": ts_code.split(".")[0],
            "name": "",
            "price": _num(row.get("close")),
            "open": _num(row.get("open")),
            "high": _num(row.get("high")),
            "low": _num(row.get("low")),
            "volume": _num(row.get("vol")),
            "amount": _num(row.get("amount")),
            "pctChg": _num(row.get("pct_chg")),
            "freshness": "live",
            "provider": "Tushare daily",
        })
    now = datetime.now(timezone.utc).isoformat()
    snapshot = {
        "meta": {
            "generatedAt": now,
            "tradeDate": trade_date,
            "sourceMode": "live",
            "provider": "Tushare daily",
            "status": "completed",
            "rowCount": len(quotes),
            "note": "由 post-close 调度任务从真实全市场行情落盘；/api/market 新鲜时优先服务，否则回落 fixtures。",
        },
        "quotes": quotes,
    }
    _persist_market_snapshot(snapshot)
    return {
        "status": "completed" if len(quotes) >= 50 else "partial",
        "sourceMode": "live",
        "tradeDate": trade_date,
        "universe": len(quotes),
        "snapshotPath": str(_MARKET_SNAPSHOT),
    }


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
    elif name == "us-etf-map":
        result = await _job_us_etf_map()
    elif name == "post-close":
        result = await _job_post_close()
    elif name == "accuracy":
        result = await _job_accuracy()
    else:
        result = await _job_stub(name)
    result = {**result, "durationMs": int((time.time() - started) * 1000)}
    logger.info("调度任务结束：%s → %s（%sms）", name, result.get("status"), result.get("durationMs"))
    return result
