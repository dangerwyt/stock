"""单股财报：按报告期展示已披露的合并累计报表，不混入单季或母公司报表。"""
import asyncio
import math
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from app import tushare_client as ts

SECTIONS = {
    'fina_indicator': ('财务指标', [
        ('eps', '基本每股收益', '元'), ('dt_eps', '稀释每股收益', '元'),
        ('bps', '每股净资产', '元'), ('roe', '净资产收益率 ROE', '%'),
        ('roa', '总资产报酬率 ROA', '%'), ('grossprofit_margin', '销售毛利率', '%'),
        ('netprofit_margin', '销售净利率', '%'), ('debt_to_assets', '资产负债率', '%'),
        ('current_ratio', '流动比率', '倍'), ('quick_ratio', '速动比率', '倍'),
        ('or_yoy', '营业收入同比', '%'), ('netprofit_yoy', '归母净利润同比', '%'),
        ('ocfps', '每股经营现金流', '元')]),
    'income': ('利润表', [
        ('total_revenue', '营业总收入', '亿元'), ('revenue', '营业收入', '亿元'),
        ('oper_cost', '营业成本', '亿元'), ('operate_profit', '营业利润', '亿元'),
        ('total_profit', '利润总额', '亿元'), ('n_income', '净利润', '亿元'),
        ('n_income_attr_p', '归母净利润', '亿元'), ('basic_eps', '基本每股收益', '元')]),
    'balancesheet': ('资产负债表', [
        ('total_assets', '资产总计', '亿元'), ('total_liab', '负债合计', '亿元'),
        ('total_hldr_eqy_exc_min_int', '归母股东权益', '亿元'),
        ('total_cur_assets', '流动资产', '亿元'), ('total_cur_liab', '流动负债', '亿元'),
        ('money_cap', '货币资金', '亿元'), ('inventories', '存货', '亿元'),
        ('accounts_receiv', '应收账款', '亿元')]),
    'cashflow': ('现金流量表', [
        ('n_cashflow_act', '经营活动现金流净额', '亿元'),
        ('n_cashflow_inv_act', '投资活动现金流净额', '亿元'),
        ('n_cash_flows_fnc_act', '筹资活动现金流净额', '亿元'),
        ('n_incr_cash_cash_equ', '现金及现金等价物净增加额', '亿元'),
        ('c_cash_equ_end_period', '期末现金及现金等价物', '亿元')]),
}
_CACHE = {}


def number(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def valid_date(value):
    value = str(value or '')
    try:
        return value if re.fullmatch(r'\d{8}', value) and datetime.strptime(value, '%Y%m%d') else None
    except ValueError:
        return None


def normalize(api, rows, code, today):
    periods = {}
    for row in rows:
        if row.get('ts_code') != code:
            raise ValueError('财报代码与请求不符')
        end = valid_date(row.get('end_date'))
        ann = valid_date(row.get('f_ann_date') or row.get('ann_date'))
        if not end or not ann or end > today or ann > today or end > ann:
            continue
        if api != 'fina_indicator' and str(row.get('report_type')) != '1':
            continue
        # 同期重复披露取最新公告；相同公告优先更新标记，再按完整度挑选，绝不逐字段拼表。
        rank = (ann, str(row.get('update_flag', '0')), sum(number(row.get(f)) is not None for f, _, _ in SECTIONS[api][1]))
        if end not in periods or rank > periods[end][0]:
            values = {f: number(row.get(f)) for f, _, _ in SECTIONS[api][1]}
            if any(v is not None for v in values.values()):
                periods[end] = (rank, {'period': end, 'announcementDate': ann, 'values': values})
    return [periods[p][1] for p in sorted(periods, reverse=True)[:12]]


async def read_section(api, code, today):
    key = (api, code, today)
    cached = _CACHE.get(key)
    if cached and time.monotonic() - cached[0] < 3600:
        return cached[1]
    label, metrics = SECTIONS[api]
    fields = ['ts_code', 'ann_date', 'end_date', 'update_flag']
    params = {'ts_code': code}
    if api != 'fina_indicator':
        fields += ['f_ann_date', 'report_type']
        params['report_type'] = '1'
    fields += [f for f, _, _ in metrics]
    for attempt in range(2):
        try:
            rows = await asyncio.wait_for(ts._call(api, params, ','.join(fields), timeout=12), 26)
            result = normalize(api, rows, code, today)
            if len(_CACHE) >= 128:
                _CACHE.pop(next(iter(_CACHE)))
            _CACHE[key] = (time.monotonic(), result)
            return result
        except (ts.TushareError, TimeoutError) as exc:
            if attempt or not ts.public_error(exc)['retryable']:
                raise
            await asyncio.sleep(1)


async def snapshot(code):
    if not re.fullmatch(r'\d{6}', code):
        raise ValueError('请输入六位股票代码')
    # 股票基础池给出交易所，避免 920 开头北交所代码被误判为沪市。
    catalog = await ts.search_stock_basic(code)
    stock = next((s for s in catalog if s.get('code') == code), None)
    if not stock:
        raise ValueError('未找到该股票')
    ts_code = stock.get('tsCode') or ts._to_ts_code(code)
    today = datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d')
    # 并发请求复用已成功的分区缓存，失败分区允许下次重试。
    results = await asyncio.gather(*(read_section(api, ts_code, today) for api in SECTIONS), return_exceptions=True)
    sections = []
    for (api, (label, metrics)), result in zip(SECTIONS.items(), results):
        section = {'id': api, 'label': label, 'metrics': [{'key': f, 'label': name, 'unit': unit} for f, name, unit in metrics]}
        if isinstance(result, Exception):
            section.update(status='unavailable', rows=[], **ts.public_error(result))
        else:
            section.update(status='ready' if result else 'empty', rows=result)
        sections.append(section)
    available = sum(s['status'] == 'ready' for s in sections)
    return {'status': 'ready' if available == 4 else 'partial' if available else 'unavailable' if all(s['status'] == 'unavailable' for s in sections) else 'empty',
            'stock': {'code': code, 'name': stock['name'], 'tsCode': ts_code}, 'sections': sections,
            'periods': sorted({r['period'] for s in sections for r in s['rows']}, reverse=True),
            'readAt': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')}
