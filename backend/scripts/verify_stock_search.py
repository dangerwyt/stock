"""关键词搜索回归：两个前端入口共用此接口；无外部请求。"""
import asyncio
from unittest.mock import AsyncMock, patch
from app import tushare_client as client


async def main():
    items = [
        {'code':'600900','name':'长江电力','industry':'水力发电'},
        {'code':'000001','name':'平安银行','industry':'银行'},
        {'code':'300001','name':'示例科技','industry':'IT服务'},
    ]
    with patch.object(client, '_stock_basic_universe', AsyncMock(return_value=items)):
        for keyword, code in [('600900','600900'),('长江','600900'),('水力','600900'),('000001','000001'),(' it ','300001')]:
            result = await client.search_stock_basic(keyword)
            assert [row['code'] for row in result] == [code], keyword
        assert await client.search_stock_basic('不存在') == []
        assert await client.search_stock_basic('', limit=2) == items[:2]
    with patch.object(client, '_stock_basic_universe', AsyncMock(side_effect=client.TushareError('unavailable'))):
        try: await client.search_stock_basic('银行')
        except client.TushareError: pass
        else: raise AssertionError('搜索失败不能被伪装为无结果')
    print('PASS: code, name, industry, whitespace, case, limit and upstream error')


asyncio.run(main())
