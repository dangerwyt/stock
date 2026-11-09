export function numberOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function boardRows(quotes = []) {
  const rows = new Map()
  for (const quote of quotes) {
    const price = numberOrNull(quote.price)
    if (!quote.code || price == null || price <= 0) continue
    const preClose = numberOrNull(quote.preClose)
    const high = numberOrNull(quote.high)
    const low = numberOrNull(quote.low)
    const rawAmount = numberOrNull(quote.amount)
    rows.set(quote.code, {
      ...quote, price, high, low, open: numberOrNull(quote.open),
      pct: numberOrNull(quote.pctChg) ?? (preClose > 0 ? (price / preClose - 1) * 100 : null),
      amountYuan: rawAmount != null && rawAmount >= 0
        ? rawAmount * (quote.amountUnit === 'yuan' ? 1 : 1000) : null,
      amplitude: preClose > 0 && high != null && low != null && high >= low
        ? (high - low) / preClose * 100 : null,
      industry: quote.industry || '行业未分类',
    })
  }
  return [...rows.values()]
}

export function boardStats(rows) {
  const valid = rows.filter(row => row.pct != null)
  const amounts = rows.filter(row => row.amountYuan != null)
  const up = valid.filter(row => row.pct > 0).length
  const down = valid.filter(row => row.pct < 0).length
  const strong = valid.filter(row => row.pct >= 5).length
  const weak = valid.filter(row => row.pct <= -5).length
  const bins = Array(9).fill(0)
  for (const { pct } of valid) {
    const index = pct <= -7 ? 0 : pct <= -5 ? 1 : pct <= -3 ? 2 : pct < 0 ? 3
      : pct === 0 ? 4 : pct < 3 ? 5 : pct < 5 ? 6 : pct < 7 ? 7 : 8
    bins[index]++
  }
  return {
    total: rows.length, valid: valid.length, missing: rows.length - valid.length,
    up, down, flat: valid.length - up - down, strong, weak, bins,
    breadth: valid.length ? up / valid.length * 100 : null,
    average: valid.length ? valid.reduce((sum, row) => sum + row.pct, 0) / valid.length : null,
    amount: amounts.length ? amounts.reduce((sum, row) => sum + row.amountYuan, 0) : null,
    amountCount: amounts.length,
  }
}

export function industryGroups(rows) {
  const groups = new Map()
  for (const row of rows) {
    if (row.pct == null || row.industry === '行业未分类') continue
    if (!groups.has(row.industry)) groups.set(row.industry, [])
    groups.get(row.industry).push(row)
  }
  return [...groups].map(([name, stocks]) => ({
    name, count: stocks.length,
    pct: stocks.reduce((sum, row) => sum + row.pct, 0) / stocks.length,
    leader: stocks.reduce((best, row) => row.pct > best.pct ? row : best),
  })).sort((a, b) => b.pct - a.pct)
}
