"""后端运行环境离线验证：基础行情不得等待补充接口。"""
import asyncio
from datetime import date
from unittest.mock import AsyncMock, patch
from app.routers import snapshots


async def main():
    rows = [{"ts_code": "000001.SZ", "trade_date": "20261105", "close": 12}]
    blocked = asyncio.Event()
    async def slow(day):
        await blocked.wait()
        return {"indices": [], "ladder": {"status": "unavailable"}}
    supplement = AsyncMock(side_effect=slow)
    with patch.object(snapshots.tushare_client, "_latest_market_trade_date", AsyncMock(return_value=("20261105", rows))), \
         patch.object(snapshots.tushare_client, "_stock_basic_universe", AsyncMock(return_value=[])), \
         patch.object(snapshots.market_dashboard, "fetch_supplement", supplement):
        payload = await asyncio.wait_for(snapshots.market(scope="all", supplement=False), .5)
        assert len(payload["quotes"]) == 1
        supplement.assert_not_awaited()
        task = asyncio.create_task(snapshots.market_supplement(date(2026, 11, 5)))
        await asyncio.sleep(0)
        assert not task.done()
        again = await asyncio.wait_for(snapshots.market(scope="all", supplement=False), .5)
        assert again["meta"]["tradeDate"] == "2026-11-05"
        blocked.set()
        extra = await task
        assert extra["tradeDate"] == "2026-11-05" and "quotes" not in extra
        combined = await snapshots.market(scope="all")
        assert "indices" in combined and combined["quotes"] == payload["quotes"]
    print("PASS: base market independent of slow supplement; split date and old API compatibility")


asyncio.run(main())
