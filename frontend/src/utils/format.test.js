import test from 'node:test'
import assert from 'node:assert/strict'
import { findDecisionStock, hydrateStock } from './format.js'

test('股票弹窗保留来源周期，切换股票和无来源入口仍能匹配',()=>{
  const short={code:'300751',score:61}, swing={code:'300751',score:62}, next={code:'000001',score:70}
  assert.equal(findDecisionStock('300751',[swing,next],[short]),swing)
  assert.equal(findDecisionStock('000001',[swing,next],[short]),next)
  assert.equal(findDecisionStock('300751',null,[short]),short)
  assert.equal(findDecisionStock('missing',[swing],[short]),null)
})

test('新报价覆盖已解析股票的占位价，只有 price 的调用方保持兼容',()=>{
  const base=hydrateStock({code:'000001',score:null})
  assert.equal(hydrateStock({...base,close:11.81}).price,11.81)
  assert.equal(hydrateStock({code:'000001',price:12.5}).price,12.5)
  assert.equal(hydrateStock({...base,close:11.81}).score,null)
})
