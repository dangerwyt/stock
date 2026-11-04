"""盘后复盘：冻结 TOP50 × 当日真实收盘价。

计算口径**逐字移植** reference-react ``worker/index.js`` 的 ``buildPostCloseReview``
（原第 4523 行）与 ``postCloseReviewJob``（原第 4566 行）；换掉的只有存储和触发方式：

============ ======================================== ==========================================
维度          reference-react                          本项目
============ ======================================== ==========================================
报告          Cloudflare KV ``review:day:{date}``       ``data/review/days/{date}.json``
尝试记录      KV ``review:attempt:{date}``              ``data/review/attempts/{date}.json``
历史日期列表  列 KV ``review:day:`` 前缀              扫 ``days/`` 目录
冻结榜单      KV ``top50:latest``                     ``data/review/boards/{date}.json`` + 实时快照兜底
触发          调度 job ``post-close``                 ``post-close`` 调度 + 手动 ``POST /api/review/refresh``
============ ======================================== ==========================================

**刻意保留的「不生成」规则**（reference 的商业底线：缺数据就不出结论，绝不虚构）：

1. 复盘「当天」时 15:10 前不生成 —— 收盘价还没落库；
2. 非交易日不生成；
3. ``daily`` 取不到当日行时不生成，只写 attempt 说明原因；
4. 本次数据不完整而上一份是完整报告时，**保留上一份**及其原始时间，不拿残缺数据盖掉。

**对 reference 的两处收紧**（都因为本实现多暴露了手动生成入口，reference 只被调度器
用「今天」调用过，所以从没校验过这两件事）：

* 目标日期找不到**同日冻结榜单**时直接拒绝生成，而不是拿错位的参考价算出一份看着
  正常、其实无意义的「日表现」；
* 冻结榜单的 ``marketDataDate`` 若与复盘日期相同（榜单是收盘后建的），参考价已含当日
  收盘，日表现恒为 0，此时补一条 gap 并降级为 ``partial``，不给"已核验"的假象。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from app import market_clock, news_aggregate, tushare_client, top50_engine
from app.config import settings

logger = logging.getLogger(__name__)

# 收盘数据落库的保守时点：与 ``tushare_client._data_window`` 的 15:30 一致，
# 取 15:10 是 reference 的值（宁可早试一次、失败留给下一次校准）。
_CLOSE_READY_TIME = "15:10"

# 抓「当日资讯」的最长等待。新闻只是背景线索，超时就当没有，不拖整体生成。
_NEWS_TIMEOUT_SECONDS = 8.0

_METHOD = (
    "冻结TOP50逐股与当日daily收盘价匹配；周期内等权，不计交易成本、不可成交和实际持仓。"
    "该日表现不是到期预测命中率。"
)
_ATTRIBUTION_METHOD = "行业分组仅解释样本表现分布；新闻为背景线索，不能据此断定涨跌因果。"


class ReviewError(RuntimeError):
    """复盘生成不可继续（调用方转 4xx/5xx，不写成报告）。"""


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------
def _review_dir() -> Path:
    return Path(settings.review_dir)


def _sub(name: str) -> Path:
    path = _review_dir() / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("复盘存档读取失败（当作没有）：%s %s", path.name, exc)
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, payload: dict) -> None:
    """原子写：先写 ``.tmp`` 再 ``replace``，避免半份 JSON 被读到。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_report(date: str) -> dict | None:
    return _read_json(_review_dir() / "days" / f"{date}.json")


def load_attempt(date: str) -> dict | None:
    return _read_json(_review_dir() / "attempts" / f"{date}.json")


def load_board(date: str) -> dict | None:
    """取某一日的冻结榜单副本（复盘生成时自动存档）。"""
    return _read_json(_review_dir() / "boards" / f"{date}.json")


def save_report(report: dict) -> None:
    _write_json(_sub("days") / f"{report['tradeDate']}.json", report)


def save_attempt(date: str, attempt: dict) -> None:
    _write_json(_sub("attempts") / f"{date}.json", attempt)


def archive_board(snapshot: dict) -> None:
    """把冻结榜单按 ``meta.tradeDate`` 存档，供该日复盘复算。

    幂等：同一天重复调用只覆盖同一天的文件；没有 ``meta.tradeDate`` 的快照直接跳过。
    """
    meta = (snapshot or {}).get("meta") or {}
    trade_date = meta.get("tradeDate")
    if not trade_date or not (snapshot or {}).get("cycles"):
        return
    path = _sub("boards") / f"{trade_date}.json"
    # 已有同日存档就不覆盖：首次存档才是「当时真正冻结的那一份」。
    if path.exists():
        return
    _write_json(path, snapshot)
    logger.info("已存档 %s 的冻结榜单：%s", trade_date, meta.get("snapshotId"))


def list_dates(limit: int = 60) -> list[str]:
    """可复盘的日期，倒序。对齐 reference 的 ``keys.slice(0, 60)``。

    取的是**已生成报告 ∪ 已存档冻结榜单**的并集，而不是只列报告。理由：某天可能只冻了
    榜单、没生成报告（当天没空点，或那天没人打开生成）。这种日期照样能补看 —— 参考价在
    ``boards/`` 里，收盘价可以按日期从数据源取。只列 ``days/`` 会让这些天在页面上彻底消失，
    用户连"可以补"都不知道。
    """
    found: set[str] = set()
    for sub in ("days", "boards"):
        folder = _review_dir() / sub
        if not folder.exists():
            continue
        for item in folder.glob("*.json"):
            stem = item.stem
            if len(stem) == 10 and stem[4] == "-" and stem[7] == "-":
                found.add(stem)
    return sorted(found, reverse=True)[:limit]


# ---------------------------------------------------------------------------
# 纯计算（reference buildPostCloseReview 的逐行移植）
# ---------------------------------------------------------------------------
def _iso_date(value: Any) -> str | None:
    """``20261028`` / ``2026-10-28`` / ``2026-10-28 00:00:00`` → ``2026-10-28``。

    容忍带时间的形态：有些数据源会在日期列上带 ``00:00:00`` 或 ``T`` 分隔，直接拼成
    "20261028 00:00:00" 会因为长度不是 8 而被判成"无法识别"，进而把整天的行全部丢掉。
    """
    raw = str(value or "").strip()
    if not raw:
        return None
    raw = raw.split(" ")[0].split("T")[0]
    compact = raw.replace("-", "")
    if len(compact) != 8 or not compact.isdigit():
        return None
    return f"{compact[:4]}-{compact[4:6]}-{compact[6:]}"


def _num(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _round2(value: float) -> float:
    return float(f"{value:.2f}")


def _ts_code_of(stock: dict) -> str:
    existing = str(stock.get("tsCode") or "").strip()
    if existing:
        return existing
    try:
        return tushare_client._to_ts_code(str(stock.get("code") or ""))
    except tushare_client.TushareError:
        return ""


def _shanghai_date(iso_value: Any) -> str | None:
    """ISO 时间（含 ``Z``）→ 上海时区的自然日。解析不出来返回 None。"""
    text = str(iso_value or "").strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=market_clock.SHANGHAI)
    return moment.astimezone(market_clock.SHANGHAI).strftime("%Y-%m-%d")


def build_post_close_review(
    top50: dict,
    daily: list[dict],
    news: dict | None,
    date: str,
    now: datetime | None = None,
    *,
    assume_date: bool = False,
) -> dict:
    """生成一份复盘报告（纯函数，不读写磁盘、不发请求）。

    ``top50`` 是当日冻结榜单（``{meta, cycles}``），``daily`` 是 Tushare ``daily`` 行，
    只有 ``trade_date == date`` 且 ``close > 0`` 的行会被采用 —— 这是"不用旧价补位"的实现
    所在，缺价的股票 ``close`` 留 ``None``，前端显式显示「缺数据」。

    ``assume_date``：当日线行**整列没有 ``trade_date``** 时，是否把它们视为 ``date`` 当天。
    只在调用方确实按交易日取数时传 ``True``（``daily?trade_date=...`` 是日期参数化查询，
    "这行属于哪天"在调用侧已经确定，字段只是数据源没回）。带日期但日期不符的行**永远**
    被丢弃，所以这个开关不会让错位的数据混进来。

    留这个开关的直接原因：曾经有一份行来源用了不带 ``trade_date`` 的字段表，结果四周期
    一律 ``0 / 50``、等权表现 ``--`` —— 既没报错也没留痕，看着就像"当天全市场都没数据"。
    """
    moment = now or datetime.now(market_clock.SHANGHAI)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=market_clock.SHANGHAI)
    moment = moment.astimezone(market_clock.SHANGHAI)
    now_ms = int(moment.timestamp() * 1000)

    quotes: dict[str, dict] = {}
    for row in daily or []:
        row_date = _iso_date(row.get("trade_date"))
        if row_date is None:
            if not assume_date:
                continue
            row_date = date
        if row_date != date:
            continue
        close = _num(row.get("close"))
        if close is None or close <= 0:
            continue
        ts_code = str(row.get("ts_code") or "")
        if ts_code:
            quotes[ts_code] = row

    cycles: list[dict] = []
    for cycle, data in ((top50 or {}).get("cycles") or {}).items():
        stocks: list[dict] = []
        for stock in (data or {}).get("ranking") or []:
            quote = quotes.get(_ts_code_of(stock))
            baseline = _num(stock.get("close"))
            close = _num(quote.get("close")) if quote else None
            invalid_price = _num(stock.get("invalidPrice"))
            valid_invalid = bool(invalid_price is not None and invalid_price > 0)
            stocks.append({
                "code": stock.get("code"),
                "name": stock.get("name"),
                "industry": stock.get("industry") or "未分类",
                "rank": stock.get("rank"),
                "referencePrice": baseline if (baseline is not None and baseline > 0) else None,
                "close": close,
                "change": (
                    _round2(100 * (close / baseline - 1))
                    if (close is not None and baseline is not None and baseline > 0)
                    else None
                ),
                "invalidPrice": invalid_price if valid_invalid else None,
                "invalidated": (
                    close < invalid_price
                    if (close is not None and valid_invalid)
                    else None
                ),
                "evidenceId": (
                    stock.get("predictionId")
                    or next(iter((stock.get("predictionIds") or {}).values()), None)
                ),
            })

        observed = [item for item in stocks if item["change"] is not None]
        by_industry: dict[str, list[float]] = {}
        for item in observed:
            by_industry.setdefault(item["industry"], []).append(item["change"])
        industries = sorted(
            (
                {
                    "industry": industry,
                    "count": len(values),
                    "averageChange": _round2(sum(values) / len(values)),
                }
                for industry, values in by_industry.items()
            ),
            key=lambda item: item["averageChange"],
            reverse=True,
        )
        cycles.append({
            "cycle": cycle,
            "expected": len(stocks),
            "observed": len(observed),
            "averageChange": (
                _round2(sum(item["change"] for item in observed) / len(observed))
                if observed
                else None
            ),
            "advancing": len([item for item in observed if item["change"] > 0]),
            "invalidated": len([item for item in stocks if item["invalidated"] is True]),
            "industries": industries,
            "stocks": stocks,
        })

    meta = (top50 or {}).get("meta") or {}
    complete = (
        meta.get("tradeDate") == date
        and len(cycles) == 4
        and all(item["expected"] > 0 and item["observed"] == item["expected"] for item in cycles)
    )

    news_items: list[dict] = []
    for item in ((news or {}).get("items") or []):
        published = item.get("publishedAt")
        at = _shanghai_date(published)
        if not at or at != date:
            continue
        try:
            at_ms = int(
                datetime.fromisoformat(str(published).replace("Z", "+00:00")).timestamp() * 1000
            )
        except ValueError:
            continue
        if at_ms > now_ms:
            continue
        url = str(item.get("url") or "")
        if not url.startswith(("http://", "https://")):
            continue
        news_items.append({
            "title": item.get("title"),
            "url": url,
            "publishedAt": published,
            "source": item.get("source"),
            "marketScope": item.get("marketScope"),
        })
        if len(news_items) >= 8:
            break

    gaps = [
        "缺少当日冻结榜单" if meta.get("tradeDate") != date else None,
        "部分周期或股票缺少可核验当日收盘价" if not complete else None,
        "没有可核验的当日新闻引用" if not news_items else None,
    ]

    return {
        "id": f"review-{date}-{uuid.uuid4()}",
        "tradeDate": date,
        "generatedAt": moment.isoformat(),
        "status": "ready" if complete else "partial",
        "snapshotId": meta.get("snapshotId"),
        "frozenAt": meta.get("generatedAt"),
        "referenceDate": meta.get("marketDataDate")
        or (meta.get("dataLineage") or {}).get("marketDataDate"),
        "source": "Tushare兼容 daily（主备查询，以数据源质量请求记录为准）",
        "method": _METHOD,
        "attributionMethod": _ATTRIBUTION_METHOD,
        "cycles": cycles,
        "news": news_items,
        "gaps": [gap for gap in gaps if gap],
        "nextDayPlan": [
            {
                "scenario": "继续观察",
                "condition": "次日价格、成交量与行业强弱同时支持原研究逻辑",
                "action": "回到单股证据核验触发条件，不自动下单。",
            },
            {
                "scenario": "证据冲突",
                "condition": "价格表现与基本面或新闻证据方向不一致",
                "action": "列出冲突来源与时间，交由老师Agent复核，暂不确认新结论。",
            },
            {
                "scenario": "风险失效",
                "condition": "报告中标记收盘跌破冻结失效价，或次日数据缺失",
                "action": "重新检查失效规则；缺数据保持未知，不沿用过期报价。",
            },
        ],
    }


# ---------------------------------------------------------------------------
# 编排
# ---------------------------------------------------------------------------
def _is_degenerate(report: dict | None) -> bool:
    """这份存档报告是不是"一只也没对上"的空壳？

    判定：非 ``ready`` 且所有周期的 ``observed`` 加起来是 0，而 ``expected`` 不是 0。
    这种报告四周期一律 ``0 / 50``、等权表现 ``--``，展示出来会被读成"当天全市场没数据"，
    实际是取数口径出了错（历史成因见 ``build_post_close_review`` 的 ``assume_date`` 说明）。

    为什么宁可当作没有：项目底线是"缺数据就不出结论"。一份看着正常、其实一只都没核验过的
    报告，比"暂无报告 + 一句真实原因"危害大得多 —— 前者会被人当成结论。
    """
    if not report or report.get("status") == "ready":
        return False
    expected = observed = 0
    for item in report.get("cycles") or []:
        expected += int(item.get("expected") or 0)
        observed += int(item.get("observed") or 0)
    return expected > 0 and observed == 0


def _pending(date: str, reason: str, now: datetime | None = None) -> dict:
    """写一条「这次没生成」的记录 —— 页面据此显示原因，而不是空白。"""
    moment = now or datetime.now(market_clock.SHANGHAI)
    attempt = {
        "status": "pending",
        "checkedAt": moment.astimezone(market_clock.SHANGHAI).isoformat(),
        "reportId": None,
        "reason": reason,
    }
    save_attempt(date, attempt)
    logger.info("复盘未生成（%s）：%s", date, reason)
    return {"status": "pending", "date": date, "reportId": None, "reason": reason}


def _current_board_trade_date() -> str | None:
    try:
        snapshot = top50_engine.get_known_snapshot()
    except Exception:  # noqa: BLE001 - 仅为文案里的提示，不该因它失败
        return None
    return ((snapshot or {}).get("meta") or {}).get("tradeDate")


def _frozen_board_for(date: str) -> dict | None:
    """找 ``date`` 那一日的冻结榜单：先查存档，再用现有的实时快照兜底。"""
    archived = load_board(date)
    if archived:
        return archived
    try:
        snapshot = top50_engine.get_known_snapshot()
    except Exception:  # noqa: BLE001
        return None
    if ((snapshot or {}).get("meta") or {}).get("tradeDate") == date:
        return snapshot
    return None


def freeze_today() -> None:
    """把「今天的冻结榜单」存档一份（启动时调用；幂等）。"""
    _freeze_board_if_current(market_clock.shanghai_clock()["date"])


def ensure_today_board_frozen() -> None:
    """读接口的轻量兜底：今天还没存过就顺手存一次。

    为什么让 GET 也做这件事：不能把「每天都能复盘」寄托在外部计时器上。只要那天有人
    打开过复盘页，当天的盘前榜单就落盘了 —— 于是**当天没空看、隔天再补看**也仍然成立
    （参考价来自存档，收盘价从 Tushare 按日期取，两者都不依赖"当天有没有人点生成"）。

    成本受控：当天已存过就只剩一次 ``exists()``，不做任何读取。
    """
    date = market_clock.shanghai_clock()["date"]
    if (_review_dir() / "boards" / f"{date}.json").exists():
        return
    _freeze_board_if_current(date)


def _freeze_board_if_current(date: str) -> None:
    """手上这份榜单若正好是 ``date`` 那天的，就立刻存档（幂等，已有则不覆盖）。

    这是「盘后重算会毁掉当日参考价」的唯一兜底：调用点放在 ``generate`` 最前面，
    所以哪怕这一次因为"还没到 15:10"或"行情取不到"而没生成报告，榜单也已经冻住了。
    """
    try:
        snapshot = top50_engine.get_known_snapshot()
    except Exception:  # noqa: BLE001 - 存档是兜底，失败不该影响主流程
        return
    if ((snapshot or {}).get("meta") or {}).get("tradeDate") == date:
        archive_board(snapshot)


async def _news_snapshot() -> dict | None:
    """当日资讯快照。拉取失败/超时都不算致命 —— 报告里会记一条「没有可核验的当日新闻」的 gap。

    **必须限时**：资讯聚合会依次试晴红 50+ / NewsAPI / Tushare major_news，任一家的网络
    抖动都会把整个复盘拖到十几秒，而新闻在这份报告里只是「背景线索」，不值得为它
    冒前端超时的风险。超时就当没有，报告照出。
    """
    try:
        return await asyncio.wait_for(
            news_aggregate.build_news_snapshot(), timeout=_NEWS_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        logger.warning("复盘取资讯超时（>%.0fs），报告将不含新闻依据", _NEWS_TIMEOUT_SECONDS)
        return None
    except Exception as exc:  # noqa: BLE001 - 资讯只是背景线索，不该阻断复盘
        logger.warning("复盘取资讯失败，报告将不含新闻依据：%s", exc)
        return None


async def _safe_daily_rows(target: str) -> list[dict]:
    """取当日全市场日线；失败返回空列表。

    复盘里"取不到行情"和"行情为空"走的是同一句提示（都是数据源没给这一天），
    所以在这里把异常收掉，避免 ``asyncio.gather`` 因为一个取数失败把整个生成打断。
    """
    try:
        return await tushare_client.fetch_daily_rows(target)
    except tushare_client.TushareError as exc:
        logger.warning("复盘取当日行情失败（%s）：%s", target, exc)
        return []


async def generate(
    date: str | None = None,
    *,
    daily_rows: list[dict] | None = None,
    now: datetime | None = None,
    force: bool = False,
) -> dict:
    """生成（或重新校准）某一天的复盘报告。

    ``daily_rows`` 允许调用方传入已取到的全市场日线（``post-close`` 任务手上就有），
    传了就不再多打一次 Tushare。**必须**是 ``date`` 当天那一次按交易日查询的结果 ——
    传错日期的行会在匹配阶段被全部丢弃，最终触发下方"一只也没对上"的守卫而拒绝生成
    （不会静默产出一份 0/50 的报告）。

    返回 ``{status, date, reportId, reason?}``，``status`` 为 ``completed`` / ``pending``；
    **任何情况下都不抛**（异常转成 pending 原因）。
    """
    moment = (now or datetime.now(market_clock.SHANGHAI)).astimezone(market_clock.SHANGHAI)
    clock = market_clock.shanghai_clock(moment)
    target = (date or clock["date"]).strip()

    try:
        _validate_date(target, clock["date"])
    except ReviewError as exc:
        return {"status": "invalid", "date": target, "reportId": None, "reason": str(exc)}

    # 「第一次有人问起这一天，就把那天的榜单冻住」—— 放在所有分支之前，包括"还没到收盘
    # 时点"的 pending 分支。理由很具体：榜单只保留最新一份，而复盘要的是**盘前冻结**的
    # 参考价（前一交易日收盘）。盘后一旦有人打开 TOP50 页面触发重算，参考价就变成当日
    # 收盘，日表现会全变 0；这个窗口从收盘到当晚 17:40 之间一直存在，只有提前存档能兜住。
    _freeze_board_if_current(target)

    existing = load_report(target)
    if existing and existing.get("status") == "ready" and not force:
        # 已经是完整报告：没有新数据就不重算，避免每次刷新都吃一次 Tushare 额度。
        return {
            "status": "completed",
            "date": target,
            "reportId": existing.get("id"),
            "reused": True,
        }

    if target == clock["date"] and clock["time"] < _CLOSE_READY_TIME:
        return _pending(target, "等待真实交易日收盘（15:10 后生成）", moment)

    # 行情与资讯互不依赖，**并发**取：
    # 早前是"先查交易日历 → 再拉日线 → 再抓资讯"串行三步，主源超额时每一步都要先等
    # 它 4 秒才回落 B 套，冷启动一次生成能到 22 秒，把前端超时顶穿。并发后只剩最慢那步。
    daily_task = None
    if daily_rows is None:
        daily_task = asyncio.ensure_future(_safe_daily_rows(target))
    news_task = asyncio.ensure_future(_news_snapshot())
    if daily_task is not None:
        daily_rows, news = await asyncio.gather(daily_task, news_task)
    else:
        news = await news_task

    if not daily_rows:
        # 拿不到当日行情时再问一次交易日历，只为把"非交易日"和"数据没落库"这两种
        # 完全不同的原因区分开 —— 页面上它们是两句不一样的话。顺带省掉正常路径上的一次调用：
        # 有当日行情本身就证明那天是交易日。
        try:
            trading_day = await tushare_client.is_market_open(target)
        except tushare_client.TushareError as exc:
            trading_day = clock["weekday"] not in ("Sat", "Sun")
            logger.warning("复盘交易日历不可用，按周末近似判定（%s）：%s", target, exc)
        if not trading_day:
            return _pending(target, "非交易日，不生成复盘", moment)
        return _pending(target, "当日收盘数据暂不可用（数据源未返回该日行情）；保留已有报告，等待下一次校准。", moment)

    board = _frozen_board_for(target)
    if not board:
        current = _current_board_trade_date()
        return _pending(
            target,
            f"缺少 {target} 的冻结榜单"
            f"（当前榜单交易日记为 {current or '未知'}），参考价无法对齐，不生成报告。",
            moment,
        )

    report = build_post_close_review(
        board, daily_rows, news, target, moment,
        # 两条取数路径（``fetch_daily_rows`` 与 ``_latest_market_trade_date``）都是
        # ``daily?trade_date=...`` 的日期参数化查询，行属于哪天在取数时就已确定。
        # 所以字段被数据源裁掉时按 target 归日是安全的 —— 详见该函数 ``assume_date`` 说明。
        assume_date=True,
    )

    # 「一只也没对上」= 行情行与榜单的交集为空，这不是"数据不全"，而是**取数口径出了错**
    # （历史上就是 daily 缺 trade_date 导致的）。这种报告四周期一律 0/50、等权表现 ``--``，
    # 用户根本分不清是"当天真没数据"还是"程序算错了"，等于拿一份看起来正常的空壳糊弄人。
    # 按项目「缺数据就不出结论」的底线，这种情况不出报告，只写原因。
    expected_total = sum(item["expected"] for item in report["cycles"])
    observed_total = sum(item["observed"] for item in report["cycles"])
    if expected_total and not observed_total:
        return _pending(
            target,
            f"当日行情与 {target} 冻结榜单一只股票也没匹配上"
            f"（{expected_total} 只全部缺当日收盘价，通常是行情字段异常），"
            "不生成全 0 的空报告；已保留日志，待数据源恢复后重试。",
            moment,
        )

    board_meta = board.get("meta") or {}
    if _iso_date(board_meta.get("marketDataDate")) == target:
        # 榜单是收盘后建的：参考价已含当日收盘，日表现恒为 0，不能算"已核验"。
        report["gaps"].append(
            "冻结榜单参考价取自当日收盘，本次日表现无法归因（需使用盘前冻结的榜单）"
        )
        report["status"] = "partial"

    previous = load_report(target)
    retained = report["status"] != "ready" and (previous or {}).get("status") == "ready"
    if retained:
        reason = "本次数据不完整，保留上次完整报告及原始时间。"
        save_attempt(target, {
            "status": "pending",
            "checkedAt": report["generatedAt"],
            "reportId": report["id"],
            "reason": reason,
        })
        logger.info("复盘 %s 本次不完整，保留上一份完整报告", target)
        return {
            "status": "pending",
            "date": target,
            "reportId": (previous or {}).get("id"),
            "reason": reason,
        }

    save_report(report)
    archive_board(board)
    save_attempt(target, {
        "status": report["status"],
        "checkedAt": report["generatedAt"],
        "reportId": report["id"],
        "reason": None,
    })
    logger.info(
        "复盘 %s 已生成：%s，%s",
        target,
        report["status"],
        "；".join(f"{item['cycle']} {item['observed']}/{item['expected']}" for item in report["cycles"]),
    )
    return {"status": "completed", "date": target, "reportId": report["id"]}


def _validate_date(value: str, today: str) -> None:
    """日期必须是合法的 ``YYYY-MM-DD`` 且不晚于今天 —— 未来日期没有收盘价可言。"""
    if len(value) != 10 or value[4] != "-" or value[7] != "-":
        raise ReviewError(f"日期格式应为 YYYY-MM-DD：{value!r}")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise ReviewError(f"无效日期：{value!r}") from exc
    if value > today:
        raise ReviewError(f"不能生成未来日期的复盘：{value}（今天是 {today}）")


def snapshot_payload(date: str) -> dict:
    """``GET /api/review`` 的响应体：报告 + 尝试 + 历史日期。"""
    report = load_report(date)
    if _is_degenerate(report):
        # 旧代码写下的空壳报告（全 0 观测）不再对外，页面会落到空态并给出「立即生成复盘」，
        # 重新生成后正常覆盖 —— 比继续展示一份 0/50 的假报告更诚实。
        logger.warning("复盘 %s 的存档是「一只也没对上」的空报告，已忽略（可重新生成）", date)
        report = None
    return {
        "date": date,
        "report": report,
        "attempt": load_attempt(date),
        "dates": list_dates(),
    }
