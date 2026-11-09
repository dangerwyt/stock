"""后端运行环境离线验证日线窗口，禁止盘中先探测未落库的今日行情。"""
import asyncio
from unittest.mock import AsyncMock, patch
from app import tushare_client as t


async def verify(window, expected):
    async def call(api, params, fields):
        if api == 'trade_cal':
            await asyncio.sleep(.01)
            return [{'cal_date': '20261106'}, {'cal_date': '20261105'}]
        assert api == 'daily' and params['trade_date'] == expected
        return [{'ts_code': str(i), 'trade_date': expected, 'close': 10} for i in range(50)]
    mocked = AsyncMock(side_effect=call)
    with patch.object(t, '_LATEST_CACHE', {'window': None, 'trade_date': None, 'rows': None}), \
         patch.object(t, '_data_window', return_value=window), patch.object(t, '_call', mocked):
        first, second = await asyncio.gather(t._latest_market_trade_date(), t._latest_market_trade_date())
        day, rows = first
        assert first == second
        assert day == expected and len(rows) == 50
        await t._latest_market_trade_date()
        assert mocked.call_count == 2


async def main():
    await verify('20261105', '20261105')
    await verify('20261106', '20261106')
    print('PASS: intraday skips unpublished day; post-close advances; same-window cache reused')


asyncio.run(main())
