"""调度运行记录：per-round 持久锁 + attempt 去重 + 最近一次运行快照。

对齐 reference-react ``worker/index.js`` 的 ``writeStateIfAbsent`` / attempt 键 / job 锁：
tick 每 60 秒来一次，而一个轮次的宽限窗是 5 分钟 —— 同一轮会被命中最多 5 次。靠两层键去重：

* ``job-attempt:{date}:{name}:round:{slot}`` —— 「这个轮次这个 job 已经试过了」，
  用 writeStateIfAbsent 语义抢占，**第一个抢到的才继续**；
* ``job:{date}:{slot}:{name}`` —— 该 job 的**最终状态**（completed / failed / …），
  存在即跳过（防止 job 跑到一半进程重启后又重跑一轮）。

存储形态与 ``custom_agents.json`` / ``ai_threads.json`` 一致：单个 JSON 文件 + 原子写
（临时文件 + ``replace``）+ 进程内锁。单 uvicorn 进程下足够；将来多 worker 时换成
DB 唯一索引即可（同 T54 的思路）。
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import settings

_LOCK = threading.Lock()

# 记录保留期：只留最近 30 天的 attempt/lock，避免文件无界增长。
_RETENTION_DAYS = 30


_DEFAULT_PATH = Path(__file__).resolve().parent / "data" / "job_runs.json"


def _path() -> Path:
    # `.env.example` 里该键留空（表示"用默认"），但空串会让 ``Path('')`` 变成当前目录，
    # 记录就落到 CWD 去了 —— 显式兜住默认值。
    raw = (settings.job_runs_path or "").strip()
    return Path(raw) if raw else _DEFAULT_PATH


def _default() -> dict:
    return {"attempts": {}, "locks": {}, "lastRun": None}


def _read() -> dict:
    path = _path()
    if not path.exists():
        return _default()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _default()
    if not isinstance(data, dict):
        return _default()
    state = _default()
    state.update(data)
    return state


def _write(state: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _key_date(key: str) -> str:
    """从 ``前缀:YYYY-MM-DD:...`` 形态的键里取出日期段（两类键都在第 2 段）。"""
    parts = str(key).split(":")
    return parts[1] if len(parts) > 1 else ""


def _prune(state: dict) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_RETENTION_DAYS)).strftime("%Y-%m-%d")
    for bucket in ("attempts", "locks"):
        state[bucket] = {
            key: value
            for key, value in (state.get(bucket) or {}).items()
            if _key_date(key) >= cutoff
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------- 键构造


def attempt_key(date: str, name: str, slot: str) -> str:
    return f"job-attempt:{date}:{name}:round:{slot}"


def lock_key(date: str, name: str, slot: str) -> str:
    return f"job:{date}:{slot}:{name}"


# ---------------------------------------------------------------- 对外操作


def claim_attempt(date: str, name: str, slot: str) -> bool:
    """抢占本轮的执行权。返回 True 表示"由我第一次尝试"，False 表示本轮已试过。"""
    key = attempt_key(date, name, slot)
    with _LOCK:
        state = _read()
        if key in (state.get("attempts") or {}):
            return False
        state["attempts"][key] = {"startedAt": _now_iso()}
        _prune(state)
        _write(state)
        return True


def lock_state(date: str, name: str, slot: str) -> dict | None:
    return (_read().get("locks") or {}).get(lock_key(date, name, slot))


def save_lock(date: str, name: str, slot: str, payload: dict) -> None:
    key = lock_key(date, name, slot)
    with _LOCK:
        state = _read()
        state.setdefault("locks", {})[key] = payload
        _prune(state)
        _write(state)


def save_last_run(payload: dict) -> None:
    with _LOCK:
        state = _read()
        state["lastRun"] = payload
        _write(state)


def last_run() -> dict | None:
    return _read().get("lastRun")


def describe() -> dict:
    """调度运行态摘要（挂在 ``/health`` 上，便于确认"上一轮跑了什么、什么状态"）。"""
    state = _read()
    last = state.get("lastRun") or {}
    return {
        "attempts": len(state.get("attempts") or {}),
        "locks": len(state.get("locks") or {}),
        "lastRunAt": last.get("scheduledAt"),
        "lastSlot": last.get("slot"),
        "lastResults": [
            {"name": item.get("name"), "status": item.get("status")}
            for item in (last.get("results") or [])
        ],
    } if last else {"attempts": len(state.get("attempts") or {}), "locks": len(state.get("locks") or {}), "lastRunAt": None}
