import test from 'node:test'
import assert from 'node:assert/strict'
import { teacherScore, strategyRows, strategyRanking } from './teacherStrategies.js'

const teachers=[{id:'a',name:'甲'},{id:'b',name:'乙'}]
const stocks=[{code:'001',name:'一',industry:'电子',agentScores:{甲:80,乙:40}},
  {code:'002',name:'二',industry:'银行',agentScores:{甲:60,乙:70}},
  {code:'003',name:'三',agentScores:{甲:0}}, {code:'004',name:'四',agentScores:{乙:90}}]
test('同一冻结评分支持单选、交集、并集，缺失分不按零分处理',()=>{
  assert.deepEqual(strategyRows(stocks,teachers,['a']).map(s=>s.code),['001','002'])
  assert.deepEqual(strategyRows(stocks,teachers,['a','b']).map(s=>s.code),['002'])
  const union=strategyRows(stocks,teachers,['a','b'],{match:'any'})
  assert.deepEqual(union.map(s=>s.code),['004','002','001'])
  assert.equal(union[0].selectedScored,1)
  assert.equal(teacherScore(stocks[2],'甲'),0)
  assert.equal(teacherScore(stocks[2],'乙'),null)
  assert.equal(teacherScore({agentScores:{甲:'NaN'}},'甲'),null)
  assert.deepEqual(strategyRows(stocks,teachers,['deleted']),[])
})
test('阈值、搜索与演示数据隔离',()=>{
  assert.equal(strategyRows(stocks,teachers,['a'],{threshold:75}).length,1)
  assert.equal(strategyRows(stocks,teachers,['a'],{query:'银行'})[0].code,'002')
  for(const meta of [{sourceMode:'fixtures',status:'ready'},{sourceMode:'live',status:'computing'}])
    assert.deepEqual(strategyRanking({meta,cycles:{波段:{ranking:stocks}}},'波段'),[])
  assert.equal(strategyRanking({meta:{sourceMode:'live',status:'ready'},cycles:{波段:{ranking:stocks}}},'波段'),stocks)
})
