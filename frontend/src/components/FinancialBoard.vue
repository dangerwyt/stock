<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { fetchSnapshot } from '@/api/client'
import { IconFileAnalytics, IconSearch, IconRefresh } from '@tabler/icons-vue'

const query = ref('')
const searchState = ref('idle')
const searchError = ref('')
const selected = ref(null)
const data = ref(null)
const loading = ref(false)
const error = ref('')
const period = ref('')
const sectionId = ref('fina_indicator')
let searchRequest = 0
let reportRequest = 0
watch(query, () => { searchRequest++; searchState.value = 'idle'; searchError.value = '' }, { flush: 'sync' })
onBeforeUnmount(() => { searchRequest++; reportRequest++ })
async function search(text, callback) {
  const request = ++searchRequest
  const q = text.trim()
  if (!q) { searchState.value = 'idle'; callback([]); return }
  searchState.value = 'loading'
  searchError.value = ''
  try {
    const result = await fetchSnapshot(`/api/stocks/search?q=${encodeURIComponent(q)}`, { timeout: 70000, retry: true })
    if (request !== searchRequest) return
    const items = (result.items || []).map(stock => ({ ...stock, value: `${stock.name} ${stock.code}` }))
    searchState.value = items.length ? 'ready' : 'empty'
    callback(items)
  } catch (e) {
    if (request !== searchRequest) return
    searchState.value = 'error'
    searchError.value = e.response?.data?.message || '股票搜索暂不可用，请稍后重新输入关键词。'
    callback([])
  }
}
function chooseStock(stock) {
  searchRequest++
  searchState.value = 'idle'
  searchError.value = ''
  load(stock)
}
async function load(stock = selected.value) {
  if (!stock) return
  const request = ++reportRequest
  const previousPeriod = selected.value?.code === stock.code ? period.value : ''
  selected.value = stock
  searchState.value = 'idle'
  loading.value = true
  error.value = ''
  data.value = null
  period.value = ''
  try {
    const result = await fetchSnapshot(`/api/stocks/${encodeURIComponent(stock.code)}/financials`, { timeout: 90000, fresh: true })
    if (request !== reportRequest) return
    data.value = result
    period.value = result.periods.includes(previousPeriod) ? previousPeriod : result.periods[0] || ''
  } catch (e) {
    if (request !== reportRequest) return
    error.value = e.response?.data?.message || '财务数据读取失败，请稍后重试。'
  } finally { if (request === reportRequest) loading.value = false }
}
const sections = computed(() => data.value?.sections || [])
const section = computed(() => sections.value.find(s => s.id === sectionId.value))
const row = computed(() => section.value?.rows.find(r => r.period === period.value))
function valueAt(id, key) { return sections.value.find(s => s.id === id)?.rows.find(r => r.period === period.value)?.values[key] }
function format(value, unit = '') {
  if (value == null || !Number.isFinite(Number(value))) return '--'
  const n = Number(value) / (unit === '亿元' ? 1e8 : 1)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + unit
}
function dateLabel(value) { return value ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : '--' }
const cards = computed(() => [
  ['营业收入', 'income', 'revenue', '亿元'], ['归母净利润', 'income', 'n_income_attr_p', '亿元'],
  ['净资产收益率', 'fina_indicator', 'roe', '%'], ['资产负债率', 'fina_indicator', 'debt_to_assets', '%'],
  ['经营现金流净额', 'cashflow', 'n_cashflow_act', '亿元'],
].map(([label, id, key, unit]) => ({ label, value: format(valueAt(id, key), unit) })))
const historyRows = computed(() => section.value?.rows.filter(r => !period.value || r.period <= period.value) || [])
</script>

<template>
  <section class="financial-board">
    <header class="fin-heading"><div><h1><IconFileAnalytics :size="23" />财务分析</h1><p>按报告期查看盈利能力、资产负债与现金流</p></div><span class="fin-badge">已披露财报</span></header>
    <div class="fin-search">
      <label for="financial-search">选择股票</label>
      <el-autocomplete id="financial-search" v-model="query" :fetch-suggestions="search" :debounce="300" :trigger-on-focus="false" clearable fit-input-width placeholder="输入股票名称、代码或行业，选择后查看财报" @select="chooseStock">
        <template #prefix><IconSearch :size="18" /></template>
        <template #default="{ item }"><div class="fin-stock-option"><strong>{{ item.name }}</strong><span>{{ item.code }} · {{ item.industry }}</span></div></template>
      </el-autocomplete>
    </div>
    <p v-if="searchError" class="fin-notice" role="alert">{{ searchError }}</p>
    <p v-if="searchState === 'empty'" class="fin-notice" role="status">没有匹配的股票，请换个关键词。</p>
    <div v-if="!selected" class="fin-empty"><IconFileAnalytics :size="46" /><h2>选择一只股票，查看真实财报</h2><p>支持财务指标、利润表、资产负债表、现金流量表</p></div>
    <template v-else>
      <div class="fin-stock"><div><h2>{{ selected.name }} <small>{{ selected.code }}</small></h2><span>报告期与公告日期分别标注</span></div><div class="fin-actions"><label>报告期 <select v-model="period" :disabled="loading || !data?.periods.length"><option v-if="!data?.periods.length" value="">暂无报告期</option><option v-for="p in data?.periods || []" :key="p" :value="p">{{ dateLabel(p) }}</option></select></label><button :disabled="loading" @click="load()"><IconRefresh :size="16" />重新读取</button></div></div>
      <p v-if="loading" class="fin-notice" role="status">正在读取四类财报，首次加载可能需要约一分钟…</p>
      <p v-if="error" class="fin-notice" role="alert">{{ error }}</p>
      <template v-if="data">
        <p v-if="data.status !== 'ready'" class="fin-notice" role="status">{{ data.periods.length ? '部分财报缺失或暂不可用，可重新读取失败的分区。' : '当前没有可展示的已披露财报，可稍后重新读取。' }}</p>
        <div class="fin-cards"><article v-for="card in cards" :key="card.label"><span>{{ card.label }}</span><strong>{{ card.value }}</strong><small>{{ dateLabel(period) }} · 同期数据</small></article></div>
        <section class="fin-panel">
          <div class="fin-tabs" role="tablist" aria-label="财报类型"><button v-for="s in sections" :key="s.id" role="tab" :aria-selected="s.id === sectionId" :class="{ active: s.id === sectionId }" @click="sectionId = s.id">{{ s.label }}<small>{{ s.status === 'unavailable' ? '暂不可用' : `${s.rows.length}期` }}</small></button></div>
          <p class="fin-period">报告期 {{ dateLabel(period) }}<span>公告日期 {{ dateLabel(row?.announcementDate) }}</span></p>
          <p v-if="section?.status === 'unavailable'" class="fin-notice" role="alert">{{ section.message }}</p>
          <p v-else-if="!row" class="fin-notice">该报告期暂无{{ section?.label }}，未使用其他报告期替代。</p>
          <div v-else class="fin-metrics"><div v-for="metric in section.metrics" :key="metric.key"><span>{{ metric.label }}</span><strong>{{ format(row.values[metric.key], metric.unit) }}</strong></div></div>
          <template v-if="historyRows.length"><h3>历史报告对照 <small>截至所选报告期，最多12期</small></h3><div class="fin-table-scroll"><table><thead><tr><th scope="col">指标</th><th v-for="r in historyRows" :key="r.period" scope="col">{{ dateLabel(r.period) }}<small>公告 {{ dateLabel(r.announcementDate) }}</small></th></tr></thead><tbody><tr v-for="metric in section.metrics" :key="metric.key"><th scope="row">{{ metric.label }}（{{ metric.unit }}）</th><td v-for="r in historyRows" :key="r.period">{{ format(r.values[metric.key], metric.unit) }}</td></tr></tbody></table></div></template>
        </section>
        <p class="fin-footnote">来源：现有 Tushare / ProMax 数据通道。三张报表采用合并报表；利润与现金流为年初至报告期末累计值，资产负债为期末值。各分区取同期最新公告版本；“--”表示缺失，不代表零。成功分区缓存1小时，重新读取会重试失败分区。</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.financial-board { color: #234a7b; font-size: 14px; }
.fin-heading,.fin-stock,.fin-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.fin-heading { margin: 20px 0; }.fin-heading h1 { display: flex; align-items: center; gap: 9px; margin: 0; font-size: 23px; }.fin-heading h1 svg { color: #287cf0; }
.fin-heading p,.fin-stock span { margin: 7px 0 0; color: #738bad; font-size: 13px; }.fin-badge { padding: 5px 10px; border: 1px solid #bde5dd; border-radius: 5px; background: #eef9f6; color: #168575; font-size: 12px; }
.financial-board button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 38px; padding: 0 14px; border: 1px solid #d5e4f8; border-radius: 7px; background: #fff; color: #35659e; font: inherit; }
.financial-board button:hover:not(:disabled) { background: #edf5ff; border-color: #aacaff; }.fin-search { display: flex; align-items: center; gap: 12px; padding: 16px; border: 1px solid #d7e5f8; border-radius: 10px; background: #f6f9ff; }
.fin-search { width: 100%; max-width: 600px; box-sizing: border-box; }
.fin-search > label { flex-shrink: 0; white-space: nowrap; }
.fin-search .el-autocomplete { flex: 1; width: auto; min-width: 0; }
.fin-search :deep(.el-input__wrapper) { min-height: 42px; border-radius: 7px; background: #fff; padding: 0 12px; }
.fin-search :deep(.el-input__inner) { font-size: 14px; }
.fin-stock-option { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 42px; }
.fin-stock-option strong { color: #234a7b; font-size: 14px; }
.fin-stock-option span { color: #738bad; font-size: 12px; }
.fin-empty { display: grid; justify-items: center; padding: 90px 20px; color: #7893b9; text-align: center; }.fin-empty svg { color: #aac9ef; }.fin-empty h2 { font-size: 19px; color: #426b9d; }.fin-stock { margin: 22px 0 16px; }.fin-stock h2 { margin: 0 0 7px; font-size: 19px; }.fin-stock small { font-size: 13px; font-weight: 400; color: #7893b9; margin-left: 8px; }.fin-actions label { display: flex; align-items: center; gap: 8px; }.fin-actions select { height: 38px; border: 1px solid #d5e4f8; border-radius: 7px; background: #fff; color: #35659e; padding: 0 9px; font: inherit; }
.fin-notice { background: #fff9ec; color: #906d2c; border: 1px solid #f2dfb4; padding: 12px 16px; border-radius: 7px; line-height: 1.6; }.fin-cards { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 10px; margin-bottom: 16px; }.fin-cards article { display: grid; gap: 10px; padding: 16px; border: 1px solid #dce7f6; border-radius: 9px; background: #f8fbff; }.fin-cards span { font-size: 13px; color: #6e87aa; }.fin-cards strong { font-size: 22px; color: #206fd1; font-variant-numeric: tabular-nums; }.fin-cards small { font-size: 11px; color: #8b9eb8; }
.fin-panel { border: 1px solid #dce7f6; border-radius: 10px; background: #fff; overflow: hidden; }.fin-tabs { display: flex; gap: 6px; padding: 12px; border-bottom: 1px solid #e4edf8; overflow-x: auto; }.fin-tabs button { white-space: nowrap; border-color: transparent; flex-shrink: 0; }.fin-tabs button.active { background: #edf5ff; border-color: #c7deff; color: #2176ed; }.fin-tabs small { font-size: 11px; color: #8298b5; }.fin-period { display: flex; flex-wrap: wrap; gap: 24px; padding: 0 18px; font-size: 13px; color: #7189aa; }.fin-panel > .fin-notice { margin: 16px; }
.fin-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 0 24px; padding: 0 18px 16px; }.fin-metrics > div { display: flex; justify-content: space-between; gap: 12px; padding: 15px 0; border-bottom: 1px solid #edf2f9; }.fin-metrics span { color: #6d84a4; }.fin-metrics strong { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.fin-panel h3 { margin: 0; padding: 16px 18px; font-size: 15px; border-top: 1px solid #e4edf8; }.fin-panel h3 small { margin-left: 10px; font-size: 12px; color: #8298b5; font-weight: 400; }.fin-table-scroll { overflow: auto; max-height: 480px; }table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }th,td { padding: 13px 16px; white-space: nowrap; text-align: right; border-bottom: 1px solid #e6eef8; }thead th { background: #f5f9ff; color: #5879a4; }th:first-child { text-align: left; position: sticky; left: 0; background: #f8fbff; }tbody th { font-weight: 400; }td { font-variant-numeric: tabular-nums; }th small { display: block; font-size: 11px; font-weight: 400; margin-top: 6px; color: #869bb6; }.fin-footnote { color: #7a91b0; font-size: 12px; line-height: 1.8; margin: 14px 0; }
@media(max-width:1200px) { .fin-cards { grid-template-columns: repeat(3,minmax(0,1fr)); }.fin-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media(max-width:620px) { .fin-search { flex-wrap: wrap; }.fin-search label { width: 100%; }.fin-cards { grid-template-columns: repeat(2,minmax(0,1fr)); }.fin-cards strong { font-size: 18px; }.fin-metrics { grid-template-columns: 1fr; }.fin-actions { gap: 8px; }.fin-panel h3 small { display: block; margin: 7px 0 0; } }
</style>
