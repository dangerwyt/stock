export function compareConcepts(histories) {
  const usable = histories.filter(h => h.points?.length >= 2)
  if (!usable.length) return { dates: [], series: [], start: '' }
  const common = usable[0].points.map(p => p.date).filter(d => usable.every(h => h.points.some(p => p.date === d))).sort()
  if (common.length < 2) return { dates: [], series: [], start: '' }
  const start = common[0]
  const dates = [...new Set(usable.flatMap(h => h.points.map(p => p.date)))].filter(d => d >= start).sort()
  return { dates, start, series: usable.map(h => {
    const prices = new Map(h.points.map(p => [p.date, p.close]))
    const base = prices.get(start)
    return { code: h.code, name: h.name, values: dates.map(d => prices.has(d) && base > 0 ? (prices.get(d) / base - 1) * 100 : null) }
  }) }
}

export function mergeConceptFlows(items, flows, day) {
  const matching = flows?.tradeDate === day ? new Map(flows.items.map(f => [f.code, f])) : new Map()
  return items.map(item => ({ ...item, netAmount: matching.get(item.code)?.netAmount ?? null }))
}
