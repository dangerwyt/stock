import { createRouter, createWebHistory } from 'vue-router'

// Route names mirror the reference app's nav ids so sidebar highlighting and
// the `.active-{id}` app-shell class work exactly like the original.
const routes = [
  { path: '/', name: 'overview', component: () => import('@/views/OverviewPage.vue'), meta: { title: '首页' } },
  { path: '/top50', name: 'top50', component: () => import('@/views/Top50Page.vue'), meta: { title: 'TOP50' } },
  { path: '/market', name: 'market', component: () => import('@/views/MarketCenterPage.vue'), meta: { title: '行情' } },
  { path: '/portfolio', name: 'portfolio', component: () => import('@/views/PortfolioPage.vue'), meta: { title: '自选' } },
  { path: '/news', name: 'news', component: () => import('@/views/NewsPage.vue'), meta: { title: '资讯' } },
  { path: '/ai', name: 'ai', component: () => import('@/views/AILabPage.vue'), meta: { title: 'AI研究' } },
  { path: '/industries', name: 'industries', component: () => import('@/views/IndustriesPage.vue'), meta: { title: '行业主题' } },
  { path: '/strategies', name: 'strategies', component: () => import('@/views/StrategiesPage.vue'), meta: { title: '老师策略' } },
  { path: '/tools', name: 'tools', component: () => import('@/views/QuantPage.vue'), meta: { title: '量化工具' } },
  { path: '/review', name: 'review', component: () => import('@/views/ReviewPage.vue'), meta: { title: '盘后复盘' } },
  { path: '/accuracy', name: 'accuracy', component: () => import('@/views/AccuracyPage.vue'), meta: { title: '准确率证据' } },
  { path: '/risk', name: 'risk', component: () => import('@/views/RiskPage.vue'), meta: { title: '风险中心' } },
  { path: '/operations', name: 'operations', component: () => import('@/views/OperationsPage.vue'), meta: { title: '运行状态' } },
]

const router = createRouter({ history: createWebHistory(), routes })
export default router
