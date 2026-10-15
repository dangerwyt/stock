<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { useAppStore } from '@/stores/snapshot'
import { fetchSnapshot } from '@/api/client'
import { hydrateStock, displayField, formatShanghaiTime, formatShanghaiDateTime } from '@/utils/format'
import { useStockDecision } from '@/composables/useStockDecision'
import StatusBadge from '@/components/StatusBadge.vue'
import {
  IconSearch,
  IconFilter,
  IconChevronLeft,
  IconChevronRight,
  IconX,
  IconDatabase,
  IconActivity,
  IconTrendingUp,
  IconCircleCheck,
  IconStar,
  IconFileAnalytics,
  IconClock,
  IconUsersGroup,
  IconBell,
  IconShieldCheck,
  IconTargetArrow,
  IconBriefcase2,
  IconBrain,
  IconAlertTriangle,
} from '@tabler/icons-vue'

const router = useRouter()
const { data: snapshot, state, sourceMode } = useSnapshot('/api/top50', { refreshMs: 300000 })

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原版 12 位老师现已作为
// 自建角色写入 custom_agents.json（见任务②），所以分母回到 /12；仍不写死 12（用户可继续
// 增删角色），没有自建老师时兜 1 避免除零。
const teacherCount = computed(() => Number(snapshot.value?.meta?.teacherCount) || 1)

const CYCLES = ['超短', '短线', '波段', '中长线']
const query = ref('')
const page = ref(1)
const cycle = ref('超短')
const showFilters = ref(false)

const cycleData = computed(() => snapshot.value?.cycles?.[cycle.value] || null)
const rankedStocks = computed(() =>
  (cycleData.value?.ranking || []).map(hydrateStock).sort((a, b) => a.rank - b.rank),
)

// 自选股（全局 watchlist，localStorage 持久化）作为额外行追加到榜单下方：
// 搜索选股加入后，在 TOP50 表格展示并计入底部总数。
const store = useAppStore()
const wlMeta = ref({})
watch(
  () => store.watchlist.slice(),
  (codes) => {
    codes.forEach((code) => {
      if (wlMeta.value[code]) return
      fetchSnapshot(`/api/stocks/search?q=${encodeURIComponent(code)}`)
        .then((d) => {
          const hit = (d?.items || []).find((i) => i.code === code) || (d?.items || [])[0]
          if (hit) wlMeta.value = { ...wlMeta.value, [code]: { name: hit.name, industry: hit.industry } }
        })
        .catch(() => {})
    })
  },
  { immediate: true },
)
const watchlistExtras = computed(() => {
  const rankedCodes = new Set(rankedStocks.value.map((s) => s.code))
  return store.watchlist
    .filter((code) => !rankedCodes.has(code))
    .map((code) => {
      const m = wlMeta.value[code] || {}
      return {
        code,
        name: m.name || code,
        industry: m.industry || '自选跟踪',
        isWatchlist: true,
        rank: null,
        score: null,
        agentVotes: null,
        consensus: null,
        status: null,
        reason: null,
        invalid: null,
        marketDataDate: null,
        predictionId: null,
      }
    })
})
const combinedStocks = computed(() => [...rankedStocks.value, ...watchlistExtras.value])
const filtered = computed(() =>
  combinedStocks.value.filter((stock) =>
    `${stock.name}${stock.code}${stock.industry}`.includes(query.value.trim()),
  ),
)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 10)))
const currentPage = computed(() => Math.min(page.value, pageCount.value))
const pageStocks = computed(() =>
  filtered.value.slice((currentPage.value - 1) * 10, currentPage.value * 10),
)
watch([query, cycle], () => { page.value = 1 })

// 单股决策弹窗改由全局 StockDecisionDialog 承接（与顶栏搜索 / 行情中心加自选共用同一实例）。
// 这里只负责唤起：列表点股票名 → 带上当前周期 rankedStocks 作为上/下一只切换上下文。
const stockDecision = useStockDecision()
function openStockDecision(stock) {
  stockDecision.open({ code: stock.code, stock, ranked: rankedStocks.value })
}

function onTabKey(event, items, active, onChange) {
  const index = items.indexOf(active)
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  event.preventDefault()
  const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
  onChange(items[next])
  nextTick(() => {
    const buttons = event.currentTarget?.parentElement?.querySelectorAll('button')
    buttons?.[next]?.focus()
  })
}

// 四个周期在「自建老师完全接管」下每位 Agent 的权重都是 100%，看着一模一样，
// 但榜单确实不同 —— 差异全在**因子配比**上（后端按持有周期重配后下发 factorGroups）。
// 不把这层翻译出来，界面上会像 bug：同一个老师、同一个 100%，凭什么四份榜单不一样。
function factorGroupsLabel(item) {
  const groups = item?.factorGroups
  if (!groups) return ''
  return Object.entries(groups)
    .map(([group, share]) => `${group} ${Math.round(share * 100)}%`)
    .join(' · ')
}
</script>

<template>
  <div class="page-grid top50-page">
    <main class="primary-workspace">
      <!-- 状态条 -->
      <div class="top50-status-bar">
        <span :class="state === 'ready' ? 'ready' : 'warn'"><i /> {{ state === 'ready' ? '真实冻结榜单' : state === 'computing' ? '榜单计算中…' : '正在读取榜单' }}</span>
        <span>周期 <strong>{{ cycle }}</strong></span>
        <span>入选 <strong>{{ filtered.length }}只</strong></span>
        <span>榜单日 <strong>{{ snapshot?.meta?.tradeDate || '--' }}</strong></span>
        <span>行情截止 <strong>{{ snapshot?.meta?.marketDataDate || '--' }}</strong></span>
        <span>生成 <strong>{{ formatShanghaiTime(snapshot?.meta?.generatedAt) }}</strong></span>
      </div>

      <!-- 工具栏 -->
      <div class="page-toolbar">
        <div class="segmented" role="tablist" aria-label="TOP50周期切换">
          <button
            v-for="item in CYCLES"
            :key="item"
            role="tab"
            :aria-selected="cycle === item"
            :class="{ active: cycle === item }"
            @click="cycle = item"
            @keydown="onTabKey($event, CYCLES, cycle, (v) => (cycle = v))"
          >
            {{ item }}
          </button>
        </div>
        <label class="search-field">
          <IconSearch :size="15" />
          <el-input v-model="query" class="ep-form-control" placeholder="  搜索股票 / 代码 / 行业" clearable />
        </label>
        <button :class="['toolbar-button', { active: showFilters }]" @click="showFilters = !showFilters">
          <IconFilter :size="15" /> 筛选
        </button>

        <div v-if="showFilters" class="filter-bar">
          <span>策略：{{ teacherCount }}套因子画像</span><span>行业：全部</span><span>硬门槛：上市≥90天</span><span>排除涨跌停/低流动性/风险警示</span>
          <button @click="showFilters = false">收起</button>
        </div>
      </div>

      <!-- 榜单表 -->
      <div class="table-wrap">
        <table class="decision-table">
          <thead>
            <tr>
              <th>排名</th><th>股票/代码</th><th>所属行业</th><th>综合分</th><th>因子支持</th>
              <th>状态</th><th>是否自选</th><th>为什么入选</th><th>失效条件</th><th>行情日</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="stock in pageStocks"
              :key="stock.code"
              class="stock-row"
              @click="openStockDecision(stock)"
            >
              <td><span v-if="stock.isWatchlist" class="muted-dash">—</span><span v-else :class="`rank rank-${stock.rank}`">{{ stock.rank }}</span></td>
              <td><strong>{{ stock.name }}</strong><small>{{ stock.code }}</small></td>
              <td><b>{{ stock.industry || '--' }}</b></td>
              <td><b v-if="stock.isWatchlist" class="muted-dash">—</b><b v-else class="score-value">{{ stock.score }}</b></td>
              <td><b v-if="stock.isWatchlist" class="muted-dash">—</b><b v-else class="agent-vote-value">{{ stock.agentVotes ?? stock.consensus ?? 0 }}<small>/{{ teacherCount }}</small></b></td>
              <td><StatusBadge v-if="!stock.isWatchlist" :status="stock.status" /><span v-else class="muted-dash">—</span></td>
              <td>
                <span v-if="stock.isWatchlist" class="watchlist-badge">自选</span>
                <span v-else class="muted-dash">—</span>
              </td>
              <td><span v-if="stock.isWatchlist" class="muted-dash">—</span><span v-else class="top50-reason">{{ stock.reason || stock.trend }}</span></td>
              <td><span v-if="stock.isWatchlist" class="muted-dash">—</span><span v-else class="top50-invalid">{{ stock.invalid || '待更新' }}</span></td>
              <td><time v-if="stock.isWatchlist" class="muted-dash">—</time><time v-else>{{ stock.marketDataDate || snapshot?.meta?.marketDataDate || '--' }}</time></td>
              <td>
                <template v-if="stock.isWatchlist">
                  <button class="table-action evidence-trigger" @click.stop="stockDecision.openEvidence(stock)">查看证据</button>
                  <button class="table-action remove-watch" @click.stop="store.toggleWatch(stock.code)">
                    <IconX :size="14" /> 移除自选
                  </button>
                </template>
                <button v-else class="table-action evidence-trigger" :disabled="!stock.predictionId" @click.stop="stockDecision.openEvidence(stock)">查看证据</button>
              </td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="11">
                <div class="top50-table-empty">
                  <strong>{{ query.trim() ? '没有符合当前搜索条件的标的' : displayField(snapshot?.reason, `${cycle}暂无可展示榜单`) }}</strong>
                  <small>最后成功 {{ formatShanghaiDateTime(snapshot?.meta?.generatedAt) }} · 等待下一次 07:20 冻结榜单</small>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="table-footer">
          <span>共 {{ filtered.length }} 只 · 每页10只</span>
          <div>
            <button aria-label="上一页" :disabled="currentPage === 1" @click="page = currentPage - 1"><IconChevronLeft :size="15" /></button>
            <button
              v-for="n in pageCount"
              :key="n"
              :class="{ active: n === currentPage }"
              :aria-label="`第${n}页`"
              :aria-current="n === currentPage ? 'page' : undefined"
              @click="page = n"
            >{{ n }}</button>
            <button aria-label="下一页" :disabled="currentPage === pageCount" @click="page = currentPage + 1"><IconChevronRight :size="15" /></button>
          </div>
        </div>
      </div>

      <!-- 移动榜单 -->
      <div class="top50-mobile-list" :aria-label="`${cycle}移动榜单`">
        <article
          v-for="stock in filtered"
          :key="`${cycle}-${stock.code}`"
          class="top50-mobile-card"
          @click="openStockDecision(stock)"
        >
          <div class="top50-mobile-head">
            <strong>#{{ stock.rank }} {{ stock.name }}</strong>
            <StatusBadge :status="stock.status" />
          </div>
          <p>{{ stock.code }} · {{ stock.industry }}</p>
          <div class="top50-mobile-metrics">
            <span>综合分 <b>{{ stock.score }}</b></span>
            <span>因子支持 <b>{{ stock.agentVotes ?? stock.consensus ?? 0 }}/{{ teacherCount }}</b></span>
            <span>方向因子 <b>{{ stock.confidence ?? '--' }}/100</b></span>
            <span>领先画像 <b>{{ stock.topAgents?.[0] || '暂无' }}</b></span>
          </div>
          <small>{{ stock.reason || stock.trend }}</small>
          <div class="top50-mobile-actions">
            <button @click.stop="openStockDecision(stock)">查看详情</button>
            <button class="primary" :disabled="!stock.predictionId && !stock.isWatchlist" @click.stop="stockDecision.openEvidence(stock)">选股证据</button>
          </div>
          <small class="top50-mobile-cutoff">行情日 {{ stock.marketDataDate || snapshot?.meta?.marketDataDate || '--' }} · 失效：{{ stock.invalid || '待更新' }}</small>
        </article>
        <div v-if="!filtered.length" class="top50-mobile-empty">
          <strong>{{ query.trim() ? '没有符合当前搜索条件的标的' : displayField(snapshot?.reason, `${cycle}暂无可展示榜单`) }}</strong>
          <span>最后成功 {{ formatShanghaiDateTime(snapshot?.meta?.generatedAt) }}</span>
          <small>等待下一次 07:20 冻结榜单</small>
        </div>
      </div>

      <!-- 方法说明 -->
      <details class="top50-method-disclosure">
        <summary>查看选股方法、数据范围与Agent权重</summary>
        <section class="snapshot-banner">
          <div class="snapshot-icon"><IconDatabase :size="21" /></div>
          <div class="snapshot-title">
            <span>盘前自动任务</span>
            <strong>{{ state === 'loading' ? '正在读取共享缓存…' : sourceMode === 'live' ? `今日${cycle} TOP50已自动生成` : `${cycle}演示快照 · 待接入真实行情` }}</strong>
            <small>{{ sourceMode === 'live' ? '因子画像基于真实行情加权 · AI只做证据汇总与风险复核' : '真实行情不可用，不生成排名' }}</small>
          </div>
          <div class="snapshot-flow">
            <div><span>全市场</span><strong>{{ snapshot?.meta?.marketUniverse || '--' }}</strong></div>
            <IconChevronRight :size="15" />
            <div><span>初筛候选</span><strong>{{ snapshot?.meta?.candidateCount || '--' }}</strong></div>
            <IconChevronRight :size="15" />
            <div><span>因子画像</span><strong>{{ snapshot?.meta?.completedAgents || '--' }}/{{ snapshot?.meta?.agentCount || 12 }}</strong></div>
            <IconChevronRight :size="15" />
            <div><span>最终入选</span><strong>{{ snapshot?.meta?.selectedCount || 50 }}</strong></div>
          </div>
          <div class="snapshot-cache">
            <span :class="{ 'demo-source': sourceMode !== 'live' }"><i /> {{ sourceMode === 'live' ? '真实共享缓存已就绪' : '演示备用快照' }}</span>
            <strong>{{ cycleData?.snapshotId || '等待真实快照' }}</strong>
            <small>生成 {{ formatShanghaiTime(snapshot?.meta?.generatedAt) }} · A股交易日 07:20 自动运行</small>
          </div>
        </section>
        <section class="cycle-method-strip" :aria-label="`${cycle}选股方法`">
          <div class="method-lead">
            <span>本周期选股引擎</span>
            <strong>{{ snapshot?.meta?.selectionEngine || '等待真实因子快照' }}</strong>
            <small>AI不直接决定排名，只负责{{ snapshot?.meta?.aiRole || '证据汇总与风险复核' }}</small>
          </div>
          <div class="method-focus">
            <span>{{ cycle }}关注重点</span>
            <strong>{{ cycleData?.focus || '产业景气、趋势结构与风险收益比' }}</strong>
            <small>建议持有：{{ cycleData?.holdingPeriod || '2—8周' }}</small>
          </div>
          <div class="method-weights">
            <span>核心Agent权重</span>
            <div>
              <b v-for="item in cycleData?.weights || []" :key="item.agent">
                {{ item.agent }}<small>{{ item.weight }}%</small>
                <em v-if="factorGroupsLabel(item)" :title="`本周期按持有周期重配后的因子侧重：${factorGroupsLabel(item)}`">
                  {{ factorGroupsLabel(item) }}
                </em>
              </b>
            </div>
          </div>
        </section>
      </details>
    </main>
  </div>
</template>
