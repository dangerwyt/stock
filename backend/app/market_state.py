"""行情健康度状态机：忠实移植 reference-react/worker/index.js 的 ``marketSnapshotState``。

输入与 v1 完全一致：真实行情快照 ``market``（meta.provider/generatedAt/tradeDate/session/status
+ quotes[].observedAt）、当前上海会话 ``session``、最近一次抓取状态记录 ``sourceState``、``now``。
输出 ``{status, label, isIntraday, sourceState}``，由前端 MarketCenterPage 直接消费。

移植要点（与原版逐字对应）：
* ``isIntraday`` 按 **provider 是否含 rt_min** 判定「数据粒度」，不是按时钟；盘中与否看 ``session.session``。
* 陈旧度 ``ageMinutes`` 取 min(generatedAt, max(quote observedAt)) 距今分钟数。
* 分支级联顺序与 v1 对齐：daily_close → 不可核验 → 源异常 → partial → 过期 → 盘中延迟 →
  盘中非实时 → rt_k → 兜底。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from app import market_clock

SHANGHAI = market_clock.SHANGHAI
_DATA_DIR = Path(__file__).resolve().parent / "data"
_MARKET_SOURCE_STATE_PATH = _DATA_DIR / "market_source_state.json"


def _parse_dt(value: object) -> datetime | None:
    """解析 ISO 时间；无时区按上海解释；无法解析返回 None（对齐 v1 的 Date.parse→NaN）。"""
    if not value:
        return None
    text = str(value).strip()
    try:
        t = text[:-1] + "+00:00" if text.endswith("Z") else text
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=SHANGHAI)
    return dt.astimezone(SHANGHAI)


def _public_source_state(source_state: object) -> dict | None:
    """把内部 sourceState 收口成对外结构（对齐 v1 的 publicSourceState）。"""
    if not isinstance(source_state, dict):
        return None
    return {
        "status": source_state.get("status"),
        "provider": source_state.get("provider"),
        "failedAt": source_state.get("failedAt"),
        "succeededAt": source_state.get("succeededAt"),
        "quoteCount": source_state.get("quoteCount"),
        "staleCount": source_state.get("staleCount"),
    }


def load_market_source_state() -> dict | None:
    """读取最近一次行情抓取状态记录（market-source:latest 的等价物）。"""
    if not _MARKET_SOURCE_STATE_PATH.exists():
        return None
    try:
        data = json.loads(_MARKET_SOURCE_STATE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _dash_trade_date(raw: object) -> str:
    """把紧凑 YYYYMMDD 归一为 YYYY-MM-DD（用于展示与 15:00 收盘判定）。"""
    s = str(raw or "")
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s


def build_market_health(
    market: dict | None,
    session: dict | None = None,
    source_state: dict | None = None,
    now: datetime | None = None,
) -> dict:
    if session is None:
        session = market_clock.shanghai_session()
    if now is None:
        now = datetime.now(SHANGHAI)

    if not isinstance(market, dict) or not isinstance(market.get("meta"), dict):
        return {"status": "unavailable", "label": "无行情快照", "isIntraday": False, "sourceState": None}

    public_source = _public_source_state(source_state)
    provider = str(market["meta"].get("provider") or "")
    is_intraday = bool(re.search(r"rt_min", provider, re.IGNORECASE))
    is_realtime_daily = bool(re.search(r"rt_k", provider, re.IGNORECASE))
    is_realtime = is_intraday or is_realtime_daily

    generated_at = _parse_dt(market["meta"].get("generatedAt"))
    observation_times = [
        ts
        for ts in (
            _parse_dt((q or {}).get("observedAt") or (q or {}).get("time"))
            for q in (market.get("quotes") or [])
        )
        if ts is not None
    ]
    if observation_times and generated_at is not None:
        data_at = min(generated_at, max(observation_times))
    elif observation_times:
        # 对齐 v1：generatedAt 不可解析但 quotes 有时间 → Math.min(NaN, ...) = NaN → 整体无效
        data_at = None
    else:
        data_at = generated_at
    age_minutes = None
    if data_at is not None:
        age_minutes = max(0, int((now - data_at).total_seconds() // 60))

    failed_at = _parse_dt((source_state or {}).get("failedAt"))
    session_key = (session or {}).get("session")

    if market["meta"].get("session") == "daily_close":
        in_session = session_key in ("morning", "afternoon")
        status = "degraded" if in_session else ("partial" if market["meta"].get("status") == "partial" else "ready")
        td = _dash_trade_date(market["meta"].get("tradeDate"))
        label = f"{td}收盘快照{in_session and '，盘中行情未更新' or '（非实时）'}"
        return {"status": status, "label": label, "isIntraday": False, "sourceState": public_source}

    if is_realtime and age_minutes is None:
        return {"status": "degraded", "label": "行情时间无法核验，不能作为实时数据", "isIntraday": is_intraday, "sourceState": public_source}

    if (source_state or {}).get("status") == "degraded" and failed_at is not None and (generated_at is None or failed_at >= generated_at):
        if market["meta"].get("session") == "opening_auction":
            return {"status": "auction_only", "label": "盘中行情源异常，当前仅展示09:25集合竞价快照", "isIntraday": False, "sourceState": public_source}
        return {"status": "degraded", "label": f"行情源异常，展示{age_minutes is None and '上一份' or f'{age_minutes}分钟前'}快照", "isIntraday": is_intraday, "sourceState": public_source}

    if market["meta"].get("status") == "partial" or (source_state or {}).get("status") == "partial":
        return {"status": "partial", "label": "部分股票行情已更新，其余继续展示最近快照", "isIntraday": is_intraday, "sourceState": public_source}

    if is_intraday and age_minutes is not None and age_minutes > 180:
        return {"status": "degraded", "label": f"盘中行情已过期，展示{age_minutes}分钟前快照", "isIntraday": is_intraday, "sourceState": public_source}

    if session_key in ("morning", "afternoon") and is_realtime and age_minutes is not None and age_minutes > 15:
        return {"status": "degraded", "label": f"盘中行情已延迟{age_minutes}分钟，展示上一份快照", "isIntraday": is_intraday, "sourceState": public_source}

    if session_key in ("morning", "afternoon") and not is_realtime:
        return {"status": "degraded", "label": "盘中分钟行情未更新，当前为集合竞价快照", "isIntraday": False, "sourceState": public_source}

    if is_realtime_daily:
        in_session = session_key in ("morning", "afternoon")
        td_dashed = _dash_trade_date(market["meta"].get("tradeDate"))
        current_trade_date = market_clock.shanghai_clock(now).get("date")
        current_day_snapshot = td_dashed == current_trade_date
        close_15 = _parse_dt(f"{td_dashed}T15:00:00+08:00")
        confirmed_close = data_at is not None and close_15 is not None and data_at >= close_15
        if in_session:
            label = f"盘中日线快照 · 报价距今{age_minutes}分钟 · 按8轮计划采集，非实时"
        elif session_key == "lunch" and current_day_snapshot:
            label = f"午间休市 · 盘中快照距今{age_minutes}分钟（非收盘）"
        elif confirmed_close:
            label = "今日收盘行情快照" if current_day_snapshot else "最近交易日收盘行情快照"
        else:
            label = f"{td_dashed}盘中快照 · 尚无可核验的收盘报价"
        return {"status": "live" if in_session else "ready", "label": label, "isIntraday": False, "sourceState": public_source}

    status = "live" if is_intraday else ("auction_only" if market["meta"].get("session") == "opening_auction" else "ready")
    label = (
        f"盘中分钟快照 · 报价距今{age_minutes}分钟 · 按8轮计划采集，非实时"
        if is_intraday
        else market["meta"].get("disclaimer") or "行情快照"
    )
    return {"status": status, "label": label, "isIntraday": is_intraday, "sourceState": public_source}
