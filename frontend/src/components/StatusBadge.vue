<script setup>
import { computed } from 'vue'

const props = defineProps({ status: { type: String, default: '' } })

const cls = computed(() => {
  if (props.status === '可试仓') return 'success'
  if (props.status === '待信号') return 'warn'
  if (props.status === '风险排除') return 'danger'
  return 'muted'
})

// 三态口径对齐 backend/app/top50_engine.py + reference-react/worker/index.js：
// 可试仓 = score≥70 且 支持≥7/12；待信号 = score≥60 且 支持≥6/12（未达上档）；仅观察 = 未达门槛。
const title = computed(() => {
  switch (props.status) {
    case '可试仓':
      return '综合分≥70 且因子支持≥7/12：可回踩试仓，单笔≤5%'
    case '待信号':
      return '综合分≥60 但分数或共识未达可试仓：不追价'
    case '仅观察':
      return '未达风控门槛（综合分<60 或因子支持<6/12）：不进入执行建议'
    case '风险排除':
      return '风险排除：不纳入执行建议'
    default:
      return ''
  }
})
</script>

<template>
  <span class="status-badge" :class="cls" :title="title">{{ status }}</span>
</template>
