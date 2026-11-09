import test from 'node:test'
import assert from 'node:assert/strict'
import { watchlistRows, filterWatchlist, candleOptions } from './watchlistBoard.js'

test('只展示自选；真实报价优先，旧报价不能覆盖新快照，缺失和零不混淆', () => {
  const snap={meta:{sourceMode:'live',status:'ready',marketDataDate:'2026-11-05'},cycles:{波段:{ranking:[{code:'000001',name:'平安银行',close:11,pct:2},{code:'000002',close:12,pct:-1}]}}}
  const q={'000001':{name:'平安银行',close:10,pct:0,tradeDate:'20261106',amount:0},'000002':{close:9,tradeDate:'20261104'}}
  const rows=watchlistRows(['000002','000001','000003'],snap,q)
  assert.deepEqual(rows.map(r=>r.code),['000002','000001','000003'])
  assert.equal(rows[0].close,12); assert.equal(rows[0].frozen,true)
  assert.equal(rows[1].close,10); assert.equal(rows[1].pct,0); assert.equal(rows[1].amount,0)
  assert.equal(rows[2].close,null); assert.equal(rows[2].pct,null)
  assert.equal(filterWatchlist(rows,'','down','default').length,1)
  assert.equal(filterWatchlist(rows,'平安','all','default')[0].code,'000001')
  assert.equal(filterWatchlist(rows,'','all','close').at(-1).code,'000003')
  assert.equal(watchlistRows(['000001'],{...snap,meta:{sourceMode:'demo',status:'ready'}},{})[0].close,null)
})

test('日 K 与20日涨幅使用有效日线，历史不足时不伪造收益', () => {
  const history=Array.from({length:21},(_,i)=>({date:`202610${String(i+1).padStart(2,'0')}`,open:10,close:10+i,low:9,high:31}))
  const rows=watchlistRows(['000001'],null,{'000001':{history:[...history].reverse()}})
  assert.equal(rows[0].change20,200)
  assert.equal(candleOptions(rows[0].history).series[0].data.length,20)
  history[0].close=null
  assert.equal(watchlistRows(['000001'],null,{'000001':{history}})[0].change20,null)
})
