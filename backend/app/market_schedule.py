"""调度计划 + 运行编排（对齐 reference-react ``scheduledJobPlan`` / ``runScheduledCore``）。

**执行模型（用户选定：复用 v1 外部 tick）**：本模块不自己计时。外部每分钟 POST 一次
``/api/admin/scheduled``，由 :func:`scheduled_job_plan` 按上海时间算出"当前命中的 5 分钟
窗口该跑哪些 job"，命中才跑。好处是不依赖进程内的定时器精度，且**断点续跑**天然成立：
服务重启后下一分钟 tick 进来，按持久锁判断该轮跑没跑过。

窗口语义（与 v1 一字不差）：``minute >= start && minute < start + 5``。所以 14:00 那一轮
会在 14:00–14:04 之间被反复命中，靠 :mod:`app.job_runs` 的 attempt 键去重，只跑第一个。

**为什么不补造数据**（``apply_daily_catch_up`` 是 no-op，同 v1）：漏掉的窗口就让它漏，
等下一轮。补跑会引入"计划外请求"，让数据快照的时间戳与轮次表对不上，反而更难查。

交易日判定：优先用 ``trade_cal``（按日缓存，成功才缓存），失败退到"周末即休市"的近似。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from app import job_runs, market_clock, market_jobs, tushare_client
from app.config import settings

logger = logging.getLogger(__name__)

# 5 分钟宽限窗：tick 每 60s 一次，一轮里会命中最多 5 次。
GRACE_WINDOW_MINUTES = 5

# 交易日轮次表（v1 原样）。
TRADING_ROUNDS: list[tuple[str, list[str]]] = [
    ("07:20", ["us-etf-map", "global-news", "market-close", "top50"]),
    ("09:26", ["opening-auction", "global-news"]),
    ("10:30", ["market-pulse", "intraday-news"]),
    ("11:35", ["market-pulse", "intraday-news", "midday-review"]),
    ("13:05", ["market-pulse", "intraday-news"]),
    ("14:00", ["market-pulse", "intraday-news"]),
    ("17:40", ["market-close", "post-close", "accuracy", "global-news"]),
    ("22:00", ["global-news", "market-close", "post-close", "accuracy"]),
]
# 非交易日只有两轮，且只跑资讯。
CLOSED_ROUNDS: list[tuple[str, list[str]]] = [
    ("08:30", ["global-news"]),
    ("22:00", ["global-news"]),
]

# 交易日历按日缓存：只缓存**查询成功**的结果，失败时下次 tick 会重试。
_CALENDAR_CACHE: dict[str, bool] = {}


def _round_minutes(time_str: str) -> int:
    return int(time_str[:2]) * 60 + int(time_str[3:])


def scheduled_job_plan(now: datetime | None = None, trading_day: bool = True) -> dict:
    """算出当前该跑哪些 job（纯函数，无副作用，便于直接验收窗口边界）。"""
    session = market_clock.shanghai_session(now, trading_day)
    rounds = TRADING_ROUNDS if trading_day else CLOSED_ROUNDS
    minute = session["hour"] * 60 + session["minute"]
    hit = next(
        (
            (slot, jobs)
            for slot, jobs in rounds
            if _round_minutes(slot) <= minute < _round_minutes(slot) + GRACE_WINDOW_MINUTES
        ),
        None,
    )
    jobs = list(hit[1]) if hit else []
    # 周日 22:00 追加画像蒸馏（v1 原逻辑，用于"周末把这一周的会话/资料重新提炼一遍"）。
    if hit and hit[0] == "22:00" and session["weekday"] == "Sun":
        jobs.append("teacher-distillation")
    return {
        "session": session,
        "jobs": jobs,
        "slot": hit[0] if hit else None,
        "collectionTimes": [slot for slot, _ in rounds],
    }


def apply_daily_catch_up(plan: dict, *_: object, **__: object) -> dict:
    """对齐 v1：缺数据就等下一轮，绝不补造计划外请求（保留函数是为了标记这个决策）。"""
    return plan


def _has_tushare() -> bool:
    return bool(
        settings.tushare_token
        or (settings.tushare_fallback_url and settings.tushare_fallback_api_key)
    )


async def detect_trading_day(now: datetime | None = None) -> bool:
    """是否交易日。有 Tushare 走 ``trade_cal``，否则用"周末即休市"的近似。"""
    clock = market_clock.shanghai_clock(now)
    date = clock["date"]
    cached = _CALENDAR_CACHE.get(date)
    if cached is not None:
        return cached
    if not _has_tushare():
        return clock["weekday"] not in ("Sat", "Sun")
    try:
        is_open = await tushare_client.is_market_open(date)
    except tushare_client.TushareError as exc:
        logger.warning("交易日历查询失败，退到周末近似：%s", exc)
        return clock["weekday"] not in ("Sat", "Sun")
    _CALENDAR_CACHE[date] = is_open
    return is_open


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def run_scheduled(now: datetime | None = None) -> dict:
    """跑一次 tick：判定交易日 → 出计划 → 逐 job 去重后执行 → 落运行记录。"""
    trading_day = await detect_trading_day(now)
    plan = scheduled_job_plan(now, trading_day)
    date = plan["session"]["date"]
    slot = plan["slot"]
    results: list[dict] = []

    for name in plan["jobs"]:
        # ① 本轮次该 job 只准第一个 tick 执行（5 分钟窗会被命中多次）。
        if not job_runs.claim_attempt(date, name, slot):
            logger.info("调度跳过 %s：轮次 %s 已尝试过", name, slot)
            continue
        # ② 已有最终状态 = 此前跑过（含进程重启后重来的情况），不重跑。
        if job_runs.lock_state(date, name, slot):
            logger.info("调度跳过 %s：轮次 %s 已有运行记录", name, slot)
            continue

        job_runs.save_lock(date, name, slot, {"status": "running", "startedAt": _now_iso()})
        try:
            result = await market_jobs.run_job(name)
        except Exception as exc:  # noqa: BLE001 - 单个 job 失败不能拖垮本轮其余 job
            logger.exception("调度任务 %s 执行失败", name)
            job_runs.save_lock(
                date, name, slot, {"status": "failed", "error": str(exc), "failedAt": _now_iso()}
            )
            results.append({"name": name, "status": "failed", "error": str(exc)})
            continue

        status = str(result.get("status") or "completed")
        failed = status in ("failed", "partial", "degraded", "unavailable")
        job_runs.save_lock(
            date,
            name,
            slot,
            {
                "status": status,
                "startedAt": _now_iso(),
                **({"failedAt": _now_iso()} if failed else {"completedAt": _now_iso()}),
                "detail": result,
            },
        )
        results.append({"name": name, "status": status, "detail": result})

    record = {
        "scheduledAt": _now_iso(),
        "session": plan["session"],
        "tradingDay": trading_day,
        "slot": slot,
        "results": results,
    }
    job_runs.save_last_run(record)
    if results:
        logger.info(
            "调度完成：%s（slot=%s，交易日=%s）→ %s",
            plan["session"]["date"],
            slot,
            trading_day,
            "，".join(f"{item['name']}:{item['status']}" for item in results),
        )
    return {**plan, "tradingDay": trading_day, "results": results}
