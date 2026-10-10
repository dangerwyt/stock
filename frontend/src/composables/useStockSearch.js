import { ref, watch, onUnmounted } from 'vue'
import { http } from '@/api/client'

// Mirrors reference-react useStockDirectorySearch: debounced query against the
// /api/stocks/search directory endpoint. Returns { items, state }.
export function useStockSearch(queryRef, { enabled = true } = {}) {
  const items = ref([])
  const state = ref('idle') // idle | loading | ready | error
  let timer = null
  let controller = null

  function run(q) {
    const term = (q || '').trim()
    if (!enabled || !term) {
      items.value = []
      state.value = 'idle'
      return
    }
    state.value = 'loading'
    if (controller) controller.abort()
    controller = new AbortController()
    timer = window.setTimeout(() => {
      http
        .get('/api/stocks/search', { params: { q: term }, signal: controller.signal })
        .then((r) => {
          items.value = r.data?.items || []
          state.value = 'ready'
        })
        .catch((e) => {
          if (e.name !== 'CanceledError' && e.code !== 'ERR_CANCELED') state.value = 'error'
        })
    }, 250)
  }

  watch(queryRef, (q) => run(q), { immediate: true })
  onUnmounted(() => {
    if (timer) window.clearTimeout(timer)
    if (controller) controller.abort()
  })

  return { items, state }
}
