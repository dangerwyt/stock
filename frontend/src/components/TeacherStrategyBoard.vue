<script setup>
import { computed, ref, watch, onActivated, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { http } from '@/api/client'
import { useAgentsStore } from '@/stores/agents'
import { useAppStore } from '@/stores/snapshot'
import { useStockDecision } from '@/composables/useStockDecision'
import { teacherScore, strategyRows, strategyRanking } from '@/utils/teacherStrategies'
import { hydrateStock, formatDailyAmount } from '@/utils/format'
import { IconAdjustments, IconRefresh, IconUsersGroup, IconStar, IconSearch, IconArrowUpRight } from '@tabler/icons-vue'

const props=defineProps({snapshot:Object,snapshotState:String,reloadSnapshot:Function})
const router=useRouter(), route=useRoute(), agents=useAgentsStore(), app=useAppStore(), decision=useStockDecision()
const teachers=computed(()=>agents.teacherList)
const cycle=ref('波段'), ids=ref([]), detailId=ref(''), stacked=ref(false), match=ref('all')
const threshold=ref(60), query=ref(''), sort=ref('score'), refreshing=ref(false)
const profile=ref(null), profileState=ref('idle'), extraction=ref(''), page=ref(1)
let request=0
const ranking=computed(()=>strategyRanking(props.snapshot,cycle.value))
const rows=computed(()=>strategyRows(ranking.value,teachers.value,ids.value,{threshold:threshold.value,match:match.value,query:query.value,sort:sort.value}))
const selectedTeacher=computed(()=>teachers.value.find(t=>t.id===detailId.value))
const selectedNames=computed(()=>teachers.value.filter(t=>ids.value.includes(t.id)).map(t=>t.name))
const cards=computed(()=>teachers.value.map(t=>({ ...t,
  scored:ranking.value.filter(s=>teacherScore(s,t.name)!==null).length,
  count:ranking.value.filter(s=>{const v=teacherScore(s,t.name);return v!==null&&v>=threshold.value}).length,
})))
const day=computed(()=>props.snapshot?.meta?.marketDataDate || '--')
const pages=computed(()=>Math.max(1,Math.ceil(rows.value.length/12)))
const visibleRows=computed(()=>rows.value.slice((page.value-1)*12,page.value*12))
const num=(v,n=2)=>v==null||v===''||!Number.isFinite(Number(v))?'--':Number(v).toFixed(n)
const pct=v=>v==null?'--':`${v>0?'+':''}${num(v)}%`
const tone=v=>v>0?'ts-up':v<0?'ts-down':''
const amount=v=>v==null?'--':formatDailyAmount(v)
const detail=computed(()=>({...selectedTeacher.value,...profile.value}))
const profileWeights=computed(()=>(profile.value?.factorWeights || []).filter(w=>typeof w.factor==='string'&&Number.isFinite(w.weight)))
watch([teachers,()=>route.query.teacher],([list,wanted],[oldList,oldWanted]=[])=>{
  ids.value=ids.value.filter(id=>list.some(t=>t.id===id))
  if(wanted && (wanted!==oldWanted || !ids.value.length) && list.some(t=>t.id===wanted)) {
    ids.value=[wanted]; detailId.value=wanted; stacked.value=false
  }
  if(!ids.value.length && list.length) ids.value=[list[0].id]
  if(!ids.value.includes(detailId.value)) detailId.value=ids.value[0] || ''
},{immediate:true})
async function loadProfile() {
  const token=++request, id=detailId.value
  profile.value=null; extraction.value=''
  if(!id){profileState.value='idle';return}
  profileState.value='loading'
  try {
    const {data}=await http.get(`/api/agents/${encodeURIComponent(id)}/profile`)
    if(token!==request)return
    if(data.agentId!==id)throw new Error('teacher mismatch')
    profile.value=data.profile; extraction.value=data.extraction?.status || ''; profileState.value='ready'
  } catch {if(token===request)profileState.value='unavailable'}
}
watch(detailId,loadProfile,{immediate:true})
watch([rows,cycle],()=>{page.value=1})
onActivated(()=>agents.refresh({force:true}))
onUnmounted(()=>{request++})
function choose(id) {
  if(!stacked.value) ids.value=[id]
  else if(ids.value.includes(id)){if(ids.value.length>1)ids.value=ids.value.filter(v=>v!==id)}
  else ids.value=[...ids.value,id]
  detailId.value=ids.value.includes(id)?id:ids.value[0]
}
function toggleStack(){stacked.value=!stacked.value;if(!stacked.value)ids.value=detailId.value?[detailId.value]:[]}
async function refresh(){
  refreshing.value=true
  try{await Promise.all([agents.refresh({force:true}),props.reloadSnapshot()]);await loadProfile()}
  finally{refreshing.value=false}
}
function view(stock){decision.open({code:stock.code,stock:hydrateStock(stock),ranked:rows.value.map(hydrateStock)})}
function teacherMatrix(){router.push({path:'/strategies',query:detailId.value?{teacher:detailId.value}:{}})}
</script>

<template>
  <section class="teacher-strategy" aria-label="老师策略筛选">
    <header class="ts-heading"><div><IconAdjustments :size="23"/><h2>策略</h2><span class="ts-badge">老师策略联动</span></div><div class="ts-actions"><span>行情日 {{day}}</span><button @click="teacherMatrix"><IconUsersGroup :size="16"/>老师策略矩阵</button><button :disabled="refreshing" @click="refresh"><IconRefresh :size="15"/>{{refreshing?'刷新中':'刷新'}}</button></div></header>
    <div class="ts-toolbar"><label>选股周期<select v-model="cycle" aria-label="选股周期"><option>超短</option><option>短线</option><option>波段</option><option>中长线</option></select></label><label>匹配门槛<select v-model.number="threshold" aria-label="匹配门槛"><option :value="60">条件匹配 ≥60分</option><option :value="75">强匹配 ≥75分</option></select></label><button :aria-pressed="stacked" :class="{active:stacked}" @click="toggleStack">叠加策略 {{stacked?'已开启':'未开启'}}</button><select v-if="stacked" v-model="match" aria-label="叠加条件"><option value="all">同时满足所选老师</option><option value="any">满足任意所选老师</option></select><span class="ts-scope">{{cycle}} TOP50 · {{ranking.length}} 只候选</span></div>
    <p v-if="agents.error" class="ts-notice ts-error" role="alert">{{agents.error}}，请刷新重试。</p><p v-else-if="agents.loading&&!teachers.length" class="ts-notice" role="status">正在读取老师策略…</p><p v-else-if="!teachers.length" class="ts-notice">暂无老师策略。<button @click="router.push('/ai')">前往 AI 研究创建老师</button></p>
    <p v-if="snapshotState==='computing'||snapshotState==='loading'" class="ts-notice" role="status">正在读取共享 TOP50 评分快照，完成后自动展示命中结果。</p><p v-else-if="snapshotState==='unavailable'" class="ts-notice ts-error" role="alert">评分快照更新失败。{{ranking.length?'当前保留上次快照，请核对行情日期。':'请刷新重试。'}}</p><p v-else-if="snapshot?.meta?.sourceMode!=='live'" class="ts-notice ts-error" role="alert">当前未取得真实评分快照，暂不生成策略命中结果。</p>
    <div class="ts-cards"><button v-for="t in cards" :key="t.id" :aria-pressed="ids.includes(t.id)" :class="{active:ids.includes(t.id)}" @click="choose(t.id)"><div><span class="ts-card-tag">老师</span><b>{{t.name}}</b><strong>{{ranking.length&&t.scored?t.count:'--'}}<small> 只</small></strong></div><p>{{t.style}} · {{t.horizon}}</p><small>{{ranking.length?`已评分 ${t.scored} / ${ranking.length}`:'等待评分快照'}} · {{t.count?'点击查看命中':'按当前门槛筛选'}}</small></button></div>
    <details v-if="selectedTeacher" class="ts-profile"><summary><div><b>{{selectedTeacher.name}}</b><span>{{detail.subtitle || detail.style}}</span></div><small>查看选股条件与风险纪律</small></summary><div v-if="profileState==='loading'" class="ts-help">正在读取已提炼画像…</div><div v-else-if="profileState==='unavailable'" class="ts-help">画像读取失败，以下为老师基础配置。<button @click="loadProfile">重试画像</button></div><div v-else-if="!profile" class="ts-help">该老师尚无已提炼画像；未评分的股票不会计入命中。</div><div class="ts-rules"><div><small>决策依据</small><p>{{detail.decision || '尚未填写'}}</p></div><div><small>选股条件</small><p>{{detail.select || '尚未填写'}}</p></div><div><small>风险纪律</small><p>{{detail.risk || '尚未填写'}}</p></div></div><div v-if="profileWeights.length" class="ts-weights"><span>画像因子</span><span v-for="w in profileWeights" :key="w.factor">{{w.factor}} {{num(w.weight*100,0)}}%</span><small v-if="extraction==='running'">画像正在更新，当前展示上一版</small></div></details>
    <section class="ts-results"><header><div><h3>{{stacked?'叠加策略':selectedTeacher?.name || '策略'}} <span>命中 {{rows.length}} 只</span></h3><small>{{selectedNames.join(' + ') || '请选择老师'}} · {{stacked?(match==='all'?'同时满足':'任意满足'):'单老师'}} · 评分 ≥{{threshold}}</small></div><div class="ts-actions"><label class="ts-search"><IconSearch :size="16"/><input v-model="query" aria-label="筛选策略股票" placeholder="股票 / 代码 / 行业"/></label><select v-model="sort" aria-label="策略结果排序"><option value="score">老师评分排序</option><option value="pct">涨跌幅排序</option><option value="amount">成交额排序</option></select></div></header>
      <div class="ts-table-wrap"><table><thead><tr><th>标的 / 行业</th><th>匹配老师</th><th>{{stacked?'所选老师均分':'老师评分'}}</th><th>收盘价</th><th>涨跌幅</th><th>量比</th><th>换手率</th><th>成交额</th><th>风险</th><th>操作</th></tr></thead><tbody><tr v-for="s in visibleRows" :key="s.code"><td><button class="ts-stock" @click="view(s)">{{s.name}}</button><small>{{s.code}} · {{s.industry || '--'}}</small></td><td><div class="ts-tags"><span v-for="name in s.matchedTeachers" :key="name" :class="{chosen:selectedNames.includes(name)}">{{name}}</span></div></td><td><strong class="ts-score">{{num(s.strategyScore,1)}}</strong><small v-if="stacked">已评分 {{s.selectedScored}} / {{ids.length}}</small></td><td>{{num(s.close)}}</td><td :class="tone(s.pct)">{{pct(s.pct)}}</td><td>{{num(s.volumeRatio)}}</td><td>{{s.turnoverRate==null?'--':num(s.turnoverRate)+'%'}}</td><td>{{amount(s.amount)}}</td><td><span class="ts-risk">{{s.risk || '--'}}</span></td><td><div class="ts-actions"><button :aria-label="(app.has(s.code)?'移出自选 ':'加入自选 ')+s.name" :aria-pressed="app.has(s.code)" :class="{active:app.has(s.code)}" @click="app.toggleWatch(s.code)"><IconStar :size="15"/></button><button @click="view(s)">分析<IconArrowUpRight :size="14"/></button></div></td></tr></tbody></table></div>
      <div v-if="!rows.length" class="ts-empty">{{!ranking.length?'等待可用的真实评分快照':!teachers.length?'请先创建老师策略':'当前条件下没有命中股票，可切换老师、周期或匹配门槛。'}}</div><footer><small>匹配老师标签按当前门槛计算；分数是因子匹配度，不是收益率或上涨概率。</small><div><span>{{page}} / {{pages}}</span><button :disabled="page<=1" @click="page--">上一页</button><button :disabled="page>=pages" @click="page++">下一页</button></div></footer>
    </section>
    <p class="ts-help">来源：现有老师配置、已提炼画像及 {{cycle}} TOP50 冻结评分。只筛选该周期候选池，不代表老师在全市场的全部命中；命中按冻结评分筛选，不代表已逐项验证文字规则；画像更新后以新榜单评分为准。批次 {{snapshot?.cycles?.[cycle]?.cycleSnapshotId || snapshot?.cycles?.[cycle]?.snapshotId || '--'}}。</p>
  </section>
</template>

<style scoped>
.teacher-strategy{color:#254366;font-size:14px;font-variant-numeric:tabular-nums}.teacher-strategy h2,.teacher-strategy h3,.teacher-strategy p{margin:0}.teacher-strategy h2{font-size:21px}.teacher-strategy h3{font-size:16px}.teacher-strategy small{font-size:12px;color:#72869f}.teacher-strategy button,.teacher-strategy select,.teacher-strategy input{font:inherit;color:inherit;border:1px solid #dbe5f2;border-radius:7px;background:white;padding:8px 10px;min-width:0;max-width:100%}.teacher-strategy button{cursor:pointer;display:inline-flex;align-items:center;gap:6px}.teacher-strategy button:disabled{opacity:.45;cursor:default}.teacher-strategy :is(button,select,input):focus-visible{outline:2px solid #3983ed;outline-offset:2px}.teacher-strategy .active{color:#246ed0;border-color:#8db9f5;background:#eef5ff}.ts-heading,.ts-heading>div,.ts-actions,.ts-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ts-heading{justify-content:space-between;margin:16px 0}.ts-heading svg{color:#347ee5}.ts-heading .ts-actions>span{font-size:12px;color:#7489a3}.ts-badge{font-size:12px;color:#238770;background:#eef8f4;padding:4px 8px;border:1px solid #cde8df;border-radius:5px}.ts-toolbar{background:#f7faff;padding:12px;border:1px solid #e0e9f4;border-radius:9px;margin-bottom:14px}.ts-toolbar label{display:flex;align-items:center;gap:8px;font-size:13px}.ts-scope{margin-left:auto;font-size:12px;color:#7389a3}.ts-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.ts-cards>button{display:block;text-align:left;padding:11px;min-width:0;box-shadow:0 2px 5px #173c6610}.ts-cards>button>div{display:flex;align-items:center;gap:7px}.ts-cards b{font-size:14px;overflow-wrap:anywhere}.ts-cards strong{margin-left:auto;color:#2877df;white-space:nowrap;font-size:20px}.ts-card-tag{background:#edf4fd;color:#6b86a9;font-size:10px;border-radius:4px;padding:3px;white-space:nowrap}.ts-cards p{font-size:12px;color:#637f9f;margin:9px 0 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ts-cards small{font-size:11px}.ts-profile{margin:14px 0;border:1px solid #dde7f3;border-radius:10px;background:#fff;overflow:hidden}.ts-profile summary{cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 15px;background:#f5f9ff}.ts-profile summary>div{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.ts-profile summary span{font-size:12px;color:#6d85a3}.ts-rules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;padding:15px}.ts-rules small{color:#347bd6}.ts-rules p{font-size:13px;line-height:1.8;margin-top:7px}.ts-weights{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid #eef2f8;padding:11px 15px;font-size:12px;color:#7b8fa8}.ts-weights>span:not(:first-child){padding:4px 8px;border-radius:5px;background:#f2f6fc;color:#526e91}.ts-results{border:1px solid #dce6f2;border-radius:10px;background:#fff;overflow:hidden;margin-top:15px}.ts-results>header{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:16px;flex-wrap:wrap}.ts-results h3 span{font-size:14px;color:#347ee5;margin-left:8px}.ts-results header small{display:block;margin-top:7px}.ts-search{display:flex;align-items:center;gap:5px}.ts-search input{width:190px}.ts-table-wrap{overflow:auto}.teacher-strategy table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}.teacher-strategy th{background:#f3f7fc;color:#7087a2;font-weight:500;font-size:12px;text-align:right;padding:12px}.teacher-strategy td{padding:14px 12px;text-align:right;border-top:1px solid #edf2f8}.teacher-strategy :is(th,td):nth-child(-n+2){text-align:left}.teacher-strategy td>small{display:block;margin-top:6px}.teacher-strategy tbody tr:hover{background:#f8fbff}.teacher-strategy .ts-stock{padding:0;border:0;background:transparent;font-weight:600;color:#2b527d}.ts-tags{display:flex;flex-wrap:wrap;gap:5px;width:170px}.ts-tags span{font-size:11px;padding:3px 6px;border-radius:4px;background:#f2f5fa;color:#8594a9}.ts-tags .chosen{color:#2675d8;background:#eaf3ff}.ts-score{color:#2d7adf;font-size:17px}.teacher-strategy .ts-up{color:#df4d60}.teacher-strategy .ts-down{color:#069581}.ts-risk{font-size:12px;color:#a57e39}.ts-results footer{background:#fff;color:#72869f;white-space:normal;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid #e6edf6}.ts-results footer>div{display:flex;align-items:center;gap:8px;font-size:12px}.ts-notice{padding:12px;background:#f1f7ff;border:1px solid #d9e7f9;border-radius:8px;margin:10px 0!important;line-height:1.7}.ts-error{background:#fff8ec;border-color:#eddabc;color:#a17b40}.ts-help{font-size:12px;color:#7489a3;line-height:1.8;padding:12px 0}.ts-profile .ts-help{padding:10px 15px}.ts-empty{padding:50px 18px;text-align:center;color:#7d91aa}.ts-results td .ts-actions{flex-wrap:nowrap}
@media(max-width:950px){.ts-cards{grid-template-columns:repeat(3,minmax(0,1fr))}.ts-rules{gap:12px}}
@media(max-width:800px){.ts-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.ts-rules{grid-template-columns:minmax(0,1fr)}.ts-scope{width:100%;margin:0}.ts-heading .ts-actions{gap:6px}}
@media(max-width:450px){.ts-cards{grid-template-columns:minmax(0,1fr)}.ts-results .ts-actions{width:100%}.ts-results td .ts-actions{width:auto}.ts-results>header{padding:12px}}
</style>
