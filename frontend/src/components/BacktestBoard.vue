<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { http } from '@/api/client'
import EChart from '@/components/EChart.vue'
import { readBacktest, writeBacktest } from '@/utils/backtestStorage'
import { IconPlayerPlay, IconChartLine, IconAdjustments, IconDownload, IconHistory } from '@tabler/icons-vue'

const props = defineProps({ stocks: { type: Array, default: () => [] }, cycle: { type: String, default: '波段' } })
const dateText = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value)
const today = dateText(new Date())
const defaults = { stockCode: '', strategyId: 'ma', startDate: dateText(new Date(Date.now() - 180 * 86400000)), endDate: today,
  initialCapital: 100000, positionPct: 100, maPeriod: 20, fastPeriod: 5, slowPeriod: 20,
  commissionBps: 3, minCommission: 5, sellTaxBps: 5, slippageBps: 5 }
const saved = readBacktest(defaults)
const form = reactive(saved?.form || defaults)
const strategies = [
  { id: 'ma', name: '均线趋势', detail: '昨收高于均线时持有，跌破时退出' },
  { id: 'dual_ma', name: '双均线趋势', detail: '快线高于慢线时持有，反之退出' },
  { id: 'buy_hold', name: '买入持有', detail: '区间首日开盘买入，持有至期末' },
]
const busy = ref(false), error = ref(''), result = ref(saved?.result || null), lastSignature = ref(saved?.lastSignature || '')
const ranAt = ref(saved?.ranAt || ''), restored = ref(!!saved?.result), storageFailed = ref(false)
const runTime = computed(() => ranAt.value ? new Date(ranAt.value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '')
function persist() {
  storageFailed.value = !writeBacktest({ form: { ...form }, result: result.value, lastSignature: lastSignature.value, ranAt: ranAt.value })
}
watch(form, persist, { deep: true, flush: 'sync' })
const detailTab = ref('trades'), chartDetail = ref('drawdown'), page = ref(1)
watch(() => props.stocks, stocks => { if (!form.stockCode && stocks.length) form.stockCode = stocks[0].value }, { immediate: true })
const signature = computed(() => JSON.stringify({ ...form, cycle: props.cycle }))
const changed = computed(() => result.value && lastSignature.value !== signature.value)
const num = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? '--' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const pct = value => value == null ? '--' : `${Number(value) > 0 ? '+' : ''}${num(value)}%`
const tone = value => value > 0 ? 'bt-up' : value < 0 ? 'bt-down' : ''
const metrics = computed(() => {
  const r = result.value || {}
  return [
    ['策略收益', r.totalReturn, 'pct'], ['年化收益', r.annualReturn, 'pct'], ['基准收益', r.benchmarkReturn, 'pct'],
    ['超额收益', r.totalReturn == null ? null : r.totalReturn - r.benchmarkReturn, 'pct'], ['最大回撤', r.maxDrawdown, 'pct'], ['夏普比率', r.sharpe, 'number'],
    ['平仓胜率', r.tradeWinRate, 'rate'], ['已平仓交易', r.closedTrades, 'count'], ['入场次数', r.entries, 'count'],
    ['期末总资产', r.finalEquity, 'money'], ['手续费及税费', r.totalFees, 'money'], ['滑点成本', r.slippageCost, 'money'],
  ].map(([label, value, kind]) => ({ label, value, text: value == null ? '--' : kind === 'pct' ? pct(value) : kind === 'rate' ? `${num(value)}%` : `${num(value, kind === 'count' ? 0 : 2)}${kind === 'money' ? ' 元' : ''}`, kind }))
})
const curveOptions = computed(() => {
  const curve = result.value?.equityCurve || [], dates = curve.map(p => p.date)
  const position = chartDetail.value === 'position'
  return { animation: false, tooltip: { trigger: 'axis' },
    legend: { top: 0, data: ['策略净值', '标的持有基准'], textStyle: { color: '#627792', fontSize: 12 } },
    grid: [{ left: 62, right: 24, top: 38, height: '53%' }, { left: 62, right: 24, top: '70%', height: '17%' }],
    xAxis: [0, 1].map(i => ({ type: 'category', gridIndex: i, data: dates, boundaryGap: false, axisLabel: { show: i === 1, color: '#71829a', fontSize: 11 }, axisLine: { lineStyle: { color: '#dce6f1' } }, axisTick: { show: false } })),
    yAxis: [{ type: 'value', scale: true, axisLabel: { color: '#71829a' }, splitLine: { lineStyle: { color: '#edf2f8' } } },
      { type: 'value', gridIndex: 1, axisLabel: { formatter: '{value}%', color: '#71829a' }, splitLine: { lineStyle: { color: '#edf2f8' } } }],
    dataZoom: [{ type: 'slider', xAxisIndex: [0, 1], bottom: 0, height: 17 }, { type: 'inside', xAxisIndex: [0, 1] }],
    series: [{ name: '策略净值', type: 'line', showSymbol: false, data: curve.map(p => p.strategy), itemStyle: { color: '#2877df' }, lineStyle: { width: 2 } },
      { name: '标的持有基准', type: 'line', showSymbol: false, data: curve.map(p => p.benchmark), itemStyle: { color: '#9aa9bd' }, lineStyle: { width: 1.5, type: 'dashed' } },
      { name: position ? '收盘仓位' : '策略回撤', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false,
        data: curve.map(p => position ? p.positionPct : p.drawdown), itemStyle: { color: position ? '#c39435' : '#16a085' }, areaStyle: { opacity: 0.12 } }],
  }
})
const detailRows = computed(() => [...(detailTab.value === 'trades' ? result.value?.trades || [] : result.value?.equityCurve || [])].reverse())
const pageCount = computed(() => Math.max(1, Math.ceil(detailRows.value.length / 12)))
const visibleRows = computed(() => detailRows.value.slice((page.value - 1) * 12, page.value * 12))
watch(detailTab, () => { page.value = 1 })

async function run() {
  if (busy.value) return
  error.value = ''
  if (!props.stocks.some(s => s.value === form.stockCode)) { error.value = '请选择当前榜单中的标的'; return }
  if (!form.startDate || !form.endDate || form.startDate >= form.endDate || form.endDate > today) { error.value = '请检查日期：开始须早于结束，结束不可晚于今天'; return }
  const payload = { ...form, cycle: props.cycle }, submitted = signature.value
  busy.value = true
  try {
    const response = await http.post('/api/quant/backtest', payload, { timeout: 120000 })
    const data = response.data
    if (data?.status !== 'ready' || !data.result?.equityCurve?.length) throw new Error('未返回有效回测结果')
    result.value = data.result; lastSignature.value = submitted; page.value = 1
    ranAt.value = new Date().toISOString(); restored.value = false; persist()
  } catch (e) {
    error.value = e.response?.data?.reason || (e.code === 'ECONNABORTED' ? '历史行情读取超时，请稍后重试' : e.message)
  } finally { busy.value = false }
}

function exportTrades() {
  const rows = [['日期', '方向', '复权成交价', '复权份额', '成交额', '费用', '已实现盈亏', '现金'],
    ...(result.value?.trades || []).map(t => [t.date, t.side, t.price, t.units, t.amount, t.fees, t.pnl ?? '', t.cash])]
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `回测交易-${result.value.stock.code}-${result.value.endDate}.csv`; link.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="backtest-board" aria-label="策略回测">
    <header class="bt-heading"><div><IconChartLine :size="22" /><h2>策略回测</h2><span class="bt-badge">真实历史行情</span></div><small>单标的 · 日线 · 下一交易日开盘执行</small></header>
    <div class="bt-layout">
      <form id="backtest-config" class="bt-config bt-card" @submit.prevent="run">
        <fieldset :disabled="busy">
          <h3><IconAdjustments :size="16" />选择策略</h3>
          <div class="bt-strategies" role="radiogroup" aria-label="回测策略"><label v-for="s in strategies" :key="s.id" class="bt-strategy" :class="{ active: form.strategyId === s.id }"><input v-model="form.strategyId" type="radio" :value="s.id" name="strategy" /><span><b>{{ s.name }}</b><small>{{ s.detail }}</small></span></label></div>
          <h3>标的与区间</h3>
          <label class="bt-field">回测标的<select v-model="form.stockCode" required aria-label="回测标的"><option disabled value="">选择当前 TOP50 标的</option><option v-if="form.stockCode && !stocks.some(s => s.value === form.stockCode)" :value="form.stockCode" disabled>{{ form.stockCode }}（等待榜单或已不在当前榜单）</option><option v-for="s in stocks" :key="s.value" :value="s.value">{{ s.label }}</option></select></label>
          <p class="bt-help">标的来自当前 {{ cycle }} TOP50；本页不回测历史选股过程。</p>
          <div class="bt-input-grid"><label class="bt-field">开始日期<input v-model="form.startDate" required type="date" :max="form.endDate" aria-label="回测开始日期" /></label><label class="bt-field">结束日期<input v-model="form.endDate" required type="date" :min="form.startDate" :max="today" aria-label="回测结束日期" /></label></div>
          <p class="bt-help">最长 365 天，均线预热行情会另外读取。</p>
          <h3>资金与信号</h3>
          <div class="bt-input-grid">
            <label class="bt-field">初始资金（元）<input v-model.number="form.initialCapital" required type="number" min="1000" max="100000000" step="1000" /></label>
            <label class="bt-field">入场仓位（%）<input v-model.number="form.positionPct" required type="number" min="1" max="100" step="1" /></label>
            <label v-if="form.strategyId === 'ma'" class="bt-field">均线周期（日）<input v-model.number="form.maPeriod" required type="number" min="2" max="120" step="1" /></label>
            <template v-if="form.strategyId === 'dual_ma'"><label class="bt-field">快线（日）<input v-model.number="form.fastPeriod" required type="number" min="2" max="119" step="1" /></label><label class="bt-field">慢线（日）<input v-model.number="form.slowPeriod" required type="number" min="3" max="120" step="1" /></label></template>
          </div>
          <h3>交易成本</h3>
          <div class="bt-input-grid"><label class="bt-field">佣金（万分之）<input v-model.number="form.commissionBps" required type="number" min="0" max="100" step="0.1" /></label><label class="bt-field">最低佣金（元）<input v-model.number="form.minCommission" required type="number" min="0" max="100" step="0.1" /></label><label class="bt-field">卖出税费（万分之）<input v-model.number="form.sellTaxBps" required type="number" min="0" max="100" step="0.1" /></label><label class="bt-field">单边滑点（万分之）<input v-model.number="form.slippageBps" required type="number" min="0" max="100" step="0.1" /></label></div>
          <p class="bt-help">成本参数为研究假设，整个区间按所填费率计算。</p>
          <button class="bt-run" type="submit" :disabled="busy || !stocks.length"><IconPlayerPlay :size="17" />{{ busy ? '正在读取行情并回测…' : '运行回测' }}</button>
        </fieldset>
      </form>
      <div class="bt-results" :aria-busy="busy">
        <p v-if="ranAt" class="bt-info">{{ restored ? '已恢复本机保存结果' : '最近成功运行' }}：{{ runTime }}（上海时间）。这是历史回测结果，行情不会自动重算。</p>
        <p v-if="storageFailed" class="bt-alert" role="alert">浏览器存储不可用，本次结果仍可查看，但刷新后无法恢复。</p>
        <p v-if="error" class="bt-alert" role="alert">{{ error }}{{ result ? '。下方保留上次成功结果。' : '' }}</p>
        <p v-if="busy" class="bt-info" role="status">正在读取历史行情与复权因子，首次运行可能需要一到两分钟。</p>
        <p v-else-if="changed" class="bt-info">参数已修改。下方仍是上次运行结果，重新回测后更新。</p>
        <header class="bt-result-head"><div><h3>{{ result ? `${result.stock.name} · ${result.strategy}` : '回测结果' }}</h3><small>{{ result ? `${result.startDate} — ${result.endDate} · ${result.sampleCount} 个交易日` : '配置策略与参数后点击运行回测' }}</small></div><button type="submit" form="backtest-config" :disabled="busy || !stocks.length"><IconPlayerPlay :size="15" />{{ busy ? '回测中…' : '运行回测' }}</button><button :disabled="!result || busy" @click="exportTrades"><IconDownload :size="15" />导出交易</button></header>
        <div class="bt-metrics"><article v-for="m in metrics" :key="m.label" class="bt-card"><small>{{ m.label }}</small><strong :class="m.kind === 'pct' ? tone(m.value) : ''">{{ m.text }}</strong></article></div>
        <section class="bt-card bt-chart"><header><h3>净值与风险</h3><div class="bt-toggle"><button :class="{ active: chartDetail === 'drawdown' }" :aria-pressed="chartDetail === 'drawdown'" @click="chartDetail = 'drawdown'">回撤</button><button :class="{ active: chartDetail === 'position' }" :aria-pressed="chartDetail === 'position'" @click="chartDetail = 'position'">仓位</button></div></header><EChart v-if="result" :options="curveOptions" height="360px" /><div v-else class="bt-empty"><IconChartLine :size="40" /><b>等待首次回测</b><span>策略净值、基准和回撤均由实际历史数据计算</span></div></section>
        <section class="bt-card bt-records"><header><div class="bt-detail-tabs" role="tablist" aria-label="回测明细"><button role="tab" :aria-selected="detailTab === 'trades'" :class="{ active: detailTab === 'trades' }" @click="detailTab = 'trades'"><IconHistory :size="15" />交易记录 {{ result?.trades?.length ?? '' }}</button><button role="tab" :aria-selected="detailTab === 'daily'" :class="{ active: detailTab === 'daily' }" @click="detailTab = 'daily'">每日持仓与资产</button></div></header>
          <div v-if="visibleRows.length" class="bt-table-wrap"><table><thead><tr v-if="detailTab === 'trades'"><th>日期</th><th>方向</th><th>复权成交价</th><th>复权份额</th><th>成交额</th><th>费用</th><th>已实现盈亏</th></tr><tr v-else><th>日期</th><th>总资产</th><th>现金</th><th>持仓市值</th><th>仓位</th><th>回撤</th></tr></thead><tbody><tr v-for="(row, i) in visibleRows" :key="`${row.date}-${i}`"><td>{{ row.date }}</td><template v-if="detailTab === 'trades'"><td :class="row.side === '买入' ? 'bt-up' : 'bt-down'">{{ row.side }}</td><td>{{ num(row.price, 4) }}</td><td>{{ num(row.units, 4) }}</td><td>{{ num(row.amount) }}</td><td>{{ num(row.fees) }}</td><td :class="tone(row.pnl)">{{ num(row.pnl) }}</td></template><template v-else><td>{{ num(row.equity) }}</td><td>{{ num(row.cash) }}</td><td>{{ num(row.marketValue) }}</td><td>{{ num(row.positionPct) }}%</td><td class="bt-down">{{ pct(row.drawdown) }}</td></template></tr></tbody></table></div>
          <p v-else class="bt-table-empty">{{ result ? '该区间未触发成交，策略保持现金。' : '运行后显示真实交易和持仓记录' }}</p>
          <div v-if="detailRows.length" class="bt-pagination"><span>共 {{ detailRows.length }} 条 · {{ page }} / {{ pageCount }}</span><button :disabled="page <= 1" @click="page--">上一页</button><button :disabled="page >= pageCount" @click="page++">下一页</button></div>
        </section>
        <div class="bt-method"><p>{{ result?.method || '昨日收盘信号、次日开盘成交；复权价格与小数份额，不强制期末平仓。' }}</p><p>{{ result?.limitations || '单标的研究回测，不模拟整手、涨跌停成交限制与市场冲击。' }}</p><p>年化按 252 个交易日计算；夏普使用日收益、无风险利率取 0；平仓胜率不包含未卖出的持仓。</p></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.backtest-board { color: #254366; font-size: 14px; font-variant-numeric: tabular-nums; }
.backtest-board h2,.backtest-board h3,.backtest-board p { margin: 0; }.backtest-board h2 { font-size: 20px; }.backtest-board h3 { font-size: 15px; }.backtest-board small { color: #72849d; font-size: 12px; }.backtest-board button,.backtest-board input,.backtest-board select { font: inherit; }.backtest-board button { cursor: pointer; }.backtest-board button:disabled { cursor: default; opacity: .55; }.backtest-board button:focus-visible,.backtest-board input:focus-visible,.backtest-board select:focus-visible { outline: 2px solid #3787ef; outline-offset: 2px; }
.bt-heading,.bt-heading > div { display: flex; align-items: center; gap: 10px; }.bt-heading { justify-content: space-between; flex-wrap: wrap; margin: 14px 0; }.bt-heading svg { color: #347fe3; }.bt-badge { background: #edf8f3; color: #22836c; border: 1px solid #cfe9df; padding: 3px 7px; border-radius: 5px; font-size: 12px; }
.bt-layout { display: grid; grid-template-columns: 280px minmax(0,1fr); gap: 14px; align-items: start; }.bt-card { background: #fff; border: 1px solid #dde7f3; border-radius: 10px; min-width: 0; overflow: hidden; }.bt-config { padding: 15px; }.bt-config fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }.bt-config h3 { display: flex; align-items: center; gap: 6px; margin: 21px 0 12px; }.bt-config h3:first-child { margin-top: 0; }.bt-strategies { display: grid; gap: 7px; }.bt-strategy { display: flex; align-items: flex-start; gap: 8px; border: 1px solid #e3eaf4; background: #fafcff; border-radius: 7px; padding: 10px; cursor: pointer; }.bt-strategy.active { border-color: #8cbcf8; background: #edf5ff; }.bt-strategy span { display: grid; gap: 6px; }.bt-strategy small { line-height: 1.5; }.bt-strategy input { margin: 3px 0 0; accent-color: #2877df; }
.bt-field { display: flex; flex-direction: column; gap: 7px; color: #5e728d; font-size: 12px; min-width: 0; }.bt-field input,.bt-field select { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid #d8e3f1; border-radius: 5px; background: #fff; color: #254366; padding: 8px 6px; height: 37px; font-size: 13px; color-scheme: light; }.bt-input-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 11px; }.backtest-board .bt-help { font-size: 12px; line-height: 1.7; color: #7a8ba2; margin: 8px 0 10px; }.bt-run { width: 100%; border: 0; border-radius: 6px; padding: 11px; background: #2877df; color: #fff; display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 14px; }
.bt-results { min-width: 0; }.bt-result-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin: 3px 0 12px; }.bt-result-head > div { display: grid; gap: 7px; }.bt-result-head button,.bt-pagination button { display: flex; align-items: center; gap: 5px; border: 1px solid #d8e3f1; background: #fff; color: #5b7494; border-radius: 5px; padding: 7px 10px; font-size: 12px; }.bt-metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; margin-bottom: 12px; }.bt-metrics article { display: flex; flex-direction: column; gap: 9px; padding: 12px; background: #fafcff; }.bt-metrics strong { font-size: 18px; overflow-wrap: anywhere; }.backtest-board .bt-up { color: #dc4c5c; }.backtest-board .bt-down { color: #07947b; }
.bt-chart > header,.bt-records > header { padding: 12px 14px; border-bottom: 1px solid #e9eff7; display: flex; align-items: center; justify-content: space-between; gap: 10px; }.bt-toggle,.bt-detail-tabs { display: flex; gap: 6px; }.bt-toggle button,.bt-detail-tabs button { display: flex; gap: 5px; align-items: center; padding: 5px 9px; border: 1px solid transparent; border-radius: 5px; color: #6c7f99; background: transparent; font-size: 12px; }.bt-toggle .active,.bt-detail-tabs .active { background: #edf5ff; color: #2777df; border-color: #d4e6fd; }.bt-empty { height: 360px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: #8094af; padding: 18px; text-align: center; box-sizing: border-box; }.bt-empty svg { color: #b6cce7; }.bt-empty span { font-size: 13px; }.bt-records { margin-top: 12px; }.bt-table-wrap { overflow: auto; }.bt-records table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; }.bt-records th { background: #f6f9fd; color: #6b809b; font-weight: 500; }.bt-records th,.bt-records td { padding: 12px 10px; text-align: right; border-bottom: 1px solid #edf2f8; }.bt-records th:first-child,.bt-records td:first-child { text-align: left; }.backtest-board .bt-table-empty { text-align: center; padding: 38px 10px; color: #8293aa; font-size: 13px; }.bt-pagination { display: flex; align-items: center; gap: 8px; padding: 10px 12px; color: #71849e; font-size: 12px; }.bt-pagination span { margin-right: auto; }.bt-method { margin-top: 12px; color: #7d8da3; font-size: 12px; line-height: 1.8; }.backtest-board .bt-alert,.backtest-board .bt-info { padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; line-height: 1.6; }.bt-alert { background: #fff3f1; border: 1px solid #f3d5cf; color: #ad554b; }.bt-info { background: #f0f6ff; border: 1px solid #d7e6fa; color: #557ba7; }
@media(max-width:1100px) { .bt-layout { grid-template-columns: 250px minmax(0,1fr); }.bt-metrics { grid-template-columns: repeat(3,minmax(0,1fr)); }.bt-metrics article { padding: 10px; } }
@media(max-width:800px) { .bt-layout { grid-template-columns: minmax(0,1fr); }.bt-strategies { grid-template-columns: repeat(3,minmax(0,1fr)); }.bt-input-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media(max-width:520px) { .bt-strategies { grid-template-columns: minmax(0,1fr); }.bt-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }.bt-heading > div { flex-wrap: wrap; }.bt-heading small { font-size: 11px; }.bt-config { padding: 12px; } }
</style>
