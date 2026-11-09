export const number = value => value == null || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Number(value)

export function watchlistRows(codes, snapshot, quotes) {
  const ranked = new Map()
  if (snapshot?.meta?.sourceMode === 'live' && snapshot.meta.status === 'ready') {
    for (const cycle of Object.values(snapshot.cycles || {})) {
      for (const stock of cycle.ranking || []) ranked.set(stock.code, stock)
    }
  }
  return codes.map(code => {
    const frozen = ranked.get(code)
    const quote = quotes[code]
    const frozenDate = frozen?.marketDataDate || snapshot?.meta?.marketDataDate
    const quoteValid = number(quote?.close) > 0 && quote?.tradeDate
    const frozenValid = number(frozen?.close) > 0 && frozenDate
    const useQuote = quoteValid && (!frozenValid || quote.tradeDate.replaceAll('-', '') >= frozenDate.replaceAll('-', ''))
    const source = useQuote ? quote : frozenValid ? frozen : {}
    const history = (quote?.history || []).filter(r => /^\d{8}$/.test(r.date) && ['open','close','high','low'].every(k => number(r[k]) > 0) && r.low <= Math.min(r.open,r.close) && r.high >= Math.max(r.open,r.close)).sort((a,b) => a.date.localeCompare(b.date))
    return { code, name: quote?.name || frozen?.name || code, industry: quote?.industry || frozen?.industry || '--',
      ...Object.fromEntries(['close','pct','amount','volumeRatio','turnoverRate','amplitude'].map(k => [k,number(source[k])])),
      date: useQuote ? quote.tradeDate : frozenValid ? frozenDate : '', frozen: !useQuote && Boolean(frozenValid),
      history, historyDate: history.at(-1)?.date || '',
      change20: history.length === 21 ? (history.at(-1).close/history[0].close-1)*100 : null }
  })
}

export function filterWatchlist(rows, query, direction, sort) {
  const q = query.trim().toLowerCase()
  return rows.filter(r => `${r.name} ${r.code} ${r.industry}`.toLowerCase().includes(q) && (direction === 'all' || (direction === 'up' ? r.pct > 0 : r.pct < 0)))
    .sort((a,b) => sort === 'default' ? 0 : (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity))
}

export function candleOptions(history) {
  return { animation:false, grid:{left:2,right:2,top:6,bottom:4},
    tooltip:{trigger:'axis',confine:true}, xAxis:{type:'category',data:history.slice(-20).map(r=>r.date),show:false},
    yAxis:{scale:true,show:false}, series:[{type:'candlestick',data:history.slice(-20).map(r=>[r.open,r.close,r.low,r.high]),
      itemStyle:{color:'#f05267',color0:'#00a58e',borderColor:'#f05267',borderColor0:'#00a58e'}}] }
}
