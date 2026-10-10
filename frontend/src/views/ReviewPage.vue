<script setup>
import { ref, computed } from 'vue'
import { useSnapshot } from '@/composables/useSnapshot'
import { formatShanghaiDateTime } from '@/utils/format'
import { IconFileAnalytics, IconRefresh, IconDatabase, IconInfoCircle, IconAlertTriangle } from '@tabler/icons-vue'

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
const date = ref(today)
const cycle = ref('超短')
const refresh = ref(0)
const { data: review, state } = useSnapshot(`/api/review?date=${date.value}`, { refreshMs: 60000 })
const report = computed(() => (review.value?.date === date.value ? review.value?.report : null))
const active = computed(() => report.value?.cycles?.find((c) => c.cycle === cycle.value))
const pct = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`)
</script>

<template>
  <div class="simple-page review-page">
    <div class="page-toolbar">
      <div><h1>盘后复盘</h1><p>真实收盘数据 × 盘前冻结榜单 · 报告生成不依赖AI回答</p></div>
      <div class="review-controls">
        <label>报告日期 <input aria-label="复盘日期" type="date" :value="date" :max="today" @input="date = $event.target.value || today" /></label>
        <button class="toolbar-button" @click="refresh++"><IconRefresh :size="15" /> 刷新报告</button>
      </div>
    </div>

    <div v-if="state === 'unavailable'" role="status" class="operations-unavailable">
      <IconAlertTriangle /><span><strong>报告读取失败</strong><small>保留已显示报告及原时间，不冒充最新数据。</small></span>
    </div>

    <div class="review-history">
      已有报告：
      <template v-if="review?.dates?.length">
        <button v-for="d in review.dates" :key="d" :class="{ active: d === date }" @click="date = d">{{ d }}</button>
      </template>
      <span v-else>暂无存档</span>
    </div>

    <div v-if="review?.date === date && review.attempt?.reason" class="review-warning" role="status">{{ review.attempt.reason }}</div>

    <div v-if="!report" class="account-empty" role="status">
      <IconFileAnalytics :size="24" />
      <strong>{{ review?.date !== date ? '正在读取报告' : '当日报告待生成' }}</strong>
      <p>{{ review?.attempt?.reason || '交易日15:20首次生成，17:35、18:35补充校准；缺收盘数据时不生成虚构结论。' }}</p>
    </div>

    <template v-else>
      <div class="operations-summary">
        <span>{{ report.status === 'ready' ? '收盘样本已核验' : '报告不完整 · 不作完整结论' }}</span>
        <strong>{{ report.tradeDate }} · 生成于 {{ formatShanghaiDateTime(report.generatedAt) }}</strong>
        <small>冻结 {{ formatShanghaiDateTime(report.frozenAt) }} · 行情基准 {{ report.referenceDate || '未记录' }} · {{ report.source }}</small>
      </div>
      <div v-if="report.gaps?.length" class="review-warning" role="status">{{ report.gaps.join('；') }}</div>
      <div class="review-tabs" role="tablist" aria-label="复盘周期">
        <button v-for="c in ['超短', '短线', '波段', '中长线']" :key="c" role="tab" :aria-selected="cycle === c" :class="{ active: cycle === c }" @click="cycle = c">{{ c }}</button>
      </div>
      <div class="accuracy-kpis">
        <section><span>有效收盘覆盖</span><strong>{{ active?.observed ?? 0 }} / {{ active?.expected ?? 0 }}</strong><small>当日价格匹配，不用旧价补位</small></section>
        <section><span>榜单等权日表现</span><strong>{{ pct(active?.averageChange) }}</strong><small>相对冻结参考价，非实盘收益</small></section>
        <section><span>上涨股票</span><strong>{{ active?.advancing ?? 0 }}</strong><small>仅统计有效价格样本</small></section>
        <section><span>收盘跌破失效价</span><strong>{{ active?.invalidated ?? 0 }}</strong><small>规则复核项，不自动下单</small></section>
      </div>
      <section class="panel">
        <div class="panel-head"><div><h2>逐股复核 · {{ cycle }}</h2><span>{{ report.method }}</span></div></div>
        <div class="quality-table-scroll">
          <table>
            <thead><tr><th>股票</th><th>行业</th><th>冻结参考价</th><th>当日收盘</th><th>日表现</th><th>失效规则</th><th>研究</th></tr></thead>
            <tbody>
              <tr v-for="item in active?.stocks || []" :key="item.code">
                <td><strong>{{ item.name }}</strong><small>{{ item.code }}</small></td>
                <td>{{ item.industry }}</td>
                <td>{{ item.referencePrice ?? '--' }}</td>
                <td>{{ item.close ?? '缺数据' }}</td>
                <td :class="item.change > 0 ? 'price-up' : item.change < 0 ? 'price-down' : ''">{{ pct(item.change) }}</td>
                <td>{{ item.invalidated == null ? '未核验' : item.invalidated ? `跌破 ${item.invalidPrice}` : `未跌破 ${item.invalidPrice}` }}</td>
                <td><button class="table-action">查看股票</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div class="review-two-columns">
        <section class="panel">
          <div class="panel-head"><div><h2>行业表现分布</h2><span>描述性归因，不证明因果</span></div></div>
          <div class="review-list">
            <div v-for="item in active?.industries || []" :key="item.industry"><strong>{{ item.industry }}</strong><span>{{ item.count }}只</span><b>{{ pct(item.averageChange) }}</b></div>
          </div>
          <p class="page-data-method">{{ report.attributionMethod }}</p>
        </section>
        <section class="panel">
          <div class="panel-head"><div><h2>当日资讯依据</h2><span>点击跳转原文，自行核验关联性</span></div></div>
          <div class="review-news">
            <a v-for="item in report.news || []" :key="item.url" :href="item.url" target="_blank" rel="noopener noreferrer"><strong>{{ item.title }}</strong><small>{{ formatShanghaiDateTime(item.publishedAt) }}</small></a>
            <p v-if="!report.news?.length">没有当日可核验资讯，未使用旧新闻填充。</p>
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><div><h2>次日研究检查单</h2><span>条件式推演，不是涨跌预测</span></div></div>
        <div class="review-scenarios">
          <article v-for="item in report.nextDayPlan || []" :key="item.scenario"><h3>{{ item.scenario }}</h3><p>{{ item.condition }}</p><small>{{ item.action }}</small></article>
        </div>
      </section>
    </template>
  </div>
</template>
