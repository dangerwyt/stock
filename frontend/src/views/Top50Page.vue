<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { fetchSnapshot } from '@/api/client'
import StatusBadge from '@/components/StatusBadge.vue'
import {
  hydrateStock,
  displayField,
  formatShanghaiTime,
  formatShanghaiDateTime,
  formatDailyAmount,
} from '@/utils/format'
import {
  IconSearch,
  IconFilter,
  IconChevronLeft,
  IconChevronRight,
  IconX,
  IconDatabase,
  IconBrain,
  IconAlertTriangle,
  IconBriefcase2,
  IconTargetArrow,
  IconActivity,
  IconTrendingUp,
  IconCircleCheck,
  IconStar,
  IconFileAnalytics,
  IconClock,
  IconUsersGroup,
  IconBell,
  IconShieldCheck,
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
const selectedCode = ref(null)
// ① 还原原版 top50「点击行 / 股票 → 弹窗」：基于 Element Plus el-dialog（用户要求）。
// 右栏曾是手写 aside，现改为居中弹窗，遮罩/Esc/点击遮罩关闭/焦点陷阱全交给 EP 接管。
const dialogOpen = ref(false)
function openDialog(code) {
  selectedCode.value = code
  dialogOpen.value = true
}

const cycleData = computed(() => snapshot.value?.cycles?.[cycle.value] || null)
const rankedStocks = computed(() =>
  (cycleData.value?.ranking || []).map(hydrateStock).sort((a, b) => a.rank - b.rank),
)
const filtered = computed(() =>
  rankedStocks.value.filter((stock) =>
    `${stock.name}${stock.code}${stock.industry}`.includes(query.value.trim()),
  ),
)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 10)))
const currentPage = computed(() => Math.min(page.value, pageCount.value))
const pageStocks = computed(() =>
  filtered.value.slice((currentPage.value - 1) * 10, currentPage.value * 10),
)
watch([query, cycle], () => { page.value = 1 })

const selected = computed(() => rankedStocks.value.find((s) => s.code === selectedCode.value) || null)
const selectedIndex = computed(() =>
  selected.value ? rankedStocks.value.findIndex((s) => s.code === selected.value.code) : -1,
)
function changeSelected(offset) {
  if (!rankedStocks.value.length) return
  const next = (selectedIndex.value + offset + rankedStocks.value.length) % rankedStocks.value.length
  selectedCode.value = rankedStocks.value[next].code
}

// ---- 还原原版 SingleStockDecisionCard 的监控指标与决策数据 ----
// getMonitorMetrics 直接搬 reference-react/App.jsx:595；amount 字段走 formatDailyAmount。
function buildMonitorMetrics(stock) {
  if (!stock) return null
  const probability = Number(stock.probabilityUp)
  return {
    volumeRatio: Number.isFinite(Number(stock.volumeRatio)) ? Number(stock.volumeRatio) : null,
    turnover: Number.isFinite(Number(stock.turnoverRate)) ? Number(stock.turnoverRate) : null,
    amount: formatDailyAmount(stock.amount, stock.amountUnit),
    amplitude: Number.isFinite(Number(stock.amplitude)) ? `${Number(stock.amplitude).toFixed(2)}%` : '--',
    pe: Number.isFinite(Number(stock.peTtm)) && Number(stock.peTtm) > 0 ? Number(stock.peTtm).toFixed(1) : '--',
    upProb: Number.isFinite(probability) ? Math.round(probability * 100) : null,
    signal: stock.trend || '暂无量价结论',
    confidence: Number.isFinite(probability) ? Math.round(probability * 100) : null,
  }
}
const monitorMetrics = computed(() => buildMonitorMetrics(selected.value))

// 票数：原版 Math.min(12, agentVotes)，本项目分母随实际老师数变化（task②）。
const displayConsensus = computed(() =>
  Math.min(teacherCount.value, Number(selected.value?.agentVotes ?? selected.value?.consensus ?? 0)),
)
const trendLabel = computed(() => {
  const up = monitorMetrics.value?.upProb
  if (up == null) return '待计算'
  return up >= 60 ? '偏多' : up >= 50 ? '中性偏多' : '偏弱'
})
const recommendation = computed(() => {
  const status = selected.value?.status
  return status === '可试仓' ? '满足触发后可小仓试错' : status === '等待确认' ? '等待右侧确认' : '仅观察'
})

// 决策卡进度条宽度：模板属性内只放计算好的百分比字符串（约定：禁止内联表达式）。
const powerTrackWidth = computed(() => {
  const total = teacherCount.value || 1
  return `${Math.min(100, Math.max(0, (displayConsensus.value / total) * 100))}%`
})
const powerTrackRest = computed(() => {
  const total = teacherCount.value || 1
  return `${Math.min(100, Math.max(0, (1 - displayConsensus.value / total) * 100))}%`
})

// 半环仪表盘（替换原版 Recharts PieChart；三色段 谨慎/中性/乐观，纯 SVG，无额外依赖）。
const gaugeColors = ['#f05e65', '#d8a63d', '#59bf79']
function polarPoint(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}
function arcPath(cx, cy, r, a1, a2) {
  const [x1, y1] = polarPoint(cx, cy, r, a1)
  const [x2, y2] = polarPoint(cx, cy, r, a2)
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}
const gaugeArcs = computed(() => {
  const segments = [35, 30, 35]
  let start = 180
  return segments.map((s, i) => {
    const end = start - (s / 100) * 180
    const d = arcPath(60, 60, 48, start, end)
    start = end
    return { d, color: gaugeColors[i] }
  })
})

// 自选 / 提醒（原版本地 state；本项目暂做 UI 态，不落盘）。
const tracked = ref(true)
const watchlisted = ref(false)
const followup = ref({ price: false, risk: false, preMarket: false })
function toggleWatchlist() {
  watchlisted.value = !watchlisted.value
}
function toggleFollowup(key) {
  followup.value[key] = !followup.value[key]
}

// 数据可信度条文案（原版 StockDecisionModal 的 stock-data-trust）。
const trustLabel = computed(() => {
  if (sourceMode.value === 'live' && state.value === 'ready') return '当日快照'
  return '数据待更新'
})
const trustFresh = computed(() => sourceMode.value === 'live' && state.value === 'ready')
const snapshotMeta = computed(() => snapshot.value?.meta || null)

function goPortfolio() {
  router.push('/portfolio')
}
function openFullAnalysis(stock) {
  // 「完整分析」：本项目用冻结选股证据弹窗承接（TOP50 标的都带 predictionId）。
  if (stock?.predictionId) openEvidence(stock, { stopPropagation() {} })
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

// ---- 冻结选股证据 ----
const evidenceId = ref(null)
const evidence = ref(null)
const evidenceState = ref('idle')
let evidenceToken = 0

function closeEvidence() {
  evidenceToken += 1
  evidenceId.value = null
  evidence.value = null
  evidenceState.value = 'idle'
}
function onKeydown(event) {
  if (event.key === 'Escape' && evidenceId.value) closeEvidence()
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
})
async function openEvidence(stock, event) {
  const predictionId = stock?.predictionId
  if (!predictionId) return
  event.stopPropagation()
  const token = ++evidenceToken
  evidenceId.value = predictionId
  evidence.value = null
  evidenceState.value = 'loading'
  try {
    const data = await fetchSnapshot(`/api/top50/evidence?predictionId=${encodeURIComponent(predictionId)}`)
    if (token !== evidenceToken) return
    if (data?.evidence) {
      evidence.value = data
      evidenceState.value = 'ready'
    } else {
      evidenceState.value = 'unavailable'
    }
  } catch {
    if (token === evidenceToken) evidenceState.value = 'unavailable'
  }
}
const selectionEvidence = computed(() => evidence.value?.evidence?.selectionEvidence || null)
const evidencePrediction = computed(() => evidence.value?.evidence?.prediction || null)
const evidenceTimeline = computed(
  () => selectionEvidence.value?.timeline || evidence.value?.evidence?.events || [],
)

function goAI(stock) {
  router.push('/ai')
}
</script>

<template>
  <div class="page-grid top50-page">
    <main class="primary-workspace">
      <!-- 状态条 -->
      <div class="top50-status-bar">
        <span :class="state === 'ready' ? 'ready' : 'warn'"><i /> {{ state === 'ready' ? '真实冻结榜单' : '正在读取榜单' }}</span>
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
      </div>

      <div v-if="showFilters" class="filter-bar">
        <span>策略：{{ teacherCount }}套因子画像</span><span>行业：全部</span><span>硬门槛：上市≥90天</span><span>排除涨跌停/低流动性/风险警示</span>
        <button @click="showFilters = false">收起</button>
      </div>

      <!-- 榜单表 -->
      <div class="table-wrap">
        <table class="decision-table">
          <thead>
            <tr>
              <th>排名</th><th>股票/代码</th><th>所属行业</th><th>综合分</th><th>因子支持</th>
              <th>状态</th><th>为什么入选</th><th>失效条件</th><th>行情日</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="stock in pageStocks"
              :key="stock.code"
              :class="{ selected: selectedCode === stock.code }"
              @click="openDialog(stock.code)"
            >
              <td><span :class="`rank rank-${stock.rank}`">{{ stock.rank }}</span></td>
              <td><strong>{{ stock.name }}</strong><small>{{ stock.code }}</small></td>
              <td><b>{{ stock.industry || '--' }}</b></td>
              <td><b class="score-value">{{ stock.score }}</b></td>
              <td><b class="agent-vote-value">{{ stock.agentVotes ?? stock.consensus ?? 0 }}<small>/{{ teacherCount }}</small></b></td>
              <td><StatusBadge :status="stock.status" /></td>
              <td><span class="top50-reason">{{ stock.reason || stock.trend }}</span></td>
              <td><span class="top50-invalid">{{ stock.invalid || '待更新' }}</span></td>
              <td><time>{{ stock.marketDataDate || snapshot?.meta?.marketDataDate || '--' }}</time></td>
              <td>
                <button class="table-action evidence-trigger" :disabled="!stock.predictionId" @click="openEvidence(stock, $event)">查看证据</button>
              </td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="10">
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
          @click="openDialog(stock.code)"
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
            <button @click.stop="openDialog(stock.code)">查看详情</button>
            <button class="primary" :disabled="!stock.predictionId" @click="openEvidence(stock, $event)">选股证据</button>
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

    <!-- 个股决策弹窗（基于 Element Plus el-dialog，内容还原原版 reference-react 的
         StockDecisionModal + SingleStockDecisionCard）。
         ⚠️ 与 AILabPage 新建角色 / AccuracyPage 证据弹窗同源：遮罩、Esc、点击遮罩关闭、
         焦点陷阱、body 滚动锁全由组件接管；容器级样式在 theme.css 6e)。
         `class="stock-decision-dialog"` 经 EP 的 mergeProps($attrs) 落在 `.el-dialog` 元素上。 -->
    <el-dialog
      v-model="dialogOpen"
      class="stock-decision-dialog"
      align-center
      append-to-body
      :show-close="false"
      @close="selectedCode = null"
    >
      <template v-if="selected" #default>
        <header class="stock-modal-head">
          <div class="stock-modal-title">
            <span>TOP50 · 单股决策</span>
            <h2 id="stock-decision-title">{{ selected.name }} <small>{{ selected.code }}</small></h2>
          </div>
          <div class="stock-modal-actions">
            <div class="stock-modal-stepper" aria-label="切换股票">
              <button aria-label="上一只股票" @click="changeSelected(-1)"><IconChevronLeft :size="16" /></button>
              <span>{{ selectedIndex + 1 }}/{{ rankedStocks.length }}</span>
              <button aria-label="下一只股票" @click="changeSelected(1)"><IconChevronRight :size="16" /></button>
            </div>
            <button :class="['watch-toggle', { watchlisted }]" @click="toggleWatchlist">
              <IconStar :size="16" :fill="watchlisted ? 'currentColor' : 'none'" />
              {{ watchlisted ? '已加入自选' : '加入自选股' }}
            </button>
            <button class="stock-modal-close" aria-label="关闭单股决策浮层" @click="dialogOpen = false"><IconX :size="18" /></button>
          </div>
        </header>

        <div class="stock-data-trust">
          <span :class="trustFresh ? 'fresh' : 'stale'"><i /> {{ trustLabel }}</span>
          <span><IconClock :size="13" /> 行情日期 {{ selected.marketDataDate || snapshotMeta?.marketDataDate || '待更新' }}</span>
          <span><IconDatabase :size="13" /> TOP50生成 {{ formatShanghaiTime(snapshotMeta?.generatedAt) }} · 数据窗口 {{ snapshotMeta?.dataWindow || '—' }} 内复用</span>
          <span><IconUsersGroup :size="13" /> {{ snapshotMeta?.selectionEngine || `${teacherCount}套可审计因子画像` }} · AI风险复核</span>
        </div>

        <div v-if="watchlisted" class="watchlist-actionbar">
          <span><IconCircleCheck :size="14" /><b>自选已保存</b><small>本机保存 · 可同步匿名设备提醒</small></span>
          <div>
            <button :class="{ active: followup.price }" @click="toggleFollowup('price')">
              <IconBell :size="14" /><span>{{ followup.price ? '已开启价格提醒' : '价格提醒' }}<small>{{ selected.trigger }}</small></span>
            </button>
            <button :class="{ active: followup.risk }" @click="toggleFollowup('risk')">
              <IconShieldCheck :size="14" /><span>{{ followup.risk ? '已开启风险预警' : '风险预警' }}<small>{{ selected.invalid }}</small></span>
            </button>
            <button :class="{ active: followup.preMarket }" @click="toggleFollowup('preMarket')">
              <IconClock :size="14" /><span>{{ followup.preMarket ? '已开启盘前复核' : '盘前复核' }}<small>明日 07:20</small></span>
            </button>
          </div>
        </div>
        <div v-else class="watchlist-prompt"><IconStar :size="14" /> 加入自选后可开启价格提醒、风险预警与盘前复核</div>

        <div class="stock-modal-scroll">
          <div class="single-stock-workspace">
            <!-- 左：个股决策卡 -->
            <article class="benchmark-stock-card" :aria-label="`${selected.name}单股票决策卡`">
              <header class="benchmark-stock-head">
                <div>
                  <h3>{{ selected.name }}<button @click="goPortfolio"><IconBriefcase2 :size="13" /> 模拟买入</button></h3>
                  <span>{{ selected.code }}</span>
                  <small>数据来自TOP50冻结行情与{{ teacherCount }}套可审计因子画像；未接入字段显示“--”</small>
                </div>
                <div>
                  <button :class="{ active: tracked }" aria-label="行情追踪开关" @click="tracked = !tracked"><IconTargetArrow :size="16" /></button>
                  <StatusBadge :status="selected.status" />
                </div>
              </header>

              <div class="benchmark-stock-quote">
                <strong>{{ selected.price.toFixed(2) }}</strong>
                <span :class="selected.pct >= 0 ? 'price-up' : 'price-down'">
                  {{ selected.pct >= 0 ? '+' : '' }}{{ selected.pct }}%　{{ selected.pct >= 0 ? '+' : '' }}{{ (selected.price * selected.pct / 100).toFixed(2) }}
                </span>
              </div>

              <div class="benchmark-metric-grid">
                <div>
                  <span>量比</span>
                  <strong>{{ monitorMetrics && monitorMetrics.volumeRatio == null ? '--' : monitorMetrics.volumeRatio.toFixed(2) }}</strong>
                  <small>{{ monitorMetrics && monitorMetrics.volumeRatio == null ? '数据未提供' : monitorMetrics.volumeRatio >= 1.8 ? '明显放量' : '正常区间' }}</small>
                </div>
                <div>
                  <span>换手率</span>
                  <strong>{{ monitorMetrics && monitorMetrics.turnover == null ? '--' : `${monitorMetrics.turnover.toFixed(2)}%` }}</strong>
                  <small>{{ monitorMetrics && monitorMetrics.turnover == null ? '数据未提供' : monitorMetrics.turnover > 2 ? '较活跃' : '正常区间' }}</small>
                </div>
                <div><span>成交额</span><strong>{{ monitorMetrics?.amount }}</strong></div>
                <div><span>振幅 / 市盈率（PE）</span><strong>{{ monitorMetrics?.amplitude }} / {{ monitorMetrics?.pe }}</strong></div>
              </div>

              <div class="benchmark-average-strip" aria-label="均价指标">
                <div><span>30日均价</span><strong>--</strong><small>历史数据不足</small></div>
                <div><span>60日均价</span><strong>--</strong><small>历史数据不足</small></div>
                <div><span>今日分时均价</span><strong>--</strong><small>当前行情未覆盖</small></div>
              </div>

              <div class="benchmark-signal"><IconActivity :size="15" /><span>量价信号</span><strong>{{ monitorMetrics?.signal }}</strong></div>

              <section class="benchmark-decision-block">
                <div class="benchmark-block-head"><span><IconTrendingUp :size="14" /> {{ recommendation }}</span><strong>{{ selected.score }}分</strong></div>
                <div class="benchmark-power-track"><i :style="{ width: powerTrackWidth }" /><b :style="{ width: powerTrackRest }" /></div>
                <div class="benchmark-power-labels"><span>{{ displayConsensus }}/{{ teacherCount }} 因子支持</span><span>{{ teacherCount - displayConsensus }}/{{ teacherCount }}未达支持线</span></div>
                <div class="benchmark-factor-tags">
                  <span>画像均分 {{ selected.agentAverage ?? '--' }}</span>
                  <span>{{ monitorMetrics?.signal }}</span>
                  <span>风险 {{ selected.risk || '--' }}</span>
                </div>
              </section>

              <section class="benchmark-prediction-block">
                <div class="benchmark-block-head"><span><IconTargetArrow :size="14" /> 冻结方向因子 <b>{{ trendLabel }}</b></span><strong>因子 {{ monitorMetrics?.confidence == null ? '--' : `${monitorMetrics.confidence}/100` }}</strong></div>
                <div class="benchmark-prediction-body">
                  <div class="benchmark-gauge">
                    <svg viewBox="0 0 120 66" role="img" aria-label="方向因子概率">
                      <path
                        v-for="(seg, i) in gaugeArcs"
                        :key="i"
                        :d="seg.d"
                        :stroke="seg.color"
                        stroke-width="11"
                        fill="none"
                        stroke-linecap="butt"
                      />
                      <text x="60" y="58" text-anchor="middle" class="benchmark-gauge-value">{{ monitorMetrics?.upProb ?? '--' }}</text>
                    </svg>
                  </div>
                  <div class="benchmark-probabilities">
                    <div><span>{{ monitorMetrics?.upProb == null ? '--' : `${monitorMetrics.upProb}/100` }}</span><i><b :style="{ width: `${monitorMetrics?.upProb || 0}%` }" /></i><small>看多因子</small></div>
                    <div><span>{{ monitorMetrics?.upProb == null ? '--' : `${100 - monitorMetrics.upProb}/100` }}</span><i><b :style="{ width: `${monitorMetrics?.upProb == null ? 0 : 100 - monitorMetrics.upProb}%` }" /></i><small>反向因子</small></div>
                  </div>
                </div>
                <p><strong>{{ monitorMetrics?.upProb == null ? '暂无因子' : `${monitorMetrics.upProb}/100` }}</strong> · 规则评分，未经概率校准，不是胜率或准确率</p>
                <div class="benchmark-prediction-factors">
                  <span><IconCircleCheck :size="13" /> {{ displayConsensus }}/{{ teacherCount }} 因子支持</span>
                  <span><IconCircleCheck :size="13" /> {{ monitorMetrics?.signal }}</span>
                  <span :class="selected.risk === '低' ? '' : 'warn'"><IconAlertTriangle :size="13" /> {{ selected.risk === '低' ? '尾盘承接积极' : '谨防追高' }}</span>
                </div>
              </section>

              <section class="benchmark-flow-block warn">
                <div class="benchmark-block-head"><span><IconBriefcase2 :size="14" /> 资金流向</span><strong>{{ tracked ? '追踪中' : '未追踪' }}</strong></div>
                <p>当前数据源未提供可核验的主力净流入与峰值数据，不作推算。</p>
              </section>

              <section class="benchmark-tracking-block">
                <div class="benchmark-block-head"><span><IconTargetArrow :size="14" /> 行情追踪</span><strong>冻结快照</strong></div>
                <p>当日高 {{ Number.isFinite(Number(selected.high)) ? Number(selected.high).toFixed(2) : '--' }}　|　当日低 {{ Number.isFinite(Number(selected.low)) ? Number(selected.low).toFixed(2) : '--' }}</p>
                <p>成交额 <b>{{ monitorMetrics?.amount }}</b>　振幅 <b>{{ monitorMetrics?.amplitude }}</b></p>
              </section>

              <footer class="benchmark-stock-actions">
                <button @click="goAI(selected)"><IconBrain :size="14" /> 问AI复核</button>
                <button @click="openFullAnalysis(selected)"><IconFileAnalytics :size="14" /> 完整分析</button>
                <button class="primary-button" @click="goPortfolio"><IconBriefcase2 :size="14" /> 模拟交易</button>
              </footer>
            </article>

            <!-- 右：决策增强层 -->
            <aside class="single-stock-context">
              <section>
                <div class="single-context-head"><span>我们的决策增强层</span><StatusBadge :status="selected.status" /></div>
                <h3>{{ teacherCount }}套因子画像</h3>
                <div class="single-agent-score"><strong>{{ displayConsensus }}/{{ teacherCount }}</strong><span>看多</span><i><b :style="{ width: powerTrackWidth }" /></i></div>
                <p>AI不决定排名，只汇总老师证据并检查风险边界。</p>
              </section>
              <section>
                <h3>核心证据</h3>
                <ol>
                  <li><IconCircleCheck :size="14" /><span><strong>产业与基本面</strong>{{ selected.reason }}</span></li>
                  <li><IconCircleCheck :size="14" /><span><strong>量价与流动性</strong>{{ monitorMetrics?.signal }}，成交额 {{ monitorMetrics?.amount }}</span></li>
                  <li><IconCircleCheck :size="14" /><span><strong>估值与赔率</strong>{{ selected.valuation }}，综合分 {{ selected.score }}</span></li>
                </ol>
              </section>
              <section class="single-risk-discipline">
                <h3>风险纪律</h3>
                <p><span>允许动作</span><strong>{{ selected.status === '可试仓' ? '回踩试仓 · 单笔≤5%' : '等待确认 · 不追价' }}</strong></p>
                <p><span>触发条件</span><strong>{{ selected.trigger }}</strong></p>
                <p><span>失效条件</span><strong class="price-down">{{ selected.invalid }}</strong></p>
              </section>
            </aside>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- 冻结选股证据 -->
    <div
      v-if="evidenceId"
      class="top50-evidence-backdrop"
      role="presentation"
      @mousedown.self="closeEvidence"
    >
      <section class="top50-evidence-dialog" role="dialog" aria-modal="true" aria-labelledby="top50-evidence-title" tabindex="-1">
        <header>
          <div>
            <span>冻结选股证据</span>
            <h2 id="top50-evidence-title">{{ evidencePrediction?.name || evidencePrediction?.code || evidenceId }}</h2>
            <p>{{ evidencePrediction?.code || evidenceId }} · {{ displayField(selectionEvidence?.cycle || evidencePrediction?.cycle, '周期待补充') }} · {{ displayField(evidencePrediction?.horizonLabel || evidencePrediction?.horizon, '期限待补充') }}</p>
          </div>
          <button aria-label="关闭选股证据" @click="closeEvidence"><IconX :size="17" /></button>
        </header>
        <div v-if="evidenceState === 'loading'" class="top50-evidence-state">正在读取冻结选股证据…</div>
        <div v-else-if="evidenceState === 'unavailable'" class="top50-evidence-state">
          <IconAlertTriangle :size="18" /><strong>选股证据暂不可用</strong>
          <p>未能读取该 predictionId 的冻结记录；系统不会改用其他股票或静态样例补位。</p>
        </div>
        <div v-else-if="evidenceState === 'ready' && selectionEvidence" class="top50-evidence-body">
          <div class="top50-evidence-meta">
            <div><span>入选理由</span><strong>{{ displayField(selectionEvidence.reason, '未记录') }}</strong></div>
            <div><span>冻结批次</span><strong>{{ displayField(selectionEvidence.cycleSnapshotId || selectionEvidence.snapshotId, '未记录') }}</strong></div>
            <div><span>来源截止</span><strong>{{ formatShanghaiDateTime(evidence?.evidence?.dataCutoff || selectionEvidence.dataCutoff, true) }}</strong></div>
            <div><span>评估截止</span><strong>{{ displayField(evidencePrediction?.maturityTradeDate, '待到期验证') }}</strong></div>
          </div>
          <section class="top50-evidence-section">
            <h3>因子拆解</h3>
            <div class="top50-evidence-factor-list">
              <article v-for="item in selectionEvidence.factorBreakdown || []" :key="`${item.agent}-${item.weight}`">
                <strong>{{ item.agent }}</strong>
                <span>权重 {{ item.weight }}% · 原始 {{ item.score ?? '--' }} · 贡献 {{ item.contribution ?? '--' }}</span>
                <p>{{ item.thesis || item.style || '未记录额外说明' }}</p>
              </article>
            </div>
          </section>
          <section class="top50-evidence-section">
            <h3>Agent 观点</h3>
            <div class="top50-evidence-agent-columns">
              <div>
                <span>支持 Agent</span>
                <ul v-if="selectionEvidence.supportingAgents?.length">
                  <li v-for="item in selectionEvidence.supportingAgents" :key="`${item.agent}-${item.score}`">
                    <strong>{{ item.agent }}</strong><span>{{ item.score ?? '--' }}分 · {{ item.rationale || item.style || '未记录' }}</span>
                  </li>
                </ul>
                <p v-else>暂无达到支持阈值的 Agent 记录。</p>
              </div>
              <div>
                <span>反对 Agent</span>
                <ul v-if="selectionEvidence.opposingAgents?.length">
                  <li v-for="item in selectionEvidence.opposingAgents" :key="`${item.agent}-${item.score}`">
                    <strong>{{ item.agent }}</strong><span>{{ item.score ?? '--' }}分 · {{ item.concern || item.style || '未记录' }}</span>
                  </li>
                </ul>
                <p v-else>暂无明确反对意见。</p>
              </div>
            </div>
          </section>
          <section class="top50-evidence-section">
            <h3>触发与失效</h3>
            <div class="top50-evidence-rule-grid">
              <article>
                <span>触发条件</span>
                <strong>{{ displayField(selectionEvidence.trigger?.rule, '未记录') }}</strong>
                <p>{{ displayField(selectionEvidence.trigger?.context, '未记录') }} · 价格 {{ displayField(selectionEvidence.trigger?.price, '--') }}</p>
              </article>
              <article>
                <span>失效条件</span>
                <strong>{{ displayField(selectionEvidence.invalidation?.rule, '未记录') }}</strong>
                <p>{{ displayField(selectionEvidence.invalidation?.context, '未记录') }} · 价格 {{ displayField(selectionEvidence.invalidation?.price, '--') }}</p>
              </article>
            </div>
          </section>
          <section class="top50-evidence-section">
            <h3>评估时间线</h3>
            <ol v-if="evidenceTimeline.length" class="top50-evidence-timeline">
              <li v-for="(item, index) in evidenceTimeline" :key="`${item.type || 'event'}-${item.occurredAt || index}`">
                <strong>{{ displayField(item.type, '事件') }}</strong>
                <time>{{ formatShanghaiDateTime(item.occurredAt, true) }}</time>
                <p>{{ displayField(item.reason, '未记录说明') }}</p>
              </li>
            </ol>
            <p v-else class="top50-evidence-empty">暂无后续评估事件；系统仅展示该 predictionId 的冻结记录。</p>
          </section>
        </div>
      </section>
    </div>
  </div>
</template>
