<script setup>
import { computed, ref, watch, onUnmounted, inject } from 'vue'
import { useAppStore } from '@/stores/snapshot'
import { useStockDecision } from '@/composables/useStockDecision'
import { fetchSnapshot } from '@/api/client'
import { watchlistRows, filterWatchlist, candleOptions } from '@/utils/watchlistBoard'
import EChart from '@/components/EChart.vue'
import { IconStar, IconPlus, IconRefresh, IconSearch, IconTrash, IconChartCandle } from '@tabler/icons-vue'

const props = defineProps({ snapshot:Object })
const store = useAppStore(), decision = useStockDecision()
const quotes = ref({}), states = ref({}), loading = ref(false)
const errors = ref({})
const query = ref(''), direction = ref('all'), sort = ref('default'), page = ref(1), charts = ref(true)
const removed = ref(null)
const openStockSearch = inject('openStockSearch')
let request = 0
const rows = computed(() => watchlistRows(store.watchlist, props.snapshot, quotes.value))
const filtered = computed(() => filterWatchlist(rows.value, query.value, direction.value, sort.value))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length/12)))
const visible = computed(() => filtered.value.slice((page.value-1)*12, page.value*12))
const ready = computed(() => rows.value.filter(r=>r.close != null).length)
const up = computed(() => rows.value.filter(r=>r.pct>0).length)
const down = computed(() => rows.value.filter(r=>r.pct<0).length)
const failed = computed(() => store.watchlist.filter(c=>states.value[c]==='unavailable').length)
const failureMessages = computed(() => [...new Set(store.watchlist.filter(c=>states.value[c]==='unavailable').map(c=>errors.value[c]).filter(Boolean))])
const num = v => v == null ? '--' : v.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})
const pct = v => v == null ? '--' : `${v>0?'+':''}${num(v)}%`
const tone = v => v>0?'wl-up':v<0?'wl-down':''
const date = v => /^\d{8}$/.test(v) ? `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6)}` : v || '--'

async function refresh() {
  const token = ++request, queue = [...store.watchlist]
  loading.value = queue.length > 0
  // Each row is independent, so a slow or unavailable quote does not hide the list.
  await Promise.all(Array.from({length:Math.min(3,queue.length)}, async () => {
    while (queue.length && token === request) {
      const code = queue.shift()
      states.value[code] = 'loading'
      delete errors.value[code]
      try {
        const data = await fetchSnapshot(`/api/stocks/${code}/quote`,{timeout:70000,retry:true})
        if (token !== request) return
        if (data.status !== 'ready' || data.quote?.code !== code) throw new Error('invalid quote')
        quotes.value[code] = data.quote
        states.value[code] = data.quote.close > 0 ? 'ready' : 'unavailable'
      } catch (error) {
        if (token === request) {
          states.value[code] = 'unavailable'
          errors.value[code] = error.response?.data?.message || '行情请求超时或服务暂不可用，请稍后刷新重试。'
        }
      }
    }
  }))
  if (token === request) loading.value = false
}
function remove(row) { store.toggleWatch(row.code); removed.value = row }
function undo() { if (removed.value && !store.has(removed.value.code)) store.toggleWatch(removed.value.code); removed.value = null }
function open(row) { decision.open({code:row.code}) }
watch(() => store.watchlist.join(','), refresh, {immediate:true})
watch([query,direction,sort], () => { page.value=1 })
watch(pages, value => { page.value=Math.min(page.value,value) })
onUnmounted(() => { ++request })
</script>

<template>
  <section class="watchlist-board">
    <header class="wl-head"><div><h2><IconStar :size="21"/> 我的自选 <span>{{rows.length}} 只</span></h2><p>与自选组合、行情中心共用当前浏览器的自选名单</p></div><div class="wl-actions"><button :aria-pressed="charts" @click="charts=!charts"><IconChartCandle :size="17"/>日 K {{charts?'开启':'关闭'}}</button><button :disabled="loading" @click="refresh"><IconRefresh :size="16"/>{{loading?'读取中':'刷新'}}</button><button class="wl-primary" aria-haspopup="dialog" @click="openStockSearch"><IconPlus :size="17"/>添加自选</button></div></header>
    <div class="wl-toolbar"><div class="wl-filters"><button :class="{active:direction==='all'}" @click="direction='all'">全部 {{rows.length}}</button><button :class="['wl-up',{active:direction==='up'}]" @click="direction='up'">上涨 {{up}}</button><button :class="['wl-down',{active:direction==='down'}]" @click="direction='down'">下跌 {{down}}</button></div><label class="wl-search"><IconSearch :size="16"/><input v-model="query" aria-label="筛选自选股票" placeholder="筛选名称 / 代码 / 行业"/></label><select v-model="sort" aria-label="自选排序"><option value="default">加入顺序</option><option value="pct">涨跌幅从高到低</option><option value="amount">成交额从高到低</option><option value="volumeRatio">量比从高到低</option><option value="change20">20日涨幅从高到低</option></select></div>
    <div class="wl-notice" role="status">已获得行情 {{ready}} / {{rows.length}} 只 · 涨跌统计基于已读取的各股日线快照。<span v-if="loading">正在逐只读取，其余标的会陆续显示。</span><span v-if="failed"> {{failed}} 只刷新失败或缺少行情，可点击刷新重试。</span></div>
    <div v-for="message in failureMessages" :key="message" class="wl-notice" role="alert">{{message}} 自选名单已保存，不需要重复添加。</div>
    <div v-if="removed" class="wl-undo" role="status">已移除 {{removed.name}} <button @click="undo">撤销移除</button></div>
    <div class="wl-table-wrap"><table><thead><tr><th>代码 / 名称</th><th>最新日线价</th><th>涨跌幅</th><th>成交额</th><th>量比</th><th>换手率</th><th>所属行业</th><th v-if="charts">日 K <small>近20条 · 不复权</small></th><th>20日涨幅<small>不复权</small></th><th>操作</th></tr></thead><tbody><tr v-for="row in visible" :key="row.code"><td><button class="wl-stock" @click="open(row)">{{row.name}}</button><small>{{row.code}}</small><small class="wl-date">{{date(row.date)}}{{row.frozen?' · 榜单快照':''}}</small><small v-if="states[row.code]==='loading'">行情读取中…</small><small v-else-if="states[row.code]==='unavailable'">{{row.close==null?'行情暂不可用':'刷新未完成 · 保留快照'}}</small></td><td :class="tone(row.pct)"><b>{{num(row.close)}}</b></td><td :class="tone(row.pct)">{{pct(row.pct)}}</td><td>{{row.amount==null?'--':num(row.amount/1e5)+'亿'}}</td><td>{{num(row.volumeRatio)}}</td><td>{{row.turnoverRate==null?'--':num(row.turnoverRate)+'%'}}</td><td>{{row.industry}}</td><td v-if="charts" class="wl-chart"><EChart v-if="row.history.length" :options="candleOptions(row.history)" height="66px"/><span v-else>暂无日 K 数据</span><small v-if="row.history.length">截至 {{date(row.historyDate)}}</small></td><td :class="tone(row.change20)">{{pct(row.change20)}}</td><td><div class="wl-row-actions"><button @click="open(row)">分析</button><button :aria-label="'移除自选 '+row.name" @click="remove(row)"><IconTrash :size="16"/></button></div></td></tr></tbody></table></div>
    <div v-if="!filtered.length" class="wl-empty"><IconStar :size="32"/><h3>{{rows.length?'没有匹配的自选股票':'还没有自选股票'}}</h3><p>{{rows.length?'调整搜索词或涨跌筛选条件。':'从上方添加自选，或在行情中心、策略页点击星标。已有自选会自动显示在这里。'}}</p></div>
    <footer class="wl-footer"><span>共 {{filtered.length}} 只 · 本机保存</span><div><span>{{page}} / {{pages}}</span><button :disabled="page===1" @click="page--">上一页</button><button :disabled="page===pages" @click="page++">下一页</button></div></footer>
    <p class="wl-help">数据来自现有行情接口，按各股日期展示；日线不代表盘中实时行情。20日涨幅需有21条有效日线，未复权价格可能受除权除息影响。分时、资金流及人气数据暂未接入。</p>
  </section>
</template>

<style scoped>
.watchlist-board{color:#183c65;font-size:14px;min-width:0}.watchlist-board button,.watchlist-board input,.watchlist-board select{font:inherit}.watchlist-board button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #d9e5f4;border-radius:7px;background:#fff;color:#41618a;padding:8px 11px;cursor:pointer}.watchlist-board button:hover:not(:disabled){background:#edf5ff;border-color:#b8d3ff}.watchlist-board button:disabled{opacity:.45;cursor:default}.watchlist-board button:focus-visible,.watchlist-board input:focus-visible{outline:2px solid #2478f4;outline-offset:2px}.wl-head{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:10px 0 16px}.wl-head h2{display:flex;align-items:center;gap:8px;font-size:21px;margin:0}.wl-head h2 svg{color:#287af0}.wl-head h2 span{font-size:13px;font-weight:400;background:#edf5ff;color:#3178d3;padding:4px 8px;border-radius:5px}.wl-head p,.wl-help{color:#7186a2;font-size:13px;line-height:1.7;margin:8px 0 0}.wl-actions{display:flex;gap:8px;flex-wrap:wrap}.wl-actions .wl-primary{background:#edf5ff;color:#246dd2;border-color:#bbd6fb}.wl-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border:1px solid #d9e5f4;background:#fff;padding:12px;border-radius:10px 10px 0 0}.wl-filters{display:flex;gap:5px}.wl-filters button{border-color:transparent}.wl-filters .active{background:#edf5ff;border-color:#cce0ff}.wl-search{margin-left:auto;display:flex;align-items:center;gap:6px;color:#7990af;border:1px solid #d9e5f4;padding:0 9px;border-radius:6px}.wl-search input{border:0;background:transparent;min-width:0;width:190px;padding:8px 0;color:#183c65}.wl-toolbar select{border:1px solid #d9e5f4;background:#fff;color:#41618a;padding:8px;border-radius:6px}.wl-notice,.wl-undo{background:#f5f9ff;padding:10px 13px;color:#6b829f;font-size:13px;line-height:1.7}.wl-undo{display:flex;align-items:center;gap:14px}.wl-table-wrap{overflow-x:auto;border:1px solid #d9e5f4;border-top:0;background:#fff}.wl-table-wrap table{width:100%;border-collapse:collapse;white-space:nowrap}.wl-table-wrap th{font-size:13px;font-weight:500;color:#7085a2;background:#f7faff;padding:12px;text-align:right}.wl-table-wrap td{padding:12px;text-align:right;border-top:1px solid #e7eef8;font-variant-numeric:tabular-nums;height:92px}.wl-table-wrap tr:nth-child(even){background:#fafcff}.wl-table-wrap th:first-child,.wl-table-wrap td:first-child{text-align:left;min-width:155px}.wl-table-wrap small{display:block;font-size:12px;color:#7a8fa9;margin-top:5px}.wl-table-wrap .wl-stock{border:0;background:transparent;color:#214f80;font-weight:600;padding:0;font-size:15px}.wl-table-wrap .wl-date{font-size:11px}.wl-chart{min-width:155px;width:170px;text-align:center!important;color:#91a1b6;font-size:12px}.wl-chart small{font-size:11px}.wl-row-actions{display:flex;gap:5px;justify-content:flex-end}.wl-row-actions button{font-size:12px;padding:6px 8px}.wl-up,.wl-filters .wl-up{color:#f04c63}.wl-down,.wl-filters .wl-down{color:#00a28d}.wl-footer{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px;background:#fff;color:#7186a2;border:1px solid #d9e5f4;border-top:0;border-radius:0 0 10px 10px;white-space:normal;font-size:13px}.wl-footer>div{display:flex;align-items:center;gap:8px}.wl-empty{background:#fff;border:1px solid #d9e5f4;text-align:center;padding:50px 20px;color:#8295af}.wl-empty svg{color:#a9c7ee}.wl-empty h3{font-size:16px;color:#476b96}@media(max-width:800px){.wl-head{align-items:flex-start;flex-direction:column}.wl-search{margin-left:0;flex:1}.wl-search input{width:100%}.wl-table-wrap td{padding:10px}.wl-footer{flex-wrap:wrap}}
</style>
