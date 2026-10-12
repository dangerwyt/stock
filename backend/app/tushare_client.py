"""Tushare 实时行情客户端。

对齐原 reference-react（worker/index.js）的 Tushare 链路：

* 股票搜索用 ``stock_basic`` 拉全市场股票池（按用户要求「必须实时」，不回落 fixtures）；
* 选中股票做分析时，用代码实时拉 ``stock_basic`` + ``daily`` + ``daily_basic``，
  丢弃前端传来的行情（原项目明确标注浏览器给的名称/价格/行业 "not evidence"）。

策略（用户决策）：**必须实时**。``TUSHARE_TOKEN`` 缺失或调用失败时抛 ``TushareError``，
由调用方转成明确的 503 报错，而不是悄悄退回假数据。
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# 全市场股票池缓存时长。原项目也是缓存 24h（state_store expirationTtl=24*3600），
# 这里用进程内 TTL 缓存，避免每次搜索都打一次 stock_basic（5000+ 行，容易被限流）。
_UNIVERSE_TTL_SECONDS = 24 * 3600
_UNIVERSE: dict[str, Any] = {"at": 0.0, "data": None}
_UNIVERSE_LOCK = asyncio.Lock()


class TushareError(RuntimeError):
    """Tushare 未配置或调用失败。

    按「必须实时」策略，调用方应把它转成明确报错（如 503），**不要**回落到 fixtures 假数据。
    """


def _to_ts_code(code: str) -> str:
    """6 位 A 股代码 → Tushare ts_code（带交易所后缀）。"""
    code = (code or "").strip()
    if code.endswith((".SH", ".SZ", ".BJ")):
        return code
    if len(code) != 6 or not code.isdigit():
        raise TushareError(f"无效的 A 股代码：{code!r}")
    head = code[0]
    if head in ("6", "9"):
        return f"{code}.SH"
    if head in ("0", "3"):
        return f"{code}.SZ"
    if head in ("4", "8"):
        return f"{code}.BJ"
    return f"{code}.SH"


def _compact(date_str: str) -> str:
    """2026-10-10 → 20261010。"""
    return date_str.replace("-", "")


def _num(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _err_msg(body: Any) -> str | None:
    """从错误响应体里取可读原因，兼容主源(msg)与 B 套(message/error)两种形态。"""
    if not isinstance(body, dict):
        return None
    return body.get("msg") or body.get("message") or body.get("error") or None


def _parse_rows(data: Any, status_code: int, raw_text: str = "") -> list[dict]:
    """把 ``{code,data:{fields,items}}`` 响应体解析成字段名→值的 dict 列表。

    主源(relay A)与 B 套(ProMax)返回体同构，故两处共用这一份解析。
    """
    if not isinstance(data, dict):
        raise TushareError(
            f"Tushare 返回非 JSON 响应（HTTP {status_code}）：{(raw_text or '')[:150]}"
        )
    code = data.get("code")
    if code not in (0, None):
        raise TushareError(f"Tushare 返回错误 code={code} msg={_err_msg(data)}")
    rows = data.get("data") or {}
    field_list = rows.get("fields") or []
    items = rows.get("items") or []
    return [dict(zip(field_list, item)) for item in items]


async def _post_primary(
    api_name: str, params: dict, fields: str, timeout: float
) -> list[dict]:
    """主源(relay A)：POST 到 ``tushare_api_url``，body 里带 token。"""
    payload = {
        "api_name": api_name,
        "token": settings.tushare_token,
        "params": params,
        "fields": fields,
    }
    try:
        async with httpx.AsyncClient(
            timeout=timeout, verify=settings.tushare_verify_ssl
        ) as client:
            resp = await client.post(settings.tushare_api_url, json=payload)
    except httpx.HTTPError as exc:
        raise TushareError(f"请求失败（{type(exc).__name__}）：{exc}") from exc

    # 中继把业务错误放在 body 里，但**外层 HTTP 可能是 200 也可能是 401/403**：
    #   200 + {"code":401,"msg":"[unauthorized] 调用Token缺失、无效或已过期"}
    #   401 + {"ok":false,"error":"unauthorized","message":"..."}
    # 所以不能只靠 raise_for_status——否则 401 会被包成没营养的 HTTPStatusError，
    # 真正的原因（token 失效）反而看不到。先把 body 解出来，两种形态都取 msg/message。
    try:
        data = resp.json()
    except ValueError:
        data = None

    if resp.status_code >= 400:
        reason = _err_msg(data)
        detail = f"：{reason}" if reason else f"：{resp.text[:150]}"
        raise TushareError(f"HTTP {resp.status_code}{detail}")
    return _parse_rows(data, resp.status_code, resp.text)


async def _get_fallback(
    api_name: str, params: dict, fields: str, timeout: float
) -> list[dict]:
    """B 套「ProMax 接口聚合」：GET ``{fallback_url}/{api_name}`` + 查询参数 + ``X-API-Key`` 头。

    对齐 reference-react ``tushareQuery`` 的回落分支：参数走 query string，
    ``fields`` 也是 query 参数（不是 body）；鉴权用头，不是 token。
    """
    base = settings.tushare_fallback_url.rstrip("/")
    query: dict[str, str] = {k: str(v) for k, v in (params or {}).items()}
    if fields:
        query["fields"] = fields
    try:
        async with httpx.AsyncClient(
            timeout=timeout, verify=settings.tushare_verify_ssl
        ) as client:
            resp = await client.get(
                f"{base}/{api_name}",
                params=query,
                headers={"X-API-Key": settings.tushare_fallback_api_key},
            )
    except httpx.HTTPError as exc:
        raise TushareError(f"请求失败（{type(exc).__name__}）：{exc}") from exc

    try:
        data = resp.json()
    except ValueError:
        data = None

    if resp.status_code >= 400:
        reason = _err_msg(data)
        detail = f"：{reason}" if reason else f"：{resp.text[:150]}"
        raise TushareError(f"HTTP {resp.status_code}{detail}")
    return _parse_rows(data, resp.status_code, resp.text)


# 全市场批量接口（trade_cal / 不带 ts_code 的 daily、daily_basic）在 B 套上会慢很多，
# 对话式单股查询仍用原来的短超时。与 reference-react 的 60s/25s 分档一致。
_BULK_APIS = ("trade_cal", "daily", "daily_basic")


async def _call(
    api_name: str,
    params: dict,
    fields: str,
    *,
    timeout: float = 25.0,
) -> list[dict]:
    """调用一次 Tushare HTTP 接口，返回字段名→值的 dict 列表。

    回落顺序对齐 reference-react ``tushareQuery``：
      ① 主源 relay A（POST + ``TUSHARE_TOKEN``）
      ② B 套 ProMax（GET + ``X-API-Key``，需配置 ``TUSHARE_FALLBACK_*``）
    两条都失败才抛 ``TushareError``（由调用方转 503），**全程不回落 fixtures 假数据**。
    """
    errors: list[str] = []
    if settings.tushare_token:
        try:
            return await _post_primary(api_name, params, fields, timeout)
        except TushareError as exc:
            errors.append(f"主源: {exc}")
            logger.warning("Tushare 主源失败，尝试 B 套备用：%s", exc)
    if settings.tushare_fallback_url and settings.tushare_fallback_api_key:
        fb_timeout = (
            60.0
            if api_name in _BULK_APIS and not (params or {}).get("ts_code")
            else timeout
        )
        try:
            return await _get_fallback(api_name, params, fields, fb_timeout)
        except TushareError as exc:
            errors.append(f"备用: {exc}")
    raise TushareError(
        "；".join(errors)
        or "TUSHARE_TOKEN 未配置：按「必须实时」策略拒绝回落假数据，请在 .env 填入后重试。"
    )


async def _stock_basic_universe() -> list[dict]:
    """全市场股票基础信息池（缓存 24h）。"""
    now = time.time()
    cached = _UNIVERSE["data"]
    if cached is not None and now - _UNIVERSE["at"] < _UNIVERSE_TTL_SECONDS:
        return cached
    async with _UNIVERSE_LOCK:
        cached = _UNIVERSE["data"]
        if cached is not None and time.time() - _UNIVERSE["at"] < _UNIVERSE_TTL_SECONDS:
            return cached
        rows = await _call(
            "stock_basic",
            {"list_status": "L"},
            "ts_code,symbol,name,industry,market,list_date",
        )
        items = [
            {
                "code": (r.get("symbol") or str(r.get("ts_code") or "")[:6]).strip(),
                "tsCode": r.get("ts_code"),
                "name": r.get("name") or "",
                "industry": r.get("industry") or "行业待映射",
                "market": r.get("market") or None,
                "listDate": r.get("list_date") or None,
            }
            for r in rows
            if r.get("symbol") or r.get("ts_code")
        ]
        _UNIVERSE["data"] = items
        _UNIVERSE["at"] = time.time()
        return items


async def search_stock_basic(query: str, limit: int = 20) -> list[dict]:
    """按代码/名称模糊搜索全市场 A 股（实时，无 fixtures 回落）。"""
    universe = await _stock_basic_universe()
    q = (query or "").strip().lower()
    if not q:
        return universe[:limit]
    return [
        it
        for it in universe
        if q in it["code"].lower() or q in str(it["name"]).lower()
    ][:limit]


async def get_stock_snapshot(code: str) -> dict:
    """为选中股票实时拉 name/industry + 当日行情 + 估值。

    返回「纯行情快照」，不含 TOP50 排名/因子（那些来自 fixtures 持仓池，由调用方叠加）。
    前端传来的名称/价格一律不采用——只信 6 位代码，其余从 Tushare 重查。
    """
    ts_code = _to_ts_code(code)
    end = datetime.now()
    start = end - timedelta(days=40)
    start_s = _compact(start.strftime("%Y-%m-%d"))
    end_s = _compact(end.strftime("%Y-%m-%d"))

    basics, daily, daily_basic = await asyncio.gather(
        _call("stock_basic", {"ts_code": ts_code, "list_status": "L"},
              "ts_code,symbol,name,industry,market,list_date"),
        _call("daily", {"ts_code": ts_code, "start_date": start_s, "end_date": end_s},
              "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount"),
        _call("daily_basic", {"ts_code": ts_code, "start_date": start_s, "end_date": end_s},
              "ts_code,trade_date,turnover_rate,volume_ratio,pe_ttm,pb,total_mv,circ_mv"),
        return_exceptions=True,
    )

    # 基础信息都拿不到（通常网络/鉴权失败），按「必须实时」直接报错，不编造。
    if isinstance(basics, Exception):
        raise TushareError(f"Tushare 获取基础信息失败：{basics}")

    name = industry = None
    if basics:
        b0 = basics[0]
        name = b0.get("name")
        industry = b0.get("industry")

    # 所有数值字段先置 None，避免 KeyError；拉不到时 _stock_block 会自然跳过。
    snap: dict[str, Any] = {
        "code": (code or "").strip(),
        "tsCode": ts_code,
        "name": name or "",
        "industry": industry or "行业待映射",
        "close": None, "pct": None, "open": None, "high": None,
        "low": None, "preClose": None, "turnoverRate": None,
        "volumeRatio": None, "peTtm": None, "pb": None,
    }

    if not isinstance(daily, Exception) and daily:
        last = sorted(daily, key=lambda x: str(x.get("trade_date") or ""), reverse=True)[0]
        snap["close"] = _num(last.get("close"))
        snap["pct"] = _num(last.get("pct_chg"))
        snap["open"] = _num(last.get("open"))
        snap["high"] = _num(last.get("high"))
        snap["low"] = _num(last.get("low"))
        snap["preClose"] = _num(last.get("pre_close"))

    if not isinstance(daily_basic, Exception) and daily_basic:
        last = sorted(daily_basic, key=lambda x: str(x.get("trade_date") or ""), reverse=True)[0]
        snap["turnoverRate"] = _num(last.get("turnover_rate"))
        snap["volumeRatio"] = _num(last.get("volume_ratio"))
        snap["peTtm"] = _num(last.get("pe_ttm"))
        snap["pb"] = _num(last.get("pb"))

    if snap["close"] is None and not name:
        raise TushareError(f"Tushare 未返回该股票的有效数据：{code}（{ts_code}）")
    return snap


async def _latest_market_trade_date(days_back: int = 30, tries: int = 8) -> tuple[str, list[dict]]:
    """返回最近一个「有全市场行情数据」的交易日（YYYYMMDD）及其 daily 行。

    用 ``trade_cal`` 列出近 N 个交易日，从最新往前试 ``daily``，取第一个 ≥50 行的
    日期（含节假日/盘中未出数据的情况都能自愈）。
    """
    end = datetime.now()
    start = end - timedelta(days=days_back)
    cal = await _call(
        "trade_cal",
        {
            "exchange": "SSE",
            "start_date": _compact(start.strftime("%Y-%m-%d")),
            "end_date": _compact(end.strftime("%Y-%m-%d")),
            "is_open": "1",
        },
        "cal_date,is_open",
    )
    dates = sorted({str(r.get("cal_date")) for r in cal if r.get("cal_date")}, reverse=True)
    for d in dates[:tries]:
        try:
            rows = await _call(
                "daily",
                {"trade_date": d},
                "ts_code,open,high,low,close,pre_close,pct_chg,vol,amount",
            )
        except TushareError:
            continue
        if len(rows) >= 50:
            return d, rows
    raise TushareError("无法取得最近交易日的全市场行情（daily 为空或不足 50 行）")


async def is_market_open(date_str: str) -> bool:
    """查 ``trade_cal`` 判断某日是否 A 股交易日。

    ``date_str`` 接受 ``YYYY-MM-DD`` 或 ``YYYYMMDD``。对应 reference-react 的
    ``detectTradingDay``：交易日历不可用时**不要**在这里回落近似值 —— 由调用方决定
    （抛 ``TushareError`` 让调度退到"周末即休市"的近似）。
    """
    compact = _compact(date_str)
    cal = await _call(
        "trade_cal",
        {"exchange": "SSE", "start_date": compact, "end_date": compact},
        "cal_date,is_open",
    )
    for row in cal:
        if str(row.get("cal_date")) == compact:
            return str(row.get("is_open")) == "1"
    return False


async def fetch_top50_universe() -> tuple[list[dict], str]:
    """拉 TOP50 量化引擎的输入：最近交易日全市场 daily + daily_basic + stock_basic。

    对齐 reference-react ``collectTop50Job``：按 ``ts_code`` 合并三张表，只保留三表
    齐全的股票，返回 (rows, trade_date)。字段名与引擎/hydrateStock 契约一致。
    """
    trade_date, daily = await _latest_market_trade_date()
    basics = await _call(
        "daily_basic",
        {"trade_date": trade_date},
        "ts_code,trade_date,turnover_rate,volume_ratio,pe_ttm,pb,total_mv,circ_mv",
    )
    basic_by = {r.get("ts_code"): r for r in basics if r.get("ts_code")}
    universe = await _stock_basic_universe()
    name_by = {it.get("tsCode"): it for it in universe}

    merged: list[dict] = []
    for r in daily:
        ts = r.get("ts_code")
        b = basic_by.get(ts)
        n = name_by.get(ts)
        if not b or not n:
            continue
        merged.append(
            {
                "ts_code": ts,
                "name": n.get("name"),
                "industry": n.get("industry"),
                "list_date": n.get("listDate"),
                "open": r.get("open"),
                "high": r.get("high"),
                "low": r.get("low"),
                "close": r.get("close"),
                "pre_close": r.get("pre_close"),
                "pct_chg": r.get("pct_chg"),
                "amount": r.get("amount"),
                "turnover_rate": b.get("turnover_rate"),
                "volume_ratio": b.get("volume_ratio"),
                "pe_ttm": b.get("pe_ttm"),
                "pb": b.get("pb"),
                "total_mv": b.get("total_mv"),
                "circ_mv": b.get("circ_mv"),
            }
        )
    if len(merged) < 50:
        raise TushareError(f"TOP50 输入有效标的不足 50 只（{len(merged)}）")
    return merged, trade_date


def invalidate_universe_cache() -> None:
    """测试或强制刷新时清空股票池缓存。"""
    _UNIVERSE["data"] = None
    _UNIVERSE["at"] = 0.0
