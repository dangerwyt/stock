import test from 'node:test'
import assert from 'node:assert/strict'
import { readBacktest, writeBacktest } from './backtestStorage.js'

const defaults = { stockCode: '', strategyId: 'ma', initialCapital: 100000 }
const result = { stock: { code: '000001', name: '测试' }, strategy: '均线趋势', startDate: '2026-01-01', endDate: '2026-01-02',
  equityCurve: [{ date: '2026-01-02', strategy: 1, benchmark: 1, equity: 100000, cash: 100000, marketValue: 0, positionPct: 0, drawdown: 0 }], trades: [] }
const snapshot = { form: { ...defaults, stockCode: '000001' }, result, lastSignature: 'old-parameters', ranAt: '2026-11-06T06:00:00Z' }
const memory = () => { let value; return { getItem: () => value, setItem: (key, data) => { value = data } } }

test('刷新恢复最后成功结果和修改后参数，并保留旧结果签名', () => {
  const storage = memory()
  assert.equal(writeBacktest(snapshot, storage), true)
  assert.deepEqual(readBacktest(defaults, storage), snapshot)
  writeBacktest({ ...snapshot, form: { ...snapshot.form, initialCapital: 50000 } }, storage)
  const restored = readBacktest(defaults, storage)
  assert.equal(restored.form.initialCapital, 50000)
  assert.equal(restored.lastSignature, 'old-parameters')
  assert.deepEqual(restored.result, result)
})

test('损坏或旧版本缓存不崩溃，损坏结果不冒充成功', () => {
  const storage = memory()
  storage.setItem('', '{bad')
  assert.equal(readBacktest(defaults, storage), null)
  storage.setItem('', JSON.stringify({ ...snapshot, version: 0 }))
  assert.equal(readBacktest(defaults, storage), null)
  writeBacktest({ ...snapshot, form: { stockCode: null, initialCapital: 'oops' }, result: { ...result, equityCurve: [null] } }, storage)
  assert.deepEqual(readBacktest(defaults, storage), { form: defaults, result: null, lastSignature: '', ranAt: '' })
})

test('禁用存储或空间用尽时返回失败，运行结果仍由页面保留', () => {
  const storage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  assert.equal(readBacktest(defaults, storage), null)
  assert.equal(writeBacktest(snapshot, storage), false)
})
