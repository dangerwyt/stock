<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { http } from '@/api/client'
import { useSnapshot } from '@/composables/useSnapshot'
import { useStockDecision } from '@/composables/useStockDecision'
import { compareConcepts, mergeConceptFlows } from '@/utils/conceptAnalysis'
import EChart from '@/components/EChart.vue'
import { IconChartLine, IconRefresh, IconArrowUpRight, IconArrowDownRight, IconSearch } from '@tabler/icons-vue'

const { data: snapshot, state, reload } = useSnapshot('/api/concepts', { refreshMs: 300000, timeout: 70000 })
const day = computed(() => snapshot.value?.tradeDate || '')
const flowData = ref(null), flowState = ref('idle'), refreshing = ref(false)
const selected = ref(''), compared = ref([]), query = ref(''), sort = ref('pct'), mode = ref('line'), days = ref(60)
const histories = ref({}), historyLoading = ref(false), historyErrors = ref(0)
const memberData = ref(null), memberState = ref('idle'), memberPage = ref(1)
let flowRequest = 0, historyRequest = 0, memberRequest = 0
const decision = useStockDecision()
const items = computed(() => mergeConceptFlows(snapshot.value?.items || [], flowData.value, day.value))
const selectedItem = computed(() => items.value.find(i => i.code === selected.value))
const filtered = computed(() => items.value.filter(i => `${i.code} ${i.name}`.toLowerCase().includes(query.value.trim().toLowerCase())).sort((a,b) => sort.value === 'flow' ? (b.netAmount ?? -Infinity) - (a.netAmount ?? -Infinity) : b.pct - a.pct))
const leaders = computed(() => [...items.value].sort((a,b) => b.pct-a.pct).slice(0,8))
const laggards = computed(() => [...items.value].sort((a,b) => a.pct-b.pct).slice(0,8))
const flowLeader = computed(() => [...items.value].filter(i => i.netAmount > 0).sort((a,b) => b.netAmount-a.netAmount)[0])
const up = computed(() => items.value.filter(i => i.pct > 0).length)
const down = computed(() => items.value.filter(i => i.pct < 0).length)
const num = (v, n=2) => v == null ? '--' : Number(v).toLocaleString('zh-CN',{maximumFractionDigits:n,minimumFractionDigits:n})
const pct = v => v == null ? '--' : `${v>0?'+':''}${num(v)}%`
const money = v => v == null ? '--' : `${num(v/1e8)} 亿`
const tone = v => v>0?'ca-up':v<0?'ca-down':''
const heatStyle = v => ({background: v>0?`rgba(224,73,93,${Math.min(.75,.08+Math.abs(v)*.065)})`:v<0?`rgba(10,154,124,${Math.min(.65,.08+Math.abs(v)*.065)})`:'#f0f4fa'})
async function get(path) { return (await http.get(path,{timeout:70000})).data }
watch(snapshot, async value => {
  if (!value?.items?.length) return
  if (!value.items.some(i => i.code === selected.value)) selected.value = value.items[0].code
  compared.value = compared.value.filter(c => value.items.some(i => i.code === c))
  if (!compared.value.length) compared.value = value.items.slice(0,6).map(i => i.code)
  const request = ++flowRequest, date = value.tradeDate
  flowState.value = 'loading'
  try {
    const data = await get(`/api/concepts/flows?trade_date=${date}`)
    if (request !== flowRequest) return
    if (data.tradeDate !== date || !Array.isArray(data.items)) throw new Error('date mismatch')
    flowData.value = data; flowState.value = 'ready'
  } catch { if (request === flowRequest) flowState.value = 'unavailable' }
})

watch(() => [day.value, compared.value.join(','), days.value], async () => {
  const request = ++historyRequest, date = day.value
  histories.value = {}; historyErrors.value = 0
  if (!date || !compared.value.length) { historyLoading.value = false; return }
  historyLoading.value = true
  await Promise.all(compared.value.map(async code => {
    try {
      const data = await get(`/api/concepts/history?trade_date=${date}&code=${code}&days=${days.value}`)
      if (request !== historyRequest) return
      if (data.code !== code || data.tradeDate !== date || !Array.isArray(data.points)) throw new Error('mismatch')
      histories.value = {...histories.value,[code]:data}
    } catch { if (request === historyRequest) historyErrors.value++ }
  }))
  if (request === historyRequest) historyLoading.value = false
})

async function loadMembers() {
  const request = ++memberRequest, code = selected.value, date = day.value
  memberData.value = null; memberPage.value = 1
  if (!code || !date) return
  memberState.value = 'loading'
  try {
    const data = await get(`/api/concepts/members?trade_date=${date}&code=${code}`)
    if (request !== memberRequest) return
    if (data.code !== code || data.tradeDate !== date || !Array.isArray(data.items)) throw new Error('mismatch')
    memberData.value = data; memberState.value = 'ready'
  } catch { if (request === memberRequest) memberState.value = 'unavailable' }
}
watch(() => [selected.value, day.value], loadMembers)
onUnmounted(() => { flowRequest++; historyRequest++; memberRequest++ })
const comparison = computed(() => compareConcepts(compared.value.map(code => ({...histories.value[code],code,name:items.value.find(i=>i.code===code)?.name || code}))))
const curveOptions = computed(() => ({animation:false,color:['#347ee5','#9560d6','#e1a02e','#1ba699','#e86675','#50a7ce'],
  tooltip:{trigger:'axis',valueFormatter:v=>pct(v)},legend:{type:'scroll',bottom:0,textStyle:{color:'#627792',fontSize:12}},
  grid:{left:56,right:20,top:25,bottom:65},xAxis:{type:'category',data:comparison.value.dates,boundaryGap:false,axisLabel:{color:'#71829a',fontSize:12}},
  yAxis:{type:'value',axisLabel:{formatter:'{value}%',color:'#71829a'},splitLine:{lineStyle:{color:'#edf2f8'}}},
  series:comparison.value.series.map(s=>({name:s.name,type:'line',showSymbol:false,connectNulls:false,data:s.values,lineStyle:{width:2}}))}))
const distribution = computed(() => ({animation:false,tooltip:{trigger:'axis',valueFormatter:v=>`${v} 个概念`},grid:{left:40,right:12,top:20,bottom:32},
  xAxis:{type:'category',data:['≤-3%','-3~0%','平盘','0~3%','≥3%'],axisLabel:{color:'#71829a',fontSize:11}},yAxis:{type:'value',minInterval:1,splitLine:{lineStyle:{color:'#edf2f8'}},axisLabel:{color:'#71829a'}},
  series:[{type:'bar',barMaxWidth:32,label:{show:true,position:'top',color:'#536d90'},data:[items.value.filter(i=>i.pct<=-3).length,items.value.filter(i=>i.pct>-3&&i.pct<0).length,items.value.filter(i=>i.pct===0).length,items.value.filter(i=>i.pct>0&&i.pct<3).length,items.value.filter(i=>i.pct>=3).length].map((value,i)=>({value,itemStyle:{color:i<2?'#16a782':i===2?'#9cadc2':'#e85b67'}}))}]}))
const members = computed(() => [...(memberData.value?.items || [])].sort((a,b)=>(b.pct ?? -Infinity)-(a.pct ?? -Infinity)))
const pages = computed(() => Math.max(1,Math.ceil(members.value.length/12)))
const visibleMembers = computed(() => members.value.slice((memberPage.value-1)*12,memberPage.value*12))
function toggle(code) { if (compared.value.includes(code)) compared.value = compared.value.filter(c=>c!==code); else if (compared.value.length<6) compared.value=[...compared.value,code] }
async function refresh() {
  refreshing.value=true
  const previousDay=day.value, previousCode=selected.value
  try {
    await reload()
    if (day.value===previousDay && selected.value===previousCode) await loadMembers()
  } finally { refreshing.value=false }
}
</script>

<template>
  <section class="concept-board" aria-label="概念分析">
    <header class="ca-heading"><div><IconChartLine :size="22"/><h2>概念分析</h2><span class="ca-badge">日线快照</span></div><div><small>行情日 {{ day || '--' }} · {{ items.length }} 个概念</small><button :disabled="refreshing || state==='loading'" @click="refresh"><IconRefresh :size="15"/>刷新</button></div></header>
    <p v-if="state==='loading'" class="ca-notice" role="status">正在读取概念分类和日线行情…</p>
    <p v-if="state==='unavailable'" class="ca-alert" role="alert">概念行情读取失败，请点击刷新重试。{{items.length?'以下保留上次成功快照，请核对日期。':''}}</p>
    <section class="ca-card ca-main">
      <header class="ca-section-head"><div><h3>概念走势 · 强弱对比</h3><small>日线区间表现；未接入分钟级轮动</small></div><div class="ca-toggle"><button :class="{active:mode==='line'}" :aria-pressed="mode==='line'" @click="mode='line'">走势线</button><button :class="{active:mode==='heat'}" :aria-pressed="mode==='heat'" @click="mode='heat'">热力图</button></div></header>
      <div class="ca-controls"><label><IconSearch :size="16"/><input v-model="query" placeholder="搜索概念名称 / 代码" aria-label="搜索概念"/></label><select v-model="sort" aria-label="概念排序"><option value="pct">涨幅排序</option><option value="flow">资金净流入排序</option></select><select v-model.number="days" aria-label="走势区间"><option :value="30">近 30 天</option><option :value="60">近 60 天</option><option :value="120">近 120 天</option></select><details><summary>选择对比 {{compared.length}} / 6</summary><div class="ca-compare-picker"><label v-for="i in filtered" :key="i.code"><input type="checkbox" :checked="compared.includes(i.code)" :disabled="!compared.includes(i.code)&&compared.length>=6" @change="toggle(i.code)"/>{{i.name}}<b :class="tone(i.pct)">{{pct(i.pct)}}</b></label></div></details></div>
      <div class="ca-charts"><div class="ca-trend">
        <template v-if="mode==='line'"><EChart v-if="comparison.series.length" :options="curveOptions" height="390px"/><div v-else class="ca-empty">{{historyLoading?'正在读取板块历史走势…':'暂无足够的共同日期数据，请调整对比板块或区间'}}</div><p class="ca-help">{{historyLoading?'走势更新中 · ':''}}{{historyErrors?`${historyErrors} 个板块读取失败 · `:''}}{{comparison.start?`共同起点 ${comparison.start} = 0%，缺失日期断开显示`:'最多对比 6 个概念，仅使用接口实际返回的历史数据'}}</p></template>
        <template v-else><div v-if="filtered.length" class="ca-heatmap"><button v-for="i in filtered.slice(0,60)" :key="i.code" :style="heatStyle(i.pct)" :class="{selected:selected===i.code}" @click="selected=i.code"><b>{{i.name}}</b><strong>{{pct(i.pct)}}</strong></button></div><div v-else class="ca-empty">暂无匹配概念</div><p class="ca-help">按当前筛选和排序展示前 60 个概念，色深代表涨跌幅；点击查看成分股。</p></template>
      </div><aside class="ca-side"><h3>概念涨跌分布</h3><EChart v-if="items.length" :options="distribution" height="175px"/><div v-else class="ca-mini-empty">等待行情</div><div class="ca-rank-title"><b>{{sort==='flow'?'资金净流入排行':'概念涨幅排行'}}</b><small>前 10 · 点击联动</small></div><button v-for="(i,n) in filtered.slice(0,10)" :key="i.code" class="ca-rank" :class="{selected:selected===i.code}" @click="selected=i.code"><small>{{n+1}}</small><b>{{i.name}}</b><span :class="tone(sort==='flow'?i.netAmount:i.pct)">{{sort==='flow'?money(i.netAmount):pct(i.pct)}}</span></button><p v-if="!filtered.length" class="ca-help">暂无匹配概念</p></aside></div>
      <div class="ca-selection"><span>已选对比</span><button v-for="code in compared" :key="code" @click="selected=code">{{items.find(i=>i.code===code)?.name || code}}</button></div>
    </section>
    <div class="ca-metrics"><article class="ca-card"><small>涨幅居首</small><b>{{leaders[0]?.name || '--'}}</b><strong :class="tone(leaders[0]?.pct)">{{pct(leaders[0]?.pct)}}</strong></article><article class="ca-card"><small>涨幅末位</small><b>{{laggards[0]?.name || '--'}}</b><strong :class="tone(laggards[0]?.pct)">{{pct(laggards[0]?.pct)}}</strong></article><article class="ca-card"><small>上涨 / 下跌概念</small><strong><span class="ca-up">{{items.length?up:'--'}}</span> / <span class="ca-down">{{items.length?down:'--'}}</span></strong><small>平盘 {{items.filter(i=>i.pct===0).length}} 个</small></article><article class="ca-card"><small>资金净流入居前</small><b>{{flowLeader?.name || '--'}}</b><strong class="ca-up">{{money(flowLeader?.netAmount)}}</strong></article><article class="ca-card"><small>行情覆盖</small><strong>{{items.length}} / {{snapshot?.catalogCount || 0}}</strong><small>分类与同日行情匹配</small></article></div>
    <p v-if="flowState==='loading'" class="ca-help" role="status">资金流单独读取中，行情及走势不受影响。</p><p v-if="flowState==='unavailable'" class="ca-alert" role="alert">资金流更新失败，同日已有快照暂时保留；不影响概念涨跌数据。</p>
    <div class="ca-rankings"><section v-for="panel in [{name:'涨幅居前',rows:leaders,icon:IconArrowUpRight},{name:'涨幅居后',rows:laggards,icon:IconArrowDownRight}]" :key="panel.name" class="ca-card"><header class="ca-section-head"><h3><component :is="panel.icon" :size="16"/>{{panel.name}}</h3><small>点击选择概念</small></header><button v-for="(i,n) in panel.rows" :key="i.code" class="ca-ranking" :class="{selected:selected===i.code}" @click="selected=i.code"><small>{{n+1}}</small><b>{{i.name}}</b><strong :class="tone(i.pct)">{{pct(i.pct)}}</strong><small>成交 {{money(i.amount)}}</small></button></section></div>
    <section class="ca-card ca-members"><header class="ca-section-head"><div><h3>概念成分股</h3><small>{{day || '--'}} · 按同日涨幅排序</small></div><select v-model="selected" aria-label="查看概念成分股"><option v-for="i in items" :key="i.code" :value="i.code">{{i.name}} · {{pct(i.pct)}}</option></select></header><div v-if="selectedItem" class="ca-selected-summary"><b>{{selectedItem.name}}</b><strong :class="tone(selectedItem.pct)">{{pct(selectedItem.pct)}}</strong><span>成交额 {{money(selectedItem.amount)}}</span><span>换手率 {{pct(selectedItem.turnover)}}</span><span>资金净流入 {{money(selectedItem.netAmount)}}</span></div>
      <p v-if="memberState==='loading'" class="ca-help" role="status">正在读取成分股及同日行情…</p><p v-if="memberState==='unavailable'" class="ca-alert" role="alert">成分股读取失败。<button @click="loadMembers">重试成分股</button></p><p v-if="memberData" class="ca-help">共 {{members.length}} 只成分股，{{memberData.quotedCount}} 只有同日涨跌幅。{{memberData.quoteState==='unavailable'?'股票行情源暂不可用，仅展示成员名单。':''}}</p>
      <div v-if="visibleMembers.length" class="ca-table-wrap"><table><thead><tr><th>股票</th><th>收盘价</th><th>涨跌幅</th><th>成交额</th><th>操作</th></tr></thead><tbody><tr v-for="s in visibleMembers" :key="s.code"><td><b>{{s.name}}</b><small>{{s.code}}</small></td><td>{{num(s.close)}}</td><td :class="tone(s.pct)">{{pct(s.pct)}}</td><td>{{money(s.amount)}}</td><td><button @click="decision.open({code:s.code})">查看分析</button></td></tr></tbody></table></div><p v-else-if="memberState==='ready'" class="ca-help">接口未返回该日期的成分股名单。</p><div v-if="members.length" class="ca-pagination"><span>{{memberPage}} / {{pages}}</span><button :disabled="memberPage<=1" @click="memberPage--">上一页</button><button :disabled="memberPage>=pages" @click="memberPage++">下一页</button></div>
    </section>
    <p class="ca-help ca-source">来源：{{snapshot?.source || '等待数据'}}；资金流：DC 概念资金（元转亿元）。概念存在重叠，成交额和资金流不可相加作为全市场总量。图表为日线历史表现，不表示盘中轮动或未来收益。</p>
  </section>
</template>

<style scoped>
.concept-board{color:#254366;font-size:14px;font-variant-numeric:tabular-nums}.concept-board h2,.concept-board h3,.concept-board p{margin:0}.concept-board h2{font-size:20px}.concept-board h3{font-size:15px;display:flex;align-items:center;gap:6px}.concept-board small{font-size:12px;color:#71849d}.concept-board button,.concept-board input,.concept-board select{font:inherit}.concept-board button{cursor:pointer;border:1px solid #dce6f2;background:#fff;color:#41668d;border-radius:6px;padding:7px 10px;display:inline-flex;align-items:center;gap:5px}.concept-board button:disabled{opacity:.5;cursor:default}.concept-board :is(button,input,select,summary):focus-visible{outline:2px solid #3787ef;outline-offset:2px}.concept-board select,.concept-board input{border:1px solid #dce6f2;border-radius:6px;background:#fff;color:#254366;padding:8px;min-width:0;max-width:100%}.ca-heading,.ca-heading>div{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ca-heading{justify-content:space-between;margin:14px 0}.ca-heading svg{color:#347ee5}.ca-badge{font-size:12px;padding:3px 7px;color:#24876e;background:#edf8f3;border:1px solid #cfe9df;border-radius:5px}.ca-card{background:#fff;border:1px solid #dfe7f1;border-radius:10px;min-width:0;overflow:hidden}.ca-section-head{padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-bottom:1px solid #edf2f7}.ca-section-head>div{display:grid;gap:6px}.ca-section-head .ca-toggle{display:flex}.ca-toggle .active,.concept-board .selected{border-color:#9ac1f7;background:#edf5ff;color:#276fcd}.ca-controls{padding:12px 16px;display:flex;gap:9px;align-items:center;flex-wrap:wrap}.ca-controls>label{display:flex;align-items:center;gap:7px}.ca-controls details{position:relative}.ca-controls summary{cursor:pointer;padding:8px;border:1px solid #dce6f2;border-radius:6px}.ca-compare-picker{position:absolute;top:42px;left:0;z-index:5;width:285px;max-height:300px;overflow:auto;padding:10px;background:#fff;box-shadow:0 8px 25px #15396025;border:1px solid #dce6f2;border-radius:8px}.ca-compare-picker label{display:flex;align-items:center;gap:7px;padding:7px}.ca-compare-picker b{margin-left:auto}.ca-charts{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(270px,1fr);gap:14px;padding:0 16px 12px}.ca-trend{min-width:0;border:1px solid #e3eaf4;border-radius:8px;padding:8px}.ca-side{border:1px solid #e3eaf4;border-radius:8px;padding:12px;min-width:0}.ca-rank-title{display:flex;align-items:center;justify-content:space-between;gap:7px;margin:10px 0}.concept-board .ca-rank{display:flex;width:100%;border:0;border-bottom:1px solid #eef2f8;border-radius:0;padding:9px 3px;text-align:left;font-size:13px}.ca-rank b{flex:1}.ca-rank span{white-space:nowrap}.ca-empty{height:390px;display:flex;align-items:center;justify-content:center;text-align:center;color:#7d90aa;padding:12px;box-sizing:border-box}.ca-mini-empty{height:175px;display:grid;place-items:center;color:#7d90aa}.concept-board .ca-help{font-size:12px;color:#7488a2;line-height:1.7;padding:10px 14px}.ca-selection{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 16px;border-top:1px solid #edf2f8;font-size:12px;color:#71849d}.ca-selection button{font-size:12px;background:#f5f9fe}.ca-heatmap{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;max-height:390px;overflow:auto}.ca-heatmap button{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:66px;padding:6px;border:2px solid transparent;color:#234363;font-size:12px;text-align:center}.ca-heatmap .selected{border-color:#347ee5}.ca-heatmap strong{font-size:14px}.ca-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:14px 0 3px}.ca-metrics article{padding:13px;display:flex;flex-direction:column;gap:8px}.ca-metrics strong{font-size:19px;overflow-wrap:anywhere}.ca-metrics b{font-size:14px}.concept-board .ca-up{color:#dc4c5c}.concept-board .ca-down{color:#07947b}.ca-rankings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:14px 0}.concept-board .ca-ranking{display:flex;width:100%;gap:10px;text-align:left;border:0;border-bottom:1px solid #edf2f8;border-radius:0;padding:13px}.ca-ranking b{flex:1}.ca-ranking small:last-child{font-size:11px;white-space:nowrap}.ca-members select{max-width:310px}.ca-selected-summary{display:flex;gap:15px;flex-wrap:wrap;padding:14px;background:#f6f9fd}.ca-selected-summary span{color:#71849d;font-size:13px}.ca-table-wrap{overflow:auto}.ca-members table{width:100%;white-space:nowrap;border-collapse:collapse;font-size:13px}.ca-members th,.ca-members td{padding:12px 15px;text-align:right;border-bottom:1px solid #edf2f8}.ca-members th{font-weight:500;background:#f6f9fd;color:#71849d}.ca-members th:first-child,.ca-members td:first-child{text-align:left}.ca-members td small{display:block;margin-top:5px}.ca-members td button{font-size:12px}.ca-pagination{display:flex;justify-content:flex-end;align-items:center;gap:9px;padding:12px}.ca-notice,.ca-alert{border:1px solid #dce8f8;background:#f1f7ff;border-radius:7px;padding:12px;margin:10px 0!important;font-size:13px}.ca-alert{background:#fff6ed;border-color:#f1d8b4;color:#a57634}.ca-source{padding-left:0!important}
@media(max-width:1150px){.ca-charts{grid-template-columns:minmax(0,1fr)}.ca-side{display:block}.ca-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.ca-ranking small:last-child{display:none}}
@media(max-width:700px){.ca-rankings{grid-template-columns:minmax(0,1fr)}.ca-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ca-heatmap{grid-template-columns:repeat(3,minmax(0,1fr))}.ca-controls{padding:10px;gap:6px}.ca-charts{padding:0 10px 10px}.ca-controls>label{width:100%}.ca-controls>label>input{width:100%}.ca-compare-picker{left:auto;right:0;width:260px}.ca-section-head{padding:12px}.ca-heading small{font-size:11px}}
</style>

