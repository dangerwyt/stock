"""管理端点：外部 tick 调度入口。

对齐 reference-react 的 ``POST /api/admin/scheduled``：由外部（launchd / systemd timer /
cron / 手动）每分钟调一次，鉴权用 ``Authorization: Bearer {ADMIN_API_TOKEN}``。

**为什么把调度做成"外部 tick + 服务端判定"**：见 :mod:`app.market_schedule` 顶部注释 ——
不依赖进程内定时器精度，重启后下一分钟自动接上，且"这一轮跑没跑"由磁盘上的持久锁决定。

两个入口：

* ``POST /api/admin/scheduled`` —— 真正跑一轮（有副作用）；
* ``GET  /api/admin/scheduled`` —— 只**预览**本轮计划（无副作用），验收窗口边界用。

开发环境（``APP_ENV=development``）额外支持 ``?at=2026-10-12T14:02`` 注入时间，
用于在不改系统时钟的前提下验收"某时刻命中哪一轮"。生产环境会忽略该参数。
"""
from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse

from app import job_runs, market_schedule
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


def _authorized(authorization: str | None) -> bool:
    """token 为空时**一律拒绝** —— 不给"没配就等于不校验"这种默认放行留后门。"""
    token = settings.admin_api_token or ""
    if not token:
        return False
    return authorization == f"Bearer {token}"


def _resolve_at(at: str | None) -> tuple[datetime | None, JSONResponse | None]:
    """解析 ``?at=`` 注入的时间。仅开发环境生效；解析失败返回 400。"""
    if not at:
        return None, None
    if settings.app_env != "development":
        logger.warning("非开发环境忽略 ?at= 参数（app_env=%s）", settings.app_env)
        return None, None
    try:
        # naive 一律按上海时区解释（见 market_clock.shanghai_clock）。
        return datetime.fromisoformat(at), None
    except ValueError:
        return None, JSONResponse(status_code=400, content={"error": "invalid 'at'", "at": at})


@router.post("/api/admin/scheduled")
async def run_scheduled_tick(
    authorization: str | None = Header(default=None),
    at: str | None = Query(default=None),
):
    if not _authorized(authorization):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    now, error = _resolve_at(at)
    if error is not None:
        return error
    result = await market_schedule.run_scheduled(now)
    return {"status": "completed", "result": result}


@router.get("/api/admin/scheduled")
async def preview_scheduled_tick(
    authorization: str | None = Header(default=None),
    at: str | None = Query(default=None),
    tradingDay: bool | None = Query(default=None),
):
    """只看计划，不执行。``tradingDay`` 显式传入可跳过交易日历查询（验收窗口边界用）。"""
    if not _authorized(authorization):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    now, error = _resolve_at(at)
    if error is not None:
        return error
    trading_day = (
        tradingDay if tradingDay is not None else await market_schedule.detect_trading_day(now)
    )
    plan = market_schedule.scheduled_job_plan(now, trading_day)
    return {
        "status": "ready",
        "tradingDay": trading_day,
        "plan": plan,
        "runs": job_runs.describe(),
    }
