"""每天 9:00 自动更新自建角色的画像（T4）。

**为什么用 APScheduler 而不是 Celery**：单进程 uvicorn + ``AsyncIOScheduler`` 在进程内
跑最省事，不引入 broker / worker。Celery 在 Windows 上要 ``--pool=solo`` 还得单独起
worker，对 demo 阶段是过度设计。

**为什么用 cron 而不是 interval**：``IntervalTrigger`` 是从进程启动开始计时的相对值 ——
重启一次，「每天几点跑」就漂移一次。``CronTrigger(hour=9)`` 是绝对时刻，重启后仍然是
每天 9:00（代价：进程若在当天 9:00 之后才启动，当天就跳过，等第二天）。

**变更检测是这里最关键的逻辑**：只有「资料指纹或会话指纹变了」才重新提炼。否则每天无脑重跑，
既白烧模型调用额度，又可能覆盖用户手工调整过的画像。

**已知局限**（demo 阶段可接受）：
- 调度器没配持久化 jobstore，重启后由 cron 重新计算下次触发时刻（这点 cron 比 interval 好）；
- 将来上多 worker 时，每个 worker 都会跑一轮 → 那时需要 DB 锁或单独起一个调度进程。
"""
from __future__ import annotations

import hashlib
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app import agent_docs, agent_extract, agents, threads
from app.config import settings

logger = logging.getLogger(__name__)

JOB_ID = "auto-extract-profiles"

# 时区固定用上海：部署机可能是 UTC（服务器/Docker），而「每天 9:00」指的是北京时间。
TIMEZONE = "Asia/Shanghai"

# 万一 9:00 那一刻进程正忙（比如在处理一场会诊），1 小时内补跑仍算这次触发。
MISFIRE_GRACE_SECONDS = 3600

_scheduler: AsyncIOScheduler | None = None


def compute_fingerprint(agent_id: str, agent_name: str, client_id: str = "") -> str:
    """资料集 + 会话状态的指纹。任一项变化都会得到新值。

    资料侧带上 ``status``：一份资料从 ``parsed`` 变成 ``rejected``（或反之）同样意味着
    「喂给模型的东西变了」，必须触发重提炼。
    """
    documents = agent_docs.list_documents(agent_id)
    doc_part = "|".join(
        sorted(
            f"{item.get('id')}:{item.get('uploadedAt')}:{item.get('status')}"
            for item in documents
        )
    )
    count, last = threads.history_stats(agent_name, client_id)
    raw = f"{doc_part}#{count}#{last}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


async def refresh_all(force: bool = False) -> dict:
    """跑一轮巡检。返回统计，便于日志与验收时对账。

    ``force=True`` 时忽略指纹，强制重提炼（验收/手动补跑用）。
    """
    stats = {"checked": 0, "skipped": 0, "extracted": 0, "failed": 0, "noDocs": 0}
    for item in agents.list_custom():
        agent_id = item.get("id")
        name = item.get("name") or ""
        if not agent_id:
            continue
        stats["checked"] += 1

        if not agent_docs.effective_documents(agent_id):
            # 没有可用资料的角色没什么可提炼的（rejected 的资料也不算）。
            stats["noDocs"] += 1
            continue

        fingerprint = compute_fingerprint(agent_id, name)
        state = agent_docs.auto_extract_state(agent_id)
        if not force and state.get("fingerprint") == fingerprint:
            stats["skipped"] += 1
            logger.info("自动提炼跳过「%s」：指纹未变（%s）", name, fingerprint)
            continue

        if not agent_docs.begin_extraction(agent_id):
            # 用户此刻正在手动点「提炼画像」，别插队。
            stats["skipped"] += 1
            logger.info("自动提炼跳过「%s」：已有提炼在跑", name)
            continue

        logger.info("自动提炼触发「%s」（指纹 %s）", name, fingerprint)
        ok = await agent_extract.run_extraction(agent_id, name)
        agent_docs.save_auto_extract(
            agent_id,
            fingerprint,
            "ok" if ok else "failed",
            None if ok else "提炼失败，详见 extraction.error",
        )
        stats["extracted" if ok else "failed"] += 1
    logger.info("自动提炼巡检完成：%s", stats)
    return stats


def start() -> None:
    """在 app lifespan 启动时调用。"""
    global _scheduler
    if not settings.auto_extract_enabled:
        logger.info("自动画像更新已关闭（AUTO_EXTRACT_ENABLED=false）")
        return
    if _scheduler is not None:
        return

    hour = min(23, max(0, int(settings.auto_extract_hour)))
    minute = min(59, max(0, int(settings.auto_extract_minute)))

    scheduler = AsyncIOScheduler(timezone=TIMEZONE)
    scheduler.add_job(
        refresh_all,
        CronTrigger(hour=hour, minute=minute, timezone=TIMEZONE),
        id=JOB_ID,
        replace_existing=True,
        # 上一轮还没跑完就跳过这一轮，别把同一批角色重复塞进模型。
        max_instances=1,
        coalesce=True,
        misfire_grace_time=MISFIRE_GRACE_SECONDS,
    )
    scheduler.start()
    _scheduler = scheduler
    logger.info("自动画像更新已启动：每天 %02d:%02d（%s）巡检一轮", hour, minute, TIMEZONE)
    job = scheduler.get_job(JOB_ID)
    if job and job.next_run_time:
        logger.info("下次巡检时间：%s", job.next_run_time.isoformat())


def shutdown() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("自动画像更新已停止")


def is_running() -> bool:
    return _scheduler is not None and _scheduler.running


def describe() -> dict:
    """调度状态快照（挂在 /health 上，便于确认「到底几点跑、下次什么时候」）。"""
    if _scheduler is None:
        return {"running": False}
    job = _scheduler.get_job(JOB_ID)
    return {
        "running": _scheduler.running,
        "jobId": JOB_ID if job else None,
        "trigger": str(job.trigger) if job else None,
        "nextRunAt": job.next_run_time.isoformat() if job and job.next_run_time else None,
    }
