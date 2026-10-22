// Formatting + stock hydration helpers ported from reference-react/src/App.jsx.

export function formatShanghaiTime(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatShanghaiDateTime(value, withSeconds = false) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })
}

export function displayField(value, fallback = '--') {
  return value == null || value === '' ? fallback : String(value)
}

// 成交额单位换算：value 为 Tushare 的 amount（单位＝千元）。
// unit === 'yuan' 时按元换算（÷1e8），否则按千元换算（÷1e5），结果统一为「亿」。
export function formatDailyAmount(value, unit) {
  const amount = Number(value)
  return Number.isFinite(amount)
    ? `${(amount / (unit === 'yuan' ? 100000000 : 100000)).toFixed(2)}亿`
    : '--'
}

export function hydrateStock(item) {
  const base = {}
  const liveRankedItem = Boolean(item?.code && item?.agentScores)
  const pct = Number(item?.pct ?? base.pct ?? 0)
  return {
    rank: item?.rank ?? base.rank ?? 0,
    change: item?.change || 0,
    name: item?.name || base.name || item?.code || '未知股票',
    code: item?.code || base.code || '',
    industry: item?.industry || base.industry || '行业待映射',
    price: Number(item?.close ?? item?.price ?? base.price ?? 0),
    pct,
    score: Number(item?.score ?? base.score ?? 0),
    confidence: Number(item?.confidence ?? base.confidence ?? 0),
    consensus: Number(item?.agentVotes ?? base.consensus ?? 0),
    status: item?.status || base.status || (Number(item?.score) >= 75 ? '可试仓' : '待信号'),
    valuation: item?.valuation || (liveRankedItem ? (Number(item?.peTtm) > 0 ? `PE(TTM) ${Number(item.peTtm).toFixed(1)}` : 'PE暂无有效值') : base.valuation || '按实时因子'),
    trend: item?.trend || (liveRankedItem ? (pct >= 0 ? '当日价格上涨' : '当日价格回撤') : base.trend || '等待数据'),
    risk: item?.risk || (liveRankedItem ? '高' : base.risk || '高'),
    // 引擎现在总会给出 reason，这里的兜底只服务于「有 agentScores 却没带 reason」的旧数据，
    // 因此不再写死 /12 —— 内置 12 位 mock 老师已从产品去掉，票数分母随实际老师数变化。
    reason: item?.reason || (liveRankedItem ? `${item.topAgents?.join('、') || '策略画像'}因子领先` : '等待真实因子快照'),
    trigger: item?.trigger || (Number.isFinite(Number(item?.triggerPrice)) ? `突破当日高点 ${Number(item.triggerPrice).toFixed(2)}` : liveRankedItem ? '暂无真实触发位' : base.trigger || '暂无真实触发位'),
    invalid: item?.invalid || (Number.isFinite(Number(item?.invalidPrice)) ? `跌破当日低点 ${Number(item.invalidPrice).toFixed(2)}` : liveRankedItem ? '暂无真实失效位' : base.invalid || '暂无真实失效位'),
    ...item,
  }
}

export function resolveWatchlistStocks(codes, liveStocks = [], details = {}) {
  return codes.map((code) => {
    const live = liveStocks.find((item) => item.code === code)
    const extra = details[code]
    if (live) {
      const base = hydrateStock(live)
      // 自选股里不在 TOP50 的标的，用 /api/stocks/enrich 同口径因子字段补全
      // （综合分 / 因子支持 / 状态 / 为什么入选 / 失效条件 / 行情日）。
      // 价/幅/名/行业仍以 live（实时行情，通常更新）为准，只补决策字段，不覆盖行情。
      if (!live.agentScores && extra?.agentScores) {
        const enriched = hydrateStock(extra)
        return {
          ...base,
          score: enriched.score,
          consensus: enriched.consensus,
          agentVotes: enriched.agentVotes,
          status: enriched.status,
          risk: enriched.risk,
          reason: enriched.reason,
          trigger: enriched.trigger,
          invalid: enriched.invalid,
          valuation: enriched.valuation,
          trend: enriched.trend,
          confidence: enriched.confidence,
          probabilityUp: enriched.probabilityUp,
          agentScores: enriched.agentScores,
          topAgents: enriched.topAgents,
          agentAverage: enriched.agentAverage,
          marketDataDate: extra.marketDataDate || base.marketDataDate,
          cycles: extra.cycles,
          watchlistDataAvailable: true,
          decisionAvailable: true,
        }
      }
      return { ...base, watchlistDataAvailable: true, decisionAvailable: Boolean(live.agentScores) }
    }
    if (extra?.agentScores) {
      const enriched = hydrateStock(extra)
      return {
        ...enriched,
        marketDataDate: extra.marketDataDate || enriched.marketDataDate,
        cycles: extra.cycles,
        watchlistDataAvailable: Boolean(enriched.close != null),
        decisionAvailable: true,
      }
    }
    return {
      code,
      name: extra?.name || code,
      industry: extra?.industry || '行情待刷新',
      watchlistDataAvailable: false,
      decisionAvailable: false,
    }
  })
}

// Build a flat live stock universe (TOP50 rankings + market quotes) used to
// resolve watchlist rows, mirroring reference-react watchlistLiveUniverse.
export function buildLiveUniverse(top50Snapshot, marketSnapshot) {
  const seen = new Map()
  for (const cycle of Object.values(top50Snapshot?.cycles || {})) {
    for (const item of cycle?.ranking || []) {
      if (item?.code) seen.set(item.code, item)
    }
  }
  for (const quote of marketSnapshot?.quotes || []) {
    if (!quote?.code || seen.has(quote.code)) continue
    const price = Number(quote.price ?? quote.close)
    const open = Number(quote.open)
    const preClose = Number(quote.preClose ?? quote.pre_close)
    // 涨跌幅口径对齐 reference-react ``watchlistLiveUniverse``：/api/market 的 quote
    // 只带 price/open/high/low，**没有 pct 字段**；直接用 changePct ?? pct 会得到
    // undefined，模板渲染成「%」前面空着。这里优先用接口自带涨跌幅，其次按
    // preClose（更准）→ open 现算，都没有才回 0。
    const rawPct = quote.changePct ?? quote.pct
    const hasRawPct =
      rawPct !== null && rawPct !== undefined && rawPct !== '' && Number.isFinite(Number(rawPct))
    let pct
    if (hasRawPct) pct = Number(rawPct)
    else if (preClose > 0 && Number.isFinite(price)) pct = Number(((price / preClose - 1) * 100).toFixed(2))
    else if (open > 0 && Number.isFinite(price)) pct = Number(((price / open - 1) * 100).toFixed(2))
    else pct = 0
    seen.set(quote.code, {
      code: quote.code,
      name: quote.name || quote.code,
      industry: quote.industry || quote.sector || '自选跟踪',
      close: Number.isFinite(price) ? price : quote.close,
      pct,
    })
  }
  return [...seen.values()]
}

export function changeClass(v) {
  return v >= 0 ? 'price-up' : 'price-down'
}

export function formatDurationMs(durationMs) {
  const value = Number(durationMs)
  if (!Number.isFinite(value) || value <= 0) return '--'
  const totalSeconds = Math.max(1, Math.round(value / 1000))
  if (totalSeconds < 60) return `${totalSeconds}秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`
}
