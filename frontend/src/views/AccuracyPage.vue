<script setup>
import { ref, computed } from 'vue'
import { useSnapshot } from '@/composables/useSnapshot'
import { fetchSnapshot } from '@/api/client'
import { formatShanghaiDateTime } from '@/utils/format'
import {
  IconReportAnalytics,
  IconAlertTriangle,
  IconDatabase,
  IconInfoCircle,
} from '@tabler/icons-vue'

const { data: snapshot, state } = useSnapshot('/api/accuracy', { refreshMs: 300000 })
const { data: acceptance } = useSnapshot('/api/acceptance', { refreshMs: 60000 })

const version = ref('all')
const cycle = ref('all')
const horizon = ref('all')
const breakdown = ref('四周期')

const overall = computed(() =>
  version.value === 'all'
    ? snapshot.value?.overall || {}
    : snapshot.value?.factorVersions?.[version.value] || { sampleCount: 0, sampleStatus: 'insufficient' },
)
const records = computed(() =>
  (snapshot.value?.recentEvaluations || []).filter(
    (item) =>
      (cycle.value === 'all' || item.cycle === cycle.value) &&
      (horizon.value === 'all' || item.horizon === horizon.value),
  ),
)
const versions = computed(() => [
  ...new Set(
    [snapshot.value?.currentFactorVersion, ...Object.keys(snapshot.value?.factorVersions || {})].filter(Boolean),
  ),
])
const REGIME_LABEL = { bull: '偏强', risk_off: '风险收缩', range: '震荡', unknown: '未记录' }

// el-select 需要 {label,value}（原生 <option> 的插值/内联三元在 EP 里不成立）。
const versionChoices = computed(() => [
  { value: 'all', label: '全部历史版本（不是当前策略表现）' },
  ...versions.value.map((item) => ({
    value: item,
    label: `${item === snapshot.value?.currentFactorVersion ? '当前版本' : '历史版本'} · ${item}`,
  })),
])
const cycleChoices = [
  { value: 'all', label: '全部策略' },
  { value: '超短', label: '超短' },
  { value: '短线', label: '短线' },
  { value: '波段', label: '波段' },
  { value: '中长线', label: '中长线' },
]
const horizonChoices = [
  { value: 'all', label: '全部期限' },
  { value: '1d', label: '1日' },
  { value: '5d', label: '5日' },
  { value: '20d', label: '20日' },
  { value: '60d', label: '60日' },
]
const breakdowns = computed(() => [
  ['预测方向', [['看涨', snapshot.value?.directions?.up], ['看跌', snapshot.value?.directions?.down]]],
  ['四周期', Object.entries(snapshot.value?.cycles || {})],
  ['验证期限', Object.entries(snapshot.value?.horizons || {}).map(([k, v]) => [v.label || k, v])],
  ['行业', Object.entries(snapshot.value?.industries || {})],
  ['市场环境', Object.entries(snapshot.value?.marketRegimes || {}).map(([k, v]) => [REGIME_LABEL[k] || k, v])],
  ['老师因子支持组', Object.entries(snapshot.value?.byAgent || {})],
  ['因子版本', Object.entries(snapshot.value?.factorVersions || {})],
])
const activeBreakdown = computed(() => breakdowns.value.find(([title]) => title === breakdown.value) || ['四周期', []])

function hasNumber(value) {
  return value != null && Number.isFinite(Number(value))
}
function percent(value, digits = 1) {
  return hasNumber(value) ? `${Number(value).toFixed(digits)}%` : '--'
}
function metricLabel(metric) {
  return metric?.sampleStatus === 'insufficient'
    ? `样本积累中（${metric.sampleCount || 0}/${snapshot.value?.minimumSample || 30}）`
    : percent(metric?.hitRate)
}
function displayValue(value) {
  return value || '数据缺失（未记录）'
}

// ---- 冻结预测证据 ----
const evidenceId = ref(null)
const evidence = ref(null)
const evidenceState = ref('idle')
let evidenceToken = 0

// el-dialog 需要布尔 v-model；evidenceId 仍是指挥源，关闭时统一走 closeEvidence()。
// Esc / 点遮罩 / 关闭按钮由 EP 接管 —— 原先手写的 window keydown 监听与 onBeforeUnmount
// 清理已随之移除（少一处自维护的副作用）。
const evidenceVisible = computed({
  get: () => Boolean(evidenceId.value),
  set: (value) => {
    if (!value) closeEvidence()
  },
})

function closeEvidence() {
  evidenceToken += 1
  evidenceId.value = null
  evidence.value = null
  evidenceState.value = 'idle'
}
async function openEvidence(item, event) {
  if (!item.id) return
  event.stopPropagation()
  const token = ++evidenceToken
  evidenceId.value = item.id
  evidence.value = null
  evidenceState.value = 'loading'
  try {
    const data = await fetchSnapshot(`/api/accuracy/evidence?predictionId=${encodeURIComponent(item.id)}`)
    if (token !== evidenceToken) return
    if (data?.evidence) {
      evidence.value = data.evidence
      evidenceState.value = 'ready'
    } else {
      evidenceState.value = 'unavailable'
    }
  } catch {
    if (token === evidenceToken) evidenceState.value = 'unavailable'
  }
}
const EVENT_LABEL = { evaluation: '收盘验证', evaluation_recorded: '记录验证', invalidation: '记录失效' }
const EVENT_REASON = { maturity_market_data_available: '已取得目标交易日收盘数据' }
</script>

<template>
  <div class="simple-page accuracy-page">
    <div class="page-toolbar">
      <div><h1>预测验证</h1><p>看历史表现，也看每一次判断的依据</p></div>
      <span class="toolbar-button"><IconReportAnalytics :size="15" /> 历史验证 · 不保证未来命中</span>
    </div>

    <div v-if="state === 'unavailable'" class="account-empty">
      <IconAlertTriangle :size="22" /><strong>准确率数据暂不可用</strong>
      <p>系统不会用模型置信度替代真实验证结果。</p>
    </div>

    <div class="operations-summary">
      <span>最近一期冻结 · {{ acceptance?.pipeline?.tradeDate || '待生成' }}</span>
      <strong>{{ acceptance?.pipeline?.frozenCount ?? 0 }} 条预测 · 最早到期 {{ acceptance?.pipeline?.firstMaturityTradeDate || '待确认' }}</strong>
      <small>冻结于 {{ formatShanghaiDateTime(acceptance?.pipeline?.frozenAt || acceptance?.pipeline?.generatedAt) }}。与下方历史累计样本不是同一统计范围。</small>
    </div>

    <div class="accuracy-controls">
      <label>统计版本
        <el-select v-model="version" class="ep-form-control ep-form-control--filter" aria-label="统计版本">
          <el-option v-for="c in versionChoices" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
      </label>
      <span>验证截止 {{ formatShanghaiDateTime(snapshot?.lastEvaluatedAt) }} · 满30条才披露指标</span>
    </div>

    <details class="accuracy-method">
      <summary>统计范围与数据保护说明</summary>
      <p class="page-data-method">去重股票 {{ snapshot?.coverage?.stocks ?? '待新统计' }} 只 · 预测交易日 {{ snapshot?.coverage?.tradeDates ?? '待新统计' }} 天。周期、期限和老师组可能重叠；记录条数不是独立实验次数。</p>
      <p class="page-data-method">数据保护：盘前只用已确认的上一交易日数据生成新预测；15:10 后按目标交易日收盘验证。未到期、缺数据均不算成功，缺数据也不直接认定为停牌。当前规则为原始收盘价方向比较，持平归入上涨；不代表可成交收益。</p>
      <p v-if="snapshot?.evaluation" class="page-data-method">最近一轮到期验证：新增 {{ snapshot.evaluation.newlyEvaluated ?? '--' }} 条 · 缺数待重试 {{ snapshot.evaluation.missingCloseQueueCount ?? '待下轮统计' }} 条。{{ snapshot.evaluation.scope || '本轮统计不代表全部历史预测覆盖率。' }}</p>
    </details>

    <div class="accuracy-kpis">
      <section><span>历史成熟样本</span><strong>{{ overall.sampleCount || 0 }}</strong><small>当前所选版本 · 非本期完成率</small></section>
      <section><span>方向命中率</span><strong>{{ metricLabel(overall) }}</strong><small>不代表未来收益</small></section>
      <section><span>统计状态</span><strong>{{ overall.sampleCount >= 30 ? '可查看' : '积累中' }}</strong><small>30条只是披露门槛，不代表可靠性证明</small></section>
      <section><span>样本平均收益</span><strong>{{ hasNumber(overall.averageReturn) ? percent(Number(overall.averageReturn) * 100, 2) : '--' }}</strong><small>仅为历史样本统计</small></section>
    </div>

    <details class="panel evidence-method-panel">
      <summary>基准对比与技术指标（展开查看）</summary>
      <div class="panel-head"><div><h2>与冻结基准比较</h2><span>上证指数 · 同参考日、同到期日 · 仅统计事前已冻结基准的配对样本</span></div></div>
      <div class="accuracy-kpis">
        <section><span>有效配对样本</span><strong>{{ overall.pairedSampleCount || 0 }} / {{ snapshot?.minimumSample || 30 }}</strong></section>
        <section><span>基准平均收益</span><strong>{{ overall.benchmarkAverageReturn == null ? '采集中' : percent(overall.benchmarkAverageReturn * 100, 2) }}</strong></section>
        <section><span>平均超额收益</span><strong>{{ overall.averageExcessReturn == null ? '采集中' : percent(overall.averageExcessReturn * 100, 2) }}</strong></section>
      </div>
      <p class="page-data-method">方向评分误差（Brier）：{{ hasNumber(overall.brierScore) ? Number(overall.brierScore).toFixed(4) : '--' }}，仅为未校准评分的探索性误差。旧预测未冻结基准的不补写。老师支持组之间可能重叠，不是独立样本；30条只是披露门槛，不代表统计结论可靠。未扣费、未考虑不可成交，不能视为实盘收益。到期日不利波动不等于持有全程最大回撤。</p>
    </details>

    <div class="accuracy-group-tabs" role="tablist" aria-label="历史统计分组">
      <button
        v-for="[title] in breakdowns"
        :key="title"
        role="tab"
        :aria-selected="breakdown === title"
        @click="breakdown = title"
      >{{ title }}</button>
    </div>
    <p class="page-data-method">以下分组为全部历史版本统计。策略周期不等于验证期限；例如“中长线 / 1日”只表示中长线策略的次日表现。</p>

    <div class="accuracy-breakdown-grid compact-breakdowns">
      <section class="panel">
        <div class="panel-head"><div><h2>{{ activeBreakdown[0] }}</h2><span>真实样本数量与历史方向命中率</span></div></div>
        <div class="accuracy-breakdown-list">
          <p v-if="!activeBreakdown[1].length" class="page-data-method">暂无该分组的成熟样本。</p>
          <div v-for="[label, metric] in activeBreakdown[1]" :key="label">
            <span><strong>{{ label }}</strong><small>{{ metric?.sampleCount || 0 }} 条样本</small></span>
            <b>{{ metricLabel(metric) }}</b>
          </div>
        </div>
      </section>
    </div>

    <div class="accuracy-controls">
      <label>记录策略
        <el-select v-model="cycle" class="ep-form-control ep-form-control--filter" aria-label="记录策略">
          <el-option v-for="c in cycleChoices" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
      </label>
      <label>验证期限
        <el-select v-model="horizon" class="ep-form-control ep-form-control--filter" aria-label="验证期限">
          <el-option v-for="c in horizonChoices" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
      </label>
      <span>仅筛选最近20条记录，不代表全历史覆盖率</span>
    </div>

    <section class="panel accuracy-evaluation-table">
      <div class="panel-head">
        <div>
          <h2>最近验证记录</h2>
          <span>最近 {{ records.length || 0 }} 条 · 截止 {{ formatShanghaiDateTime(snapshot?.lastEvaluatedAt) }}</span>
        </div>
      </div>
      <div v-if="records.length" class="accuracy-table-scroll">
        <table>
          <thead><tr><th>股票</th><th>周期/期限</th><th>预测</th><th>实际</th><th>收益</th><th>结果</th><th>验证日</th><th>证据</th></tr></thead>
          <tbody>
            <tr v-for="(item, index) in records" :key="item.id || `${item.code}:${item.evaluatedAt}:${index}`">
              <td><strong>{{ item.name || item.code }}</strong><small>{{ item.code }}</small></td>
              <td>{{ item.cycle || '--' }} / {{ item.horizon || '--' }}</td>
              <td>{{ item.predictedDirection === 'up' ? '看涨' : '看跌' }}{{ item.probabilityUp == null ? '' : ` · 评分 ${Math.round(item.probabilityUp * 100)}/100` }}</td>
              <td>{{ item.actualDirection === 'up' ? '上涨' : item.actualDirection === 'down' ? '下跌' : '--' }}</td>
              <td :class="Number(item.actualReturn) >= 0 ? 'price-up' : 'price-down'">{{ item.actualReturn == null ? '--' : percent(Number(item.actualReturn) * 100, 2) }}</td>
              <td><span :class="item.hit ? 'positive' : 'negative'">{{ item.hit ? '命中' : '未命中' }}</span></td>
              <td>{{ item.maturityTradeDate || '--' }}</td>
              <td><button class="table-action evidence-trigger" :disabled="!item.id" @click="openEvidence(item, $event)">查看证据</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="account-empty">
        <IconDatabase :size="22" /><strong>当前筛选暂无记录</strong>
        <p>这里仅筛选最近20条记录；清除筛选可查看其他记录。</p>
      </div>
    </section>

    <!-- 冻结预测证据 —— Element Plus 试点 ②（2026-10-10）。
         原先是手写 backdrop + <section role="dialog"> + header + 关闭按钮；换 el-dialog 后，
         遮罩点击关闭、Esc、焦点陷阱、body 滚动锁、aria 语义全部由组件接管。
         容器级样式放 theme.css 6c)（无层文件才能压过 EP 的 `.el-dialog`）；内容样式仍在 styles.css。
         `class="accuracy-evidence-dialog"` 的落点同新建角色弹窗：EP 把 $attrs merge 进 DialogContent，
         最终落在 `.el-dialog` 元素上。 -->
    <el-dialog
      v-model="evidenceVisible"
      class="accuracy-evidence-dialog"
      width="720px"
      align-center
      append-to-body
    >
      <template #header>
        <div class="accuracy-evidence-head">
          <span>冻结预测证据</span>
          <h2 id="accuracy-evidence-title">{{ evidence?.prediction?.name || evidence?.prediction?.code || evidenceId }}</h2>
          <p>{{ evidence?.prediction?.code || evidenceId }}</p>
        </div>
      </template>
      <div v-if="evidenceState === 'loading'" class="accuracy-evidence-state">正在读取冻结记录与事件...</div>
      <div v-else-if="evidenceState === 'unavailable'" class="accuracy-evidence-state">
        <IconAlertTriangle :size="18" /><strong>证据暂不可用</strong>
        <p>未能读取该预测的证据记录；系统没有使用其他股票或静态数据补位。</p>
      </div>
      <div v-else-if="evidenceState === 'ready' && evidence" class="accuracy-evidence-body">
        <div class="accuracy-evidence-meta">
          <div><span>冻结时间</span><strong>{{ formatShanghaiDateTime(evidence.frozenAt) }}</strong></div>
          <div><span>数据截止</span><strong>{{ formatShanghaiDateTime(evidence.dataCutoff) }}</strong></div>
          <div><span>来源</span><strong>{{ displayValue(evidence.source) }}</strong></div>
          <div><span>失效规则</span><strong>{{ displayValue(evidence.invalidationRule) }}</strong></div>
        </div>
        <details class="accuracy-evidence-result">
          <summary>策略版本与基准明细</summary>
          <p>因子版本：{{ displayValue(evidence.prediction?.factorVersion) }} · 市场环境：{{ REGIME_LABEL[evidence.prediction?.marketRegime] || '未记录' }}</p>
          <p>基准：{{ evidence.prediction?.benchmark ? `${evidence.prediction.benchmark.name} · ${evidence.prediction.benchmark.referenceDate} · ${evidence.prediction.benchmark.referencePrice}` : '当时未冻结基准，不事后补填' }}</p>
          <p>老师知识版本：{{ Object.entries(evidence.prediction?.teacherVersions || {}).map(([n, v]) => `${n}: ${v}`).join('；') || '未记录' }}</p>
        </details>
        <section class="accuracy-evidence-result">
          <h3>验证口径与行情证据</h3>
          <p>事前规则版本：{{ evidence.prediction?.evaluationRule?.version || '历史记录未单独冻结规则版本，不事后补写' }}</p>
          <p>收盘报价来源：{{ evidence.evaluation?.evaluationEvidence?.provider || '历史记录未保存供应商明细' }} · 目标交易日：{{ evidence.evaluation?.evaluationEvidence?.tradeDate || '未记录' }} · 收盘价：{{ evidence.evaluation?.evaluationEvidence?.close ?? '未记录' }}</p>
          <p>采集时间：{{ evidence.evaluation?.evaluationEvidence?.fetchedAt || '未记录' }}。除权除息可能影响原始价格比较，不能视为投资总回报。</p>
        </section>
        <section v-if="evidence.evaluation" class="accuracy-evidence-result">
          <h3>这次预测是否命中？</h3>
          <p>{{ evidence.evaluation.actualDirection === 'up' ? '上涨' : evidence.evaluation.actualDirection === 'down' ? '下跌' : '数据缺失（未记录）' }} · {{ evidence.evaluation.actualReturn == null ? '收益数据缺失' : percent(Number(evidence.evaluation.actualReturn) * 100, 2) }} · {{ evidence.evaluation.hit == null ? '命中结果缺失' : evidence.evaluation.hit ? '命中' : '未命中' }}</p>
        </section>
        <section class="accuracy-evidence-events">
          <h3>事件时间线</h3>
          <ol v-if="evidence.events?.length">
            <li v-for="(event, index) in evidence.events" :key="event.eventId || `${event.occurredAt}:${index}`">
              <strong>{{ EVENT_LABEL[event.type] || '证据事件' }}</strong>
              <time>{{ formatShanghaiDateTime(event.occurredAt) }}</time>
              <p v-if="event.reason">{{ EVENT_REASON[event.reason] || '系统追加证据记录' }}</p>
              <details v-if="event.patch"><summary>查看原始证据数据</summary><pre>{{ JSON.stringify(event.patch, null, 2) }}</pre></details>
            </li>
          </ol>
          <p v-else class="accuracy-evidence-empty">暂无追加事件；冻结预测仍保留原始记录。</p>
        </section>
      </div>
    </el-dialog>

    <p class="page-data-method"><IconInfoCircle :size="15" /> {{ snapshot?.methodology || '按目标交易日收盘验证方向与概率，不使用模型自评准确率。' }}</p>
  </div>
</template>
