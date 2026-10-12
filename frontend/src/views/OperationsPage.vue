<script setup>
import { ref, computed } from 'vue'
import { useSnapshot } from '@/composables/useSnapshot'
import { formatShanghaiTime, formatShanghaiDateTime, formatDurationMs } from '@/utils/format'
import {
  IconActivity,
  IconAlertTriangle,
  IconCircleCheck,
  IconSearch,
  IconInfoCircle,
} from '@tabler/icons-vue'

const { data: ops, state } = useSnapshot('/api/operations', { refreshMs: 30000 })
const { data: quality } = useSnapshot('/api/source-quality', { refreshMs: 30000 })

const labels = { market: '行情数据', news: '定时资讯', ai: 'AI研究', scheduler: '定时任务', notification: '通知推送' }
const statusLabels = { healthy: '正常', degraded: '降级', critical: '严重', unknown: '未知' }

const components = computed(() =>
  Object.entries(labels).map(([id, label]) => ({ id, label, ...(ops.value?.components?.[id] || { status: 'unknown' }) })),
)

// --- SourceQualityPanel inline ---
const qQuery = ref('')
const qResult = ref('all')
const qLabels = { ready: '有效响应', failed: '请求失败', empty: '空数据' }
// el-select 要 {label,value} 数组（原来靠 <option v-for="(label, id) in qLabels"> 遍历对象）。
const qResultChoices = [{ value: 'all', label: '全部状态' }, ...Object.entries(qLabels).map(([value, label]) => ({ value, label }))]
const endpoints = computed(() =>
  (quality.value?.endpoints || []).filter(
    (item) =>
      `${item.provider} ${item.endpoint}`.toLowerCase().includes(qQuery.value.trim().toLowerCase()) &&
      (qResult.value === 'all' || item.status === qResult.value),
  ),
)
</script>

<template>
  <div class="simple-page operations-page">
    <div class="page-toolbar">
      <div><h1>运行状态</h1><p>只读运行观测，不展示数据源密钥、原始报错或内部地址</p></div>
      <span class="toolbar-button"><IconActivity :size="15" /> 30秒刷新</span>
    </div>

    <div v-if="state === 'unavailable'" class="operations-unavailable" role="status">
      <IconAlertTriangle :size="20" />
      <span><strong>运行状态暂不可用</strong><small>最后已知时间：{{ formatShanghaiDateTime(ops?.generatedAt, true) }}</small></span>
    </div>

    <div class="review-feed-grid">
      <article v-for="item in (quality?.feeds || [])" :key="item.name">
        <h3>{{ item.name }}</h3>
        <strong>{{ item.count ?? '--' }}{{ item.expected ? ` / ${item.expected}` : '' }}<small> 条</small></strong>
        <p>{{ item.status }}</p>
        <small>{{ item.provider || '来源未记录' }} · 数据日 {{ item.date || '见原文时间' }}<br />采集 {{ formatShanghaiDateTime(item.at) }}{{ item.staleCount != null ? ` · 旧价 ${item.staleCount} 条` : '' }}</small>
      </article>
    </div>

    <section class="panel runtime-overview">
      <div class="panel-head"><h2>运行概览</h2><span>观测于 {{ formatShanghaiDateTime(ops?.generatedAt, true) }}</span></div>
      <div class="runtime-overview-grid">
        <div v-for="c in components" :key="c.id">
          <span>{{ c.label }}</span>
          <strong :class="c.status">{{ statusLabels[c.status] || '未知' }}</strong>
          <small>{{ c.id === 'ai' ? `${ops?.aiBudget?.usedCalls ?? '--'} / ${ops?.aiBudget?.callLimit ?? '--'} 次/日` : `最后成功 ${formatShanghaiTime(c.lastSuccessAt)}` }}</small>
        </div>
      </div>
    </section>

    <section class="panel source-quality-panel">
      <div class="panel-head">
        <div><h2>数据源质量</h2><span>{{ quality?.window || '等待真实接口观测' }}</span></div>
        <div class="quality-filters">
          <label class="search-field"><IconSearch :size="14" /><el-input v-model="qQuery" class="ep-form-control" placeholder="搜索数据源 / 接口" clearable /></label>
          <el-select v-model="qResult" class="ep-form-control ep-form-control--filter" aria-label="接口响应状态">
            <el-option v-for="c in qResultChoices" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </div>
      </div>
      <div v-if="state === 'unavailable'" class="review-warning" role="status">质量记录读取失败，不能据此认定数据源正常。</div>
      <div class="quality-table-scroll">
        <table v-if="quality?.endpoints?.length">
          <thead><tr><th>数据源 / 接口</th><th>最近结果</th><th>原始行数</th><th>数据时间</th><th>最近成功</th><th>请求样本</th><th>失败率 / 空响应</th><th>P95耗时</th><th>剩余额度</th></tr></thead>
          <tbody>
            <tr v-for="item in endpoints" :key="`${item.provider}:${item.endpoint}`">
              <td><strong>{{ item.provider }}</strong><small>{{ item.endpoint }}</small></td>
              <td>{{ qLabels[item.status] || '未知' }}<small>{{ item.errorCategory || '' }}</small></td>
              <td>{{ item.rowCount }}</td>
              <td>{{ item.dataTime || '未返回' }}</td>
              <td>{{ formatShanghaiDateTime(item.lastSuccessAt) }}</td>
              <td>{{ item.sampleCount }}</td>
              <td>{{ item.failureRate }}% / {{ item.emptyCount }}次</td>
              <td>{{ formatDurationMs(item.p95DurationMs) }}</td>
              <td>未知</td>
            </tr>
            <tr v-if="!endpoints.length"><td colspan="9">没有符合筛选条件的接口</td></tr>
          </tbody>
        </table>
        <div v-else class="account-empty"><strong>尚无本版本接口观测</strong><p>后续真实采集请求会自动记录；不会补造历史错误率。</p></div>
      </div>
      <p class="page-data-method">{{ quality?.quotaNote }} 原始行数不等于有效股票覆盖。观测截止 {{ formatShanghaiDateTime(quality?.generatedAt) }}</p>
    </section>

    <details class="operations-history">
      <summary>查看采集轮次、AI预算与任务运行明细</summary>
      <div class="operations-summary">
        <span>AI调用硬上限（当前站点）</span>
        <strong>{{ ops?.aiBudget?.usedCalls ?? '--' }} / {{ ops?.aiBudget?.callLimit ?? '--' }} 次/日</strong>
        <small>含失败与重试 · 每次最多 {{ ops?.aiBudget?.maxOutputTokensPerCall ?? '--' }} 输出 token · 非人民币费用统计</small>
      </div>
      <div v-for="feed in (ops?.delivery || [])" :key="feed.name" class="operations-summary">
        <span>{{ feed.name }}</span><strong>{{ feed.label }}</strong>
        <small>{{ feed.count }}条 · {{ feed.origin }} · {{ formatShanghaiDateTime(feed.generatedAt, true) }} · {{ feed.nextTime ? `下轮 ${feed.nextTime}` : '下轮以交易日历为准' }}</small>
      </div>
      <p class="page-data-method">以下为任务与接口调用历史，和上方共享快照分开核验。备用源或本地同步成功，不会抹去接口失败记录。</p>
      <div class="operations-grid">
        <section v-for="c in components" :key="c.id" :class="['panel operations-card', c.status || 'unknown']">
          <header><div><span>{{ c.label }}</span><strong>{{ statusLabels[c.status] || '未知' }}</strong></div><IconActivity :size="21" /></header>
          <dl>
            <div><dt>最后观测</dt><dd>{{ formatShanghaiDateTime(c.observedAt, true) }}</dd></div>
            <div><dt>最后成功</dt><dd>{{ formatShanghaiDateTime(c.lastSuccessAt, true) }}</dd></div>
            <div><dt>连续失败</dt><dd>{{ c.consecutiveFailures ?? 0 }}</dd></div>
            <div><dt>P95耗时</dt><dd>{{ c.p95DurationMs == null ? '--' : `${c.p95DurationMs} ms` }}</dd></div>
            <div><dt>快照年龄</dt><dd>{{ c.snapshotAgeMs == null ? '--' : formatDurationMs(c.snapshotAgeMs) }}</dd></div>
            <div><dt>恢复时间</dt><dd>{{ formatShanghaiDateTime(c.recovery?.occurredAt, true) }}</dd></div>
          </dl>
          <p v-if="c.id === 'ai'">当前队列 {{ c.queueDepth ?? 0 }} 个任务</p>
        </section>
      </div>
    </details>

    <p class="page-data-method"><IconInfoCircle :size="15" /> 状态由最近成功、失败、恢复事件与快照时间计算；未知不等于正常。</p>
  </div>
</template>
