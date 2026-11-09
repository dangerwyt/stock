"""离线验证上游拒绝、资料缓存和错误契约，不访问行情源。"""
import asyncio
import json
import time
from unittest.mock import AsyncMock, patch
from app import tushare_client as client
from app.routers import snapshots


async def main():
    notice = client.TushareError('备用: HTTP 409：请确认今日提示 https://example.invalid/notice')
    assert client.public_error(notice)['errorCode'] == 'provider_notice_required'
    assert client.public_error(notice)['retryable'] is False
    mixed = client.TushareError('主源: token daily limit exceeded；备用: 请求失败 ReadTimeout')
    assert client.public_error(mixed)['retryable'] is True
    daily = [{'trade_date':'20261106','close':29.91}]
    async def fake(api, params, fields):
        if api == 'stock_basic':
            raise AssertionError('不应重复请求已经缓存的资料')
        return daily if api == 'daily' else []
    cached = {'at':time.time(),'data':[{'tsCode':'600900.SH','code':'600900','name':'长江电力','industry':'水力发电'}]}
    with patch.object(client,'_UNIVERSE',cached), patch.object(client,'_call',fake):
        quote = await client._build_stock_snapshot('600900.SH','600900')
        assert quote['name']=='长江电力' and quote['close']==29.91
    async def rejected(api, params, fields):
        if api == 'daily': raise notice
        return [{'name':'长江电力'}] if api == 'stock_basic' else []
    with patch.object(client,'_call',rejected):
        try: await client._build_stock_snapshot('600900.SH','600900')
        except client.TushareError as exc: assert client.public_error(exc)['errorCode']=='provider_notice_required'
        else: raise AssertionError('不可把日线拒绝伪装成只有名称的成功响应')
    with patch.object(client,'search_stock_basic',AsyncMock(side_effect=notice)), patch.object(client,'get_stock_snapshot',AsyncMock(side_effect=notice)), patch.object(client,'_latest_market_trade_date',AsyncMock(side_effect=notice)):
        for response in (await snapshots.stocks_search('600900'),await snapshots.stock_quote('600900'),await snapshots.market(scope='all',supplement=False)):
            data=json.loads(response.body)
            assert response.status_code==503 and data['retryable'] is False
            assert data['errorCode']=='provider_notice_required' and 'example.invalid' not in str(data)
    calls=[]
    async def calendar(api, params, fields):
        calls.append(api)
        if api=='trade_cal': return [{'cal_date':'20261105'},{'cal_date':'20261104'}]
        raise notice
    with patch.object(client,'_LATEST_CACHE',{'window':None,'trade_date':None,'rows':None}),patch.object(client,'_call',calendar):
        try: await client._load_latest_market_trade_date(30, 8)
        except client.TushareError: pass
        else: raise AssertionError('账户错误必须抛出')
    assert calls==['trade_cal','daily'],calls
    print('PASS: cached identity, daily rejection, safe actionable 503, fail-fast notice; no external requests')


asyncio.run(main())
