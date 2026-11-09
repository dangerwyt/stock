"""离线验证财报口径、空值、分区失败与缓存。"""
import asyncio
from unittest.mock import AsyncMock, patch
from app import financials as f
from app import tushare_client as ts


async def main():
    base = {'ts_code': '600519.SH', 'end_date': '20250930', 'ann_date': '20251030', 'report_type': '1', 'revenue': 0}
    rows = [base, {**base, 'f_ann_date': '20251101', 'revenue': 123},
            {**base, 'report_type': '2', 'revenue': 999},
            {**base, 'f_ann_date': '20270101', 'revenue': 777},
            {**base, 'end_date': '20250230', 'revenue': 888}]
    normalized = f.normalize('income', rows, '600519.SH', '20261106')
    assert len(normalized) == 1 and normalized[0]['values']['revenue'] == 123
    assert normalized[0]['announcementDate'] == '20251101'
    assert normalized[0]['values']['n_income'] is None
    assert f.normalize('income', [base], '600519.SH', '20261106')[0]['values']['revenue'] == 0
    assert f.number('nan') is None and f.number('') is None and f.number(False) is None
    try: f.normalize('income', [{**base, 'ts_code':'000001.SZ'}], '600519.SH', '20261106')
    except ValueError: pass
    else: raise AssertionError('不得串股票')
    calls = []
    async def provider(api, params, fields, **kwargs):
        calls.append(api)
        assert params['ts_code'] == '600519.SH'
        if api != 'fina_indicator': assert params['report_type'] == '1'
        if api == 'cashflow': raise ts.TushareError('HTTP 409 notice')
        return [{**base, 'eps': 2, 'total_assets': 100}]
    with patch.object(ts, 'search_stock_basic', AsyncMock(return_value=[{'code':'600519','name':'贵州茅台','tsCode':'600519.SH'}])), patch.object(ts, '_call', provider):
        f._CACHE.clear()
        result = await f.snapshot('600519')
        assert result['status'] == 'partial'
        assert result['periods'] == ['20250930']
        failed = result['sections'][-1]
        assert failed['status'] == 'unavailable' and failed['rows'] == []
        before = {api: calls.count(api) for api in f.SECTIONS}
        await f.snapshot('600519')
        assert all(calls.count(api) == before[api] for api in ('fina_indicator','income','balancesheet'))
        assert calls.count('cashflow') > before['cashflow']
    f._CACHE.clear()
    transient = AsyncMock(side_effect=[ts.TushareError('timeout'), [base]])
    with patch.object(ts, '_call', transient):
        assert await f.read_section('income', '600519.SH', '20261106')
        assert transient.await_count == 2
    with patch.object(ts, 'search_stock_basic', AsyncMock()) as search:
        try: await f.snapshot('../bad')
        except ValueError: pass
        else: raise AssertionError('拒绝非法代码')
        search.assert_not_called()
    from app.routers.snapshots import stock_financials
    response = await stock_financials('bad')
    assert response.status_code == 400
    print('PASS: report scope, disclosure date, duplicates, null/zero, partial failure, cache, retry, invalid code')

asyncio.run(main())
