<script setup>
import { computed } from 'vue'

const props = defineProps({ status: { type: String, default: '' } })

const cls = computed(() => {
  if (props.status === '可试仓') return 'success'
  if (props.status === '等待确认') return 'warn'
  if (props.status === '风险排除') return 'danger'
  return 'muted'
})
</script>

<template>
  <span class="status-badge" :class="cls">{{ status }}</span>
</template>
