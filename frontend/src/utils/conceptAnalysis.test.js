import test from 'node:test'
import assert from 'node:assert/strict'
import { compareConcepts, mergeConceptFlows } from './conceptAnalysis.js'
test('不同上市日期按共同起点比较，缺失日保留断点', () => {
  const result = compareConcepts([
    {code:'a',name:'A',points:[{date:'01',close:50},{date:'02',close:100},{date:'03',close:110},{date:'04',close:120}]},
    {code:'b',name:'B',points:[{date:'02',close:200},{date:'04',close:180}]},
  ])
  assert.equal(result.start,'02')
  assert.deepEqual(result.dates,['02','03','04'])
  assert.equal(result.series[0].values[0],0)
  assert.equal(result.series[1].values[1],null)
  assert.ok(Math.abs(result.series[1].values[2]+10)<1e-10)
  assert.equal(compareConcepts([{points:[{date:'02',close:1}]}]).series.length,0)
})
test('资金流按同日同代码连接，零值有效，跨日不混用', () => {
  const items=[{code:'a',pct:0},{code:'b',pct:-1}]
  const flows={tradeDate:'2026-11-05',items:[{code:'a',netAmount:0},{code:'c',netAmount:500}]}
  assert.equal(mergeConceptFlows(items,flows,'2026-11-05')[0].netAmount,0)
  assert.equal(mergeConceptFlows(items,flows,'2026-11-05')[1].netAmount,null)
  assert.equal(mergeConceptFlows(items,flows,'2026-11-06')[0].netAmount,null)
})
