"""验证自选复用日线、日期对齐与接口失败降级；不访问外部服务。"""
import asyncio
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import tushare_client as client


async def main():
    calls = []
    daily = [{"trade_date": "20261105", "open": 10, "close": 11, "high": 12, "low": 9, "pct_chg": 10, "amount": 100},
             {"trade_date": "20261104", "open": 9, "close": 10, "high": 11, "low": 8}]
    basic = [{"trade_date": "20261104", "volume_ratio": 99}]
    async def fake(api, params, fields):
        calls.append(api)
        return {"stock_basic": [{"name": "测试股票"}], "daily": daily, "daily_basic": basic}[api]

    with patch.object(client, "_call", fake):
        quote = await client._build_stock_snapshot("000001.SZ", "000001")
        assert quote["tradeDate"] == "20261105" and quote["close"] == 11
        assert [r["date"] for r in quote["history"]] == ["20261104", "20261105"]
        assert quote["volumeRatio"] is None, "不能将前一日量比拼入当前日行情"
        assert len(calls) == 3, "历史日线不新增上游请求"
        basic.append({"trade_date": "20261105", "volume_ratio": 0, "turnover_rate": 2})
        quote = await client._build_stock_snapshot("000001.SZ", "000001")
        assert quote["volumeRatio"] == 0 and quote["turnoverRate"] == 2
        daily.clear()
        quote = await client._build_stock_snapshot("000001.SZ", "000001")
        assert quote["history"] == [] and quote["tradeDate"] is None and quote["close"] is None
    print("PASS: history reused, dates aligned, zero preserved, missing quotes stay empty")


asyncio.run(main())
