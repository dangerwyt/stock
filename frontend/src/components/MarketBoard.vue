<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { fetchSnapshot } from '@/api/client'
import { useSnapshot } from '@/composables/useSnapshot'
import { useStockDecision } from '@/composables/useStockDecision'
import { boardRows, boardStats, industryGroups } from '@/utils/marketBoard'
import { formatShanghaiTime } from '@/utils/format'
import EChart from '@/components/EChart.vue'
import { IconLayoutDashboard, IconRefresh, IconChartBar, IconRadar, IconBolt, IconBuildingFactory2, IconNews, IconArrowUpRight, IconX } from '@tabler/icons-vue'

const { data: daily, state, error, reload } = useSnapshot('/api/market?scope=all&supplement=false', { refreshMs: 300000, timeout: 90000 })
const supplement = ref(null), supplementState = ref('idle')
const market = computed(() => ({ ...daily.value, ...(supplement.value?.tradeDate === daily.value?.meta?.tradeDate ? supplement.value : {}) }))
let supplementRequest = 0
watch(daily, async snapshot => {
  const request = ++supplementRequest, day = snapshot?.meta?.tradeDate
  if (!day) { supplementState.value = 'idle'; return }
  supplementState.value = 'loading'
  try {
    const response = await fetchSnapshot(`/api/market/supplement?trade_date=${encodeURIComponent(day)}`, { timeout: 90000 })
    if (request !== supplementRequest) return
    if (response?.tradeDate !== day) throw new Error('补充行情日期不匹配')
    supplement.value = response
    supplementState.value = 'ready'
  } catch {
    if (request === supplementRequest) supplementState.value = 'unavailable'
  }
})
onUnmounted(() => { supplementRequest++ })
const { data: news, state: newsState, reload: reloadNews } = useSnapshot('/api/news', { refreshMs: 300000 })
const decision = useStockDecision()
const refreshing = ref(false)
const activeIndustry = ref('')
const query = ref('')
const rows = computed(() => boardRows(market.value?.quotes))
const stats = computed(() => boardStats(rows.value))
const industries = computed(() => industryGroups(rows.value))
const filteredRows = computed(() => rows.value.filter(row =>
  (!activeIndustry.value || row.industry === activeIndustry.value)
  && (!query.value.trim() || `${row.name} ${row.code}`.includes(query.value.trim())),
))
const indexLabels = [
  { name: '上证指数', code: '000001.SH' }, { name: '深证成指', code: '399001.SZ' },
  { name: '创业板指', code: '399006.SZ' }, { name: '科创50', code: '000688.SH' },
]
const indices = computed(() => indexLabels.map(index => ({
  ...index, ...(market.value?.indices || []).find(quote => quote.code === index.code),
})))
const mixedDates = computed(() => indices.value.some(index => index.price != null
  && index.tradeDate && market.value?.meta?.tradeDate && index.tradeDate !== market.value.meta.tradeDate))
const ladder = computed(() => market.value?.ladder)
const ladderLevels = computed(() => [5, 4, 3, 2].map(level => ({
  level, count: null, stocks: [], ...(ladder.value?.levels || []).find(item => item.level === level),
})))
const ladderMax = computed(() => Math.max(1, ...ladderLevels.value.map(item => item.count || 0)))
const industryPanels = computed(() => [
  { title: '行业涨幅居前', items: industries.value.slice(0, 6) },
  { title: '行业涨幅居后', items: [...industries.value].reverse().slice(0, 6) },
])
const rankings = computed(() => [
  { title: '涨幅榜', field: 'pct', direction: -1, format: pct },
  { title: '跌幅榜', field: 'pct', direction: 1, format: pct },
  { title: '成交额榜', field: 'amountYuan', direction: -1, format: money },
  { title: '振幅榜', field: 'amplitude', direction: -1, format: value => `${value.toFixed(2)}%` },
].map(group => ({ ...group, items: filteredRows.value.filter(row => row[group.field] != null
    && (group.field !== 'pct' || (group.direction < 0 ? row.pct > 0 : row.pct < 0)))
  .sort((a, b) => (a[group.field] - b[group.field]) * group.direction).slice(0, 8) })))
const statusText = computed(() => refreshing.value || state.value === 'loading' ? '读取行情中'
  : state.value === 'unavailable' ? '更新失败' : rows.value.length ? '分区快照' : '暂无数据')
const breadthText = computed(() => stats.value.breadth == null ? '--' : stats.value.breadth.toFixed(1))
const ratio = computed(() => !stats.value.valid ? '--' : stats.value.down ? (stats.value.up / stats.value.down).toFixed(2) : '无下跌')
const newsItems = computed(() => (news.value?.items || []).slice(0, 12))

function pct(value) { return value == null ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%` }
function tone(value) { return value > 0 ? 'mb-up' : value < 0 ? 'mb-down' : 'mb-muted' }
function money(value) {
  if (value == null) return '--'
  return value >= 1e12 ? `${(value / 1e12).toFixed(2)}万亿` : `${(value / 1e8).toFixed(2)}亿`
}
function count(value) { return stats.value.valid ? value.toLocaleString() : '--' }
function openStock(stock) { decision.open({ code: stock.code }) }
function selectIndustry(name) { activeIndustry.value = activeIndustry.value === name ? '' : name }
function newsUrl(url) { return /^https?:\/\//i.test(url || '') ? url : undefined }
async function refresh() {
  refreshing.value = true
  if (!rows.value.length) state.value = 'loading'
  try { await Promise.all([reload(), reloadNews()]) } finally { refreshing.value = false }
}

const distribution = computed(() => ({
  animation: false,
  grid: { left: 12, right: 12, top: 30, bottom: 34 },
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  xAxis: { type: 'category', data: ['≤-7', '-7~\n-5', '-5~\n-3', '-3~\n0', '0', '0~\n3', '3~\n5', '5~\n7', '≥7'],
    axisLabel: { color: '#687c94', fontSize: 11, interval: 0 }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#dce5ef' } } },
  yAxis: { type: 'value', show: false },
  series: [{ type: 'bar', barMaxWidth: 20,
    label: { show: true, position: 'top', color: '#687c94', fontSize: 12 },
    data: stats.value.bins.map((value, i) => ({ value, itemStyle: { color: i < 4 ? '#16a782' : i > 4 ? '#e85b67' : '#9cadc2', borderRadius: [2, 2, 0, 0] } })) }],
}))
const radar = computed(() => {
  const valid = rows.value.filter(row => row.pct != null)
  const withOpen = valid.filter(row => row.open > 0)
  const withHigh = valid.filter(row => row.high > 0)
  const share = (count, total) => total ? count / total * 100 : 0
  return {
    animation: false,
    radar: { center: ['50%', '50%'], radius: '46%', splitNumber: 4, axisNameGap: 5,
      axisName: { color: '#687c94', fontSize: 12 },
      indicator: ['上涨', '强势≥5%', '收阳', '近高≤1%', '弱势≤-5%', '下跌'].map(name => ({ name, max: 100 })),
      splitArea: { areaStyle: { color: ['#ffffff', '#f3f8ff'] } },
      axisLine: { lineStyle: { color: '#dce7f5' } }, splitLine: { lineStyle: { color: '#dce7f5' } } },
    series: [{ type: 'radar', symbol: 'circle', symbolSize: 3,
      lineStyle: { color: '#4386df', width: 1.5 }, itemStyle: { color: '#4386df' }, areaStyle: { color: '#73a7ec', opacity: 0.22 },
      data: [{ value: [stats.value.breadth || 0, share(stats.value.strong, valid.length),
        share(withOpen.filter(row => row.price > row.open).length, withOpen.length),
        share(withHigh.filter(row => row.price >= row.high * 0.99).length, withHigh.length),
        share(stats.value.weak, valid.length), share(stats.value.down, valid.length)] }] }],
  }
})
</script>

<template>
  <section class="market-board" aria-label="市场看板" :aria-busy="refreshing || state === 'loading'">
    <header class="mb-toolbar">
      <div class="mb-title"><IconLayoutDashboard :size="18" /><h2>市场看板</h2><span class="mb-state">{{ statusText }}</span></div>
      <div class="mb-actions"><span>全市场日线 <b>{{ market?.meta?.tradeDate || '--' }}</b></span><button :disabled="refreshing || state === 'loading'" @click="refresh"><IconRefresh :size="14" :class="{ spinning: refreshing }" /> 刷新</button></div>
    </header>
    <div v-if="state === 'unavailable'" class="mb-alert" role="alert">{{ error?.message || '全市场行情暂不可用，请稍后刷新。' }}{{ rows.length ? '以下保留上次成功快照，请核对行情日。' : '' }}</div>
    <div v-if="state === 'loading'" class="mb-alert" role="status">正在读取全市场日线，首次加载可能需要约一分钟…</div>
    <p v-if="supplementState === 'loading'" class="mb-data-note" role="status">全市场统计已就绪，指数、涨跌停与连板数据正在单独更新；已有补充快照暂时保留。</p>
    <p v-else-if="supplementState === 'unavailable'" class="mb-alert" role="alert">补充行情更新失败，不影响下方全市场统计；已有补充快照保留原日期，请点击刷新重试。</p>

    <div class="mb-indices">
      <article v-for="index in indices" :key="index.code" class="mb-card mb-index">
        <div><h3>{{ index.name }}</h3><span :class="tone(index.pctChg)">{{ pct(index.pctChg) }}</span></div>
        <div><small>{{ index.code }}</small><b v-if="index.price != null" :class="tone(index.pctChg)">{{ index.price.toFixed(2) }}</b><small v-else>{{ state === 'loading' || supplementState === 'loading' ? '读取中' : '指数行情暂不可用' }}</small></div>
        <p class="mb-index-date">{{ index.price != null ? `${index.tradeDate} · ${index.session === 'intraday' ? '盘中快照' : '日线回退'}` : '等待有效行情' }}</p>
      </article>
    </div>
    <p class="mb-data-note">指数与全市场统计分别标注日期；指数源仅提供日期，精确行情延迟未知。</p>
    <div class="mb-history-heading"><h3>{{ market?.meta?.tradeDate || '--' }} · 收盘统计</h3><span>{{ mixedDates ? '与上方指数日期不同，以下不是今日盘中数据' : '以下按同日收盘快照统计' }}</span></div>
    <div class="mb-metrics">
      <article class="mb-card"><label>收盘上涨 / 平盘 / 下跌</label><strong><span class="mb-up">{{ count(stats.up) }}</span><i>/</i><span>{{ count(stats.flat) }}</span><i>/</i><span class="mb-down">{{ count(stats.down) }}</span></strong><small>{{ market?.meta?.tradeDate || '--' }} · 有效 {{ stats.valid }} / {{ stats.total }} 只</small></article>
      <article class="mb-card"><label>涨停池 / 跌停池（不含 ST）</label><strong><span class="mb-up">{{ market?.limitUp?.count ?? '--' }}</span><i>/</i><span class="mb-down">{{ market?.limitDown?.count ?? '--' }}</span></strong><small>{{ market?.meta?.tradeDate || '--' }} · {{ market?.limitUp?.status === 'ready' && market?.limitDown?.status === 'ready' ? '接口名单家数' : '部分名单暂不可用' }}</small></article>
      <article class="mb-card"><label>强势 / 弱势股</label><strong><span class="mb-up">{{ count(stats.strong) }}</span><i>/</i><span class="mb-down">{{ count(stats.weak) }}</span></strong><small>涨幅 ≥5% / 跌幅 ≥5%</small></article>
      <article class="mb-card"><label>最高连板</label><strong class="mb-blue">{{ ladder?.highest ?? '--' }}<em>板</em></strong><small>{{ ladder?.tradeDate || '--' }} · {{ ladder?.status === 'ready' ? '连板天梯' : '连板数据暂不可用' }}</small></article>
      <article class="mb-card"><label>成交总额</label><strong>{{ money(stats.amount) }}</strong><small>已覆盖 {{ stats.amountCount }} 只快照股票</small></article>
      <article class="mb-card"><label>上涨占比 / 涨跌比</label><strong class="mb-blue">{{ breadthText }}<em>%</em><i>/</i>{{ ratio }}</strong><small>按有效涨跌幅统计</small></article>
    </div>

    <div class="mb-overview">
      <article class="mb-card mb-distribution">
        <header class="mb-panel-head"><h3><IconChartBar :size="14" />涨跌分布 / 广度</h3><small>单位：% · 家数</small></header>
        <EChart v-if="stats.valid" :options="distribution" height="162px" />
        <div v-else class="mb-empty mb-chart-empty">{{ state === 'loading' ? '正在读取涨跌分布' : '暂无可核验的涨跌幅' }}</div>
        <div class="mb-breadth-bar" aria-hidden="true"><span :style="{ flex: stats.down, background: '#16a782' }" /><span :style="{ flex: stats.flat, background: '#9cadc2' }" /><span :style="{ flex: stats.up, background: '#e85b67' }" /></div>
        <div class="mb-bar-labels"><span class="mb-down">跌 {{ count(stats.down) }}</span><span>平 {{ count(stats.flat) }}</span><span class="mb-up">涨 {{ count(stats.up) }}</span></div>
        <div class="mb-mini-grid"><div><small>等权平均涨幅</small><b :class="tone(stats.average)">{{ pct(stats.average) }}</b></div><div><small>缺少涨跌幅</small><b>{{ stats.missing }} 只</b></div></div>
      </article>
      <article class="mb-card mb-radar">
        <header class="mb-panel-head"><h3><IconRadar :size="14" />情绪雷达</h3><small>涨跌结构</small></header>
        <div v-if="stats.valid" class="mb-radar-chart"><EChart :options="radar" height="224px" /><div class="mb-radar-value"><b>{{ breadthText }}</b><small>上涨占比 %</small></div></div>
        <div v-else class="mb-empty mb-chart-empty">暂无结构数据</div>
        <p class="mb-footnote">各维度为有效样本占比，不代表投资评分</p>
      </article>
      <article class="mb-card">
        <header class="mb-panel-head"><h3><IconBolt :size="14" />市场强度</h3><small>日线快照</small></header>
        <div class="mb-strength-grid">
          <div><small>涨幅 ≥7%</small><b class="mb-up">{{ count(stats.bins[8]) }}</b></div><div><small>跌幅 ≥7%</small><b class="mb-down">{{ count(stats.bins[0]) }}</b></div>
          <div><small>上涨家数</small><b class="mb-up">{{ count(stats.up) }}</b></div><div><small>下跌家数</small><b class="mb-down">{{ count(stats.down) }}</b></div>
          <div><small>上涨占比</small><b class="mb-blue">{{ breadthText }}%</b></div><div><small>涨跌比</small><b class="mb-blue">{{ ratio }}</b></div>
        </div>
        <header class="mb-panel-head mb-subhead"><h3>观测范围</h3></header>
        <div class="mb-strength-grid"><div><small>行情股票</small><b>{{ stats.total || '--' }}</b></div><div><small>行业分类</small><b>{{ industries.length || '--' }}</b></div></div>
      </article>
      <article class="mb-card mb-ladder">
        <header class="mb-panel-head"><h3><IconChartBar :size="14" />连板梯队</h3><small>{{ ladder?.tradeDate || '--' }}</small></header>
        <div v-for="group in ladderLevels" :key="group.level" class="mb-ladder-group">
          <div class="mb-ladder-row"><b>{{ group.level }}{{ group.level === 5 ? '+' : '' }}板</b><span><i :style="{ width: `${(group.count || 0) / ladderMax * 100}%` }" /></span><small>{{ group.count ?? '--' }} 家</small></div>
          <div v-if="group.stocks.length" class="mb-ladder-stocks"><button v-for="stock in group.stocks" :key="stock.code" @click="openStock(stock)">{{ stock.name }}<small v-if="group.level === 5"> {{ stock.boards }}板</small></button></div>
        </div>
        <p v-if="ladder?.status !== 'ready'" class="mb-empty">连板数据暂不可用</p>
      </article>
    </div>

    <div class="mb-bottom">
      <div class="mb-left">
        <div class="mb-industries">
          <article v-for="panel in industryPanels" :key="panel.title" class="mb-card">
            <header class="mb-panel-head"><h3><IconBuildingFactory2 :size="14" />{{ panel.title }}</h3><small>等权涨幅 · 点击筛选</small></header>
            <button v-for="(group, i) in panel.items" :key="group.name" class="mb-industry-row" :class="{ selected: activeIndustry === group.name }" :aria-pressed="activeIndustry === group.name" @click="selectIndustry(group.name)">
              <span class="mb-order">{{ i + 1 }}</span><span><b>{{ group.name }}</b><small>{{ group.count }} 只 · 领涨 {{ group.leader.name }}</small></span><strong :class="tone(group.pct)">{{ pct(group.pct) }}</strong>
            </button>
            <div v-if="!panel.items.length" class="mb-empty">暂无行业数据</div>
          </article>
        </div>
        <div class="mb-rank-toolbar"><span>个股排行 <small>{{ filteredRows.length }} 只</small></span><button v-if="activeIndustry" class="mb-filter" @click="activeIndustry = ''">{{ activeIndustry }} <IconX :size="12" /></button><input v-model="query" aria-label="筛选看板股票" placeholder="搜索名称 / 代码" /></div>
        <div class="mb-rankings">
          <article v-for="group in rankings" :key="group.title" class="mb-card">
            <header class="mb-panel-head"><h3>{{ group.title }}</h3><small>TOP 8</small></header>
            <button v-for="(stock, i) in group.items" :key="stock.code" class="mb-stock-row" @click="openStock(stock)">
              <span class="mb-order">{{ i + 1 }}</span><span><b>{{ stock.name || stock.code }}</b><small>{{ stock.code }} · {{ stock.price.toFixed(2) }}</small></span><span class="mb-stock-value"><b :class="group.field === 'pct' ? tone(stock.pct) : ''">{{ group.format(stock[group.field]) }}</b><small v-if="group.field !== 'pct'" :class="tone(stock.pct)">{{ pct(stock.pct) }}</small></span>
            </button>
            <div v-if="!group.items.length" class="mb-empty">{{ rows.length ? '没有匹配的股票' : '暂无行情数据' }}</div>
          </article>
        </div>
      </div>
      <aside class="mb-card mb-news">
        <header class="mb-panel-head"><h3><IconNews :size="14" />资讯动态</h3><small>{{ news?.meta?.sourceMode === 'fixtures' ? '演示资讯' : news?.meta?.sourceMode === 'live' ? '最新快照' : '缓存资讯' }}</small></header>
        <p class="mb-news-note">现有新闻源 · 非实时盘口异动</p>
        <a v-for="item in newsItems" :key="item.id || item.url || item.title" :href="newsUrl(item.url)" target="_blank" rel="noopener noreferrer" class="mb-news-row">
          <div><time>{{ item.time || '--' }}</time><span>{{ item.source || '市场资讯' }}</span><IconArrowUpRight v-if="newsUrl(item.url)" :size="12" /></div><b>{{ item.title }}</b>
        </a>
        <div v-if="newsState === 'unavailable'" class="mb-empty">资讯更新失败{{ newsItems.length ? '，当前保留最近快照' : '，请稍后刷新' }}</div>
        <div v-else-if="!newsItems.length" class="mb-empty">{{ newsState === 'loading' ? '正在读取资讯…' : '暂无资讯' }}</div>
      </aside>
    </div>
    <footer class="mb-source"><span>全市场：{{ market?.meta?.provider || '等待行情源' }} · 指数 / 涨跌停 / 连板：ProMax · 每 5 分钟读取快照</span><span>读取时间 {{ market?.meta?.generatedAt ? formatShanghaiTime(market.meta.generatedAt) : '--' }}</span></footer>
  </section>
</template>

<style scoped>
.market-board { --mb-line: #e1e8f1; --mb-muted: #687c94; color: #233f63; background: #ffffff; border: 1px solid #e1e8f1; border-radius: 12px; padding: 14px; font-size: 14px; font-variant-numeric: tabular-nums; color-scheme: light; }
.market-board :where(h2,strong,span) { color: inherit; }
.market-board h2,.market-board h3,.market-board p { margin: 0; }
.market-board h2 { font-size: 18px; font-weight: 650; }.market-board h3 { font-size: 14px; font-weight: 600; color: #233f63; }
.market-board small { font-size: 12px; color: var(--mb-muted); }.market-board button,.market-board input { font: inherit; }.market-board button { color: inherit; }
.market-board .mb-index-date { margin-top: 8px; color: var(--mb-muted); font-size: 12px; }
.market-board .mb-data-note { margin: 9px 0 3px; color: var(--mb-muted); font-size: 12px; line-height: 1.6; }
.mb-history-heading { margin-top: 12px; padding: 10px 12px; border: 1px solid #e1e8f1; border-radius: 6px; background: #f5f8fc; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; }
.mb-history-heading span { font-size: 12px; color: #687c94; line-height: 1.5; }
.market-board .mb-source { background: #fff; border-top: 1px solid var(--mb-line); margin-top: 12px; padding: 12px 0 0; white-space: normal; line-height: 1.6; }
.mb-ladder-row > span > i { display: block; height: 100%; background: #4386df; border-radius: inherit; }
.mb-ladder-stocks { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 10px 10px; max-height: 90px; overflow: auto; }
.mb-ladder-stocks button { border: 1px solid #dce7f5; border-radius: 4px; background: #f4f8fe; padding: 3px 5px; font-size: 12px; cursor: pointer; }
.market-board .mb-up { color: #df4b57; }.market-board .mb-down { color: #078869; }.market-board .mb-muted { color: var(--mb-muted); }.market-board .mb-blue { color: #2877db; }
.mb-toolbar,.mb-title,.mb-actions { display: flex; align-items: center; gap: 10px; }.mb-toolbar { justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; }.mb-title > svg { color: #4386df; }.mb-state { font-size: 12px; color: #238467; border: 1px solid #c8e8dc; background: #edf8f2; border-radius: 4px; padding: 2px 6px; }.mb-actions { font-size: 13px; color: #687c94; }.mb-actions b { color: #385373; font-weight: 500; }.mb-actions button { display: flex; gap: 5px; align-items: center; background: #f4f8fe; border: 1px solid #d7e3f2; border-radius: 4px; padding: 5px 10px; }
.mb-card { min-width: 0; border: 1px solid var(--mb-line); border-radius: 8px; background: #ffffff; overflow: hidden; }.mb-indices { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 7px; }.mb-index { padding: 11px 12px; }.mb-index > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.mb-index > div + div { margin-top: 10px; flex-wrap: wrap; }.mb-index > div > span { font-size: 20px; }
.mb-metrics { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 7px; margin-top: 7px; }.mb-metrics article { background: #f8faff; padding: 9px 10px; display: flex; flex-direction: column; gap: 5px; }.mb-metrics label { font-size: 12px; color: #687c94; }.mb-metrics strong { font-size: clamp(18px,1.55vw,24px); line-height: 1.3; white-space: nowrap; }.mb-metrics i { font-size: 15px; font-style: normal; color: #8191a5; margin: 0 4px; }.mb-metrics em { font-size: 13px; font-style: normal; margin-left: 3px; }
.mb-overview { display: grid; grid-template-columns: 1.25fr 1fr 1fr 1fr; gap: 7px; margin-top: 7px; }.mb-panel-head { min-height: 40px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; padding: 7px 9px; border-bottom: 1px solid #edf1f6; }.mb-panel-head h3 { display: flex; align-items: center; gap: 6px; }.mb-panel-head h3 > svg { color: #4386df; }.mb-panel-head small { font-size: 11px; }.mb-breadth-bar { display: flex; height: 5px; margin: 0 10px; background: #e9eef5; border-radius: 2px; overflow: hidden; }.mb-bar-labels { display: flex; justify-content: space-between; color: #687c94; font-size: 12px; padding: 7px 10px; }.mb-mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 0 8px 8px; }.mb-mini-grid > div { padding: 6px; background: #f5f8fc; display: grid; gap: 4px; }
.mb-radar-chart { position: relative; }.mb-radar-value { pointer-events: none; position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }.mb-radar-value b { font-size: 32px; line-height: 1.2; color: #2877db; text-shadow: 0 1px 5px #fff; }.mb-radar-value small { color: #5d7ba1; font-size: 11px; }.mb-footnote { text-align: center; font-size: 11px; color: #71829a; padding: 0 6px 9px; }
.mb-strength-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); padding: 8px; gap: 5px; }.mb-strength-grid > div { display: grid; gap: 5px; padding: 7px; background: #f5f8fc; }.mb-strength-grid b { font-size: 18px; }.mb-subhead { min-height: 30px; padding-top: 2px; padding-bottom: 2px; }.mb-ladder-row { padding: 17px 12px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #edf1f6; }.mb-ladder-row b { color: #2877db; font-size: 15px; min-width: 28px; }.mb-ladder-row > span { height: 4px; flex: 1; background: #e7edf5; border-radius: 2px; }
.mb-bottom { display: grid; grid-template-columns: minmax(0,3.25fr) minmax(0,1fr); gap: 7px; margin-top: 7px; }.mb-left { min-width: 0; }.mb-industries { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }.mb-industry-row,.mb-stock-row { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; padding: 10px 9px; text-align: left; background: transparent; border: 0; border-bottom: 1px solid #edf1f6; }.mb-industry-row:hover,.mb-stock-row:hover,.mb-industry-row.selected { background: #edf5ff; }.mb-order { flex: 0 0 12px; font-size: 12px; color: #8293a9; }.mb-industry-row > span:nth-child(2),.mb-stock-row > span:nth-child(2) { display: grid; gap: 5px; min-width: 0; flex: 1; }.mb-industry-row b,.mb-stock-row b { font-size: 13px; font-weight: 500; }.mb-industry-row small,.mb-stock-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }.mb-industry-row strong { font-size: 14px; font-weight: 500; flex-shrink: 0; }
.mb-rank-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 0 7px; }.mb-rank-toolbar > span { font-size: 13px; }.mb-rank-toolbar small { margin-left: 7px; }.mb-rank-toolbar input { min-width: 100px; width: 170px; margin-left: auto; padding: 5px 8px; border: 1px solid #d6e2f1; background: #ffffff; color: #233f63; border-radius: 4px; }.mb-filter { display: flex; align-items: center; gap: 5px; padding: 3px 6px; background: #eaf3ff; border: 1px solid #bdd6f7; border-radius: 4px; font-size: 12px !important; }.mb-rankings { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 7px; }.mb-stock-row { padding: 11px 6px; gap: 4px; }.mb-stock-value { display: grid; text-align: right; gap: 5px; flex-shrink: 0; }.mb-stock-value b { font-size: 12px; }.mb-stock-row > span:nth-child(2) b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mb-news-note { font-size: 12px; color: #687c94; padding: 8px 10px; background: #f5f8fc; }.mb-news-row { display: block; padding: 11px 10px; border-bottom: 1px solid #e1e8f1; text-decoration: none; }.mb-news-row[href]:hover { background: #f2f7fe; }.mb-news-row > div { display: flex; align-items: center; gap: 6px; color: #71839b; font-size: 11px; margin-bottom: 6px; }.mb-news-row > div > span { margin-left: auto; }.mb-news-row b { font-size: 13px; line-height: 1.7; font-weight: 400; color: #385373; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mb-empty { padding: 22px 10px; text-align: center; color: #71839b; font-size: 13px; line-height: 1.8; }.mb-chart-empty { height: 162px; display: grid; place-content: center; }.mb-source { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding-top: 12px; color: #71839b; font-size: 12px; }.mb-alert { padding: 9px 12px; margin-bottom: 8px; background: #fff8e9; border: 1px solid #f2dfb1; color: #916c21; border-radius: 4px; font-size: 13px; }.spinning { animation: mb-spin 1s linear infinite; }@keyframes mb-spin { to { transform: rotate(360deg); } }
@media (max-width: 1200px) { .mb-metrics { grid-template-columns: repeat(3,minmax(0,1fr)); }.mb-overview { grid-template-columns: repeat(2,minmax(0,1fr)); }.mb-bottom { grid-template-columns: minmax(0,1fr) 260px; }.mb-rankings { grid-template-columns: repeat(2,minmax(0,1fr)); }.mb-industry-row { flex-wrap: wrap; } }
@media (max-width: 850px) { .mb-bottom { grid-template-columns: minmax(0,1fr); }.mb-news { max-height: 390px; overflow: auto; }.mb-indices { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media (max-width: 520px) { .market-board { padding: 8px; }.mb-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }.mb-overview,.mb-industries { grid-template-columns: minmax(0,1fr); }.mb-indices small { font-size: 11px; }.mb-index { padding: 9px; }.mb-index > div + div { flex-wrap: wrap; gap: 4px; }.mb-actions { width: 100%; justify-content: space-between; }.mb-metrics strong { font-size: 20px; }.mb-rank-toolbar input { width: 140px; } }
</style>
