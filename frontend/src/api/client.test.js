import test from 'node:test'
import assert from 'node:assert/strict'
import { http, fetchSnapshot } from './client.js'

test('报价临时失败只重试一次，并让并发读者共享请求；账户错误不重试', async () => {
  const original = http.get
  let calls = 0
  try {
    http.get = async () => {
      if (++calls === 1) throw {response:{status:503,data:{retryable:true}}}
      return {data:{status:'ready'}}
    }
    const [a,b] = await Promise.all([fetchSnapshot('/test/recovery',{retry:true}),fetchSnapshot('/test/recovery',{retry:true})])
    assert.equal(calls,2); assert.deepEqual(a,b); assert.equal(a.status,'ready')
    calls=0
    http.get = async () => { calls++; throw {response:{status:503,data:{retryable:false,errorCode:'provider_notice_required'}}} }
    await assert.rejects(fetchSnapshot('/test/notice',{retry:true}))
    assert.equal(calls,1)
    calls=0
    http.get = async () => { calls++; throw {code:'ERR_NETWORK'} }
    await assert.rejects(fetchSnapshot('/test/still-down',{retry:true}))
    assert.equal(calls,2)
    calls=0
    await assert.rejects(fetchSnapshot('/test/no-retry'))
    assert.equal(calls,1)
  } finally { http.get=original }
})
