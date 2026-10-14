<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSnapshot } from '@/composables/useSnapshot'
import { useStockDecision } from '@/composables/useStockDecision'
import { IconShieldCheck, IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-vue'

const router = useRouter()
const stockDecision = useStockDecision()
const { data: snap, state } = useSnapshot('/api/risk', { refreshMs: 60000 })
const gates = computed(() => snap.value?.gates || [])
const alerts = computed(() => snap.value?.alerts || [])
const dataDate = computed(() => snap.value?.meta?.marketDataDate || '--')

function openStock(item) {
  // 风险中心「查看个股」：有代码则弹出与 TOP50 一致的单股决策弹窗，否则退回原导航。
  if (item?.code) stockDecision.open({ code: item.code, stock: item })
  else router.push('/top50')
}
</script>

<template>
  <div class="simple-page">
    <div class="page-toolbar">
      <div>
        <h1>风险中心</h1>
        <p>{{ state === 'ready' ? `真实快照推导 · 行情截止 ${dataDate}` : '正在读取真实风险快照' }}</p>
      </div>
      <span class="toolbar-button">
        <IconShieldCheck :size="15" />
        {{ snap?.meta?.sourceMode === 'derived_from_live' ? '可审计规则' : '等待数据' }}
      </span>
    </div>

    <div v-if="state === 'unavailable'" class="account-empty">
      <IconAlertTriangle :size="22" /><strong>真实风险数据暂不可用</strong>
      <p>本页不会显示固定风险分数或虚构组合预警。</p>
    </div>

    <div class="risk-grid">
      <section v-for="gate in gates" :key="gate.id" :class="['panel risk-card', gate.tone]">
        <div><span>{{ gate.title }}</span><IconShieldCheck :size="20" /></div>
        <strong>{{ gate.value }}</strong>
        <p>{{ gate.desc }}</p>
        <div class="risk-meter"><i :style="{ width: `${gate.score}%` }" /></div>
        <small>风险指数 {{ gate.score }}/100 · {{ gate.evidence }}</small>
      </section>
    </div>

    <section class="panel alerts-table">
      <div class="panel-head">
        <div><h2>股票风险预警</h2><span>仅来自当前TOP50冻结风险分布；系统故障统一进入运行状态</span></div>
      </div>
      <template v-if="alerts.length">
        <div v-for="item in alerts" :key="item.id" :class="['alert-row', item.tone || '']">
          <IconAlertTriangle :size="18" />
          <span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span>
          <b>{{ item.label }}</b>
          <button v-if="item.action === 'stock'" @click="openStock(item)">查看个股</button>
        </div>
      </template>
      <div v-else class="account-empty">
        <IconCircleCheck :size="22" /><strong>当前没有股票风险告警</strong>
        <p>系统不会使用静态预警补位。</p>
      </div>
    </section>

    <p v-if="snap?.meta?.methodology" class="page-data-method">
      <IconInfoCircle :size="15" /> {{ snap.meta.methodology }}
    </p>
  </div>
</template>
