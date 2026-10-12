"""上海时区「市场时钟 / 会话判定」。

逐字对齐 reference-react ``worker/index.js`` 的 ``shanghaiClock``（第 150 行）与
``getShanghaiSession``（第 163 行）—— 调度引擎靠它算出"当前落在哪个 5 分钟窗口"。

为什么单独抽一个模块：时钟判定有两个消费方，口径必须**唯一**，否则会出现
"调度认为现在是盘前、页头却显示隔夜"这种自相矛盾：

* :func:`shanghai_session` —— 调度引擎用的 8 段会话（v1 原口径，含集合竞价/收盘核验）；
* :func:`header_session`  —— 前端页头标签用的简化口径（盘前/上午交易/…/已收盘）。

两者共用同一个 :func:`shanghai_clock`，只是把分钟数映射成不同的标签集合。
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def shanghai_clock(now: datetime | None = None) -> dict:
    """当前上海时间快照。

    ``now`` 允许传入 **naive** datetime（验收时用 ``?at=`` 注入）—— naive 一律按
    上海时区解释，与 `_live_session` 里 ``datetime.now(_SHANGHAI)`` 的语义一致。
    """
    value = now or datetime.now(SHANGHAI)
    if value.tzinfo is None:
        value = value.replace(tzinfo=SHANGHAI)
    value = value.astimezone(SHANGHAI)
    return {
        "date": value.strftime("%Y-%m-%d"),
        "compactDate": value.strftime("%Y%m%d"),
        "time": value.strftime("%H:%M"),
        "hour": value.hour,
        "minute": value.minute,
        "weekday": WEEKDAYS[value.weekday()],
        "iso": value.isoformat(),
    }


def shanghai_session(now: datetime | None = None, trading_day: bool | None = None) -> dict:
    """8 段会话判定（reference-react ``getShanghaiSession`` 的等价物）。

    ``trading_day=None`` 时按「周末即休市」近似（真正的交易日历由
    :func:`app.market_schedule.detect_trading_day` 用 ``trade_cal`` 复核）。
    """
    clock = shanghai_clock(now)
    if trading_day is None:
        trading_day = clock["weekday"] not in ("Sat", "Sun")
    if not trading_day:
        return {**clock, "session": "closed", "label": "休市日"}

    minutes = clock["hour"] * 60 + clock["minute"]
    # 边界刻意用 <= 而不是 <：11:30 / 15:00 整点仍算"交易中"，与 v1 一字不差。
    if minutes < 7 * 60 + 20:
        return {**clock, "session": "overnight", "label": "隔夜跟踪"}
    if minutes < 9 * 60 + 15:
        return {**clock, "session": "pre_market", "label": "盘前准备"}
    if minutes < 9 * 60 + 30:
        return {**clock, "session": "call_auction", "label": "集合竞价"}
    if minutes <= 11 * 60 + 30:
        return {**clock, "session": "morning", "label": "上午交易"}
    if minutes < 13 * 60:
        return {**clock, "session": "lunch", "label": "午间休市"}
    if minutes <= 15 * 60:
        return {**clock, "session": "afternoon", "label": "下午交易"}
    if minutes <= 15 * 60 + 30:
        return {**clock, "session": "post_close", "label": "收盘核验"}
    return {**clock, "session": "after_hours", "label": "盘后研究"}


def header_session(now: datetime | None = None) -> dict:
    """页头标签口径（简化版：盘前 / 上午交易 / 午间休市 / 下午交易 / 已收盘 / 周末休市）。

    与 :func:`shanghai_session` **有意不同**：页头只做"今天交易到哪一步"的粗粒度提示，
    不需要集合竞价/收盘核验这种调度内部节点。保留这个简化口径是为了不改变已验收的
    页头文案（``已收盘`` 而不是 ``盘后研究``）。
    """
    clock = shanghai_clock(now)
    if clock["weekday"] in ("Sat", "Sun"):
        key, label = "closed", "周末休市"
    else:
        minutes = clock["hour"] * 60 + clock["minute"]
        if minutes < 9 * 60 + 15:
            key, label = "pre_open", "盘前"
        elif minutes <= 11 * 60 + 30:
            key, label = "morning", "上午交易"
        elif minutes < 13 * 60:
            key, label = "lunch", "午间休市"
        elif minutes <= 15 * 60:
            key, label = "afternoon", "下午交易"
        else:
            key, label = "closed", "已收盘"
    return {**clock, "session": key, "label": label}
