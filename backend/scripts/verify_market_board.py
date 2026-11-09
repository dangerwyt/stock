"""离线运行：python backend/scripts/verify_market_board.py。"""
import sys
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.market_dashboard import build_snapshot
from app import market_dashboard

rows = [
    {"ts_code": "000001.SZ", "trade_date": "20261105", "close": 12, "pct_chg": 0, "amount": 125},
    {"ts_code": "000002.SZ", "trade_date": "20261104", "close": 20},
    {"ts_code": "000003.SZ", "trade_date": "20261105", "close": None},
    {"ts_code": "000004.SZ", "trade_date": "20261105", "close": float("nan")},
    {"ts_code": "000005.SZ", "trade_date": "20261105", "close": 10, "pct_chg": float("inf")},
]
names = [{"tsCode": "000001.SZ", "name": "平安银行", "industry": "银行"}]
snapshot = build_snapshot("20261105", rows, names)
assert snapshot["meta"]["tradeDate"] == "2026-11-05"
assert snapshot["meta"]["scope"] == "all"
assert len(snapshot["quotes"]) == 2
quote = snapshot["quotes"][0]
assert quote["pctChg"] == 0
assert quote["amount"] == 125 and quote["amountUnit"] == "thousand_yuan"
assert quote["name"] == "平安银行" and quote["industry"] == "银行"
assert snapshot["quotes"][1]["pctChg"] is None
assert build_snapshot("20261105", rows, [])["quotes"][0]["name"] == "000001"
assert build_snapshot("20261106", rows, names)["meta"]["status"] == "unavailable"
assert "amountUnit" not in rows[0]
assert len(build_snapshot("20261105", rows + [rows[0]], names)["quotes"]) == 2
print("市场看板：日期隔离、数值校验、金额单位、缺失分类、去重及原始数据保护均通过")


async def verify_indices():
    async def response(api, params, fields):
        return [{"ts_code": params["ts_code"], "trade_date": params["start_date"],
                 "close": 3000, "pct_chg": 0}]
    call = AsyncMock(side_effect=response)
    client = SimpleNamespace(_call=call, TushareError=RuntimeError)
    with patch.dict(sys.modules, {"app.tushare_client": client}):
        first = await market_dashboard.fetch_indices("20261105")
        assert len(first) == 4 and all(q["pctChg"] == 0 for q in first)
        await market_dashboard.fetch_indices("20261105")
        assert call.call_count == 4
        call.side_effect = None
        call.return_value = [{"ts_code": "000001.SH", "trade_date": "20261105", "close": 999}]
        wrong_date = await market_dashboard.fetch_indices("20261106")
        assert all(q["price"] is None for q in wrong_date)
        call.side_effect = RuntimeError("unavailable")
        failed = await market_dashboard.fetch_indices("20261107")
        assert all(q["price"] is None for q in failed)
        assert "20261107" not in market_dashboard._INDEX_CACHE
    market_dashboard._INDEX_CACHE.clear()


asyncio.run(verify_indices())
print("Index cache, zero change, date matching and failure handling passed")


def verify_promax_tables():
    valid = {"code": 0, "data": {"fields": ["ts_code"], "items": [["000001.SZ"]]}}
    assert market_dashboard._promax_rows(valid, 20) == [{"ts_code": "000001.SZ"}]
    for body, limit in [(dict(valid, code=503), 20), (dict(valid, meta={"partial": True}), 20),
                        (dict(valid, meta={"pending": True}), 20), (valid, 1),
                        (dict(valid, data={"fields": ["a", "b"], "items": [[1]]}), 20)]:
        try:
            market_dashboard._promax_rows(body, limit)
        except ValueError:
            pass
        else:
            raise AssertionError("Failed / partial / truncated result accepted")


async def verify_supplement():
    async def response(api, params, fields):
        if api == "rt_idx_k":
            if params["ts_code"] == "000688.SH":
                return [{"ts_code": "000688.SH", "trade_time": "20261105", "close": 100, "pre_close": 100}]
            return [{"ts_code": params["ts_code"], "trade_time": "20261106", "close": 110, "pre_close": 100}]
        if api == "limit_list_d":
            if params["limit_type"] == "D":
                raise ValueError("partial")
            row = {"ts_code": "000001.SZ", "trade_date": "20261105", "name": "平安银行", "limit": "U"}
            return [row, row]
        return [{"ts_code": f"{i:06}.SZ", "name": str(i), "trade_date": "20261105", "nums": str(level)}
                for i, level in enumerate([1, 2, 2, 3, 4, 5, 7])]

    fallback = [{"code": code, "price": 99, "pctChg": 0, "tradeDate": "2026-11-05", "session": "daily_close"}
                for code, name in market_dashboard._INDICES]
    with patch.object(market_dashboard, "datetime") as clock, \
            patch.object(market_dashboard, "_promax", AsyncMock(side_effect=response)) as call, \
            patch.object(market_dashboard, "fetch_indices", AsyncMock(return_value=fallback)):
        clock.now.return_value = datetime(2026, 11, 6, tzinfo=timezone.utc)
        result = await market_dashboard.fetch_supplement("20261105")
        assert result["indices"][0]["tradeDate"] == "2026-11-06"
        assert abs(result["indices"][0]["pctChg"] - 10) < 1e-9
        assert result["indices"][3]["session"] == "daily_close"
        assert result["indices"][3]["tradeDate"] == "2026-11-05"
        assert result["limitUp"]["count"] == 1
        assert result["limitUp"]["scope"] == "non_st"
        assert result["limitDown"]["count"] is None
        assert result["ladder"]["highest"] == 7
        assert [level["count"] for level in result["ladder"]["levels"]] == [2, 1, 1, 2]
        await market_dashboard.fetch_supplement("20261105")
        assert call.call_count == 7
        market_dashboard._SUPPLEMENT_CACHE.clear()
        call.side_effect = None
        call.return_value = [{"ts_code": "000001.SZ", "trade_date": "20261104", "nums": 8}]
        stale = await market_dashboard.fetch_supplement("20261105")
        assert stale["limitUp"]["count"] is None and stale["ladder"]["highest"] is None
        for row in [{"ts_code": "000001.SZ", "trade_date": "20261105", "limit": "Z"},
                    {"ts_code": "000001.SZ", "trade_date": "20261105", "limit": "U", "name": "*ST测试"}]:
            market_dashboard._SUPPLEMENT_CACHE.clear()
            call.return_value = [row]
            mismatched = await market_dashboard.fetch_supplement("20261105")
            assert mismatched["limitUp"]["count"] is None
        market_dashboard._SUPPLEMENT_CACHE.clear()
        call.return_value = []
        empty = await market_dashboard.fetch_supplement("20261105")
        assert empty["limitUp"]["count"] == 0 and empty["ladder"]["status"] == "unavailable"
    market_dashboard._SUPPLEMENT_CACHE.clear()


verify_promax_tables()
asyncio.run(verify_supplement())
print("ProMax status, truncation, independent dates, fallback, limit counts, ladder and TTL passed")
