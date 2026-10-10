import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { http } from '@/api/client'

// Single shared source of truth for agent (老师) personas.
//
// AILabPage writes to it (new persona) and both AILabPage and StrategiesPage
// read from it, so a persona created in the AI lab shows up in the strategy
// tabs immediately.
//
// 这里**只有用户自己创建的角色**：原版内置的 12 位老师是 mock 人设，后端
// `GET /api/agents` 已经不再返回它们，所以本 store 也不再做静态兜底 ——
// 后端不可用时列表就是空的，宁可显示空态，也不要凭空冒出 12 个假老师。
export const useAgentsStore = defineStore('agents', () => {
  const customAgents = ref([])
  const loading = ref(false)
  const error = ref('')
  const loaded = ref(false)

  const teacherList = computed(() => customAgents.value)
  const teacherByName = computed(() => {
    const map = {}
    for (const item of teacherList.value) map[item.name] = item
    return map
  })

  async function refresh({ force = false } = {}) {
    if (loaded.value && !force) return
    loading.value = true
    try {
      // Bypass fetchSnapshot's 1s cache: persona list must be current
      // right after a create/delete round-trip.
      const { data } = await http.get('/api/agents', { params: { _t: Date.now() } })
      const items = Array.isArray(data?.items) ? data.items : []
      customAgents.value = items.filter((i) => i.custom)
      error.value = ''
      loaded.value = true
    } catch {
      customAgents.value = []
      error.value = '无法读取角色列表，请确认后端已启动'
    } finally {
      loading.value = false
    }
  }

  async function createAgent(payload) {
    const { data } = await http.post('/api/agents', payload)
    const agent = data?.agent
    if (agent) customAgents.value = [...customAgents.value, agent]
    return agent
  }

  async function removeAgent(id) {
    await http.delete(`/api/agents/${id}`)
    customAgents.value = customAgents.value.filter((i) => i.id !== id)
  }

  function isCustom(name) {
    return customAgents.value.some((i) => i.name === name)
  }

  return {
    customAgents,
    teacherList,
    teacherByName,
    loading,
    error,
    loaded,
    refresh,
    createAgent,
    removeAgent,
    isCustom,
  }
})
