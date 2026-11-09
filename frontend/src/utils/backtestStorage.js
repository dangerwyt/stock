const KEY = 'sip_backtest_v1'
const finite = value => typeof value === 'number' && Number.isFinite(value)
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

export function readBacktest(defaults, storage) {
  try {
    const saved = JSON.parse((storage ?? globalThis.localStorage).getItem(KEY))
    if (saved?.version !== 1 || !saved.form || typeof saved.form !== 'object') return null
    const form = { ...defaults }
    for (const key of Object.keys(defaults)) {
      const value = saved.form[key]
      if (typeof defaults[key] === 'number' ? finite(value) : typeof value === 'string' && value.length < 100) form[key] = value
    }
    const r = saved.result
    const valid = r && typeof r.stock?.code === 'string' && typeof r.stock?.name === 'string'
      && typeof r.strategy === 'string' && day(r.startDate) && day(r.endDate)
      && Array.isArray(r.equityCurve) && r.equityCurve.length > 0 && r.equityCurve.length <= 366
      && r.equityCurve.every(p => p && day(p.date) && ['strategy', 'benchmark', 'equity', 'cash', 'marketValue', 'positionPct', 'drawdown'].every(k => finite(p[k])))
      && Array.isArray(r.trades) && r.trades.length <= 732
      && r.trades.every(t => t && day(t.date) && ['买入', '卖出'].includes(t.side) && ['price', 'units', 'amount', 'fees', 'cash'].every(k => finite(t[k])))
      && typeof saved.lastSignature === 'string' && Number.isFinite(Date.parse(saved.ranAt))
    return { form, result: valid ? r : null, lastSignature: valid ? saved.lastSignature : '', ranAt: valid ? saved.ranAt : '' }
  } catch { return null }
}

export function writeBacktest(snapshot, storage) {
  try {
    // shortcut: 仅保存当前浏览器最近一次回测，跨设备历史记录需要后端存储。
    (storage ?? globalThis.localStorage).setItem(KEY, JSON.stringify({ ...snapshot, version: 1 }))
    return true
  } catch { return false }
}
