<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { useAppStore } from '@/stores/snapshot'
import { useStockDecision } from '@/composables/useStockDecision'
import { resolveWatchlistStocks, buildLiveUniverse } from '@/utils/format'
import { IconSearch, IconStar, IconDatabase } from '@tabler/icons-vue'

const router = useRouter()
const store = useAppStore()
const stockDecision = useStockDecision()
const transferOpen = ref(false)
const transferText = ref('')
const transferMessage = ref('')

const { data: top50 } = useSnapshot('/api/top50', { refreshMs: 300000 })
const { data: market } = useSnapshot('/api/market', { refreshMs: 60000 })

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原来写死 12，
// 但内置 12 位是原版 mock 人设，已从产品里去掉；没有自建老师时兜 1，避免除零。
const teacherCount = computed(() => Number(top50.value?.meta?.teacherCount) || 1)

const liveUniverse = computed(() => buildLiveUniverse(top50.value, market.value))

// 自选股不在 TOP50 时，用引擎同口径补四周期因子字段（综合分 / 因子支持 / 状态 / 为什么入选 /
// 失效条件 / 行情日）。取与 buildLiveUniverse 一致的「末位周期」中长线作主展示周期，
// 保证 TOP50 与非 TOP50 自选行口径统一。
const WATCHLIST_PRIMARY_CYCLE = '中长线'
const enrichDetails = ref({})
const enrichState = ref('idle') // idle | loading | ready | unavailable

// 需要补因子的自选：在 TOP50 榜单（带 agentScores）之外的标的。
const needsEnrich = computed(() => {
  const inTop = new Set(liveUniverse.value.filter((s) => s.agentScores).map((s) => s.code))
  return store.watchlist.filter((c) => !inTop.has(c))
})

let enrichToken = 0
let enrichRetryTimer = null
async function runEnrich({ retry = true } = {}) {
  const codes = needsEnrich.value
  if (enrichRetryTimer) {
    clearTimeout(enrichRetryTimer)
    enrichRetryTimer = null
  }
  if (!codes.length) {
    enrichState.value = 'idle'
    return
  }
  const token = ++enrichToken
  enrichState.value = 'loading'
  try {
    const resp = await fetch('/api/stocks/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes }),
    })
    if (token !== enrichToken) return
    if (!resp.ok) {
      failEnrich(retry)
      return
    }
    const data = await resp.json()
    if (token !== enrichToken) return
    if (data.status !== 'ready' || !data.result) {
      failEnrich(retry)
      return
    }
    const next = { ...enrichDetails.value }
    for (const code of codes) {
      const entry = data.result[code]
      if (entry && entry.available && entry.cycles) {
        const primary = entry.cycles[WATCHLIST_PRIMARY_CYCLE] || Object.values(entry.cycles)[0]
        if (primary) {
          next[code] = {
            ...primary,
            name: entry.name || primary.name,
            marketDataDate: entry.marketDataDate,
            cycles: entry.cycles,
          }
        }
      }
    }
    enrichDetails.value = next
    enrichState.value = 'ready'
  } catch {
    if (token === enrichToken) failEnrich(retry)
  }
}

// 失败处理：置 unavailable 并**自动重试一次**（间隔 5s）。
// 后端重启 / 冷启动重算（首次约需 20-70s）期间会短暂失败，若只失败一次就永久空着，
// 用户看到的就是「几列全是 --」而不知道原因。自动重试能自愈，手动重试按钮兜底。
function failEnrich(allowRetry) {
  enrichState.value = 'unavailable'
  if (!allowRetry) return
  enrichRetryTimer = setTimeout(() => {
    enrichRetryTimer = null
    runEnrich({ retry: false })
  }, 5000)
}

const watchItems = computed(() => resolveWatchlistStocks(store.watchlist, liveUniverse.value, enrichDetails.value))
const availableCount = computed(() => watchItems.value.filter((i) => i.watchlistDataAvailable).length)
const top50Count = computed(() => watchItems.value.filter((i) => i.decisionAvailable && i.rank > 0).length)
const actionableCount = computed(() => watchItems.value.filter((i) => i.decisionAvailable && i.status === '可试仓').length)
const highRiskCount = computed(() => watchItems.value.filter((i) => i.decisionAvailable && i.risk === '高').length)

function openTransfer() {
  transferOpen.value = !transferOpen.value
  transferText.value = store.watchlist.join(',')
  transferMessage.value = ''
}
function mergeImport() {
  const codes = [...new Set(transferText.value.trim().split(/[\s,，]+/).filter(Boolean))]
  if (!codes.length || codes.length > 100 || codes.some((code) => !/^\d{6}$/.test(code))) {
    transferMessage.value = '请输入最多100个有效的六位股票代码。'
    return
  }
  codes.filter((code) => !store.watchlist.includes(code)).forEach((code) => store.toggleWatch(code))
  transferMessage.value = '已合并到当前自选，名称将从行情资料补全。'
}
function openStock(item) {
  // 自选组合「查看」：直接弹出与 TOP50 点股票名一致的单股决策弹窗（全局实例）。
  stockDecision.open({ code: item.code, stock: item })
}
function addStock() {
  router.push('/market')
}

// 自选股因子补全：自选列表或 TOP50 快照就绪时，自动为不在榜单内的标的拉同口径四周期因子。
// token 防竞态：仅采用最后一次请求结果。
watch(
  () => `${store.watchlist.join(',')}|${top50.value?.meta?.status || ''}|${market.value?.meta?.status || ''}`,
  () => {
    runEnrich()
  },
)
onMounted(() => {
  runEnrich()
})
</script>

<template>
  <div class="simple-page">
    <div class="page-toolbar">
      <div>
        <h1>自选组合</h1>
        <p>当前浏览器自选 · 可复制股票代码到其他浏览器导入 · 不代表真实持仓</p>
      </div>
      <button class="outline-button" @click="openTransfer">导入 / 导出</button>
      <button class="primary-button compact" @click="addStock"><IconSearch :size="16" /> 添加股票</button>
    </div>

    <section v-if="transferOpen" class="panel portfolio-transfer">
      <label for="portfolio-transfer">复制或粘贴六位股票代码（逗号、空格或换行分隔）</label>
      <textarea id="portfolio-transfer" v-model="transferText" maxlength="3000" />
      <button class="outline-button" @click="mergeImport">合并导入</button>
      <p role="status">{{ transferMessage }}</p>
    </section>

    <div class="portfolio-summary">
      <section><span>自选股票</span><strong>{{ watchItems.length }}</strong><small>按实际加入顺序显示</small></section>
      <section><span>行情已就绪</span><strong>{{ availableCount }}</strong><small>{{ watchItems.length - availableCount ? `${watchItems.length - availableCount}只等待快照刷新` : '全部已有最新研究快照' }}</small></section>
      <section><span>当前TOP50</span><strong>{{ top50Count }}</strong><small>基于当前四周期合并榜单</small></section>
      <section><span>可执行 / 高风险</span><strong>{{ actionableCount }} / {{ highRiskCount }}</strong><small>以最新冻结因子结果为准</small></section>
    </div>

    <p v-if="enrichState === 'unavailable'" role="status" class="portfolio-enrich-note">
      因子评估暂不可用（行情服务未就绪或正在计算），不在 TOP50 的自选股先显示「待评估」。
      <button class="table-action" @click="runEnrich({ retry: false })">重新评估</button>
    </p>
    <p v-else-if="enrichState === 'loading'" role="status" class="portfolio-enrich-note">
      正在为榜单外的自选股计算因子评分（首次需拉取全市场行情，约 20-70 秒）…
    </p>

    <section class="panel portfolio-table">
      <div class="panel-head">
        <div><h2>我的自选</h2><span>本机保存 · 与侧边栏实时一致</span></div>
      </div>
      <table v-if="watchItems.length">
        <thead>
          <tr><th>股票</th><th>行业</th><th>参考价</th><th>涨跌幅</th><th>TOP50排名</th><th>因子支持</th><th>风险状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in watchItems" :key="item.code" :class="{ clickable: item.decisionAvailable }" @click="item.decisionAvailable && openStock(item)">
            <td><strong>{{ item.name }}</strong><small>{{ item.code }}</small></td>
            <td>{{ item.industry }}</td>
            <td>{{ item.watchlistDataAvailable ? item.price.toFixed(2) : '--' }}</td>
            <td :class="item.watchlistDataAvailable ? (item.pct >= 0 ? 'price-up' : 'price-down') : ''">{{ item.watchlistDataAvailable ? `${item.pct >= 0 ? '+' : ''}${item.pct}%` : '待刷新' }}</td>
            <td>{{ item.decisionAvailable && item.rank > 0 ? `#${item.rank}` : '--' }}</td>
            <td>{{ item.decisionAvailable ? `${item.consensus}/${teacherCount}` : '--' }}</td>
            <td><span :class="item.decisionAvailable ? (item.risk === '低' ? 'positive' : 'negative') : 'neutral'">{{ item.decisionAvailable ? `${item.risk}风险` : '待评估' }}</span></td>
            <td>
              <button v-if="item.decisionAvailable" class="table-action" @click.stop="openStock(item)">查看</button>
              <button class="table-action" @click.stop="store.toggleWatch(item.code)">移除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="account-empty">
        <IconStar :size="22" /><strong>暂未加入自选股票</strong>
        <p>点击上方“添加股票”可搜索全部A股。</p>
      </div>
    </section>
  </div>
</template>
