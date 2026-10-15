<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { useStockSearch } from '@/composables/useStockSearch'
import { useAppStore } from '@/stores/snapshot'
import { useStockDecision } from '@/composables/useStockDecision'
import { hydrateStock, formatShanghaiTime } from '@/utils/format'
import {
  IconSearch,
  IconRefresh,
  IconInfoCircle,
  IconDatabase,
  IconChevronRight,
  IconStar,
} from '@tabler/icons-vue'

const router = useRouter()
const store = useAppStore()
const stockDecision = useStockDecision()

const query = ref('')
const cycle = ref('短线')
const { items: directoryResults, state: directoryState } = useStockSearch(query)
const { data: market, state: marketState } = useSnapshot('/api/market', { refreshMs: 60000 })
const { data: status } = useSnapshot('/api/status', { refreshMs: 60000 })
const { data: top50 } = useSnapshot('/api/top50', { refreshMs: 300000 })
const { data: news, state: newsState } = useSnapshot('/api/news', { refreshMs: 60000 })

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原来写死 12，
// 但内置 12 位是原版 mock 人设，已从产品里去掉；没有自建老师时兜 1，避免除零。
const teacherCount = computed(() => Number(top50.value?.meta?.teacherCount) || 1)

const allTop50 = computed(() => {
  const items = Object.values(top50.value?.cycles || {})
    .flatMap((c) => c?.ranking || [])
    .map(hydrateStock)
  return [...new Map(items.map((i) => [i.code, i])).values()]
})
const stockByCode = computed(() => new Map(allTop50.value.map((i) => [i.code, i])))

const marketRows = computed(() =>
  (market.value?.quotes || []).map((quote) => {
    const ranked = stockByCode.value.get(quote.code)
    const price = Number(quote.price)
    const open = Number(quote.open)
    return {
      ...quote,
      name: ranked?.name || quote.name || quote.code,
      industry: ranked?.industry || '自选跟踪',
      ranked,
      price,
      open,
      changeFromOpen: open ? Number(((price / open - 1) * 100).toFixed(2)) : null,
    }
  }),
)

const cycleRanking = computed(() =>
  (top50.value?.cycles?.[cycle.value]?.ranking || []).map(hydrateStock),
)
const upCount = computed(() => marketRows.value.filter((i) => i.changeFromOpen > 0).length)
const downCount = computed(() => marketRows.value.filter((i) => i.changeFromOpen < 0).length)

const marketDegraded = computed(() =>
  ['degraded', 'partial'].includes(status.value?.health?.market?.status),
)
// 演示态：后端回落 fixture 时显式标 sourceMode='fixtures'（对齐 /api/top50 口径），
// 不再把种子数据误标成 live；这里据此显示「演示快照」而非误导性的「已连接 / 延迟」。
const marketDemo = computed(() =>
  market.value?.meta?.sourceMode === 'fixtures' || status.value?.health?.market?.status === 'fixtures',
)
const minuteMode = computed(() => Boolean(status.value?.health?.market?.isIntraday))
const realtimeDailyMode = computed(() => !marketDemo.value && /rt_k/i.test(String(market.value?.meta?.provider || '')))
const marketPanelTitle = computed(() =>
  marketDemo.value
    ? '行情快照（演示）'
    : minuteMode.value
      ? '盘中分钟行情'
      : realtimeDailyMode.value
        ? '当日行情'
        : '行情快照',
)
const marketPanelDescription = computed(() =>
  marketDemo.value
    ? '演示快照 · 行情中心未接入实时数据，当前展示种子样例；请核对报价时间'
    : minuteMode.value
      ? '真实分钟快照 · 价格方向按当前价相对开盘价计算'
      : realtimeDailyMode.value
        ? '盘中日线 / 收盘快照 · 按8轮计划采集，非逐笔实时'
        : '最近有效快照 · 价格方向按当前价相对开盘价计算',
)
const generatedAt = computed(() =>
  market.value?.meta?.generatedAt
    ? formatShanghaiTime(market.value.meta.generatedAt)
    : '--',
)

function fmtTime(raw) {
  const s = String(raw || '')
  if (s.includes('T')) {
    const t = Date.parse(s)
    if (Number.isFinite(t)) return new Date(t).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return s.match(/\d{2}:\d{2}/)?.[0] || '--'
}
function goStock(stock) {
  router.push('/top50')
}
// 行情中心「加入自选」：加完直接弹出与 TOP50 点股票名一致的单股决策弹窗。
function toggleWatchAndOpen(item) {
  const added = !store.has(item.code)
  store.toggleWatch(item.code)
  if (added) stockDecision.open({ code: item.code, stock: item })
}
function goTop50() {
  router.push('/top50')
}
function goNews() {
  router.push('/news')
}
</script>

<template>
  <div class="simple-page market-center-page">
    <div class="page-toolbar market-center-toolbar">
      <div>
        <h1>定时行情中心</h1>
        <p>盘中快照、自选跟踪、TOP50热度与资讯联动；点击股票打开完整决策浮层</p>
      </div>
      <div class="market-toolbar-actions">
        <label><IconSearch :size="17" /><input v-model="query" placeholder="搜索全部A股名称 / 6位代码" /></label>
        <button class="toolbar-button" @click="goTop50"><IconRefresh :size="16" /> 刷新行情</button>
      </div>
      <div v-if="query" class="market-search-results">
        <template v-if="directoryResults.length">
          <div v-for="item in directoryResults" :key="item.code" class="market-search-result-row">
            <button class="market-search-stock" :disabled="!stockByCode.get(item.code)" @click="goStock(stockByCode.get(item.code))">
              <span><strong>{{ item.name }}</strong><small>{{ item.code }} · {{ item.industry }}</small></span>
              <b>{{ stockByCode.get(item.code) ? `#${stockByCode.get(item.code).rank}` : item.market }}</b>
            </button>
            <button :class="['', store.watchlist.includes(item.code) ? 'active' : '']" @click="toggleWatchAndOpen(item)">
              <IconStar :size="14" /> {{ store.watchlist.includes(item.code) ? '已自选' : '加入' }}
            </button>
          </div>
        </template>
        <div v-else>{{ directoryState === 'loading' ? '正在搜索全A股目录…' : '没有找到匹配股票' }}</div>
      </div>
    </div>

    <div class="market-kpis">
      <section>
        <span>行情状态</span>
        <strong :class="marketDegraded ? 'neutral' : marketDemo ? 'neutral' : marketState === 'ready' ? 'positive' : 'neutral'">{{ marketDegraded ? '延迟' : marketDemo ? '演示快照' : marketState === 'ready' ? '已连接' : '读取中' }}</strong>
        <small>{{ status?.health?.market?.label || market?.meta?.provider || '等待真实行情' }}</small>
      </section>
      <section>
        <span>快照时间</span>
        <strong>{{ generatedAt }}<template v-if="marketDemo"> · 演示</template></strong>
        <small>上海时间 · 自动刷新60秒</small>
      </section>
      <section>
        <span>跟踪股票</span>
        <strong>{{ marketRows.length }}</strong>
        <small>当前自选与候选监控范围</small>
      </section>
      <section>
        <span>较开盘上涨 / 下跌</span>
        <strong><i class="price-up">{{ upCount }}</i> / <i class="price-down">{{ downCount }}</i></strong>
        <small>仅统计当前{{ marketRows.length }}只，不代表全市场</small>
      </section>
    </div>

    <div class="market-center-grid">
      <section class="panel market-live-panel">
        <div class="panel-head">
          <div><h2>{{ marketPanelTitle }}</h2><span>{{ marketPanelDescription }}</span></div>
          <span :class="['stream-state', marketState !== 'ready' || marketDegraded || marketDemo ? 'warn' : '']"><i /> {{ marketDegraded ? '行情延迟' : marketDemo ? '演示快照 · 待接入' : marketState === 'ready' ? '行情已读取' : '沿用最近快照' }}</span>
        </div>
        <div class="market-live-table">
          <div class="market-live-head">
            <span>股票</span><span>现价</span><span>较开盘</span><span>最高 / 最低</span><span>成交额</span><span>数据时间</span>
          </div>
          <button v-for="item in marketRows" :key="item.code" @click="goStock(item.ranked || item)">
            <span><strong>{{ item.name }}</strong><small>{{ item.code }} · {{ item.industry }}</small></span>
            <b>{{ Number.isFinite(item.price) ? item.price.toFixed(2) : '--' }}</b>
            <em :class="item.changeFromOpen >= 0 ? 'price-up' : 'price-down'">{{ Number.isFinite(item.changeFromOpen) ? `${item.changeFromOpen >= 0 ? '+' : ''}${item.changeFromOpen}%` : '--' }}</em>
            <span>{{ Number.isFinite(Number(item.high)) ? Number(item.high).toFixed(2) : '--' }} / {{ Number.isFinite(Number(item.low)) ? Number(item.low).toFixed(2) : '--' }}</span>
            <span>{{ Number.isFinite(Number(item.amount)) ? `${(Number(item.amount) / 100000000).toFixed(2)}亿` : '--' }}</span>
            <time :class="['stale', 'stale'].includes(item.freshness) ? 'stale' : ''">{{ fmtTime(item.observedAt || item.time) }}{{ ['stale', 'snapshot'].includes(item.freshness) ? ' 快照' : '' }}</time>
          </button>
        </div>
        <div v-if="!marketRows.length" class="account-empty">
          <IconDatabase :size="22" /><strong>暂无行情快照</strong>
          <p>系统会保留最近有效快照，不使用静态价格填充。</p>
        </div>
        <div class="market-scope-note">
          <IconInfoCircle :size="16" />
          <span>当前接口按自选与候选集合抓取{{ minuteMode ? '分钟行情快照' : realtimeDailyMode ? '盘中日线快照' : '行情快照' }}，按8轮计划采集，不是逐笔实时或全市场涨跌家数；请核对报价时间。</span>
        </div>
      </section>

      <aside class="panel market-hot-panel">
        <div class="panel-head">
          <div><h2>TOP50热度</h2><span>{{ cycle }}周期 · 最近交易日冻结榜</span></div>
          <button @click="goTop50">完整榜单 <IconChevronRight :size="14" /></button>
        </div>
        <div class="market-cycle-tabs">
          <button v-for="item in ['超短', '短线', '波段', '中长线']" :key="item" :class="{ active: cycle === item }" @click="cycle = item">{{ item }}</button>
        </div>
        <div class="market-hot-list">
          <button v-for="item in cycleRanking.slice(0, 8)" :key="item.code" @click="goStock(item)">
            <b>#{{ item.rank }}</b>
            <span><strong>{{ item.name }}</strong><small>{{ item.code }} · {{ item.industry }}</small></span>
            <span><strong :class="item.pct >= 0 ? 'price-up' : 'price-down'">{{ item.pct >= 0 ? '+' : '' }}{{ item.pct }}%</strong><small>{{ item.agentVotes }}/{{ teacherCount }} 因子支持</small></span>
          </button>
        </div>
      </aside>

      <aside class="panel market-news-panel">
        <div class="panel-head">
          <div><h2>定时资讯</h2><span>{{ news?.meta?.sourceMode === 'live' ? '真实资讯源' : '最近缓存' }}</span></div>
          <button @click="goNews">资讯中心 <IconChevronRight :size="14" /></button>
        </div>
        <div class="market-news-list">
          <a v-for="item in (news?.items || []).slice(0, 8)" :key="item.id" :href="item.url" target="_blank" rel="noreferrer">
            <time>{{ item.time }}</time>
            <span><strong>{{ item.title }}</strong><small>{{ item.market || 'A股' }} · {{ item.source }}</small></span>
          </a>
        </div>
        <div v-if="newsState === 'loading'" class="account-empty"><IconRefresh :size="20" /><strong>正在读取资讯</strong></div>
      </aside>
    </div>
  </div>
</template>
