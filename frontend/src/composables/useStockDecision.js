import { reactive } from 'vue'

// 全局单例：控制「单股决策弹窗」与「冻结选股证据」浮层的打开状态。
// 任意入口（顶栏搜索加自选 / 行情中心加自选 / TOP50 列表点股票名 / 自选组合查看 /
// 风险中心查看个股）都通过这里唤起同一个弹窗，保证内容与 TOP50 点股票名跳出的完全一致。
//
// state 字段：
//   open         单股决策弹窗是否打开
//   code         当前标的代码
//   stock        可选：调用方已持有的完整标的（如 TOP50 ranked 项），避免再拉一次
//   ranked       可选：上一只/下一只切换用的候选列表（TOP50 当前周期）
//   evidenceStock 冻结选股证据浮层（可独立于决策弹窗开启，如 TOP50 表格「查看证据」）
const state = reactive({
  open: false,
  code: null,
  stock: null,
  ranked: null,
  evidenceStock: null,
})

export function useStockDecision() {
  function open(payload = {}) {
    state.code = payload.code || null
    state.stock = payload.stock || null
    state.ranked = payload.ranked || null
    state.open = Boolean(state.code)
  }
  function close() {
    state.open = false
    state.code = null
    state.stock = null
    state.ranked = null
    state.evidenceStock = null
  }
  function openEvidence(stock) {
    state.evidenceStock = stock || null
  }
  function closeEvidence() {
    state.evidenceStock = null
  }
  return { state, open, close, openEvidence, closeEvidence }
}
