<script setup>
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/snapshot'
import { fetchSnapshot } from '@/api/client'
import { useStockDecision } from '@/composables/useStockDecision'
import StockDecisionDialog from '@/components/StockDecisionDialog.vue'
import {
  IconHome2,
  IconTrendingUp,
  IconActivity,
  IconBriefcase2,
  IconNews,
  IconBrain,
  IconUsersGroup,
  IconChartDots3,
  IconFileAnalytics,
  IconReportAnalytics,
  IconMenu2,
  IconSearch,
  IconUserCircle,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconChartCandle,
} from '@tabler/icons-vue'

// 原版 reference-react 分组导航（常用 / 研究工具 / 可信与系统）
const navGroups = [
  {
    label: '常用',
    items: [
      { id: 'overview', label: '首页', icon: IconHome2 },
      { id: 'top50', label: 'TOP50', icon: IconTrendingUp },
      { id: 'market', label: '行情', icon: IconActivity },
      { id: 'portfolio', label: '自选', icon: IconBriefcase2 },
      { id: 'news', label: '资讯', icon: IconNews },
      { id: 'ai', label: 'AI研究', icon: IconBrain },
    ],
  },
  {
    label: '研究工具',
    items: [
      { id: 'strategies', label: '老师策略', icon: IconUsersGroup },
      { id: 'tools', label: '量化工具', icon: IconChartDots3 },
      { id: 'review', label: '盘后复盘', icon: IconFileAnalytics },
    ],
  },
  {
    label: '可信与系统',
    items: [
      { id: 'accuracy', label: '准确率证据', icon: IconReportAnalytics },
      { id: 'operations', label: '运行状态', icon: IconActivity },
    ],
  },
]

const navItems = navGroups.flatMap((group) => group.items)
const mobilePrimaryIds = ['overview', 'top50', 'portfolio', 'news', 'ai']
const mobilePrimaryNavItems = navItems.filter((item) => mobilePrimaryIds.includes(item.id))

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const stockDecision = useStockDecision()

const active = computed(() => route.name || 'overview')
const collapsed = ref(false)
const mobileSidebar = ref(false)
const searchOpen = ref(false)

const status = computed(() => store.platformStatus)
const session = computed(() => status.value?.session)
const marketHealth = computed(() => status.value?.health?.market)

const live = computed(() => status.value?.status === 'ready')
const marketAndNewsLive = computed(
  () => status.value?.providers?.market?.configured && status.value?.providers?.news?.configured,
)
const accuracyCount = computed(() => status.value?.health?.accuracy?.sampleCount || 0)
const schedulerObserved = computed(() => status.value?.health?.scheduler?.status === 'observed')

const dataLabel = computed(() => {
  const s = status.value
  if (!s) return '正在读取运行状态'
  if (live.value) return '生产链路已验证'
  if (s.mode === 'live') {
    const top50Label = s.health?.top50?.status === 'refresh_required'
      ? 'TOP50待完整重算'
      : marketHealth.value?.status === 'auction_only'
        ? '集合竞价快照'
        : marketHealth.value?.status === 'degraded'
          ? '行情降级'
          : '真实数据'
    const acc = accuracyCount.value ? `${accuracyCount.value}样本` : '采集中'
    const sched = schedulerObserved.value ? '调度已运行' : '调度待验证'
    return `${top50Label} · 准确率${acc} · ${sched}`
  }
  return marketAndNewsLive.value ? '真实行情/资讯 · 其他服务待验证' : '演示数据 · 待配置'
})

const footerStatus = computed(() => {
  const s = status.value
  if (!s) return '正在读取平台状态'
  if (s.status === 'ready') return '生产链路已验证'
  if (s.mode === 'live') {
    const acc = s.health?.accuracy?.sampleCount ? `${s.health.accuracy.sampleCount}个样本` : '采集中'
    const sched = s.health?.scheduler?.status === 'observed' ? '调度已观测' : '调度待验证'
    return `${s.health?.market?.label || '真实数据快照'}；准确率${acc}；${sched}`
  }
  return marketAndNewsLive.value ? '行情与资讯已配置；其余链路待验证' : '当前为演示数据，禁止用于交易决策'
})

const pageTitle = computed(() => navItems.find((n) => n.id === active.value)?.label || '首页')

function idToPath(id) {
  return id === 'overview' ? '/' : `/${id}`
}
function go(id) {
  mobileSidebar.value = false
  router.push(idToPath(id))
}

// --- 全局搜索 ---
const searchQuery = ref('')
const searchItems = ref([])
const searchState = ref('idle')
const searchError = ref('')
let searchRequest = 0
watch(searchQuery, () => {
  searchRequest++
  searchItems.value = []
  searchState.value = 'idle'
}, { flush: 'sync' })
watch(searchOpen, value => { if (!value) searchRequest++ }, { flush: 'sync' })
async function runSearch() {
  const request = ++searchRequest
  const q = searchQuery.value.trim()
  searchState.value = 'loading'
  searchItems.value = []
  searchError.value = ''
  try {
    const data = await fetchSnapshot(`/api/stocks/search?q=${encodeURIComponent(q)}`, { timeout: 70000, retry: true })
    if (request !== searchRequest) return
    if (data?.status !== 'ready' || !Array.isArray(data.items)) throw new Error('invalid search')
    searchItems.value = data.items.filter(item => /^\d{6}$/.test(item.code))
    searchState.value = 'ready'
  } catch (e) {
    if (request !== searchRequest) return
    searchItems.value = []
    searchState.value = 'unavailable'
    searchError.value = e.response?.data?.message || '搜索请求超时或服务暂不可用，请稍后重试。'
  }
}
function openSearch() {
  searchOpen.value = true
  searchQuery.value = ''
  searchItems.value = []
  searchState.value = 'idle'
  runSearch()
}
provide('openStockSearch', openSearch)
function openStock(item) {
  searchOpen.value = false
  // 加入自选（仅当尚未加入时）后，直接弹出与 TOP50 点股票名一致的单股决策弹窗。
  if (!store.has(item.code)) store.toggleWatch(item.code)
  stockDecision.open({ code: item.code, stock: item })
}

function onResize() {
  if (window.innerWidth > 760) mobileSidebar.value = false
}
onMounted(() => {
  window.addEventListener('resize', onResize)
  store.loadStatus()
})
onUnmounted(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <div
    class="app-shell"
    :class="[`active-${active}`, { 'sidebar-collapsed': collapsed, 'mobile-sidebar-open': mobileSidebar }]"
  >
    <aside class="sidebar" :class="{ collapsed }">
      <div class="brand">
        <div v-if="collapsed" class="brand-mark"><IconChartCandle :size="20" /></div>
        <img v-else src="/design-reference/brand.png" alt="智策研究 · 智能投研平台" />
      </div>
      <nav aria-label="主导航">
        <section v-for="group in navGroups" :key="group.label" class="sidebar-nav-group" :aria-label="group.label">
          <span v-if="!collapsed" class="sidebar-nav-label">{{ group.label }}</span>
          <button
            v-for="item in group.items"
            :key="item.id"
            :class="{ active: active === item.id }"
            :aria-label="item.label"
            :title="collapsed ? item.label : undefined"
            :aria-current="active === item.id ? 'page' : undefined"
            @click="go(item.id)"
          >
            <component :is="item.icon" :size="19" :stroke="1.8" />
            <span v-if="!collapsed">{{ item.label }}</span>
          </button>
        </section>
      </nav>
      <button v-if="!collapsed" class="research-promo" aria-label="开启AI研究助手" @click="go('ai')">
        <img src="/design-reference/research-promo.png" alt="AI驱动的专业投研助手，让洞察更聪明" />
      </button>
      <div class="sidebar-foot">
        <span class="live-dot" />
        <span v-if="!collapsed">共享数据缓存</span>
        <button :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'" @click="collapsed = !collapsed">
          <IconLayoutSidebarLeftExpand v-if="collapsed" :size="17" />
          <IconLayoutSidebarLeftCollapse v-else :size="17" />
        </button>
      </div>
    </aside>

    <button v-if="mobileSidebar" class="sidebar-backdrop" aria-label="关闭导航" @click="mobileSidebar = false" />

    <div class="app-content">
      <header class="app-header">
        <div class="header-title">
          <button class="mobile-menu" aria-label="打开导航" @click="collapsed = false; mobileSidebar = true"><IconMenu2 :size="20" /></button>
          <strong>{{ pageTitle }}</strong>
          <span>{{ session?.date || 'A股交易日' }}</span>
          <span>{{ session?.label || '上海时间' }}</span>
          <span class="data-state" :title="marketHealth?.label || dataLabel"><i /> {{ dataLabel }}</span>
        </div>
        <div class="header-actions">
          <button class="header-search" title="全局搜索" aria-label="全局搜索" @click="openSearch">
            <IconSearch :size="18" /><span>搜索股票 / 代码 / 行业</span>
          </button>
          <button class="profile profile-button" aria-label="匿名研究模式"><IconUserCircle :size="19" /><span>无需登录</span></button>
        </div>
      </header>

      <div class="page-content">
        <router-view />
      </div>

      <footer>
        <span>A股 · {{ session?.label || '上海时间' }}</span>
        <span>{{ footerStatus }}</span>
        <span>任务时区 Asia/Shanghai</span>
        <span class="footer-spacer" />
        <span>预测按目标交易日收盘验证</span>
        <span>非收益承诺</span>
        <span>隐私政策</span>
      </footer>
    </div>

    <nav class="mobile-primary-nav" aria-label="移动端常用导航">
      <button
        v-for="item in mobilePrimaryNavItems"
        :key="item.id"
        :class="{ active: active === item.id }"
        @click="go(item.id)"
      >
        <component :is="item.icon" :size="20" :stroke="1.8" />
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <!-- 全局搜索 -->
    <div v-if="searchOpen" class="stock-search-dialog" role="dialog" aria-label="搜索股票">
      <header><strong>搜索股票 / 代码 / 行业</strong><button aria-label="关闭" @click="searchOpen = false">✕</button></header>
      <div class="stock-search-field">
        <el-input v-model="searchQuery" class="ep-form-control" placeholder="输入代码、名称或行业" clearable @keyup.enter="runSearch" />
        <button class="table-action" :disabled="searchState === 'loading'" @click="runSearch">{{ searchState === 'loading' ? '搜索中' : '搜索' }}</button>
      </div>
      <div class="stock-search-results">
        <button v-for="item in searchItems" :key="item.code" class="stock-search-result" @click="openStock(item)">
          <strong>{{ item.name }}</strong>
          <small>{{ item.code }} · {{ item.industry }}</small>
          <small>{{ store.has(item.code) ? '已加入自选 · 查看分析' : '加入自选并查看分析' }}</small>
        </button>
        <p v-if="searchState === 'loading'" class="stock-search-empty" role="status">正在搜索股票…</p>
        <p v-if="searchState === 'unavailable'" class="stock-search-empty" role="alert">{{ searchError }}</p>
        <p v-if="searchState === 'ready' && !searchItems.length" class="stock-search-empty">没有匹配的股票</p>
      </div>
    </div>

    <!-- 全局单股决策弹窗 + 冻结选股证据（任意「加自选」入口共用）-->
    <StockDecisionDialog />
  </div>
</template>

<style scoped>
.stock-search-dialog,
.notification-center {
  position: fixed; z-index: 90; top: 66px; right: 24px; width: 380px; max-height: 70vh;
  border: 1px solid #bed6f5; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column;
  box-shadow: 0 24px 70px rgba(29, 78, 135, .24);
}
.stock-search-dialog > header,
.notification-center > header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid #d4e4f8;
}
.stock-search-dialog { max-width: calc(100vw - 48px); background: #fff; }
.stock-search-dialog > header { flex: 0 0 auto; padding: 14px 16px 8px; border-bottom: 0; background: #fff; }
.stock-search-dialog > header strong { font-size: 15px; }
.stock-search-dialog > header button { width: 30px; height: 30px; border-color: transparent; background: #f4f8ff; border-radius: 8px; }
.stock-search-field { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; padding: 4px 16px 16px; border-bottom: 1px solid #e3ecf8; }
.stock-search-field > .el-input { flex: 1; width: auto; min-width: 0; }
.stock-search-field :deep(.el-input__wrapper) { min-height: 40px; padding: 0 12px; border-radius: 8px; background: #f7faff; }
.stock-search-field :deep(.el-input__inner) { flex: 1; font-size: 13px; }
.stock-search-field > button { flex: 0 0 64px; height: 40px; margin: 0; padding: 0 10px; border: 1px solid #2878ed; border-radius: 8px; background: #2878ed; color: #fff; font-size: 13px; }
.stock-search-field > button:hover:not(:disabled) { background: #1768db; }
.stock-search-field > button:disabled { opacity: .6; cursor: wait; }
.stock-search-results, .notification-list { overflow: auto; padding: 0 10px 12px; }
.stock-search-result, .notification-item {
  display: block; width: 100%; text-align: left; border: 1px solid #dfe9f7; background: #fff;
  border-radius: 8px; padding: 9px 12px; margin: 6px 0;
}
.stock-search-result strong, .notification-item strong { display: block; }
.stock-search-result small, .notification-item small { color: #6e86ab; font-size: 11px; }
.stock-search-result small { display: block; margin-top: 3px; }
.stock-search-empty, .notification-empty { padding: 18px; color: #7f95b6; text-align: center; }
</style>
