import test from 'node:test'
import assert from 'node:assert/strict'
import { boardRows, boardStats, industryGroups } from './marketBoard.js'

test('金额统一为元，缺失涨跌幅只允许用昨收计算', () => {
  const rows = boardRows([
    { code: '1', price: 11, preClose: 10, amount: 100, amountUnit: 'thousand_yuan' },
    { code: '2', price: 10, open: 5, amount: 100000, amountUnit: 'yuan' },
    { code: '3', price: 10, pctChg: 0, amount: null },
    { code: '4', price: null },
  ])
  assert.equal(rows.length, 3)
  assert.ok(Math.abs(rows[0].pct - 10) < 1e-10)
  assert.equal(rows[0].amountYuan, rows[1].amountYuan)
  assert.equal(rows[1].pct, null)
  assert.equal(rows[2].amountYuan, null)
  assert.equal(rows[2].pct, 0)
})

test('分布覆盖边界且不将缺失值计入平盘', () => {
  const rows = boardRows([-8, -7, -5, -3, -0.1, 0, 0.1, 3, 5, 7, 8, null].map((pctChg, i) => ({ code: `${i}`, price: 10, pctChg })))
  const s = boardStats(rows)
  assert.deepEqual(s.bins, [2, 1, 1, 1, 1, 1, 1, 1, 2])
  assert.equal(s.up + s.down + s.flat, s.valid)
  assert.equal(s.missing, 1)
  assert.equal(s.flat, 1)
  assert.equal(s.strong, 3)
  assert.equal(s.weak, 3)
  assert.equal(s.amount, null)
})

test('行业等权统计、重复代码、缺失行业和振幅校验', () => {
  const rows = boardRows([
    { code: '1', price: 10, pctChg: 99, industry: '银行' },
    { code: '1', price: 10, pctChg: 2, industry: '银行', preClose: 10, high: 11, low: 9 },
    { code: '2', price: 10, pctChg: -4, industry: '银行' },
    { code: '3', price: 10, pctChg: null, industry: '银行' },
    { code: '4', price: 10, pctChg: 50 },
  ])
  const groups = industryGroups(rows)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].amplitude, 20)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].pct, -1)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].leader.code, '1')
  assert.equal(boardStats([]).breadth, null)
  assert.equal(boardStats([]).average, null)
})
