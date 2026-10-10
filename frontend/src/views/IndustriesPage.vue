<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import {
  IconDatabase,
  IconAlertTriangle,
  IconNews,
  IconInfoCircle,
} from '@tabler/icons-vue'

const router = useRouter()
const { data: snap, state } = useSnapshot('/api/industries', { refreshMs: 300000 })

const industries = computed(() => snap.value?.industries || [])
const catalysts = computed(() => snap.value?.catalysts || [])
const dataDate = computed(() => snap.value?.meta?.marketDataDate || '--')

function goStock() {
  router.push('/top50')
}
</script>

<template>
  <div class="simple-page">
    <div class="page-toolbar">
      <div>
        <h1>行业与主题</h1>
        <p>{{ state === 'ready' ? `TOP50真实行情分组 · 行情截止 ${dataDate}` : '正在读取真实行业快照' }}</p>
      </div>
      <span class="toolbar-button">
        <IconDatabase :size="15" />
        {{ snap?.meta?.sourceMode === 'derived_from_live' ? '真实数据推导' : '等待数据' }}
      </span>
    </div>

    <div v-if="state === 'unavailable'" class="account-empty">
      <IconAlertTriangle :size="22" />
      <strong>真实行业数据暂不可用</strong>
      <p>本页不会展示静态行业涨跌或虚构催化。</p>
    </div>

    <div class="industry-reference-grid">
      <div class="industry-ranking-list">
        <div class="industry-ranking-head">
          <span>排名 / 行业</span><span>区间表现</span><span>规则强度</span><span>上涨家数</span><span>样本</span><span>核心股票</span>
        </div>
        <section
          v-for="(sector, index) in industries"
          :key="sector.name"
          :class="['industry-ranking-row', sector.stockCount <= 2 ? 'small-sample' : '']"
        >
          <div class="industry-ranking-name">
            <b>#{{ index + 1 }}</b>
            <span>
              <strong>{{ sector.name }}</strong>
              <small>{{ sector.stockCount <= 2 ? '小样本，仅供观察' : 'TOP50行业分组' }}</small>
            </span>
          </div>
          <strong :class="Number(sector.averagePct) >= 0 ? 'price-up' : 'price-down'">
            {{ sector.averagePct == null ? '--' : `${sector.averagePct >= 0 ? '+' : ''}${sector.averagePct}%` }}
          </strong>
          <div class="industry-strength">
            <span><i :style="{ width: `${sector.strengthScore}%` }" /></span>
            <b>{{ sector.strengthScore }}</b>
          </div>
          <span>{{ sector.positiveBreadth }}%</span>
          <span :class="sector.stockCount <= 2 ? 'sample-warning' : ''">{{ sector.stockCount }}只</span>
          <div class="industry-core-stocks">
            <button v-for="stock in (sector.topStocks || []).slice(0, 3)" :key="stock.code" @click="goStock">
              <span>{{ stock.name }}<small>{{ stock.code }} · {{ stock.risk }}风险</small></span>
              <b>{{ stock.score }}</b>
            </button>
          </div>
        </section>
      </div>

      <aside class="panel industry-core-panel">
        <div class="panel-head"><h2>核心股票</h2></div>
        <section v-for="sector in industries.slice(0, 6)" :key="sector.name" class="industry-core-group">
          <h3>{{ sector.name }}</h3>
          <button v-for="stock in (sector.topStocks || []).slice(0, 3)" :key="stock.code" @click="goStock">
            <span>{{ stock.name }}<small>{{ stock.code }}</small></span>
            <b>{{ stock.score }}</b>
          </button>
        </section>
      </aside>
    </div>

    <section class="panel industry-table">
      <div class="panel-head">
        <div>
          <h2>行业关联资讯</h2>
          <span>来自定时资讯原文 · 仅按行业关键词关联，不自动判定利好利空</span>
        </div>
      </div>
      <table v-if="catalysts.length">
        <thead>
          <tr><th>时间</th><th>行业</th><th>来源</th><th>新闻标题</th><th>匹配方式</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in catalysts" :key="`${item.industry}:${item.id}`">
            <td>{{ item.time || '--' }}</td>
            <td>{{ item.industry }}</td>
            <td>{{ item.source }}</td>
            <td><a :href="item.url" target="_blank" rel="noreferrer">{{ item.title }}</a></td>
            <td>行业关键词</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="account-empty">
        <IconNews :size="22" />
        <strong>暂无可核验的行业关联资讯</strong>
        <p>不使用静态事件补位。</p>
      </div>
    </section>

    <p v-if="snap?.meta?.methodology" class="page-data-method">
      <IconInfoCircle :size="15" /> {{ snap.meta.methodology }}
    </p>
  </div>
</template>
