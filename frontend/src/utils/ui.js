// Small view helpers — keep template bindings as plain function calls so the
// Vue compiler never has to parse inline comparison/ternary expressions.

export function dirCls(v) {
  return v >= 0 ? 'up' : 'down'
}
export function statusType(s) {
  return s === 'ok' ? 'success' : 'warning'
}
export function boolType(b) {
  return b ? 'success' : 'info'
}
export function agentStatusType(s) {
  return s === 'completed' ? 'success' : s === 'running' ? 'warning' : 'info'
}
export function tierType(t) {
  return t === 'primary' ? 'danger' : t === 'standard' ? 'warning' : 'info'
}
export function sentimentType(s) {
  return s === 'positive' ? 'danger' : s === 'negative' ? 'success' : 'info'
}
export function chgCls(v) {
  return v >= 0 ? 'up' : 'down'
}
export function trendType(t) {
  return t === 'up' ? 'danger' : t === 'down' ? 'success' : 'info'
}
export function gateIcon(b) {
  return b ? 'CircleCheck' : 'Warning'
}
export function gateColor(b) {
  return b ? '#2bbf6a' : '#f5a623'
}
export function sign(v) {
  return v > 0 ? '+' : ''
}
export function pct(v) {
  return (v * 100).toFixed(0) + '%'
}
