"""FastAPI entrypoint for the stock-intelligence-platform backend (Phase-1 skeleton).

Serves the JSON snapshot contract + NDJSON AI research stream that the Vue
frontend consumes. Replaces the previous Cloudflare Worker/Sites data service.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import job_runs, review_engine, scheduler
from app.config import settings
from app.routers import (
    admin,
    agent_documents,
    agents,
    snapshots,
    research,
    simulation,
)

logger = logging.getLogger(__name__)

# uvicorn 只配置它自己的 logger，项目模块的 INFO 日志本来是被吞掉的（root 默认 WARNING）。
# 调度器「巡检/跳过/触发」、段落筛选这些必须能在日志里看到，所以单独放开 app 包。
# 不整体开到 INFO：httpx 会为每个请求打一行，太吵。
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logging.getLogger("app").setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """启动/关闭后台调度器（T4：每 12 小时按资料 + 会话更新画像）。

    调度器起不来不应该拖垮 API —— 用 try 兜住，服务照常提供（只是没有自动更新）。
    """
    try:
        scheduler.start()
    except Exception:  # noqa: BLE001 - 调度器是附属能力，别让它阻断启动
        logger.exception("自动画像更新调度器启动失败，服务继续运行")
    # 启动时先把「今天的冻结榜单」存档一份给盘后复盘。
    # 为什么要在启动时做：落盘的榜单可能是在这条存档逻辑存在之前就生成的（部署/升级后
    # 首次启动正是这种情况），而它一旦被盘后重算覆盖，当天的参考价（前一交易日收盘）
    # 就再也找不回来 —— 复盘会退化成"参考价取自当日收盘，无法归因"。
    try:
        review_engine.freeze_today()
    except Exception:  # noqa: BLE001 - 纯兜底，失败不影响启动
        logger.warning("启动时存档当日冻结榜单失败（不影响服务）", exc_info=True)
    try:
        yield
    finally:
        scheduler.shutdown()


app = FastAPI(
    title="Stock Intelligence Platform API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "env": settings.app_env,
        "scheduler": scheduler.describe(),
        # 外部 tick 调度的运行态（per-round 锁 / 上一轮跑了什么）。
        "jobRuns": job_runs.describe(),
        "adminScheduler": {
            "endpoint": "POST /api/admin/scheduled",
            "tokenConfigured": bool(settings.admin_api_token),
        },
    }


app.include_router(snapshots.router)
app.include_router(research.router)
app.include_router(agents.router)
app.include_router(agent_documents.router)
app.include_router(admin.router)
app.include_router(simulation.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.backend_host,
        port=settings.backend_port,
        reload=settings.app_env == "development",
    )
