import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchSnapshot } from '@/api/client'

// Shared watchlist (anonymous, browser-local) — mirrors the React prototype's
// default-browser watchlist behaviour.
export const useAppStore = defineStore('app', () => {
  const watchlist = ref(JSON.parse(localStorage.getItem('sip_watchlist') || '[]'))
  const platformStatus = ref(null)

  function toggleWatch(code) {
    const i = watchlist.value.indexOf(code)
    if (i >= 0) watchlist.value.splice(i, 1)
    else watchlist.value.push(code)
    localStorage.setItem('sip_watchlist', JSON.stringify(watchlist.value))
  }
  function has(code) {
    return watchlist.value.includes(code)
  }

  async function loadStatus() {
    try {
      platformStatus.value = await fetchSnapshot('/api/status')
    } catch (e) {
      platformStatus.value = null
    }
  }

  return { watchlist, platformStatus, toggleWatch, has, loadStatus }
})
