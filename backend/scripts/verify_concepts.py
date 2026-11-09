"""离线运行于后端环境：概念日期、代码、金额口径及数据来源隔离。"""
import asyncio
from unittest.mock import AsyncMock, patch
from app import concepts as c

catalog = [{"ts_code": "BK1001.DC", "trade_date": "20261105", "name": "测试概念", "idx_type": "概念板块", "pct_change": 99}]
daily = [{"ts_code": "BK1001.DC", "trade_date": "20261105", "close": 100, "pct_change": 0, "amount": 123000000}]
r = c.build_snapshot("20261105", catalog, daily)
assert r['items'][0]['pct'] == 0 and r['items'][0]['amount'] == 123000000
assert r['items'][0]['name'] == '测试概念'
def rejects(fn):
    try: fn()
    except ValueError: return
    raise AssertionError('Invalid data accepted')
rejects(lambda: c.build_snapshot('20261106', catalog, daily))
rejects(lambda: c.build_snapshot('20261105', catalog, daily + daily))
rejects(lambda: c.build_snapshot('20261105', catalog, [dict(daily[0],close=float('nan'))]))
rejects(lambda: c.build_snapshot('20261105', [dict(catalog[0],idx_type='行业板块')], daily))

async def main():
    with patch.object(c, 'read', AsyncMock(return_value=[{'trade_date':'20261105','ts_code':'BK1001.DC','con_code':'000001.SZ','name':'测试股'}])), \
         patch.object(c.ts,'fetch_daily_rows',AsyncMock(return_value=[{'trade_date':'20261105','ts_code':'000001.SZ','close':10,'pct_chg':0,'amount':125}])):
        m=await c.members('BK1001.DC','20261105')
        assert m['items'][0]['amount']==125000 and m['items'][0]['pct']==0 and m['quotedCount']==1
    with patch.object(c, 'read', AsyncMock(return_value=[{'trade_date':'20261105','ts_code':'BK1001.DC','con_code':'000001.SZ','name':'测试股'}])), \
         patch.object(c.ts,'fetch_daily_rows',AsyncMock(side_effect=asyncio.TimeoutError)):
        m=await c.members('BK1001.DC','20261105')
        assert len(m['items']) == 1 and m['items'][0]['close'] is None and m['quoteState'] == 'unavailable'
    with patch.object(c,'read',AsyncMock(return_value=[dict(daily[0],ts_code='BK2000.DC')])):
        try: await c.history('BK1001.DC','20261105')
        except ValueError: pass
        else: raise AssertionError('Wrong code accepted')
    with patch.object(c,'read',AsyncMock(return_value=[{'ts_code':'BK1001.DC','trade_date':'20261105','content_type':'概念','net_amount':-123000000}])):
        f=await c.flows('20261105')
        assert f['items'][0]['netAmount']==-123000000 and f['unit']=='yuan'
    print('PASS: concept dates, identity, daily source, zero/null and per-API currency units')

asyncio.run(main())
