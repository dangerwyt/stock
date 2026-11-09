"""全市场日线与 ProMax 指数、涨跌停、连板快照；各区块保留自己的数据日期。"""
import asyncio
import logging
from datetime import datetime, timezone
from math import isfinite
import time
from zoneinfo import ZoneInfo

_INDICES = [("000001.SH", "上证指数"), ("399001.SZ", "深证成指"),
            ("399006.SZ", "创业板指"), ("000688.SH", "科创50")]
_INDEX_CACHE = {}
_INDEX_LOCK = asyncio.Lock()
_SUPPLEMENT_CACHE = {}
_SUPPLEMENT_LOCK = asyncio.Lock()
logger = logging.getLogger(__name__)


async def fetch_indices(trade_date):
    from app import tushare_client

    async def fetch_one(code, name):
        quote = {"code": code, "name": name, "price": None, "pctChg": None,
                 "tradeDate": _iso_date(trade_date), "session": "daily_close"}
        try:
            rows = await tushare_client._call(
                "index_daily", {"ts_code": code, "start_date": trade_date, "end_date": trade_date},
                "ts_code,trade_date,close,pct_chg",
            )
            row = next((r for r in rows if r.get("ts_code") == code
                        and str(r.get("trade_date")) == trade_date), {})
            price = _number(row.get("close"))
            if price is not None and price > 0:
                quote.update(price=price, pctChg=_number(row.get("pct_chg")))
        except tushare_client.TushareError:
            pass
        return quote

    # 日线按行情日复用，避免页面轮询重复消耗指数接口额度。
    async with _INDEX_LOCK:
        if trade_date in _INDEX_CACHE:
            return _INDEX_CACHE[trade_date]
        quotes = await asyncio.gather(*(fetch_one(code, name) for code, name in _INDICES))
        if all(q["price"] is not None and q["pctChg"] is not None for q in quotes):
            _INDEX_CACHE.clear()
            _INDEX_CACHE[trade_date] = quotes
        return quotes


def _iso_date(value):
    return f"{value[:4]}-{value[4:6]}-{value[6:8]}"


async def _promax(api, params, fields):
    """保留业务状态检查，不把部分结果或失败空表当成完整行情。"""
    import httpx
    from app.config import settings

    if not settings.tushare_fallback_url or not settings.tushare_fallback_api_key:
        raise ValueError("ProMax unavailable")
    async with httpx.AsyncClient(timeout=30, verify=settings.tushare_verify_ssl,
                                 follow_redirects=False) as client:
        response = await client.get(
            f"{settings.tushare_fallback_url.rstrip('/')}/{api}",
            params={**params, "fields": fields},
            headers={"X-API-Key": settings.tushare_fallback_api_key},
        )
    response.raise_for_status()
    return _promax_rows(response.json(), int(params["limit"]))


def _promax_rows(body, limit):
    if not isinstance(body, dict) or type(body.get("code")) is not int or body["code"] != 0:
        raise ValueError("ProMax business error")
    meta = body.get("meta") or {}
    if not isinstance(meta, dict) or any(meta.get(k) for k in ("pending", "backfill_pending", "partial")):
        raise ValueError("ProMax incomplete result")
    data = body.get("data") or {}
    if not isinstance(data, dict):
        raise ValueError("ProMax invalid table")
    fields, items = data.get("fields"), data.get("items")
    if (not isinstance(fields, list) or not fields or not all(isinstance(f, str) for f in fields)
            or len(set(fields)) != len(fields) or not isinstance(items, list)
            or len(items) >= limit
            or any(not isinstance(row, list) or len(row) != len(fields) for row in items)):
        raise ValueError("ProMax invalid or possibly truncated table")
    return [dict(zip(fields, row)) for row in items]


def _dated_unique(rows, trade_date):
    if any(str(row.get("trade_date")) != trade_date or not row.get("ts_code") for row in rows):
        raise ValueError("ProMax date mismatch")
    return {row["ts_code"]: row for row in rows}.values()


async def fetch_supplement(trade_date):
    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d")
    key = (trade_date, today)
    async with _SUPPLEMENT_LOCK:
        cached = _SUPPLEMENT_CACHE.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]

        async def index(code, name):
            try:
                rows = await _promax("rt_idx_k", {"ts_code": code, "limit": 20},
                                     "ts_code,trade_time,close,pre_close")
                row = next(r for r in rows if r.get("ts_code") == code)
                day = str(row.get("trade_time") or "")[:10].replace("-", "")
                price, previous = _number(row.get("close")), _number(row.get("pre_close"))
                if day != today or price is None or previous is None or min(price, previous) <= 0:
                    raise ValueError("No current index quote")
                return {"code": code, "name": name, "price": price,
                        "pctChg": (price / previous - 1) * 100,
                        "tradeDate": _iso_date(day), "session": "intraday",
                        "timePrecision": "date", "provider": "ProMax rt_idx_k"}
            except Exception as exc:
                # 独立降级到明确标注日期的日线，不影响其它指数和全市场快照。
                logger.warning("ProMax rt_idx_k %s unavailable (%s)", code, type(exc).__name__)
                return None

        async def limits(kind):
            result = {"count": None, "tradeDate": _iso_date(trade_date), "status": "unavailable",
                      "scope": "non_st", "provider": "ProMax limit_list_d"}
            try:
                # limit_list_d 不含 ST，官方单页上限 2500；不能把它标成全市场涨跌停数。
                rows = await _promax("limit_list_d", {"trade_date": trade_date, "limit_type": kind, "limit": 2500},
                                     "ts_code,trade_date,name,limit")
                valid = list(_dated_unique(rows, trade_date))
                if any(row.get("limit") != kind or "ST" in str(row.get("name") or "").upper() for row in valid):
                    raise ValueError("Limit pool scope mismatch")
                result.update(count=len(valid), status="ready")
            except Exception as exc:
                logger.warning("ProMax limit_list_d %s unavailable (%s)", kind, type(exc).__name__)
            return result

        async def ladder():
            result = {"tradeDate": _iso_date(trade_date), "status": "unavailable", "highest": None, "levels": []}
            try:
                rows = await _promax("limit_step", {"trade_date": trade_date, "limit": 10000},
                                     "ts_code,name,trade_date,nums")
                stocks = []
                for row in _dated_unique(rows, trade_date):
                    level = _number(row.get("nums"))
                    if level is None or level < 1 or not level.is_integer():
                        raise ValueError("Invalid ladder level")
                    stocks.append({"code": row["ts_code"].split(".")[0],
                                   "name": str(row.get("name") or row["ts_code"]), "boards": int(level)})
                if stocks:
                    result.update(status="ready", highest=max(s["boards"] for s in stocks), levels=[
                        {"level": level, "count": sum(s["boards"] >= 5 if level == 5 else s["boards"] == level for s in stocks),
                         "stocks": [s for s in stocks if (s["boards"] >= 5 if level == 5 else s["boards"] == level)]}
                        for level in (5, 4, 3, 2)])
            except Exception as exc:
                logger.warning("ProMax limit_step unavailable (%s)", type(exc).__name__)
            return result

        results = await asyncio.gather(*(index(code, name) for code, name in _INDICES), limits("U"), limits("D"), ladder())
        indices = results[:4]
        if any(q is None for q in indices):
            daily = await fetch_indices(trade_date)
            indices = [q if q is not None else daily[i] for i, q in enumerate(indices)]
        payload = {"indices": indices, "limitUp": results[4], "limitDown": results[5], "ladder": results[6]}
        _SUPPLEMENT_CACHE.clear()
        _SUPPLEMENT_CACHE[key] = (time.monotonic(), payload)
        return payload


def _number(value):
    try:
        number = float(value)
        return number if isfinite(number) else None
    except (ValueError, TypeError):
        return None


def build_snapshot(trade_date, rows, universe):
    names = {item["tsCode"]: item for item in universe if item.get("tsCode")}
    quotes = {}
    for row in rows:
        ts_code = str(row.get("ts_code") or "")
        # 不混入其它交易日，也不把缺失价格变成零。
        if not ts_code or str(row.get("trade_date")) != trade_date:
            continue
        price = _number(row.get("close"))
        if price is None or price <= 0:
            continue
        stock = names.get(ts_code, {})
        quotes[ts_code] = {
            "tsCode": ts_code, "code": ts_code.split(".")[0],
            "name": stock.get("name") or ts_code.split(".")[0],
            "industry": stock.get("industry") or "行业未分类",
            "price": price, "open": _number(row.get("open")),
            "high": _number(row.get("high")), "low": _number(row.get("low")),
            "preClose": _number(row.get("pre_close")),
            "pctChg": _number(row.get("pct_chg")),
            "amount": _number(row.get("amount")), "amountUnit": "thousand_yuan",
        }
    return {
        "meta": {
            "tradeDate": f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:8]}",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sourceMode": "live", "provider": "Tushare daily",
            "session": "daily_close", "scope": "all", "rowCount": len(quotes),
            "status": "ready" if quotes else "unavailable",
        },
        "quotes": list(quotes.values()),
    }
