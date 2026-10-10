import { ref, onMounted, onUnmounted } from 'vue'
import { fetchSnapshot } from '@/api/client'

// Mirrors the React prototype's useSharedSnapshot: fetch JSON snapshot, expose
// { data, state, sourceMode }; optional polling + fallback url.
export function useSnapshot(url, { refreshMs = 0, fallbackUrl = null } = {}) {
  const data = ref(null)
  const state = ref('loading')
  const sourceMode = ref('loading')
  let timer = null
  let active = true

  async function load() {
    try {
      const d = await fetchSnapshot(url)
      if (!active) return
      data.value = d
      state.value = 'ready'
      sourceMode.value = d?.meta?.sourceMode || 'live'
    } catch (e) {
      if (!active) return
      if (fallbackUrl) {
        try {
          const d = await fetchSnapshot(fallbackUrl)
          if (!active) return
          data.value = d
          state.value = 'fallback'
          sourceMode.value = 'demo'
          return
        } catch (_) {}
      }
      state.value = 'unavailable'
      sourceMode.value = 'unavailable'
    }
  }

  onMounted(() => {
    load()
    if (refreshMs) {
      timer = setInterval(() => {
        if (!document.hidden) load()
      }, refreshMs)
    }
  })
  onUnmounted(() => {
    active = false
    if (timer) clearInterval(timer)
  })

  return { data, state, sourceMode, reload: load }
}
