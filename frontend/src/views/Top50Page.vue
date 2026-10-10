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
} from '@tabler/icons-vue'

const router = useRouter()
const { data: snapshot, state, sourceMode } = useSnapshot('/api/top50', { refreshMs: 300000 })

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原来写死 12，
// 但内置 12 位是原版 mock 人设，已从产品里去掉；没有自建老师时兜 1，避免除零。
const teacherCount = computed(() => Number(snapshot.value?.meta?.teacherCount) || 1)

const CYCLES = ['超短', '短线', '波段', '中长线']
const query = ref('')
const page = ref(1)
const cycle = ref('超短')
const showFilters = ref(false)
const selectedCode = ref(null)

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
// 共识进度条宽度：模板里不做运算（约定：模板属性内禁止内联表达式）。
const voteBarWidth = computed(() => {
  const votes = Number(selected.value?.agentVotes ?? selected.value?.consensus ?? 0)
  const total = teacherCount.value || 1
  return `${Math.min(100, Math.max(0, (votes / total) * 100))}%`
})
function changeSelected(offset) {
  if (!rankedStocks.value.length) return
  const next = (selectedIndex.value + offset + rankedStocks.value.length) % rankedStocks.value.length
  selectedCode.value = rankedStocks.value[next].code
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
          <input v-model="query" placeholder="搜索股票 / 代码 / 行业" />
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
              @click="selectedCode = stock.code"
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
          @click="selectedCode = stock.code"
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
            <button @click.stop="selectedCode = stock.code">查看详情</button>
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

    <!-- 个股详情右栏 -->
    <aside v-if="selected" class="right-rail stock-detail">
      <div class="stock-detail-head">
        <div><h2>{{ selected.name }} <small>{{ selected.code }}</small></h2><p>{{ selected.industry }}</p></div>
        <button aria-label="关闭个股详情" @click="selectedCode = null"><IconX :size="17" /></button>
      </div>
      <div class="stock-quote">
        <strong>{{ selected.price.toFixed(2) }}</strong>
        <span :class="selected.pct >= 0 ? 'price-up' : 'price-down'">{{ selected.pct >= 0 ? '+' : '' }}{{ selected.pct }}%</span>
        <small>{{ selected.marketDataDate || '行情截止时间待更新' }}</small>
      </div>
      <div class="detail-score-grid">
        <div><span>TOP50排名</span><strong>#{{ selected.rank }}</strong></div>
        <div><span>综合分</span><strong>{{ selected.score }}</strong></div>
        <div><span>方向因子</span><strong>{{ selected.confidence ?? '--' }}/100</strong></div>
      </div>
      <div class="detail-section">
        <h3>策略匹配</h3>
        <div class="tag-row"><span>{{ cycle }}</span><span>{{ teacherCount }}套因子加权</span><span>AI复核</span></div>
        <p>持有周期：{{ cycleData?.holdingPeriod || '2—8周' }}</p>
      </div>
      <div class="detail-section agent-consensus-detail">
        <div class="section-line"><h3>{{ cycle }} · {{ teacherCount }}套因子盘前结果</h3><strong>{{ selected.agentVotes ?? selected.consensus ?? 0 }}/{{ teacherCount }}</strong></div>
        <p>领先Agent：{{ selected.topAgents?.join('、') || '暂无' }}</p>
        <div class="agent-vote-track"><i :style="{ width: voteBarWidth }" /></div>
      </div>
      <div class="detail-section evidence">
        <div class="section-line"><h3>当前冻结证据</h3><span>{{ selected.marketDataDate || '截止时间待更新' }}</span></div>
        <ol>
          <li><b>因子依据</b><p>{{ selected.reason || '真实因子依据待更新' }}</p></li>
          <li><b>量价状态</b><p>{{ selected.trend || '真实量价状态待更新' }}</p></li>
          <li><b>估值字段</b><p>{{ selected.valuation || '真实估值字段待更新' }}</p></li>
        </ol>
      </div>
      <div class="detail-section risk-list">
        <h3>当前风险边界</h3>
        <p><IconAlertTriangle :size="14" /> 风险等级：{{ selected.risk || '待评估' }}</p>
        <p><IconAlertTriangle :size="14" /> {{ selected.invalid || '真实失效位待更新' }}</p>
      </div>
      <div class="detail-section trade-state">
        <div><span>交易状态</span><StatusBadge :status="selected.status" /></div>
        <p><span>建议关注区间</span><b>{{ selected.trigger }}</b></p>
        <p><span>止损参考</span><b>{{ selected.invalid }}</b></p>
      </div>
      <button class="primary-button" @click="goAI(selected)"><IconBrain :size="17" /> 按多策略问AI</button>
      <p class="disclaimer">本信息仅供研究，不构成投资建议。市场有风险，投资需谨慎。</p>
    </aside>

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
