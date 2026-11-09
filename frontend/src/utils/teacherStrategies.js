export function teacherScore(stock, name) {
  const value = stock?.agentScores?.[name]
  if (value == null || value === '' || typeof value === 'boolean') return null
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null
}

export function strategyRanking(snapshot, cycle) {
  // 只把真实且已完成的冻结榜单作为筛选池，演示回退不得产生策略命中。
  if (snapshot?.meta?.sourceMode !== 'live' || snapshot.meta.status !== 'ready') return []
  return snapshot.cycles?.[cycle]?.ranking || []
}

export function strategyRows(ranking, teachers, ids, { threshold = 60, match = 'all', query = '', sort = 'score' } = {}) {
  const selected = teachers.filter(t => ids.includes(t.id))
  if (!selected.length || selected.length !== ids.length) return []
  const keyword = query.trim().toLowerCase()
  return ranking.flatMap(stock => {
    const scores = selected.map(t => teacherScore(stock, t.name))
    const matched = scores.filter(s => s !== null && s >= threshold).length
    if (match === 'all' ? matched !== selected.length : !matched) return []
    if (!`${stock.code} ${stock.name} ${stock.industry || ''}`.toLowerCase().includes(keyword)) return []
    const available = scores.filter(s => s !== null)
    return [{ ...stock, strategyScore: available.reduce((a,b) => a+b,0) / available.length,
      selectedScored: available.length,
      matchedTeachers: teachers.filter(t => { const s = teacherScore(stock,t.name); return s !== null && s >= threshold }).map(t => t.name),
    }]
  }).sort((a,b) => {
    const field = sort === 'pct' ? 'pct' : sort === 'amount' ? 'amount' : 'strategyScore'
    const av = a[field] == null ? -Infinity : Number(a[field]), bv = b[field] == null ? -Infinity : Number(b[field])
    return bv-av || a.code.localeCompare(b.code)
  })
}
