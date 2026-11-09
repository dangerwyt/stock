"""概念板块：DC 日线、概念资金与成分股，分开读取并保留数据日期。"""
import asyncio
import time
from datetime import date, timedelta
from app import tushare_client as ts
from app.market_dashboard import _promax, _number, _iso_date

_CACHE = {}
_GATE = asyncio.Semaphore(3)


async def read(api, params, fields):
    key = (api, tuple(sorted(params.items())), fields)
    cached = _CACHE.get(key)
    if cached and time.monotonic() - cached[0] < 300:
        return cached[1]
    async with _GATE:
        rows = await _promax(api, {**params, "limit": 5000}, fields)
    if len(_CACHE) >= 128:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = (time.monotonic(), rows)
    return rows


def dated(rows, day, key="ts_code"):
    if any(str(r.get("trade_date")) != day or not r.get(key) for r in rows):
        raise ValueError("概念数据日期或代码与请求不符")
    if len({r[key] for r in rows}) != len(rows):
        raise ValueError("概念数据存在重复记录")
    return rows


def build_snapshot(day, catalog, daily):
    names = {r["ts_code"]: r for r in dated(catalog, day) if r.get("idx_type") == "概念板块"}
    items = []
    for r in dated(daily, day):
        info = names.get(r["ts_code"])
        price, change = _number(r.get("close")), _number(r.get("pct_change"))
        if not info or price is None or price <= 0 or change is None:
            continue
        items.append({"code": r["ts_code"], "name": info.get("name") or r["ts_code"],
                      "pct": change, "close": price, "amount": _number(r.get("amount")),
                      "turnover": _number(r.get("turnover_rate"))})
    if not items:
        raise ValueError("该交易日暂无可核验的概念行情")
    return {"tradeDate": _iso_date(day), "items": sorted(items, key=lambda r: (-r["pct"], r["code"])),
            "source": "ProMax · DC 概念日线", "catalogCount": len(names), "count": len(items)}


async def snapshot():
    window = ts._data_window()
    catalog_fields = "ts_code,trade_date,name,idx_type"
    daily_fields = "ts_code,trade_date,close,pct_change,amount,turnover_rate"
    async def load(day):
        return await asyncio.gather(read("dc_index", {"trade_date": day, "idx_type": "概念板块"}, catalog_fields),
                                    read("dc_daily", {"trade_date": day, "idx_type": "概念板块"}, daily_fields))
    catalog, daily = await load(window)
    if catalog and daily:
        return build_snapshot(window, catalog, daily)
    # 仅在成功空表时按交易日历查最近三个交易日；失败不伪装成旧日成功。
    start = (date.fromisoformat(window) - timedelta(days=30)).strftime("%Y%m%d")
    calendar = await ts._call("trade_cal", {"exchange": "SSE", "start_date": start, "end_date": window, "is_open": "1"}, "cal_date,is_open")
    days = sorted({str(r["cal_date"]) for r in calendar if r.get("cal_date") and str(r["cal_date"]) < window and str(r.get("is_open")) == "1"}, reverse=True)
    for day in days[:3]:
        catalog, daily = await load(day)
        if catalog and daily:
            return build_snapshot(day, catalog, daily)
    raise ValueError("最近交易日暂无可用的概念行情")


async def flows(day):
    rows = dated(await read("moneyflow_ind_dc", {"trade_date": day, "content_type": "概念"},
                            "trade_date,content_type,ts_code,name,net_amount,net_amount_rate"), day)
    if any(r.get("content_type") != "概念" for r in rows):
        raise ValueError("资金流返回了非概念板块")
    return {"tradeDate": _iso_date(day), "items": [{"code": r["ts_code"], "netAmount": _number(r.get("net_amount")),
            "netRate": _number(r.get("net_amount_rate"))} for r in rows], "unit": "yuan"}


async def history(code, day, days=60):
    start = (date.fromisoformat(day) - timedelta(days=days)).strftime("%Y%m%d")
    rows = await read("dc_daily", {"ts_code": code, "start_date": start, "end_date": day}, "ts_code,trade_date,close,pct_change,amount,turnover_rate")
    if any(r.get("ts_code") != code or not start <= str(r.get("trade_date", "")) <= day for r in rows):
        raise ValueError("概念历史行情代码或日期不符")
    if len({r.get("trade_date") for r in rows}) != len(rows):
        raise ValueError("概念历史行情存在重复日期")
    points = [{"date": _iso_date(r["trade_date"]), "close": _number(r.get("close")), "pct": _number(r.get("pct_change"))} for r in rows]
    if any(p["close"] is None or p["close"] <= 0 for p in points):
        raise ValueError("概念历史行情存在无效价格")
    return {"code": code, "tradeDate": _iso_date(day), "points": sorted(points, key=lambda p: p["date"])}


async def members(code, day):
    rows = dated(await read("dc_member", {"ts_code": code, "trade_date": day}, "trade_date,ts_code,con_code,name"), day, "con_code")
    if any(r.get("ts_code") != code for r in rows):
        raise ValueError("成分股所属概念不符")
    quote_state = "ready"
    try:
        daily = await asyncio.wait_for(ts.fetch_daily_rows(day), timeout=20)
        quotes = {r["ts_code"]: r for r in daily if str(r.get("trade_date")) == day}
    except (ts.TushareError, asyncio.TimeoutError):
        quotes, quote_state = {}, "unavailable"
    items = []
    for r in rows:
        q = quotes.get(r["con_code"], {})
        items.append({"code": r["con_code"].split(".")[0], "name": r.get("name") or r["con_code"],
                      "pct": _number(q.get("pct_chg")), "close": _number(q.get("close")),
                      "amount": _number(q.get("amount")) * 1000 if _number(q.get("amount")) is not None else None})
    return {"code": code, "tradeDate": _iso_date(day), "items": items, "quoteState": quote_state,
            "quotedCount": sum(r["pct"] is not None for r in items)}
