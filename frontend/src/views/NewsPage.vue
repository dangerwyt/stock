<script setup>
import { ref, computed } from 'vue'
import { useSnapshot } from '@/composables/useSnapshot'
import { describeNewsClassification } from '@/data/teachers'
import {
  IconDatabase,
  IconSearch,
  IconStar,
  IconChevronRight,
  IconChevronDown,
  IconRefresh,
} from '@tabler/icons-vue'

const { data: news, state, sourceMode } = useSnapshot('/api/news', { refreshMs: 300000 })
const query = ref('')
const top50Only = ref(false)
const visibleCount = ref(8)

const items = computed(() => news.value?.items || [])
const meta = computed(() => news.value?.meta || {})
const filtered = computed(() =>
  items.value.filter((item) => {
    const matchesQuery = `${item.stock}${item.code}${item.title}${item.source}`.includes(query.value.trim())
    const matchesTop50 = !top50Only.value || Boolean(item.relatedTop50Rank)
    return matchesQuery && matchesTop50
  }),
)
</script>

<template>
  <div class="page-grid news-page">
    <main class="primary-workspace news-workspace">
      <div class="news-statusbar">
        <div><span class="live-pulse" /><strong>全球影响资讯流</strong><small>北京时间交易日8轮采集；非交易日2轮</small></div>
        <div><IconDatabase :size="14" /><span>{{ meta?.collection?.label || (meta?.delayed ? '资讯更新延迟 · 最近真实缓存' : sourceMode === 'live' ? '真实API共享缓存' : '等待真实资讯') }}</span><b>{{ meta?.snapshotId || '等待真实快照' }}</b></div>
        <div><span>最后同步</span><strong>{{ meta?.generatedAt ? new Date(meta.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--:--' }}</strong><small>当前 {{ filtered.length }} 条 / 共 {{ meta?.itemCount || items.length }} 条</small></div>
      </div>

      <div class="news-toolbar">
        <label class="search-field"><IconSearch :size="15" /><el-input v-model="query" class="ep-form-control" placeholder="搜索资讯 / 股票 / 代码" clearable /></label>
        <button :class="['top50-toggle', top50Only ? 'active' : '']" @click="top50Only = !top50Only"><IconStar :size="14" /> 仅TOP50</button>
      </div>

      <div class="news-reference-grid">
        <section class="panel news-stream">
          <div class="panel-head">
            <div><h2>最新资讯</h2><span>显示分数、分类原因与 A 股传导路径；标题直达原文</span></div>
            <span :class="['stream-state', sourceMode === 'live' ? '' : 'warn']"><i /> {{ sourceMode === 'live' ? '真实源在线' : '待配置API' }}</span>
          </div>
          <div v-if="state === 'loading'" class="news-empty"><IconRefresh :size="18" /> 正在读取共享资讯缓存…</div>
          <div v-else-if="filtered.length === 0" class="news-empty">没有符合当前层级与筛选条件的资讯</div>
          <a v-for="item in filtered.slice(0, visibleCount)" :key="item.id" class="news-row" :href="item.url" target="_blank" rel="noreferrer">
            <span class="news-type">{{ item.source }}</span>
            <span class="news-time" :title="item.timestampBasis === 'source_updated_at' ? '来源更新时间，非原文发布时间' : '原文发布时间'">{{ item.time }}{{ item.timestampBasis === 'source_updated_at' ? ' 更新' : '' }}</span>
            <span class="news-main">
              <strong>{{ item.title }}</strong>
              <small><b>{{ item.market || 'A股' }}</b> · {{ item.source }} · {{ item.score ?? '--' }}分 · {{ describeNewsClassification(item) }}{{ item.marketImpact?.length ? ` · A股影响：${item.marketImpact.join(' / ')}` : '' }}</small>
            </span>
            <span v-if="item.relatedTop50Rank" class="news-rank">TOP50 #{{ item.relatedTop50Rank }}</span>
            <span :class="['news-impact', item.tone]"><i /> {{ item.impact }}影响</span>
            <IconChevronRight :size="15" />
          </a>
          <button v-if="visibleCount < filtered.length" class="load-more" @click="visibleCount += 8">加载更多资讯 <IconChevronDown :size="15" /></button>
        </section>

        <aside class="panel news-focus">
          <h2>市场焦点</h2>
          <p>来自当前真实资讯快照 · 标题直达原文</p>
          <a v-for="item in [...items].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6)" :key="item.id" :href="item.url" target="_blank" rel="noreferrer">
            <strong>{{ item.title }}</strong><small>{{ item.source }} · {{ item.time }}</small>
          </a>
          <p v-if="!items.length">暂无已核验资讯，不使用示例新闻补位。</p>
        </aside>
      </div>
    </main>
  </div>
</template>
