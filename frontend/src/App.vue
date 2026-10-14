<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/snapshot'
import { fetchSnapshot } from '@/api/client'
import {
  IconHome2,
  IconTrendingUp,
  IconActivity,
  IconBriefcase2,
  IconNews,
  IconBrain,
  IconBuildingFactory2,
  IconUsersGroup,
  IconChartDots3,
  IconFileAnalytics,
  IconReportAnalytics,
  IconShieldCheck,
  IconMenu2,
  IconSearch,
  IconBell,
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
      { id: 'industries', label: '行业主题', icon: IconBuildingFactory2 },
      { id: 'strategies', label: '老师策略', icon: IconUsersGroup },
      { id: 'tools', label: '量化工具', icon: IconChartDots3 },
      { id: 'review', label: '盘后复盘', icon: IconFileAnalytics },
    ],
  },
  {
    label: '可信与系统',
    items: [
      { id: 'accuracy', label: '准确率证据', icon: IconReportAnalytics },
      { id: 'risk', label: '风险中心', icon: IconShieldCheck },
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

const active = computed(() => route.name || 'overview')
const collapsed = ref(false)
const mobileSidebar = ref(false)
const searchOpen = ref(false)
const notificationsOpen = ref(false)

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
async function runSearch() {
  const q = searchQuery.value.trim()
  searchState.value = 'loading'
  try {
    const data = await fetchSnapshot(`/api/stocks/search?q=${encodeURIComponent(q)}`)
    searchItems.value = data?.items || []
    searchState.value = 'ready'
  } catch (e) {
    searchItems.value = []
    searchState.value = 'unavailable'
  }
}
function openSearch() {
  searchOpen.value = true
  searchQuery.value = ''
  searchItems.value = []
  searchState.value = 'idle'
  runSearch()
}
function openStock(item) {
  searchOpen.value = false
  if (!store.has(item.code)) store.toggleWatch(item.code)
  router.push('/top50')
}

// --- 通知中心 ---
const notifications = ref([])
async function openNotifications() {
  notificationsOpen.value = true
  try {
    const data = await fetchSnapshot('/api/notifications')
    notifications.value = data?.items || []
  } catch (e) {
    notifications.value = []
  }
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
          <button class="mobile-menu" aria-label="打开导航" @click="mobileSidebar = true"><IconMenu2 :size="20" /></button>
          <strong>{{ pageTitle }}</strong>
          <span>{{ session?.date || 'A股交易日' }}</span>
          <span>{{ session?.label || '上海时间' }}</span>
          <span class="data-state" :title="marketHealth?.label || dataLabel"><i /> {{ dataLabel }}</span>
        </div>
        <div class="header-actions">
          <button class="header-search" title="全局搜索" aria-label="全局搜索" @click="openSearch">
            <IconSearch :size="18" /><span>搜索股票 / 代码 / 行业</span>
          </button>
          <button class="notification" title="通知" aria-label="通知" @click="openNotifications">
            <IconBell :size="18" /><em>{{ notifications.length || 0 }}</em>
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
      <div class="search-field">
        <el-input v-model="searchQuery" class="ep-form-control" placeholder="输入代码、名称或行业" clearable @keyup.enter="runSearch" />
        <button class="table-action" @click="runSearch">搜索</button>
      </div>
      <div class="stock-search-results">
        <button v-for="item in searchItems" :key="item.code" class="stock-search-result" @click="openStock(item)">
          <strong>{{ item.name }}</strong>
          <small>{{ item.code }} · {{ item.industry }}</small>
        </button>
        <p v-if="searchState === 'ready' && !searchItems.length" class="stock-search-empty">没有匹配的股票</p>
      </div>
    </div>

    <!-- 通知中心 -->
    <div v-if="notificationsOpen" class="notification-center" role="dialog" aria-label="通知中心">
      <header><strong>通知中心</strong><button aria-label="关闭" @click="notificationsOpen = false">✕</button></header>
      <div class="notification-list">
        <article v-for="(item, i) in notifications" :key="i" class="notification-item">
          <strong>{{ item.title || item.name || '系统通知' }}</strong>
          <small>{{ item.detail || item.summary || item.body || '' }}</small>
        </article>
        <p v-if="!notifications.length" class="notification-empty">暂无通知</p>
      </div>
    </div>
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
.stock-search-dialog .search-field { display: flex; gap: 8px; padding: 12px 16px; }
.stock-search-dialog .search-field input { flex: 1; height: 32px; border: 1px solid #bcd4ef; border-radius: 7px; padding: 0 10px; }
.stock-search-results, .notification-list { overflow: auto; padding: 0 10px 12px; }
.stock-search-result, .notification-item {
  display: block; width: 100%; text-align: left; border: 1px solid #dfe9f7; background: #fff;
  border-radius: 8px; padding: 9px 12px; margin: 6px 0;
}
.stock-search-result strong, .notification-item strong { display: block; }
.stock-search-result small, .notification-item small { color: #6e86ab; font-size: 11px; }
.stock-search-empty, .notification-empty { padding: 18px; color: #7f95b6; text-align: center; }
</style>
