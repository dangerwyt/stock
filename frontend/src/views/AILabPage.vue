<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useSnapshot } from '@/composables/useSnapshot'
import { http, fetchSnapshot, startAiJob, readNdjsonFrame } from '@/api/client'
import AgentDocsPanel from '@/components/AgentDocsPanel.vue'
import { useAgentsStore } from '@/stores/agents'
import { hydrateStock, displayField, formatDurationMs, formatShanghaiTime, formatShanghaiDateTime } from '@/utils/format'
import {
  IconPlus,
  IconMessageCircle2,
  IconSearch,
  IconUserSearch,
  IconSparkles,
  IconChevronRight,
  IconSend2,
  IconActivity,
  IconChartDots3,
  IconTargetArrow,
  IconFileAnalytics,
  IconBrain,
  IconAlertTriangle,
  IconDatabase,
} from '@tabler/icons-vue'

const { data: labTop50Snapshot } = useSnapshot('/api/top50', { refreshMs: 60000 })
const agentsStore = useAgentsStore()

const clientId = ref('vue-web-client')
const input = ref('')
const threadItems = ref([])
const activeThreadId = ref(null)
const roleDialogOpen = ref(false)
const roleName = ref('')
const roleNameError = ref('')
const roleSaving = ref(false)
const messages = ref([])
// Shared persona pool: 只有用户自己创建的角色 —— 内置 12 位 mock 人设已从产品里去掉。
// StrategiesPage 读同一个 store，所以这里新建的角色会立刻出现在它的 tabs 里。
const agentItems = computed(() => agentsStore.teacherList)
// 没有任何自建角色时的占位画像：模板会读 `.name` / `.style`，用 null 会直接抛错。
const EMPTY_TEACHER = { name: '暂无角色', style: '尚未创建', productionVersion: { id: 'agent-factor-v1' } }
// 初始留空，onMounted 拉到角色列表后自动选中第一个 —— 不再写死一个已不存在的内置老师名。
const selectedAgentNames = ref([])
// 「搜索A股」内联下拉（EP el-select，remote 模式）的数据源，仍是 /api/stocks/search。
// 不再自己维护输入框的 query —— remote 模式下查询词由 el-select 的 remote-method 传进来。
const stockResults = ref([])
const stockSearchState = ref('idle')
// —— 通用研究会话的「选择角色」（多选）——
// 只决定"这一问由谁回答"，**不是**把整条会话绑定给角色（会话本身仍不挂在任何角色
// 名下，后端 threads._belongs_to 也仍把它排除在"整条认领"之外）。
// ⚠️ 但选中的角色**会**因此拿到新的画像素材：后端按**每条回答消息上的 teacherNames**
// 逐条归账，把这个角色答的那几问算进它的提炼历史（threads.attributed_messages）。
// 所以下面每个回答消息都必须带上真实作答角色名 —— 那是唯一的归账依据。
const generalRoles = ref([])
// 右栏「角色名单」：一个顿号串列全，一个都没选时给「—」而不是空白。
// （名字可能已经不在了 —— 角色被删后会话上还留着旧名单，这里不额外过滤：
//   显示出来反而能让用户看到"选中的角色已被删"，右栏不会出现"选了却看不到"的错觉。）
const generalRoleNames = computed(() => generalRoles.value.join('、') || '—')
// 下拉的 v-model 桥：get/set 直连 generalRoles，set 时顺手落库 ——
// 原来「选中 / 点 tag 上的 × / 清空」三条路径各自调 persistRoles，现在 el-select 的多选
// 也是同一个数组，统一在这里落库，那三个函数就都不需要了。
// ⚠️ 必须 slice()：EP 会把同一个数组引用反复 emit，直接赋值会让 v-model 的 diff 失效。
const generalRolesModel = computed({
  get: () => generalRoles.value,
  set: (value) => {
    generalRoles.value = Array.isArray(value) ? value.slice() : []
    persistRoles()
  },
})
const manualStock = ref(null)
// 「选择角色」下拉的选项。
// 副信息只保留**有信息量**的风格：后端建角色时 style 的默认值是「自定义」
// （backend/app/agents.py 的 `payload.get("style") or "自定义"`）——那是占位符、
// 不是画像风格，照抄进下拉等于每一项后面挂一句废话。
// 只有提炼出画像的角色（如「产业趋势共振」）才显示风格，其余只显示名字。
const ROLE_STYLE_PLACEHOLDER = '自定义'
const roleOptions = computed(() =>
  agentItems.value.map((item) => {
    const style = String(item.style || '').trim()
    return { name: item.name, style: style === ROLE_STYLE_PLACEHOLDER ? '' : style }
  }),
)
const sending = ref(false)
const agentJob = ref(null)
const liveAgentStates = ref([])

const agentJobStateLabels = { waiting: '等待', analyzing: '分析中', retrying: '重试', completed: '完成', failed: '未完成' }
const agentJobPhaseLabels = {
  queued: '任务排队中', preparing: '正在准备证据', agents: '老师独立研判中',
  summarizing: '正在生成最终总结', completed: '会诊完成', failed: '会诊未完成',
}

const systemMessage = {
  role: 'assistant',
  content: '选择股票和老师后开始研究。回答会标注数据来源和截止时间，仍需人工核验。',
  type: 'system',
}
const activeThread = computed(() => threadItems.value.find((item) => item.id === activeThreadId.value))
// 固定会话「通用研究」：后端用 ``general: true`` 标记，id 前缀做兜底（两道判据与后端
// ``threads.is_general`` 保持一致）。它不绑定任何角色 —— 发送时不带老师、
// 界面上也不展示任何角色相关的元素，且不进「共 N 条会话」的计数。
const isGeneralThread = computed(() => {
  const thread = activeThread.value
  if (!thread) return false
  if (thread.general === true) return true
  return String(thread.id || '').split('::', 1)[0] === 'general'
})
// 会话计数只面向"老师会话"：固定会话不计入数量（它不算一条研究会话）。
const conversationCount = computed(() => threadItems.value.filter((t) => !t.general).length)
// 标题栏副标题：模板属性里禁止内联三元（项目约定），整段在这里拼好。
const chatHeadSubtitle = computed(() => {
  if (isGeneralThread.value) {
    const n = generalRoles.value.length
    const who = n === 0
      ? '通用助手作答'
      : n === 1
        ? `由「${generalRoles.value[0]}」研判`
        : `由 ${n} 位角色联合研判`
    return `通用研究 · ${who} · 回答保留来源和数据截止时间`
  }
  const names = selectedAgentNames.value
  const who = names.length === 1 ? `${names[0]} Agent` : `${names.length}位 Agent 联合研判`
  return `${who} · 结构化证据引用 · ${activeTeacher.value?.productionVersion?.id || 'agent-factor-v1'}`
})
// 通用会话「谁在作答」的统一说法。
// ⚠️「不绑定角色」说的是**会话归属**（这条会话不专属某位老师、画像管理面板不在右栏），
// 不等于"没有角色参与" —— 选了角色就是这些角色来会诊。两个概念挤在一行，会和下面那行
// 「回答角色 B老师、C老师」字面打架，所以这里把"谁作答"独立成一句、不再提"绑定"。
const generalModeLabel = computed(() => {
  const n = generalRoles.value.length
  if (n === 0) return '通用研究 · 通用助手作答'
  return n === 1 ? `通用研究 · ${generalRoles.value[0]} 研判` : `通用研究 · ${n} 位角色会诊`
})
// 空会话引导区顶部那句"谁在研判"。
const quickStartWho = computed(() => {
  if (isGeneralThread.value) return generalModeLabel.value
  const names = selectedAgentNames.value
  return names.length === 1 ? `${names[0]} Agent` : `${names.length}位老师联合研判`
})
const selectedAgents = computed(() =>
  selectedAgentNames.value.map((name) => agentItems.value.find((i) => i.name === name)).filter(Boolean),
)
const visibleAgentNames = computed(() => selectedAgentNames.value.slice(0, 3))
const activeTeacher = computed(() => agentItems.value.find((i) => i.name === selectedAgentNames.value[0]))
// 资料/画像面板的目标：当前选中角色里的第一个。现在能选中的必然都是自建角色，
// 而只有自建角色才有可管理的资料与画像。
const docsTarget = computed(() => {
  const picked = selectedAgentNames.value
    .map((name) => agentItems.value.find((i) => i.name === name))
    .filter(Boolean)
  return picked[0] || null
})
const primaryTeacher = computed(() => selectedAgents.value[0] || agentItems.value[0] || EMPTY_TEACHER)
const labTop50Stocks = computed(() =>
  Object.values(labTop50Snapshot.value?.cycles || {}).flatMap((item) => item.ranking || []),
)
const threadStockCode = computed(() => activeThread.value?.stockCode || null)
const activeStock = computed(
  () => manualStock.value || labTop50Stocks.value.find((i) => i.code === threadStockCode.value) || null,
)
const requestStock = computed(
  () => activeStock.value || (threadStockCode.value ? { code: threadStockCode.value, name: '历史会话标的' } : null),
)
// 「搜索A股」下拉的 v-model 桥。
// - 读：**当前标的**的 code。不能用 manualStock 当读源 —— 会话自带 stockCode（老师会话）
//   时下拉会是空的，用户看不到自己正在对哪只股票提问。
// - 写：按 code 回到全量条目再走 pickStock（命中 TOP50 才有行情与因子，见 pickStock 注释）；
//   清空（clearable 的 ×）= 放弃手动覆盖：老师会话回落到会话自带标的，通用会话变成无标的。
//   原第二行的标的 chip 已删（下拉本身就显示当前标的，两处重复），清空职责由 clearable 接管。
const stockSelectCode = computed({
  get: () => requestStock.value?.code || '',
  set: (code) => {
    if (!code) {
      clearStock()
      return
    }
    const hit = labTop50Stocks.value.find((i) => i.code === code)
      || stockResults.value.find((i) => i.code === code)
    if (hit) pickStock(hit)
  },
})
// 下拉选项 = 本次搜索结果；若当前标的还不在结果里（会话自带标的、或上次选完清空了输入），
// 把它补到最前面，否则 el-select 只能拿裸 code 当 label 显示。
const stockSelectOptions = computed(() => {
  const list = stockResults.value.slice()
  const cur = requestStock.value
  if (cur?.code && !list.some((i) => i.code === cur.code)) list.unshift(cur)
  return list
})
// el-select 选中后显示的是 option 的 **label**（不是插槽内容），插槽只管下拉里的排版，
// 所以选中态要的「名称 代码」得单独拼一份。
function stockOptionLabel(item) {
  return [String(item.name || '').trim(), String(item.code || '').trim()].filter(Boolean).join(' ')
}
// 下拉空态的一句话（模板里不做条件串联，统一在这里选）。
// loading 态 EP 自己会显示 loading-text，这里兜住"还没输入 / 没结果 / 接口挂了"三种。
const stockEmptyText = computed(() => {
  if (stockSearchState.value === 'loading') return '正在搜索全市场A股…'
  if (stockSearchState.value === 'error') return '行情搜索暂不可用，请检查Tushare数据源。'
  if (stockSearchState.value === 'ready') return '没有匹配的上市A股。'
  return '输入股票代码或名称，例如 603893 / 瑞芯微'
})
// composer 上方「已选上下文」那一行是否有内容。没有就整行隐藏 —— 默认高度和改动前一样，
// 不白占聊天可视区（见模板里 context-chips / context-selected 两行的分工）。
// ⚠️ 标的与角色都不再算进来：标的选择改成 el-select 后下拉本身就显示当前标的
// （原标的 chip 已删，两处重复）；角色 tag 由下拉自己渲染。
// 这一行只剩 TOP50 榜位与老师会话的溢出人数，都是下拉表达不了的信息。
const hasPickedContext = computed(
  () =>
    Number(activeStock.value?.rank) > 0 ||
    (!isGeneralThread.value && selectedAgentNames.value.length > visibleAgentNames.value.length),
)
const composerPlaceholder = computed(() => {
  const stock = requestStock.value
  if (stock) return `输入你的研究问题，例如「分析${stock.name}」`
  return '输入你的研究问题'
})
const quickQuestions = computed(() => {
  const s = requestStock.value
  return [
    s ? `为什么${s.name}值得关注？请列出证据和主要风险。` : '今天哪些行业和股票值得关注？请只引用当前真实数据。',
    s ? `${s.name}当前最重要的失效条件是什么？` : '比较今天TOP50前三名的入选理由和风险。',
    s ? `如果${s.name}明日低开3%，应该观察哪些确认信号？` : '结合隔夜全球市场，推演今日A股三种情景。',
    s ? `生成${s.name}的盘后复盘清单。` : '生成今日盘后复盘清单。',
  ]
})
const hasConversation = computed(() =>
  messages.value.some((m) => m.role === 'user' || m.type === 'live' || m.type === 'error'),
)
// 一整个会话都没有时，chat-main 里的内容（标题栏/滚动区/输入框）一律不渲染，
// 引导用户先在左侧「新建角色」。
const hasThreads = computed(() => threadItems.value.length > 0)
const liveAgentTotal = computed(() => liveAgentStates.value.length || selectedAgentNames.value.length)
const independentCompletedCount = computed(() => liveAgentStates.value.filter((i) => i.status === 'completed').length)
const independentFailureCount = computed(() => liveAgentStates.value.filter((i) => i.status === 'failed').length)
// 进度卡的显示条件：**有参与者才显示**。
// 之前写的是 `!isGeneralThread` —— 那是单向思维时的临时挡板（通用会话当时只会
// 一条回答，硬渲染会变成 0/1）。现在通用会话选 ≥2 位角色也会走会诊链路，
// 按"有没有 agentStates"判断才对：无角色 / 单角色 → 不显示；≥2 位 → 显示进度。
const showAgentRunStatus = computed(() =>
  liveAgentStates.value.length > 0 && Boolean(
    sending.value || agentJob.value?.status === 'failed' || agentJob.value?.pollingState === 'deadline_exceeded',
  ),
)

async function refreshThreads(preferredId = null) {
  try {
    const result = await fetchSnapshot(`/api/ai/threads?clientId=${encodeURIComponent(clientId.value)}`)
    threadItems.value = result.items || result.threads || []
    // 默认选中最上面的一条（后端按 updatedAt 倒序）。若当前 activeThreadId 已失效
    // （会话被删／换了客户端），回退到头条，避免停在一条不存在的会话上。
    const ids = new Set(threadItems.value.map((t) => t.id))
    const targetId =
      preferredId ||
      (ids.has(activeThreadId.value) ? activeThreadId.value : null) ||
      threadItems.value[0]?.id ||
      null
    if (targetId) await loadThread(targetId)
    else {
      activeThreadId.value = null
      messages.value = [systemMessage]
    }
  } catch {
    messages.value = [systemMessage]
  }
}
async function loadThread(threadId) {
  try {
    const result = await fetchSnapshot(`/api/ai/threads/${threadId}?clientId=${encodeURIComponent(clientId.value)}`)
    activeThreadId.value = threadId
    const saved = result.thread?.teacherNames?.filter((n) => agentItems.value.some((i) => i.name === n))
    if (saved?.length) selectedAgentNames.value = saved
    else if (result.thread?.teacherName) selectedAgentNames.value = [result.thread.teacherName]
    // 通用会话里用户选的"回答角色"名单。它是会话级状态（跟着会话存），
    // 与上面的 selectedAgentNames 是两码事 —— 后者是"这条会话属于谁"。
    generalRoles.value = Array.isArray(result.thread?.generalRoles)
      ? result.thread.generalRoles.slice()
      : []
    messages.value = result.thread?.messages?.length
      ? result.thread.messages.map((i) => ({ ...i, type: i.role === 'assistant' ? 'live' : undefined }))
      : [systemMessage]
    agentJob.value = null
  } catch {
    messages.value = [systemMessage]
  }
}

let stockTimer = null
// el-select remote 模式：每次输入都会带着当前输入框文字调这里（不再是自定义 ref）。
// - 250ms 防抖：一个中文词/一串代码要打好几键。
// - seq 竞态保护：防抖只压住了"输入多快"，压不住"响应多慢" —— 慢的那个请求后回来
//   会把新结果覆盖掉（下拉里出现跟输入框对不上的股票）。回来的序号不是最新的就丢弃。
let stockSearchSeq = 0
function runStockSearch(query) {
  const keyword = String(query || '').trim()
  if (!keyword) {
    stockSearchSeq += 1
    stockResults.value = []
    stockSearchState.value = 'idle'
    return
  }
  stockSearchState.value = 'loading'
  clearTimeout(stockTimer)
  stockTimer = setTimeout(async () => {
    const seq = ++stockSearchSeq
    try {
      const result = await fetchSnapshot(`/api/stocks/search?q=${encodeURIComponent(keyword)}`)
      if (seq !== stockSearchSeq) return
      stockResults.value = result.items || []
      stockSearchState.value = 'ready'
    } catch {
      if (seq !== stockSearchSeq) return
      stockSearchState.value = 'error'
    }
  }, 250)
}

// —— 资料上传（入口在右栏「角色资料」面板内）——
// 只有自建角色能挂资料（内置角色的资料接口是只读的），上传逻辑因此收在
// AgentDocsPanel 里，这里不再保留入口。

// 取消手动选中的标的：清掉后就回到会话自带的 stockCode（如果有）。
// 之前只能靠"选另一只"来替换，选错了没法退回。
function clearStock() {
  manualStock.value = null
}

// 选中搜索结果。搜索接口（/api/stocks/search）只返回 code/name/industry，
// 没有行情与因子数据 —— 命中 TOP50 时换成全量条目，否则右侧「当前标的」会显示 0.00，
// 送给 AI 的快照也没有行情可依（那正是它开始编造走势的原因）。
function pickStock(item) {
  const full = labTop50Stocks.value.find((entry) => entry.code === item.code)
  manualStock.value = full || item
}

// —— 通用研究会话：选择本次回答的角色（多选）——
// 选中即写回会话，刷新/切走再回来还在；写回失败也不影响这一问 —— send() 会把
// generalRoles 随请求一起带过去（后端优先用请求里的值），所以不存在"存不下就不生效"。
//
// 关于顺序：保持用户点选/移除后的**原始顺序**，不做排序 ——
// ≥2 位时后端按这个顺序建 agent 帧，气泡与进度卡的排列顺序才跟用户的选择一致。
async function persistRoles() {
  if (!activeThreadId.value) return
  try {
    await http.patch(`/api/ai/threads/${activeThreadId.value}`, {
      generalRoles: generalRoles.value.slice(),
    })
  } catch { /* 会话落库失败不应阻断研究 */ }
}

// 选中/移除/清空全部由上面 generalRolesModel 的 setter 统一落库，
// 原 toggleRole / removeRole / clearRoles / toggleRolePicker / toggleStockPicker 已删。

// 消息上只留「名称 + 代码」。整条行情快照（因子、价位、pct…）塞进历史消息既没用
// 又把 ai_threads.json 撑大 —— 气泡只需要说明「这一问是对着哪只股票问的」。
function stockBrief(stock) {
  if (!stock) return null
  const code = String(stock.code || stock.tsCode || '').trim()
  const name = String(stock.name || '').trim()
  if (!code && !name) return null
  return { code, name }
}

// 气泡里的标的标记，形如「（瑞芯微/603893）」。只有名称或只有代码时自动省略斜杠，
// 避免渲染出「（瑞芯微/）」这种半个括号内容。
function messageStockLabel(message) {
  const stock = message?.stock
  if (!stock) return ''
  const name = String(stock.name || '').trim()
  const code = String(stock.code || '').trim()
  if (!name && !code) return ''
  if (name && code) return `（${name}/${code}）`
  return `（${name || code}）`
}

function openRoleDialog() {
  roleName.value = ''
  roleNameError.value = ''
  roleDialogOpen.value = true
}
async function submitNewRole() {
  const name = roleName.value.trim()
  if (!name) {
    roleNameError.value = '请输入角色（老师）名称'
    return
  }
  roleSaving.value = true
  roleNameError.value = ''
  try {
    // 1) Persist the persona first — this is what StrategiesPage reads.
    // Only the name is collected here; the profile (style / decision / select /
    // risk / horizon) is filled in later by the document-extraction step.
    const agent = await agentsStore.createAgent({ name })
    roleDialogOpen.value = false
    roleName.value = ''
    // 2) Then start a session with this persona as its lead agent.
    selectedAgentNames.value = [agent.name]
    try {
      const { data } = await http.post('/api/ai/threads', {
        clientId: clientId.value, title: name, teacherName: name, teacherNames: [name], stockCode: null,
      })
      await refreshThreads(data.thread?.id)
    } catch {
      // Thread persistence is still a backend stub; the persona itself is
      // already saved, so don't surface this as a failure to the user.
      messages.value = [systemMessage]
    }
  } catch (error) {
    roleNameError.value = error?.response?.data?.detail || '创建失败，请稍后重试'
  } finally {
    roleSaving.value = false
  }
}
// 没有活动会话时先建一个，避免发出的问题无处可存
async function ensureThread() {
  if (activeThreadId.value) return activeThreadId.value
  // 固定会话是常驻的，任何"没有选中会话"的兜底都应该落回它 —— 另建一条空的老师会话
  // 会把固定会话的历史拆成两半（一半在自己的 id 下，一半在新 id 下）。
  const pinned = threadItems.value.find((t) => t.general)
  if (pinned) {
    activeThreadId.value = pinned.id
    return pinned.id
  }
  try {
    const name = selectedAgentNames.value[0] || ''
    const { data } = await http.post('/api/ai/threads', {
      clientId: clientId.value,
      title: name || '新研究会话',
      teacherName: name,
      teacherNames: selectedAgentNames.value.slice(),
      stockCode: requestStock.value?.code || null,
    })
    activeThreadId.value = data.thread?.id || null
  } catch {
    activeThreadId.value = null
  }
  return activeThreadId.value
}

// 增量落库（只追加本轮消息，避免整段历史重复写入）
async function persistMessages(entries) {
  if (!activeThreadId.value || !entries?.length) return
  try {
    await http.post(`/api/ai/threads/${activeThreadId.value}/messages`, {
      messages: entries.map((m) => ({
        role: m.role,
        content: m.content,
        teacherNames: m.teacherNames || [],
        teacherAnswers: m.teacherAnswers || [],
        refused: Boolean(m.refused),
        dataCutoff: m.dataCutoff || null,
        // 标的随消息一起落库，历史会话回看时气泡里才能显示「（名称/代码）」
        stock: stockBrief(m.stock),
      })),
    })
  } catch { /* 会话落库失败不应阻断研究 */ }
}

async function rateMessage(messageId, feedback) {
  if (!activeThreadId.value || !messageId) return
  await http.post('/api/ai/feedback', { clientId: clientId.value, threadId: activeThreadId.value, messageId, feedback })
  messages.value = messages.value.map((i) => (i.id === messageId ? { ...i, feedback } : i))
}

// 气泡标题：单人会话就是该老师的普通回答，多人时才是「AI 汇总」。
// 通用研究会话没有绑定角色，但用户可能为某一问临时选了角色 —— 那种情况下消息上
// 带着实际参与者名单，按它显示；一个都没选才是通用助手。
function bubbleAuthor(message) {
  if (message.type === 'error') return '系统提示'
  if (message.refused) return '范围提示'
  if (message.type !== 'live') return '研究室状态'
  const names = message.teacherNames || []
  if (isGeneralThread.value) {
    if (!names.length) return '通用研究助手'
    return names.length > 1 ? `AI 汇总 · ${names.length} 位角色` : names[0]
  }
  return names.length > 1 ? `AI 汇总 · ${names.length} 位老师` : 'AI 研究结论'
}

// 单人会话里，老师本人的回答就是最终回答（后端也已把 summary 设成同一段文本），
// 再渲染一条汇总气泡会出现两条一模一样的内容，所以跳过。
function showsSummary(message) {
  return (message.teacherAnswers?.length || 0) !== 1
}

function scrollToEnd() {
  nextTick(() => {
    const el = document.querySelector('.ai-layout .chat-scroll')
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function send() {
  if (!input.value.trim() || sending.value) return
  const question = input.value.trim()
  const threadId = await ensureThread()
  // 按 ensureThread 真正落到的那条会话判定，而不是按发送前的 activeThread ——
  // 后者在"还没有活动会话"时是 null，会把它误判成老师会话。
  const general = Boolean(threadItems.value.find((t) => t.id === threadId)?.general)
  // 通用会话里这一问想由哪些角色回答（空 = 通用助手）。按"发送时刻"取值并随请求发出去：
  // 用户改完选择立刻点发送时，PATCH 可能还没落盘，只靠会话上的存值会慢一拍。
  const generalRolesAtSend = general ? generalRoles.value.slice() : []
  // 标的按「发送时刻」记在消息上，而不是渲染时现取 requestStock ——
  // 否则用户换一只股票后，历史气泡会集体改口成新标的。
  const userMessage = { role: 'user', content: question, stock: stockBrief(requestStock.value) }
  messages.value = [...messages.value, userMessage]
  input.value = ''
  sending.value = true
  agentJob.value = null
  scrollToEnd()
  try {
    const { accepted, reader, leftover } = await startAiJob({
      incremental: false,
      clientId: clientId.value,
      threadId: activeThreadId.value,
      question,
      stock: requestStock.value,
      // 通用研究会话：显式告诉后端"这一次走通用研究链路"（0 位角色走单条回答、
      // ≥2 位走会诊）。选中的角色会按回答消息上的 teacherNames 逐条归账，
      // 成为它们的画像素材 —— 所以下面的 teacherNames 必须是真的作答角色。
      general,
      generalRoles: generalRolesAtSend,
      teacher: general ? null : primaryTeacher.value,
      teachers: general ? [] : selectedAgents.value,
    })
    agentJob.value = accepted?.job || null
    liveAgentStates.value = (accepted?.job?.agentStates || []).map((i) => ({ ...i }))
    let summaryText = ''
    let refused = false
    // 后端**实际**用了哪位角色（可能与发出去的不一致 —— 例如那个角色刚被删），
    // 由 summary 帧回传，比前端自己猜更可信。
    let answeredRole = ''
    // 每位老师的发言随 agent 帧一起下发，收集起来渲染成各自的气泡。
    const teacherAnswers = []
    if (reader) {
      const decoder = new TextDecoder()
      let pending = leftover || ''
      let frame
      while ((frame = await readNdjsonFrame(reader, decoder, pending))) {
        pending = ''
        if (frame.type === 'agent') {
          const idx = liveAgentStates.value.findIndex((i) => i.teacherName === frame.teacherName)
          if (idx >= 0) liveAgentStates.value[idx] = { ...liveAgentStates.value[idx], status: frame.status }
          if (frame.status === 'completed' && frame.answer && !teacherAnswers.some((a) => a.teacherName === frame.teacherName)) {
            teacherAnswers.push({ teacherName: frame.teacherName, answer: frame.answer, index: Number(frame.index) || 0 })
          }
          agentJob.value = { ...(agentJob.value || {}), phase: 'agents', status: 'running' }
        } else if (frame.type === 'summary') {
          summaryText = frame.summary || ''
          answeredRole = String(frame.answeredRole || '')
          agentJob.value = { ...(agentJob.value || {}), phase: 'completed', status: 'completed' }
        } else if (frame.type === 'refused') {
          // 话题守卫（后端 guardrails）拦下：没进会诊，直接把拒绝文案当回答展示。
          refused = true
          summaryText = frame.reason || '这不在我的研究范围内。'
          agentJob.value = { ...(agentJob.value || {}), phase: 'completed', status: 'completed' }
        }
        scrollToEnd()
      }
    }
    // 按发送顺序排（帧是完成顺序，不是提交顺序）
    const orderedAnswers = teacherAnswers
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(({ teacherName, answer }) => ({ teacherName, answer }))
    // 这一问**实际**是谁答的：
    // - ≥2 位走会诊链路 → 用 agent 帧收集到的参与者，比"发出去的选择"更准
    //   （中途被剔除 / 失败 / 后端降级的角色不会混进来）；
    // - 1 位 → 后端 summary 帧回传的 answeredRole（该角色可能刚被删，后端会降级）；
    // - 0 位 → 空，气泡标题显示「通用研究助手」。
    const answeredNames = orderedAnswers.map((a) => a.teacherName)
    const generalTeacherNames = answeredNames.length
      ? answeredNames
      : (answeredRole ? [answeredRole] : [])
    const assistantMessage = {
      role: 'assistant',
      id: accepted?.job?.id,
      type: 'live',
      content: summaryText || '会诊已完成，但主持人未返回总结文本。',
      refused,
      teacherAnswers: orderedAnswers,
      // 被守卫拦下时没有老师参与，别把标题渲染成「参与 Agent：xxx」。
      // 通用会话只在这一问真的有人回答时才带上名字（气泡标题/历史回看靠它）。
      teacherNames: refused
        ? []
        : general
          ? generalTeacherNames
          : selectedAgentNames.value.slice(),
      stock: stockBrief(requestStock.value),
      dataCutoff: labTop50Snapshot.value?.meta?.marketDataDate,
    }
    messages.value = [...messages.value, assistantMessage]
    agentJob.value = null
    await persistMessages([userMessage, assistantMessage])
    await refreshThreads(activeThreadId.value)
  } catch (error) {
    messages.value = [...messages.value, {
      role: 'assistant',
      type: 'error',
      content: `真实AI尚未完成运行：${error.message}。已保存的老师观点不会丢失，可在本会话继续；系统不会用预设答案替代。`,
    }]
    agentJob.value = { ...(agentJob.value || {}), status: 'failed' }
    // 问题本身仍要留痕，下次进会话还能看到问过什么
    await persistMessages([userMessage])
  } finally {
    sending.value = false
    scrollToEnd()
  }
}

function parseText(text) {
  return String(text || '')
    .split(/(\*\*[^*]+\*\*|\[[A-Z]\d+\])/g)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**')) return { bold: true, text: part.slice(2, -2) }
      if (/^\[[A-Z]\d+\]$/.test(part)) return { cite: true, text: part }
      return { text: part }
    })
}
function evidenceLabel(message) {
  return message.verification?.status === 'screened'
    ? '已返回的AI正文通过有限规则筛查；不等于全文事实核验或投资结论正确。'
    : '此历史回答未经过本轮证据筛查，请核对原始资料。'
}
function copyMessage(message) {
  const text = `【AI生成内容】${evidenceLabel(message)}\n\n${message.content}`
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text)
}

onMounted(async () => {
  await agentsStore.refresh()
  // 内置 12 位已去掉，默认选中自己创建的第一个角色；一个都没有时保持空选，
  // 页面会引导去「新建角色」。
  if (!selectedAgentNames.value.length && agentItems.value.length) {
    selectedAgentNames.value = [agentItems.value[0].name]
  }
  refreshThreads()
  messages.value = [systemMessage]
})
onBeforeUnmount(() => clearTimeout(stockTimer))
</script>

<template>
  <div class="ai-layout">
    <!-- 研究会话列表 -->
    <aside class="thread-list">
      <div class="thread-head"><h2>研究会话</h2><button @click="openRoleDialog"><IconPlus :size="15" /> 新建角色</button></div>
      <button
        v-for="thread in threadItems"
        :key="thread.id"
        :class="{ active: activeThreadId === thread.id, pinned: thread.general }"
        @click="loadThread(thread.id)"
      >
        <strong>{{ thread.teacherName || thread.title }}</strong>
        <span>{{ formatShanghaiTime(thread.updatedAt) }}</span>
        <small><em v-if="thread.general" class="thread-pin-tag">固定</em>{{ thread.messageCount ? `${thread.messageCount} 条消息 · 已同步` : '通用助手作答 · 可直接提问' }}</small>
      </button>
      <div v-if="!threadItems.length" class="thread-empty">
        <IconMessageCircle2 :size="22" /><strong>暂无研究会话</strong>
        <span>点击“新建角色”开始。本浏览器可恢复会话；不同浏览器不会自动共享。</span>
      </div>
      <div class="thread-bottom"><span>共 {{ conversationCount }} 条会话</span><span>最多保留100条</span></div>
    </aside>

    <!-- 新建角色。
         ⚠️ Element Plus 试点（2026-10-10）：这是全项目第一个 `el-*` 组件。
         原先是手写 backdrop + form + input + 按钮；换成 el-dialog 后遮罩、Esc 关闭、
         点击遮罩关闭、焦点陷阱、body 滚动锁全部由组件接管，省掉的都是易错的那部分。
         配色靠 theme.css 里那套 `--el-*` 覆盖（主色/边框/圆角/语义色），所以这里不用传任何颜色。
         `class="ai-role-dialog"` 的落点已核实：EP 把 `$attrs` merge 进 DialogContent，
         即最终落在 `.el-dialog` 元素上（见 dialog.vue 的 mergeProps($attrs)）。 -->
    <el-dialog
      v-model="roleDialogOpen"
      class="ai-role-dialog"
      width="440px"
      align-center
      append-to-body
    >
      <template #header>
        <div class="role-create-head">
          <div><span>AI研究</span><h2 id="role-create-title">新建角色</h2></div>
        </div>
      </template>
      <!-- 按钮放在 el-form **内部**（原版也是这样）：EP 的 el-button 默认
           native-type="button"，只有设成 submit 且在 form 内，输入框里按 Enter 才会提交。 -->
      <el-form label-position="top" @submit.prevent="submitNewRole">
        <el-form-item label="角色（老师）名称" :error="roleNameError">
          <el-input v-model="roleName" maxlength="80" placeholder="例如：趋势交易老师" />
        </el-form-item>
        <p class="role-create-hint">创建后可在会话中上传股票资料，由 AI 提炼出该角色的画像，并同步到「老师策略」页。</p>
        <div class="ai-role-actions">
          <el-button @click="roleDialogOpen = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="roleSaving">
            {{ roleSaving ? '创建中…' : '创建角色' }}
          </el-button>
        </div>
      </el-form>
    </el-dialog>

    <!-- 对话主区：无任何会话时内部内容全部不渲染 -->
    <main class="chat-main">
      <div v-if="hasThreads" class="chat-head">
        <div>
          <h1>{{ activeThread?.teacherName || activeThread?.title || '新研究会话' }}</h1>
          <span>{{ chatHeadSubtitle }}</span>
        </div>
      </div>

      <div v-if="hasThreads" class="chat-scroll">
        <!-- <section v-if="!hasConversation" class="reference-banner reference-banner-ai" aria-label="AI研究室 · 让每一次投资决策更有依据">
          <img src="/design-reference/ai.png" alt="AI研究室 · 让每一次投资决策更有依据" />
        </section> -->

        <template v-for="(message, index) in (messages.length ? messages : [systemMessage])" :key="message.id || index">
          <div v-if="message.role === 'user'" class="user-message">
            <div class="user-message-text">{{ message.content }}</div>
            <span v-if="messageStockLabel(message)" class="bubble-stock-tag">{{ messageStockLabel(message) }}</span>
          </div>
          <template v-else>
            <!-- 每位老师自己的发言：第一人称气泡 -->
            <div
              v-for="answer in (message.teacherAnswers || [])"
              :key="`${message.id || index}-${answer.teacherName}`"
              class="chat-bubble assistant"
            >
              <div class="bubble-avatar"><IconBrain :size="16" /></div>
              <div class="bubble-main">
                <div class="bubble-author">{{ answer.teacherName }}</div>
                <div class="bubble-text">
                  <template v-for="(part, i) in parseText(answer.answer)" :key="i">
                    <strong v-if="part.bold">{{ part.text }}</strong>
                    <b v-else-if="part.cite" class="inline-citation">{{ part.text }}</b>
                    <span v-else>{{ part.text }}</span>
                  </template>
                </div>
              </div>
            </div>

            <!-- 汇总 / 状态气泡。单人会话不重复显示（那时上面那位老师的话就是最终回答） -->
            <div
              v-if="showsSummary(message)"
              class="chat-bubble assistant"
              :class="{ 'assistant-error': message.type === 'error' }"
            >
              <div class="bubble-avatar">
                <IconSparkles v-if="message.type === 'live'" :size="16" />
                <IconBrain v-else :size="16" />
              </div>
              <div class="bubble-main">
                <div class="bubble-author">{{ bubbleAuthor(message) }}</div>
                <div class="bubble-text">
                  <template v-for="(part, i) in parseText(message.content)" :key="i">
                    <strong v-if="part.bold">{{ part.text }}</strong>
                    <b v-else-if="part.cite" class="inline-citation">{{ part.text }}</b>
                    <span v-else>{{ part.text }}</span>
                  </template>
                </div>
                <div v-if="message.type === 'live' && message.id" class="bubble-actions">
                  <button @click="copyMessage(message)"><IconFileAnalytics :size="13" /> 复制</button>
                  <button :class="{ active: message.feedback === 'helpful' }" @click="rateMessage(message.id, 'helpful')">有帮助</button>
                  <button :class="{ active: message.feedback === 'not_helpful' }" @click="rateMessage(message.id, 'not_helpful')">需改进</button>
                </div>
              </div>
            </div>
          </template>
        </template>

        <section v-if="!hasConversation" class="ai-quick-start">
          <div>
            <span>开始一项研究</span>
            <h2>{{ requestStock ? `${requestStock.name} ${requestStock.code}` : '全市场A股研究' }}</h2>
            <p>{{ quickStartWho }} · 回答保留来源和数据截止时间</p>
          </div>
          <div class="ai-quick-question-grid">
            <button v-for="q in quickQuestions" :key="q" :disabled="sending" @click="input = q">
              <IconSparkles :size="16" /><span>{{ q }}</span><IconChevronRight :size="15" />
            </button>
          </div>
        </section>

        <div v-if="sending" class="typing"><i /><i /><i /></div>
      </div>

      <div v-if="hasThreads" class="composer">
        <!-- 第 1 行：**入口**。两个"往这次提问加上下文"的入口常驻在这行，位置永远不动
             （改动前它和已选 chip/tag 挤在同一行，每选一位角色按钮就被挤着换行一次）。
             通用研究会话专有的「选择角色」也在这行：它和「搜索A股」语义同类，都是入口。

             Element Plus 试点 ③ 第二轮（2026-10-10）：这两个入口先做成 el-dialog 弹窗，
             实拍后弹窗对"加个上下文"这种高频轻量动作太重（点开→选→关三步），
             换回**内联下拉** el-select：
             - 搜索A股：remote 模式（filterable + remote-method），输入即查 /api/stocks/search，
               选中即收起并把上下文加到这一问上；
             - 选择角色：multiple + collapse-tags（多选，超过 2 位折成 +N），
               值直接双向绑到 generalRoles，落库收在 generalRolesModel 的 setter 里。 -->
        <div class="context-chips">
          <el-select
            v-model="stockSelectCode"
            class="composer-select composer-stock-select"
            popper-class="composer-select-dropdown"
            placeholder="搜索A股"
            filterable
            remote
            clearable
            :remote-method="runStockSearch"
            :loading="stockSearchState === 'loading'"
            :disabled="sending"
            :teleported="true"
          >
            <template #prefix><IconSearch :size="14" /></template>
            <el-option
              v-for="item in stockSelectOptions"
              :key="item.tsCode || item.code"
              :label="stockOptionLabel(item)"
              :value="item.code"
            >
              <span class="composer-option-main">{{ item.name }}</span>
              <span class="composer-option-sub">{{ item.code }} · {{ item.industry }}</span>
            </el-option>
            <!-- 空态沿用原来的三句文案：下拉自带 no-data 只能给一句，说不出"在加载"和"接口挂了" -->
            <template #empty>
              <p class="composer-select-empty">{{ stockEmptyText }}</p>
            </template>
          </el-select>

          <!-- 临时挑角色来回答这一问（不改会话的角色归属）。多选。
               ⚠️ 列表里**没有**「通用助手」这一项 —— 取消选择靠 tag 上的 ×，
               多选列表里混一个非角色的项会让人误以为它也是一个"角色"。 -->
          <el-select
            v-if="isGeneralThread"
            v-model="generalRolesModel"
            class="composer-select composer-role-select"
            popper-class="composer-select-dropdown"
            placeholder="选择角色"
            multiple
            filterable
            collapse-tags
            :max-collapse-tags="1"
            :disabled="sending"
            :teleported="true"
          >
            <template #prefix><IconUserSearch :size="14" /></template>
            <el-option v-for="item in roleOptions" :key="item.name" :label="item.name" :value="item.name">
              <span class="composer-option-main">{{ item.name }}</span>
              <span v-if="item.style" class="composer-option-sub">{{ item.style }}</span>
            </el-option>
            <template #empty>
              <p class="composer-select-empty">没有匹配的角色。可先点左上「新建角色」。</p>
            </template>
          </el-select>
        </div>

        <!-- 第 2 行：**补充上下文**。TOP50 榜位 / 老师会话的溢出人数在这行 ——
             只放下拉表达不了的信息（标的由下拉显示、角色 tag 由下拉渲染），
             空的时候整行不渲染（默认态高度与改动前一致）。 -->
        <div v-if="hasPickedContext" class="context-chips context-selected">
          <span v-if="!isGeneralThread && selectedAgentNames.length > visibleAgentNames.length" class="agent-overflow-chip">+{{ selectedAgentNames.length - visibleAgentNames.length }}位</span>
          <span v-if="Number(activeStock?.rank) > 0">TOP50 #{{ activeStock.rank }}</span>
        </div>

        <div v-if="showAgentRunStatus" class="agent-run-status" aria-live="polite">
          <div class="agent-run-head">
            <span><IconActivity :size="14" /> {{ agentJobPhaseLabels[agentJob?.phase] || '正在创建AI会诊任务' }}</span>
            <b>{{ independentCompletedCount }}/{{ liveAgentTotal }}</b>
          </div>
          <div class="agent-run-summary">
            <span>独立完成 <b>{{ independentCompletedCount }}/{{ liveAgentTotal }}</b></span>
            <span>未完成 <b>{{ independentFailureCount }}</b></span>
            <span>执行上限 <b>{{ formatShanghaiTime(agentJob?.deadlineAt) }}</b></span>
            <span v-if="agentJob?.fallbackMode === 'shared_model'" class="fallback">共享模型降级，未计入老师共识</span>
          </div>
          <div class="agent-progress-grid">
            <article v-for="item in liveAgentStates" :key="item.teacherName" :class="['agent-progress-card', item.status || 'waiting']">
              <div class="agent-progress-top">
                <div><b>{{ item.teacherName }}</b><small>{{ agentJobStateLabels[item.status || 'waiting'] }}</small></div>
                <span>耗时 {{ formatDurationMs(item.durationMs) }}</span>
              </div>
              <div class="agent-progress-detail">
                <span>分类 {{ item.errorCategory || '--' }}</span>
                <span>脱敏原因：{{ item.publicMessage || '--' }}</span>
              </div>
            </article>
          </div>
        </div>

        <div class="composer-input">
          <textarea
            v-model="input"
            :disabled="sending"
            :placeholder="composerPlaceholder"
            @keydown.enter.exact.prevent="send"
          />
          <button :disabled="sending || !input.trim()" aria-label="发送研究问题" @click="send"><IconSend2 :size="17" /></button>
        </div>
        <div class="composer-actions">
          <button :disabled="sending" @click="input = activeStock ? `比较${activeStock.name}与同行公司的基本面和买点` : '比较两只指定A股的基本面、风险和触发条件'"><IconChartDots3 :size="14" /> 比较股票</button>
          <button :disabled="sending" @click="input = '如果明日低开3%，三种情景如何应对？'"><IconTargetArrow :size="14" /> 情景推演</button>
          <button :disabled="sending" @click="input = '生成一份完整的打印版研究报告'"><IconFileAnalytics :size="14" /> 生成报告</button>
        </div>
      </div>
    </main>

    <!-- 研究上下文 -->
    <aside v-if="activeStock" class="research-context">
      <div class="context-head"><h2>研究上下文</h2></div>
      <section>
        <h3>当前标的</h3>
        <p><strong>{{ hydrateStock(activeStock).name }}</strong> {{ hydrateStock(activeStock).code }}</p>
        <p>所属行业<b>{{ hydrateStock(activeStock).industry }}</b></p>
        <p>最新价<b>{{ hydrateStock(activeStock).price.toFixed(2) }}</b></p>
        <p>涨跌幅<b :class="hydrateStock(activeStock).pct >= 0 ? 'price-up' : 'price-down'">{{ hydrateStock(activeStock).pct >= 0 ? '+' : '' }}{{ hydrateStock(activeStock).pct }}%</b></p>
      </section>
      <section v-if="!isGeneralThread">
        <h3>主研判 Agent</h3>
        <p>{{ primaryTeacher.name }}<b>{{ primaryTeacher.style }}</b></p>
        <p>生产版本<b>{{ activeTeacher?.productionVersion?.id || 'agent-factor-v1' }}</b></p>
      </section>
      <!-- 通用研究会话不专属任何角色，别在这里露出一个"暂无角色"或上一轮的老师名。
           但用户可以在「搜索A股」旁边临时挑角色来作答 —— 挑了就把"回答角色"列出来。
           ⚠️「研判方式」与「回答角色」是两件事：前者说会话归属/谁在答，后者是具体名单。
           两句都要用 generalModeLabel 的统一口径，别再写回"不绑定角色"（会和名单打架）。 -->
      <section v-else>
        <h3>研判方式</h3>
        <p>{{ generalModeLabel }}</p>
        <p v-if="generalRoles.length">回答角色<b>{{ generalRoleNames }}</b></p>
      </section>
      <section>
        <h3>使用方式</h3>
        <p>回答会引用真实榜单、行情与资讯；从股票卡片点击“问AI复核”时，系统会额外带入该股票的真实代码、行情证据和榜单信息。</p>
      </section>
      <section>
        <h3>证据口径</h3>
        <p><IconDatabase :size="14" /> 榜单日 {{ displayField(labTop50Snapshot?.meta?.tradeDate) }} · 行情截止 {{ displayField(labTop50Snapshot?.meta?.marketDataDate) }}</p>
        <p><IconAlertTriangle :size="14" /> 本信息仅供研究，不构成投资建议。</p>
      </section>
      <!-- 右栏「角色资料」面板：上传入口在输入框上方（「搜索A股」左边），
           这里负责「提炼画像 → 查看画像 → 生成矩阵评分」。
           通用研究会话按产品要求不显示这块（用户明确要求去掉）；注意别把原因写成
           "选了角色也不影响画像" —— 选了角色反而会按条喂进它的提炼历史，
           只是资料/画像的**管理入口**归到该角色的专属会话里去做。 -->
      <AgentDocsPanel v-if="!isGeneralThread" :agent="docsTarget" />
    </aside>
    <aside v-else class="research-context">
      <div class="context-head"><h2>研究上下文</h2></div>
      <section>
        <h3>当前范围</h3>
        <p>全市场A股研究<b>未指定股票</b></p>
        <!-- 通用研究会话不绑定角色：别再显示「所选Agent N位」—— selectedAgentNames
             里可能还留着上一个老师会话的选择，在这里显示出来是错的。 -->
        <template v-if="isGeneralThread">
          <p>研判方式<b>{{ generalModeLabel }}</b></p>
          <p v-if="generalRoles.length">回答角色<b>{{ generalRoleNames }}</b></p>
        </template>
        <p v-else>所选Agent<b>{{ selectedAgentNames.length }}位</b></p>
      </section>
      <section>
        <h3>使用方式</h3>
        <p>可直接询问市场、行业或任意A股；从股票卡片点击“问AI复核”时，系统会额外带入该股票的真实代码、行情证据和榜单信息。</p>
      </section>
      <!-- 同上：通用研究会话不渲染角色资料面板。 -->
      <AgentDocsPanel v-if="!isGeneralThread" :agent="docsTarget" />
    </aside>
  </div>
</template>
