<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { useAppStore } from '@/stores/snapshot'
import { fetchSnapshot } from '@/api/client'
import {
  hydrateStock,
  displayField,
  formatShanghaiTime,
  formatShanghaiDateTime,
  formatDailyAmount,
} from '@/utils/format'
import { useStockDecision } from '@/composables/useStockDecision'
import StatusBadge from '@/components/StatusBadge.vue'
import {
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
const store = useAppStore()
const { state, close, closeEvidence: closeEvidenceBridge } = useStockDecision()

const open = computed(() => state.open)
const code = computed(() => state.code)
// el-dialog 的 v-model：关闭时走 close() 复位全部状态。
const dialogOpen = computed({
  get: () => state.open,
  set: (v) => {
    if (!v) close()
  },
})

const { data: snapshot, state: snapState, sourceMode } = useSnapshot('/api/top50', { refreshMs: 300000 })
const teacherCount = computed(() => Number(snapshot.value?.meta?.teacherCount) || 1)

// 把四个周期的榜单全部摊平，按 code 去重 —— 这样从搜索/自选加进来的 TOP50 标的
// 也能拿到完整的 factor/score/consensus，而不必依赖调用方传入。
const allRanked = computed(() => {
  const cycles = snapshot.value?.cycles || {}
  const map = new Map()
  for (const key of Object.keys(cycles)) {
    for (const s of cycles[key]?.ranking || []) {
      const h = hydrateStock(s)
      if (!map.has(h.code)) map.set(h.code, h)
    }
  }
  return [...map.values()]
})

// 不在 TOP50 里的标的（纯自选/搜索加进来的）走 /api/stocks/search 补足基础信息，
// 卡片对缺失的 TOP50 专属字段显示「--」，与卡片既有的「未接入字段显示--」口径一致。
const resolved = ref(null)
// 非 TOP50 标的（纯自选/搜索加入）的实时行情：补全价/涨跌幅/量比/换手/PE/振幅/成交额，
// 让单股决策弹窗的行情块不再空着 "--"。TOP50 标的已带完整数据，不额外调 Tushare。
const quote = ref(null)
watch(
  code,
  async (c) => {
    resolved.value = null
    quote.value = null
    if (!c) return
    if (allRanked.value.some((s) => s.code === c)) return
    try {
      const d = await fetchSnapshot(`/api/stocks/search?q=${encodeURIComponent(c)}`)
      const hit = (d?.items || []).find((i) => i.code === c) || (d?.items || [])[0]
      if (hit) {
        resolved.value = hydrateStock({
          ...hit,
          isWatchlist: true,
          rank: null,
          score: null,
          consensus: null,
          agentVotes: null,
          status: null,
          reason: null,
          valuation: null,
          trigger: null,
          invalid: null,
          probabilityUp: null,
          marketDataDate: null,
          predictionId: null,
        })
      }
    } catch {
      resolved.value = null
    }
    try {
      const q = await fetchSnapshot(`/api/stocks/${encodeURIComponent(c)}/quote`)
      if (q?.quote) quote.value = q.quote
    } catch {
      quote.value = null
    }
  },
  { immediate: true },
)

const selected = computed(() => {
  if (!code.value) return null
  const top = allRanked.value.find((s) => s.code === code.value)
  if (top) return top
  // 非 TOP50：基础信息来自 search/调用方，行情优先用实时 quote 补全（因子分永远没有，保持 --）。
  const base = state.stock && state.stock.code === code.value ? hydrateStock(state.stock) : resolved.value
  if (!base && !quote.value) return null
  return hydrateStock({ ...(base || {}), ...(quote.value || {}) })
})

// 是否 TOP50 榜单标的：决定 score/consensus/price 等专属字段能否展示，
// 否则按「未接入字段显示--」口径回落，避免出现误导性的 0分 / 0%。
const isTop50 = computed(() => Boolean(code.value && allRanked.value.some((s) => s.code === code.value)))
// 行情报价：搜索/纯自选加进来的标的没有实时价，显示「--」而非 0.00。
const hasQuote = computed(() => Boolean(selected.value && Number.isFinite(Number(selected.value.price)) && Number(selected.value.price) > 0))
const quotePrice = computed(() => (hasQuote.value ? Number(selected.value.price).toFixed(2) : '--'))
const quoteClass = computed(() => {
  const p = Number(selected.value?.pct)
  if (!Number.isFinite(p)) return ''
  return p >= 0 ? 'price-up' : 'price-down'
})
const quotePct = computed(() => {
  const p = Number(selected.value?.pct)
  if (!Number.isFinite(p)) return '--'
  const sign = p >= 0 ? '+' : ''
  const change = hasQuote.value ? `${sign}${(Number(selected.value.price) * p / 100).toFixed(2)}` : '--'
  return `${sign}${p}%　${change}`
})

// 上一只/下一只切换的候选上下文：TOP50 打开时传 rankedStocks，否则退化为 [当前标的]。
const rankedContext = computed(() =>
  state.ranked && state.ranked.length ? state.ranked : selected.value ? [selected.value] : [],
)
const selectedIndex = computed(() => rankedContext.value.findIndex((s) => s.code === code.value))
function changeSelected(offset) {
  if (!rankedContext.value.length) return
  const next = (selectedIndex.value + offset + rankedContext.value.length) % rankedContext.value.length
  const nextCode = rankedContext.value[next]?.code
  if (nextCode && nextCode !== code.value) state.code = nextCode
}

// ---- 还原原版 SingleStockDecisionCard 的监控指标与决策数据 ----
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

const displayConsensus = computed(() =>
  Math.min(teacherCount.value, Number(selected.value?.agentVotes ?? selected.value?.consensus ?? 0)),
)
const scoreText = computed(() => (isTop50.value ? `${selected.value?.score ?? '--'}分` : '--'))
const scoreValue = computed(() => (isTop50.value ? (selected.value?.score ?? '--') : '--'))
const consensusText = computed(() => (isTop50.value ? displayConsensus.value : '--'))
const trendLabel = computed(() => {
  const up = monitorMetrics.value?.upProb
  if (up == null) return '待计算'
  return up >= 60 ? '偏多' : up >= 50 ? '中性偏多' : '偏弱'
})
const recommendation = computed(() => {
  const status = selected.value?.status
  return status === '可试仓' ? '满足触发后可小仓试错' : status === '等待确认' ? '等待右侧确认' : '仅观察'
})

const powerTrackWidth = computed(() => {
  const total = teacherCount.value || 1
  return `${Math.min(100, Math.max(0, (displayConsensus.value / total) * 100))}%`
})
const powerTrackRest = computed(() => {
  const total = teacherCount.value || 1
  return `${Math.min(100, Math.max(0, (1 - displayConsensus.value / total) * 100))}%`
})

// 半环仪表盘（替换原版 Recharts PieChart；三色段 谨慎/中性/乐观，纯 SVG，无额外依赖）。
// 红绿对调：谨慎=绿 / 乐观=红，与本站"涨红跌绿"口径一致。
const gaugeColors = ['#59bf79', '#d8a63d', '#f05e65']
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

// 自选 / 提醒：watch-toggle 直接绑定真实 watchlist（localStorage 持久化），
// 与「加入自选」的动作同源；tracked/followup 仍为本地 UI 态。
const watchlisted = computed(() => (code.value ? store.has(code.value) : false))
const tracked = ref(true)
const followup = ref({ price: false, risk: false, preMarket: false })
function toggleWatchlist() {
  if (code.value) store.toggleWatch(code.value)
}
function toggleFollowup(key) {
  followup.value[key] = !followup.value[key]
}

// 数据可信度条文案（原版 StockDecisionModal 的 stock-data-trust）。
const trustLabel = computed(() => {
  if (sourceMode.value === 'live' && snapState.value === 'ready') return '当日快照'
  return '数据待更新'
})
const trustFresh = computed(() => sourceMode.value === 'live' && snapState.value === 'ready')
const snapshotMeta = computed(() => snapshot.value?.meta || null)

function goSimulation(stock) {
  // 「模拟交易 / 模拟买入」→ 量化工具的模拟 tab，并带上当前标的（?tool=simulation&code=）。
  router.push({ path: '/tools', query: { tool: 'simulation', code: stock?.code || '' } })
  close() // 跳转后关闭决策弹窗，避免覆盖在模拟页上方
}
function goAI(stock) {
  router.push('/ai')
}
function openFullAnalysis(stock) {
  // 「完整分析」：本项目用冻结选股证据弹窗承接（TOP50 标的都带 predictionId）。
  if (stock?.predictionId) openEvidence(stock)
}

// ---- 冻结选股证据（浮层，可独立于决策弹窗开启）----
// evidenceStock 由 useStockDecision 注入：TOP50 表格「查看证据」与决策弹窗「完整分析」共用。
const evidenceId = ref(null)
const evidence = ref(null)
const evidenceState = ref('idle')
const evidenceSubject = ref(null)
let evidenceToken = 0
function closeEvidence() {
  evidenceToken += 1
  evidenceId.value = null
  evidence.value = null
  evidenceState.value = 'idle'
  evidenceSubject.value = null
  closeEvidenceBridge()
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
// 证据弹窗的两个来源：
//  ① 榜单标的 —— 有 predictionId，去读冻结选股证据；
//  ② 自选跟踪标的 —— 不在冻结榜单里，**没有**选股证据可读，明确落到 watchlist 态。
watch(
  () => state.evidenceStock,
  (stock) => {
    if (!stock) {
      closeEvidence()
      return
    }
    const token = ++evidenceToken
    evidenceSubject.value = { name: stock?.name || '', code: stock?.code || '' }
    evidence.value = null
    const predictionId = stock?.predictionId
    if (!predictionId) {
      evidenceId.value = stock?.code || null
      evidenceState.value = 'watchlist'
      return
    }
    evidenceId.value = predictionId
    evidenceState.value = 'loading'
    fetchSnapshot(`/api/top50/evidence?predictionId=${encodeURIComponent(predictionId)}`)
      .then((data) => {
        if (token !== evidenceToken) return
        if (data?.evidence) {
          evidence.value = data
          evidenceState.value = 'ready'
        } else {
          evidenceState.value = 'unavailable'
        }
      })
      .catch(() => {
        if (token === evidenceToken) evidenceState.value = 'unavailable'
      })
  },
  { immediate: true },
)
function openEvidence(stock) {
  // 决策弹窗内部调用：直接注入 evidenceStock 走同一套渲染。
  state.evidenceStock = stock
}
const selectionEvidence = computed(() => evidence.value?.evidence?.selectionEvidence || null)
const evidencePrediction = computed(() => evidence.value?.evidence?.prediction || null)
const evidenceTimeline = computed(
  () => selectionEvidence.value?.timeline || evidence.value?.evidence?.events || [],
)
</script>

<template>
  <el-dialog
    v-model="dialogOpen"
    class="stock-decision-dialog"
    align-center
    append-to-body
    :show-close="false"
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
            <span>{{ selectedIndex + 1 }}/{{ rankedContext.length }}</span>
            <button aria-label="下一只股票" @click="changeSelected(1)"><IconChevronRight :size="16" /></button>
          </div>
          <button :class="['watch-toggle', { watchlisted }]" @click="toggleWatchlist">
            <IconStar :size="16" :fill="watchlisted ? 'currentColor' : 'none'" />
            {{ watchlisted ? '已加入自选' : '加入自选股' }}
          </button>
          <button class="stock-modal-close" aria-label="关闭单股决策浮层" @click="close"><IconX :size="18" /></button>
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
                <h3>{{ selected.name }}<button @click="goSimulation(selected)"><IconBriefcase2 :size="13" /> 模拟买入</button></h3>
                <span>{{ selected.code }}</span>
                <small>数据来自TOP50冻结行情与{{ teacherCount }}套可审计因子画像；未接入字段显示“--”</small>
              </div>
              <div>
                <button :class="{ active: tracked }" aria-label="行情追踪开关" @click="tracked = !tracked"><IconTargetArrow :size="16" /></button>
                <StatusBadge :status="selected.status" />
              </div>
            </header>

            <div class="benchmark-stock-quote">
              <strong>{{ quotePrice }}</strong>
              <span :class="quoteClass">{{ quotePct }}</span>
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
              <div class="benchmark-block-head"><span><IconTrendingUp :size="14" /> {{ recommendation }}</span><strong>{{ scoreText }}</strong></div>
              <div class="benchmark-power-track"><i :style="{ width: powerTrackWidth }" /><b :style="{ width: powerTrackRest }" /></div>
              <div class="benchmark-power-labels"><span>{{ consensusText }}/{{ teacherCount }} 因子支持</span><span>{{ teacherCount - displayConsensus }}/{{ teacherCount }}未达支持线</span></div>
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
                <span><IconCircleCheck :size="13" /> {{ consensusText }}/{{ teacherCount }} 因子支持</span>
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
              <button class="primary-button" @click="goSimulation(selected)"><IconBriefcase2 :size="14" /> 模拟交易</button>
            </footer>
          </article>

          <!-- 右：决策增强层 -->
          <aside class="single-stock-context">
            <section>
              <div class="single-context-head"><span>我们的决策增强层</span><StatusBadge :status="selected.status" /></div>
              <h3>{{ teacherCount }}套因子画像</h3>
              <div class="single-agent-score"><strong>{{ consensusText }}/{{ teacherCount }}</strong><span>看多</span><i><b :style="{ width: powerTrackWidth }" /></i></div>
              <p>AI不决定排名，只汇总老师证据并检查风险边界。</p>
            </section>
            <section>
              <h3>核心证据</h3>
              <ol>
                <li><IconCircleCheck :size="14" /><span><strong>产业与基本面</strong>{{ displayField(selected.reason, '待补充') }}</span></li>
                <li><IconCircleCheck :size="14" /><span><strong>量价与流动性</strong>{{ monitorMetrics?.signal }}，成交额 {{ monitorMetrics?.amount }}</span></li>
                <li><IconCircleCheck :size="14" /><span><strong>估值与赔率</strong>{{ displayField(selected.valuation, '待补充') }}，综合分 {{ scoreValue }}</span></li>
              </ol>
            </section>
            <section class="single-risk-discipline">
              <h3>风险纪律</h3>
              <p><span>允许动作</span><strong>{{ selected.status === '可试仓' ? '回踩试仓 · 单笔≤5%' : '等待确认 · 不追价' }}</strong></p>
              <p><span>触发条件</span><strong>{{ displayField(selected.trigger, '待补充') }}</strong></p>
              <p><span>失效条件</span><strong class="price-down">{{ displayField(selected.invalid, '待补充') }}</strong></p>
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
          <h2 id="top50-evidence-title">{{ evidenceSubject?.name || evidencePrediction?.name || evidencePrediction?.code || evidenceId }}</h2>
          <p>{{ evidencePrediction?.code || evidenceId }} · {{ displayField(selectionEvidence?.cycle || evidencePrediction?.cycle, '周期待补充') }} · {{ displayField(evidencePrediction?.horizonLabel || evidencePrediction?.horizon, '期限待补充') }}</p>
        </div>
        <button aria-label="关闭选股证据" @click="closeEvidence"><IconX :size="17" /></button>
      </header>
      <div v-if="evidenceState === 'loading'" class="top50-evidence-state">正在读取冻结选股证据…</div>
      <div v-else-if="evidenceState === 'unavailable'" class="top50-evidence-state">
        <IconAlertTriangle :size="18" /><strong>选股证据暂不可用</strong>
        <p>未能读取该 predictionId 的冻结记录；系统不会改用其他股票或静态样例补位。</p>
      </div>
      <div v-else-if="evidenceState === 'watchlist'" class="top50-evidence-state">
        <IconAlertTriangle :size="18" /><strong>自选跟踪股暂无冻结选股证据</strong>
        <p>{{ evidenceSubject?.name || '该标的' }}（{{ evidenceSubject?.code || evidenceId }}）不在冻结榜单内，没有可核验的选股证据；它仅作本地自选关注，不参与排名与评分。</p>
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
</template>
