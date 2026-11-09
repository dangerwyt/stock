import { ref, unref, watch, onMounted, onUnmounted } from 'vue'
import { fetchSnapshot } from '@/api/client'

// Mirrors the React prototype's useSharedSnapshot: fetch JSON snapshot, expose
// { data, state, sourceMode }; optional polling + fallback url.
//
// `url` 可以是字符串、ref/computed，或返回字符串的 getter —— 后两种支持"地址变了自动
// 重新拉"。字符串仍然是最常见用法，此时 watch 的 getter 恒返回同一个值，永不触发，
// 行为与从前完全一致（这是 ReviewPage 改日期后不刷新那个 bug 的修法）。
export function useSnapshot(url, { refreshMs = 0, fallbackUrl = null, timeout = 20000 } = {}) {
  const data = ref(null)
  const state = ref('loading')
  const sourceMode = ref('loading')
  const error = ref(null)
  let timer = null
  let computeTimer = null
  let active = true

  const currentUrl = () => (typeof url === 'function' ? url() : unref(url))

  async function load(opts = {}) {
    try {
      const d = await fetchSnapshot(currentUrl(), { timeout, ...opts })
      if (!active) return
      data.value = d
      error.value = null
      if (d?.meta?.status === 'computing') {
        // 榜单首次计算（拉全市场行情）较慢：进入 3 秒快速轮询，直到 ready。
        state.value = 'computing'
        sourceMode.value = d?.meta?.sourceMode || 'live'
        if (!computeTimer) computeTimer = setInterval(load, 3000)
        return
      }
      if (computeTimer) {
        clearInterval(computeTimer)
        computeTimer = null
      }
      state.value = 'ready'
      sourceMode.value = d?.meta?.sourceMode || 'live'
    } catch (e) {
      if (!active) return
      error.value = e.response?.data || null
      if (fallbackUrl) {
        try {
          const d = await fetchSnapshot(fallbackUrl)
          if (!active) return
          data.value = d
          state.value = 'fallback'
          sourceMode.value = 'demo'
          if (computeTimer) {
            clearInterval(computeTimer)
            computeTimer = null
          }
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
  // 地址变化（例如复盘页换了报告日期）→ 立刻重拉；拉回来之前先把状态打回 loading，
  // 否则页面会拿着上一份数据继续渲染，出现"日期已变但内容还是旧的"。
  watch(currentUrl, () => {
    if (!active) return
    state.value = 'loading'
    load()
  })
  onUnmounted(() => {
    active = false
    if (timer) clearInterval(timer)
    if (computeTimer) clearInterval(computeTimer)
  })

  // reload 走 fresh：调用方通常是在"刚写了后端状态"之后手动刷新，拿到缓存就白刷了。
  return { data, state, sourceMode, error, reload: () => load({ fresh: true }) }
}
