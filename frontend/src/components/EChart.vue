<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  options: { type: Object, required: true },
  height: { type: String, default: '280px' },
})

const el = ref(null)
let chart = null

function render() {
  if (!chart) return
  chart.setOption(props.options, true)
}
function resize() {
  chart && chart.resize()
}
onMounted(async () => {
  await nextTick()
  // No registered theme: rely on per-option colors (transparent bg + light axis text).
  chart = echarts.init(el.value)
  chart.setOption(props.options, true)
  window.addEventListener('resize', resize)
})
watch(() => props.options, render, { deep: true })
onUnmounted(() => {
  window.removeEventListener('resize', resize)
  chart && chart.dispose()
})
</script>

<template>
  <div ref="el" :style="{ width: '100%', height }"></div>
</template>
