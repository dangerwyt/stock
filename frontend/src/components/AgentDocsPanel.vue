<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { http } from '@/api/client'
import { useAgentsStore } from '@/stores/agents'
import { IconChartDots3, IconSparkles, IconUpload } from '@tabler/icons-vue'

// 角色资料与画像面板：上传 → 提炼 → 打分。
// 只对自建角色渲染（内置角色的资料接口是只读的）。
// 上传入口在本面板内（曾短暂挪到输入框上方的上下文行，已还原回来）；
// 文件列表与「移除（删除）资料」功能按需求不做。
const props = defineProps({
  agent: { type: Object, default: null },
})

const agentsStore = useAgentsStore()

const documents = ref([])
const extraction = ref(null)
const profile = ref(null)
const scores = ref(null)
const error = ref('')
const warn = ref('')
const busy = ref(false)
const uploading = ref(false)
const fileInput = ref(null)
let pollTimer = null
let warnTimer = null
// 上一次轮询看到的提炼状态，用来捕捉 idle/running → completed 这个跳变。
let lastExtractionStatus = null

const isCustom = computed(() => props.agent?.custom === true)
const agentId = computed(() => props.agent?.id || null)
const running = computed(() => extraction.value?.status === 'running')

// 后端会把「与股票财经无关」的资料标成 rejected：仍然留档可查，但不参与画像提炼。
const isRejected = (doc) => String(doc?.status || '').toLowerCase() === 'rejected'
const effectiveDocuments = computed(() => documents.value.filter((doc) => !isRejected(doc)))
const rejectedDocuments = computed(() => documents.value.filter(isRejected))
// 图片 / 扫描件 PDF 在后台 OCR 中（ocrStatus=pending）：此时文本未就绪，
// 不应允许「提炼画像」，否则会漏掉这份资料。轮询（schedulePoll）会在 OCR 完成后翻回 ready。
const hasPending = computed(() => documents.value.some((doc) => doc.ocrStatus === 'pending'))

const documentStatus = computed(() => {
  if (hasPending.value) {
    const n = documents.value.filter((doc) => doc.ocrStatus === 'pending').length
    return `正在识别 ${n} 份图片/扫描件资料（OCR 中），完成后即可提炼画像。`
  }
  if (!documents.value.length) {
    return '上传 PDF / MD / TXT / 图片（研报截图、扫描件）研究资料，AI 会据此提炼该角色的策略画像；图片与扫描件 PDF 会自动 OCR 提取文字；此角色会话中的问答会作为补充线索一并参考。'
  }
  const parts = []
  parts.push(
    effectiveDocuments.value.length
      ? `已上传 ${effectiveDocuments.value.length} 份资料，可提炼画像。`
      : '已上传的资料均与股票财经无关，无法用于提炼。',
  )
  if (rejectedDocuments.value.length) {
    const names = rejectedDocuments.value.map((doc) => doc.filename).join('、')
    parts.push(`另有 ${rejectedDocuments.value.length} 份因与股票财经无关被排除：${names}。`)
  }
  return parts.join('')
})


const statusLabel = computed(() => {
  const status = extraction.value?.status
  const historyUsed = Number(extraction.value?.historyCount || 0)
  const note = historyUsed > 0 ? `（已参考 ${historyUsed} 条历史对话）` : ''
  if (status === 'running') return 'AI 正在阅读资料并提炼画像，约需 15-30 秒…'
  if (status === 'completed') return `画像提炼完成${note}，已同步到「老师策略」页。`
  if (status === 'failed') return `提炼失败：${extraction.value?.error || '未知原因'}`
  return '尚未提炼画像。'
})

async function load() {
  if (!agentId.value) return
  try {
    const { data } = await http.get(`/api/agents/${agentId.value}/profile`, {
      params: { _t: Date.now() },
    })
    documents.value = data.documents || []
    extraction.value = data.extraction || null
    profile.value = data.profile || null
    scores.value = data.scores || null
    error.value = ''
  } catch (e) {
    error.value = e?.response?.data?.detail || '读取角色资料失败'
  }
  // 提炼完成后必须让共享 store 重新拉一次：refresh() 有 `loaded` 短路，
  // 否则策略页右栏（Agent决策/选股技巧/风险纪律）会一直显示提炼前的占位文本。
  const status = extraction.value?.status || null
  if (status === 'completed' && lastExtractionStatus !== 'completed') {
    agentsStore.refresh({ force: true })
  }
  lastExtractionStatus = status
  schedulePoll()
}

function schedulePoll() {
  clearTimeout(pollTimer)
  // 提炼中（running）或 OCR 中（hasPending）都要持续轮询：否则 OCR 在后台跑完、
  // 记录已变 ready，前端却再也不 load()，会永久停在"正在识别…"。
  if (running.value || hasPending.value) pollTimer = setTimeout(load, 2500)
}

function pick() {
  fileInput.value?.click()
}

async function onPick(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (!files.length || !agentId.value) return

  uploading.value = true
  error.value = ''
  warn.value = ''
  const rejected = []
  for (const file of files) {
    const form = new FormData()
    form.append('file', file)
    try {
      const { data } = await http.post(`/api/agents/${agentId.value}/documents`, form)
      // 后端判为与股票财经无关：文件已留档，但不会参与画像提炼。
      if (data?.document && String(data.document.status).toLowerCase() === 'rejected') {
        rejected.push(`${file.name}（${data.document.relevanceReason || '与股票财经无关'}）`)
      }
    } catch (e) {
      error.value = `${file.name}：${e?.response?.data?.detail || '上传失败'}`
    }
  }
  uploading.value = false
  if (rejected.length) {
    warn.value = `以下资料与股票财经无关，已留档但不会参与画像提炼：${rejected.join('；')}`
    clearTimeout(warnTimer)
    warnTimer = setTimeout(() => {
      warn.value = ''
    }, 12000)
  }
  await load()
}

async function extract() {
  if (!agentId.value) return
  busy.value = true
  error.value = ''
  try {
    await http.post(`/api/agents/${agentId.value}/extract`)
    await load()
  } catch (e) {
    error.value = e?.response?.data?.detail || '提炼任务启动失败'
  }
  busy.value = false
}

async function score() {
  if (!agentId.value) return
  busy.value = true
  error.value = ''
  try {
    await http.post(`/api/agents/${agentId.value}/score`)
  } catch (e) {
    error.value = e?.response?.data?.detail || '评分生成失败'
  }
  busy.value = false
  await load()
}

watch(
  agentId,
  () => {
    clearTimeout(pollTimer)
    clearTimeout(warnTimer)
    documents.value = []
    extraction.value = null
    profile.value = null
    scores.value = null
    error.value = ''
    warn.value = ''
    lastExtractionStatus = null
    if (isCustom.value) load()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clearTimeout(pollTimer)
  clearTimeout(warnTimer)
})
</script>

<template>
  <section v-if="isCustom" class="agent-docs">
    <h3>角色资料</h3>

    <p class="agent-docs-status">{{ documentStatus }}</p>

    <div class="agent-docs-actions">
      <button type="button" :disabled="busy || uploading" @click="pick">
        <IconUpload :size="13" /> {{ uploading ? '上传中…' : '上传资料' }}
      </button>
      <button
        type="button"
        class="primary"
        :disabled="busy || uploading || !effectiveDocuments.length || running || hasPending"
        @click="extract"
      >
        <IconSparkles :size="13" /> {{ running ? '提炼中…' : '提炼画像' }}
      </button>
    </div>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".pdf,.md,.markdown,.txt,.png,.jpg,.jpeg,.webp,.bmp,.gif"
      hidden
      @change="onPick"
    />

    <p v-if="error" class="agent-docs-status error">{{ error }}</p>
    <p v-else-if="warn" class="agent-docs-status warn">{{ warn }}</p>
    <p v-else class="agent-docs-status">{{ statusLabel }}</p>

    <template v-if="profile">
      <div class="agent-doc-row">
        <b>{{ profile.style }}</b>
        <small>{{ profile.subtitle }}</small>
      </div>

      <!-- 提炼产出的三块核心结论：与「老师策略」页右栏同名同结构，
           资料里没写到的字段由后端 normalize() 兜底成「需人工补充」。 -->
      <div class="detail-section">
        <h3>Agent决策</h3>
        <p>{{ profile.decision }}</p>
      </div>
      <div class="detail-section">
        <h3>选股技巧</h3>
        <p>{{ profile.select }}</p>
      </div>
      <div class="detail-section">
        <h3>风险纪律</h3>
        <p>{{ profile.risk }}</p>
      </div>

      <div v-for="w in profile.factorWeights || []" :key="w.factor" class="factor-weight">
        <span>{{ w.factor }}</span>
        <i><b :style="{ width: Math.round(w.weight * 100) + '%' }" /></i>
        <em>{{ Math.round(w.weight * 100) }}%</em>
      </div>

      <div class="agent-docs-actions">
        <button type="button" class="primary" :disabled="busy" @click="score">
          <IconChartDots3 :size="13" /> {{ busy ? '评分中…' : scores ? '重新评分' : '生成矩阵评分' }}
        </button>
      </div>
      <p v-if="scores" class="agent-docs-status">
        已对 {{ (scores.items || []).length }} 只股票评分，结果已并入「老师策略」矩阵。
      </p>
    </template>
  </section>
</template>
