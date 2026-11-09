"""离线验证历史接口漏行补查；在 backend 运行环境执行，不调用外部接口。"""
import asyncio
from datetime import date, timedelta
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.quant_tools import _backtest, QuantError


async def main():
    dates = [(date(2025, 1, 1) + timedelta(days=i)).strftime("%Y%m%d") for i in range(5)]
    daily = [{"ts_code": "000001.SZ", "trade_date": d, "open": 10, "close": 11} for d in dates]
    calls = []
    mismatch = False
    async def fake_call(api, params, fields):
        calls.append((api, params))
        if api == "daily":
            return daily
        if "trade_date" in params:
            return [{"ts_code": "bad" if mismatch else "000001.SZ", "trade_date": params["trade_date"], "adj_factor": 1}]
        return [{"ts_code": "000001.SZ", "trade_date": d, "adj_factor": 1} for d in dates if d != dates[2]]

    body = {"strategyId": "buy_hold", "startDate": "2025-01-01", "endDate": "2025-01-05"}
    with patch("app.quant_tools.tushare_client._call", fake_call):
        result = await _backtest({"code": "000001", "tsCode": "000001.SZ"}, body)
        assert result["sampleCount"] == 5 and result["entries"] == 1
        assert len(calls) == 3 and calls[-1][1]["trade_date"] == dates[2]
        mismatch = True
        try:
            await _backtest({"code": "000001", "tsCode": "000001.SZ"}, body)
        except QuantError as exc:
            assert "日期与请求不符" in str(exc)
        else:
            raise AssertionError("Incorrect stock accepted during repair")
    print("PASS: missing adjustment repaired by date; mismatched response rejected")


asyncio.run(main())
