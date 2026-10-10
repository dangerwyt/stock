<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { useAppStore } from '@/stores/snapshot'
import { resolveWatchlistStocks, buildLiveUniverse } from '@/utils/format'
import { IconSearch, IconStar, IconDatabase } from '@tabler/icons-vue'

const router = useRouter()
const store = useAppStore()
const transferOpen = ref(false)
const transferText = ref('')
const transferMessage = ref('')

const { data: top50 } = useSnapshot('/api/top50', { refreshMs: 300000 })
const { data: market } = useSnapshot('/api/market', { refreshMs: 60000 })

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原来写死 12，
// 但内置 12 位是原版 mock 人设，已从产品里去掉；没有自建老师时兜 1，避免除零。
const teacherCount = computed(() => Number(top50.value?.meta?.teacherCount) || 1)

const liveUniverse = computed(() => buildLiveUniverse(top50.value, market.value))
const watchItems = computed(() => resolveWatchlistStocks(store.watchlist, liveUniverse.value, {}))
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
  router.push('/top50')
}
function addStock() {
  router.push('/market')
}
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
