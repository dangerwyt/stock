<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { useAppStore } from '@/stores/snapshot'
import StatusBadge from '@/components/StatusBadge.vue'
import {
  IconClock,
  IconShieldCheck,
  IconDatabase,
  IconChartBar,
  IconWorld,
  IconBuildingFactory2,
  IconChevronRight,
  IconStar,
} from '@tabler/icons-vue'
import { formatShanghaiTime, formatShanghaiDateTime, hydrateStock, resolveWatchlistStocks, buildLiveUniverse } from '@/utils/format'

const router = useRouter()
const store = useAppStore()

const { data: top50 } = useSnapshot('/api/top50')
const { data: status } = useSnapshot('/api/status', { refreshMs: 60000 })
const { data: etfMap } = useSnapshot('/api/us-etf-map', { refreshMs: 1800000 })
const { data: news } = useSnapshot('/api/news', { refreshMs: 300000 })
const { data: market } = useSnapshot('/api/market')

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原来写死 12，
// 但内置 12 位是原版 mock 人设，已从产品里去掉；没有自建老师时兜 1，避免除零。
const teacherCount = computed(() => Number(top50.value?.meta?.teacherCount) || 1)

const activeSector = ref(null)

function go(id) {
  router.push(id === 'overview' ? '/' : `/${id}`)
}
function goTop50(mapping) {
  router.push('/top50')
}
// 四周期表格行 / 查看详情：带上当前预览周期，直达 TOP50 页对应 tab。
function goTop50Cycle(cycle) {
  router.push({ path: '/top50', query: { cycle } })
}

// --- HomeMetrics ---
const metrics = computed(() => {
  const marketHealth = status.value?.health?.market
  const marketLabel = marketHealth?.label?.includes('收盘')
    ? '收盘快照'
    : marketHealth?.status === 'degraded'
      ? '行情降级'
      : marketHealth?.label
        ? '行情快照'
        : '等待观测'
  return [
    { icon: IconClock, label: '北京时间', value: status.value?.session?.date || '等待观测', detail: status.value?.session?.label || 'Asia/Shanghai' },
    { icon: IconShieldCheck, label: '行情状态', value: marketLabel, detail: marketHealth?.label || '按轮次采集 · 非实时行情' },
    { icon: IconDatabase, label: '数据更新', value: top50.value?.meta?.marketDataDate || '待更新', detail: 'TOP50 行情基准日' },
    { icon: IconChartBar, label: '研究覆盖', value: `${Object.keys(top50.value?.cycles || {}).length} 个周期`, detail: '超短 / 短线 / 波段 / 中长线' },
  ]
})

// --- IndustryHeatmap (隔夜美股ETF影响) ---
const etfItems = computed(() => etfMap.value?.items || [])
const etfMeta = computed(() => etfMap.value?.meta || {})
const etfFreshness = computed(() => {
  const mode = etfMap.value?.meta?.sourceMode
  if (mode === 'live') return `采集于${formatShanghaiDateTime(etfMeta.value.generatedAt)}`
  if (mode === 'partial') return `部分更新 ${etfMeta.value.freshCount || 0}/${etfItems.value.length || 12}`
  return '最近成功快照'
})
const etfGroups = computed(() => {
  const ordered = [...etfItems.value].sort((a, b) => Number(b.pctChange) - Number(a.pctChange))
  const half = Math.ceil(ordered.length / 2)
  return [
    ['涨幅居前', ordered.slice(0, half)],
    ['涨幅居后', ordered.slice(half)],
  ]
})
function toggleSector(item) {
  activeSector.value = activeSector.value?.symbol === item.symbol ? null : item
}

// --- HomeTop50Summary ---
const windows = ['超短', '短线', '波段', '中长线']
const activeCycle = ref('超短')
const cycleData = computed(() => top50.value?.cycles?.[activeCycle.value])
const cycleRanking = computed(() => {
  const list = (cycleData.value?.ranking || []).map(hydrateStock)
  const sector = activeSector.value
  if (!sector) return list
  return list.filter((item) => (sector.industryKeywords || []).some((kw) => item.industry.includes(kw)))
})
const cyclePreview = computed(() => cycleRanking.value.slice(0, 5))
const top50Columns = ['排名', '股票', '行业', '综合分', '因子支持', '状态']
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date())
const top50IsToday = computed(() => top50.value?.meta?.tradeDate === today)
const top50EmptyReason = computed(
  () => cycleData.value?.reason || top50.value?.reason || (top50.value ? `${activeCycle.value}当前没有满足风控门槛的标的` : '真实TOP50快照尚未生成'),
)

// --- HomeWatchlistSummary ---
const liveUniverse = computed(() => buildLiveUniverse(top50.value, market.value))

// 自选里既不在 TOP50、也不在 /api/market 行情样本内的代码：按代码实时取一次行情，
// 否则首页只能退化成「待刷新」。对齐 reference-react 的 watchlistLiveUniverse——
// 原型的行情快照覆盖自选；本项目 /api/market 是固定样本，故用 /api/stocks/{code}/quote 补齐。
const extraQuotes = ref({})
let quoteToken = 0
function normalizeQuote(code, q) {
  const price = Number(q?.close ?? q?.price)
  if (!Number.isFinite(price)) return null
  const preClose = Number(q?.preClose ?? q?.pre_close)
  const open = Number(q?.open)
  let pct = q?.pct != null && Number.isFinite(Number(q.pct)) ? Number(q.pct) : null
  if (pct == null) {
    if (preClose > 0) pct = Number(((price / preClose - 1) * 100).toFixed(2))
    else if (open > 0) pct = Number(((price / open - 1) * 100).toFixed(2))
    else pct = 0
  }
  return {
    code,
    name: q?.name || code,
    industry: q?.industry || '自选跟踪',
    close: price,
    pct,
  }
}
async function loadMissingQuotes() {
  const have = new Set(liveUniverse.value.map((item) => item.code))
  const missing = store.watchlist.filter((code) => !have.has(code) && !extraQuotes.value[code])
  if (!missing.length) return
  const token = ++quoteToken
  const entries = await Promise.all(
    missing.slice(0, 12).map(async (code) => {
      try {
        const resp = await fetch(`/api/stocks/${code}/quote`)
        if (!resp.ok) return null
        const data = await resp.json()
        if (data?.status !== 'ready' || !data.quote) return null
        return normalizeQuote(code, data.quote)
      } catch {
        return null
      }
    }),
  )
  if (token !== quoteToken) return
  const next = { ...extraQuotes.value }
  for (const entry of entries) if (entry) next[entry.code] = entry
  extraQuotes.value = next
}
const watchUniverse = computed(() => {
  const base = liveUniverse.value
  const have = new Set(base.map((item) => item.code))
  const extra = Object.values(extraQuotes.value).filter((q) => q && !have.has(q.code))
  return extra.length ? [...base, ...extra] : base
})
watch(
  [() => top50.value, () => market.value, () => store.watchlist.join(',')],
  () => {
    loadMissingQuotes()
  },
  { immediate: true },
)
const watchItems = computed(() => resolveWatchlistStocks(store.watchlist, watchUniverse.value, {}).slice(0, 6))

// --- IntegratedNewsFeed ---
const newsTab = ref('市场资讯')
const newsTabs = ['个股资讯', '市场资讯', '要闻']
const newsSource = computed(() => (news.value?.items || []).filter((item) => item.tier === 'primary'))
function isStockNews(item) {
  return Boolean(item.code || (item.stock && item.stock !== '市场') || item.type === '个股')
}
const newsTickerItems = computed(() => {
  const headlines = newsSource.value.filter((i) => i.impact === '高' || ['宏观', '政策', '要闻'].includes(i.type))
  return (headlines.length ? headlines : newsSource.value).slice(0, 8)
})
const tickerIndex = ref(0)
let tickerTimer = null
const ticker = computed(() => {
  const list = newsTickerItems.value
  return list.length ? list[tickerIndex.value % list.length] : null
})
const newsList = computed(() => {
  const src = newsSource.value
  if (newsTab.value === '个股资讯') return src.filter(isStockNews).slice(0, 7)
  if (newsTab.value === '市场资讯') return src.filter((i) => !isStockNews(i)).slice(0, 7)
  return newsTickerItems.value.slice(0, 7)
})

onMounted(() => {
  tickerTimer = window.setInterval(() => {
    const len = newsTickerItems.value.length
    if (len > 1) tickerIndex.value = (tickerIndex.value + 1) % len
  }, 5000)
})
onUnmounted(() => {
  if (tickerTimer) window.clearInterval(tickerTimer)
})
</script>

<template>
  <div class="integrated-home">
    <div class="reference-home-metrics">
      <section v-for="m in metrics" :key="m.label">
        <component :is="m.icon" :size="29" :stroke="1.4" />
        <div><span>{{ m.label }}</span><strong>{{ m.value }}</strong><small>{{ m.detail }}</small></div>
      </section>
    </div>

    <section class="market-brief-screen">
      <div class="market-brief-grid">
        <!-- 隔夜美股ETF影响 -->
        <section class="integrated-panel industry-heatmap" aria-label="隔夜美股ETF影响">
          <header class="integrated-panel-head">
            <div>
              <h2><IconWorld :size="20" /> 隔夜美股ETF影响</h2>
              <span>美股交易日 {{ etfMeta.marketDate || '待更新' }} · {{ etfFreshness }}</span>
            </div>
            <button @click="go('industries')">查看更多 <IconChevronRight :size="14" /></button>
          </header>
          <div class="etf-reference-groups">
            <section v-for="[label, group] in etfGroups" :key="label">
              <h3>{{ label }}<small>非A股行业涨跌</small></h3>
              <button
                v-for="item in group"
                :key="item.symbol"
                :class="{ selected: activeSector?.symbol === item.symbol }"
                @click="toggleSector(item)"
              >
                <IconBuildingFactory2 :size="15" />
                <strong>{{ item.aShareSector }}</strong>
                <b :class="item.pctChange >= 0 ? 'price-up' : 'price-down'">
                  {{ item.pctChange >= 0 ? '+' : '' }}{{ Number(item.pctChange).toFixed(2) }}%
                </b>
              </button>
            </section>
          </div>
          <footer>
            <span>{{ activeSector ? `已联动筛选：${activeSector.aShareSector}` : '点击行业可联动筛选右侧TOP50' }}</span>
            <button @click="go('industries')">查看全部行业 <IconChevronRight :size="14" /></button>
          </footer>
        </section>

        <!-- 四周期TOP50 -->
        <section class="integrated-panel home-top50-summary design-top50-strip">
          <header>
            <div>
              <h2>四周期TOP50 · {{ top50IsToday ? '今日冻结' : '最近一期' }}</h2>
              <button v-if="activeSector" class="home-sector-chip" @click="goTop50(activeSector)">
                {{ activeSector.aShareSector }} <IconChevronRight :size="13" />
              </button>
            </div>
            <span>
              {{ top50?.meta?.tradeDate || '--' }}榜单 · {{ formatShanghaiTime(top50?.meta?.generatedAt) }}生成 ·
              行情基准 {{ top50?.meta?.marketDataDate || '--' }}收盘{{ top50IsToday ? '' : ' · 今日榜单未就绪' }}
            </span>
          </header>
          <div class="home-top50-window-tabs" role="tablist" aria-label="首页四周期TOP50">
            <button
              v-for="w in windows"
              :key="w"
              role="tab"
              :aria-selected="activeCycle === w"
              :class="{ active: activeCycle === w }"
              @click="activeCycle = w"
            >{{ w }}</button>
          </div>
          <div class="home-top50-preview-head" role="row">
            <span v-for="c in top50Columns" :key="c" role="columnheader">{{ c }}</span>
          </div>
          <div class="home-top50-preview-rows" :aria-label="`${activeCycle}榜单预览，共${cycleRanking.length}只`">
            <button
              v-for="(item, i) in cyclePreview"
              :key="`${activeCycle}:${item.code}`"
              class="home-top50-preview-row"
              role="row"
              @click="goTop50Cycle(activeCycle)"
            >
              <b>#{{ item.rank || i + 1 }}</b>
              <span><strong>{{ item.name }}</strong><small>{{ item.code }}</small></span>
              <span>{{ item.industry }}</span>
              <b>{{ item.score }}</b>
              <span>{{ item.consensus }}/{{ teacherCount }}</span>
              <StatusBadge :status="item.status" />
            </button>
            <div v-if="!cyclePreview.length" class="home-top50-preview-empty">
              <strong>{{ top50EmptyReason }}</strong>
              <span>最后成功 {{ formatShanghaiDateTime(top50?.meta?.generatedAt) }}</span>
              <small>等待下一次 07:20 冻结榜单</small>
            </div>
          </div>
          <button class="home-summary-detail" @click="goTop50Cycle(activeCycle)">查看详情 <IconChevronRight :size="15" /></button>
        </section>

        <!-- 我的自选 -->
        <section class="integrated-panel home-watchlist-summary" aria-label="自选股提醒">
          <header class="integrated-panel-head">
            <div>
              <h2>我的自选</h2>
              <span>{{ store.watchlist.length ? `${store.watchlist.length}只正在跟踪` : '先添加关注股票' }}</span>
            </div>
            <button @click="go('portfolio')">{{ store.watchlist.length ? '管理自选' : '添加股票' }} <IconChevronRight :size="14" /></button>
          </header>
          <div class="home-watchlist-list">
            <button v-for="item in watchItems" :key="item.code" :disabled="!item.decisionAvailable" @click="go('portfolio')">
              <span><strong>{{ item.name }}</strong><small>{{ item.code }} · {{ item.industry }}</small></span>
              <b v-if="item.watchlistDataAvailable" :class="item.pct >= 0 ? 'price-up' : 'price-down'">
                {{ item.pct >= 0 ? '+' : '' }}{{ item.pct }}%<small>{{ item.price.toFixed(2) }}</small>
              </b>
              <b v-else>待刷新</b>
            </button>
            <div v-if="!watchItems.length" class="home-watchlist-empty">
              <IconStar :size="22" />
              <strong>还没有自选股</strong>
              <span>添加股票后，在这里查看今日变化和风险提醒。</span>
              <button @click="go('portfolio')">添加第一只股票</button>
            </div>
          </div>
        </section>

        <!-- 定时资讯 -->
        <section class="integrated-panel integrated-news" aria-label="定时资讯">
          <header class="integrated-panel-head">
            <div>
              <h2>定时资讯</h2>
              <!-- <span :class="news?.meta?.sourceMode === 'live' ? 'live' : 'warn'">
                <i /> {{ news?.meta?.collection?.label || (news?.meta?.delayed ? '资讯更新延迟' : news?.meta?.sourceMode === 'live' ? '真实资讯源' : '最近真实缓存') }}
              </span> -->
            </div>
            <button @click="go('news')">资讯中心 <IconChevronRight :size="14" /></button>
          </header>
          <div class="integrated-tabs" role="tablist" aria-label="首页资讯分类">
            <button
              v-for="t in newsTabs"
              :key="t"
              role="tab"
              :aria-selected="newsTab === t"
              :class="{ active: newsTab === t }"
              @click="newsTab = t"
            >{{ t }}</button>
          </div>
          <a v-if="ticker" class="integrated-ticker" :href="ticker.url" target="_blank" rel="noreferrer">
            <b>要闻滚动</b><span>{{ ticker.title }}</span><time>{{ ticker.time }}</time>
          </a>
          <div class="integrated-news-list">
            <a v-for="item in newsList" :key="item.id" :href="item.url" target="_blank" rel="noreferrer">
              <time>{{ item.time }}</time>
              <i :class="item.tone" />
              <div>
                <strong>{{ item.title }}</strong>
                <small>{{ item.source }} · {{ item.market || 'A股' }} · {{ item.score ?? '--' }}分</small>
              </div>
            </a>
            <div v-if="!newsList.length" class="integrated-empty">当前真实资讯源暂无主要级别{{ newsTab }}</div>
          </div>
        </section>
      </div>
    </section>

    <div class="integrated-disclaimer">
      <IconShieldCheck :size="15" />
      <span>本平台提供的所有信息仅供研究参考，不构成证券投资建议；行情延迟或数据不完整时禁止用于交易执行。</span>
    </div>
  </div>
</template>
