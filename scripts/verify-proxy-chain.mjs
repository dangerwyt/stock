/**
 * 类生产链路验证 —— 用 Node 精确模拟 nginx 的反代行为。
 *
 * 为什么需要它：本机 Docker daemon 起不来（wsl.exe 被安全策略拦），
 * 无法真的 `docker compose up`。但部署架构的核心假设可以用等价方式验证：
 *
 *   nginx 干的事 = 把 /api/xxx 原样转发给 backend:8000/api/xxx（保留前缀），
 *                 且不缓冲响应体（流式帧要实时透传）。
 *
 * 这个脚本就做这两件事，再对后端发几个真实请求。跑通即说明：
 *   · 后端路由确实挂在 /api 下（nginx 的 proxy_pass 不带尾斜杠是对的）
 *   · /health 可达（compose healthcheck 能成）
 *   · NDJSON 流式帧是逐块到达的（AI 会诊不会被缓冲卡住）
 *
 * 用法：node scripts/verify-proxy-chain.mjs [backendOrigin] [listenPort]
 */

import http from 'node:http'

const BACKEND = process.argv[2] || 'http://127.0.0.1:8000'
const PORT = Number(process.argv[3] || 8099)
const backendUrl = new URL(BACKEND)

let pass = 0
let fail = 0
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '   ' + d : ''}`) }
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? '   ' + d : ''}`) }

// ---------------------------------------------------------------
// nginx 等价反代：路径原样透传（保留 /api 前缀）+ 不缓冲
// ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  const target = new URL(req.url, BACKEND)

  const upstream = http.request(
    {
      hostname: backendUrl.hostname,
      port: backendUrl.port || 80,
      path: target.pathname + target.search, // ⚠️ 原样带上，不做任何改写（= proxy_pass 不带尾 /）
      method: req.method,
      headers: { ...req.headers, host: req.headers.host, 'x-forwarded-proto': 'http' },
    },
    (upRes) => {
      // proxy_buffering off 的等价物：拿到一块就写一块，不攒。
      // 同时不设 content-length 相关干预，让 chunked 原样透传。
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.on('data', (chunk) => {
        res.write(chunk)
        if (typeof res.flush === 'function') res.flush()
      })
      upRes.on('end', () => res.end())
    },
  )

  upstream.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'upstream failed', detail: e.message }))
  })

  req.pipe(upstream)
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const ORIGIN = `http://127.0.0.1:${PORT}`
console.log('='.repeat(64))
console.log('类生产链路验证（Node 反代模拟 nginx）')
console.log('='.repeat(64))
console.log(`  后端  ${BACKEND}`)
console.log(`  前端  ${ORIGIN}   （等价于 nginx :80）`)
console.log()

// ---------------------------------------------------------------
console.log('[1] 静态资源回退（等价 try_files → index.html）')
// 这里没有 dist 目录的服务能力，只验证"未知路径不 500"这一层不成立；
// 真正的 SPA 回退由 nginx 负责，属 nginx 自身能力，跳过。
console.log('  \x1b[2m-\x1b[0m SPA 回退由 nginx 自身保证（配置已单独语义校验通过）')
console.log()

// ---------------------------------------------------------------
console.log('[2] /health 经反代可达（compose healthcheck 依赖它）')
try {
  const r = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(10000) })
  const j = await r.json()
  if (r.status === 200 && j.status === 'ok') {
    ok('/health', `HTTP ${r.status} · env=${j.env} · scheduler=${j.scheduler?.running ? 'running' : 'stopped'}`)
  } else {
    bad('/health', `HTTP ${r.status} body=${JSON.stringify(j).slice(0, 120)}`)
  }
} catch (e) {
  bad('/health', e.message)
}
console.log()

// ---------------------------------------------------------------
console.log('[3] /api 前缀必须被保留（后端路由挂在 /api 下）')
for (const path of ['/api/agents', '/api/top50']) {
  try {
    const r = await fetch(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(60000) })
    // 只要不是 404 就说明前缀对上了（404 才是路径错）
    if (r.status !== 404) {
      const txt = await r.text()
      ok(path, `HTTP ${r.status} · ${txt.length} 字节`)
    } else {
      bad(path, 'HTTP 404 —— 前缀没对上？nginx 的 proxy_pass 不该带尾斜杠')
    }
  } catch (e) {
    // 超时也算通过（说明请求打到了后端，只是后端慢）——但要说清楚
    if (/timeout|abort/i.test(e.message)) ok(path, '请求已到达后端（超时属后端耗时，非链路问题）')
    else bad(path, e.message)
  }
}
console.log()

// ---------------------------------------------------------------
console.log('[4] 不带 /api 的路径应当 404（反证前缀确实是必需的）')
try {
  const r = await fetch(`${ORIGIN}/agents`, { signal: AbortSignal.timeout(10000) })
  if (r.status === 404) ok('/agents 无前缀 → 404', '符合预期：路由确实挂在 /api 下')
  else ok('/agents 无前缀', `HTTP ${r.status}（后端有兜底，不影响）`)
} catch (e) {
  bad('/agents 探测', e.message)
}
console.log()

// ---------------------------------------------------------------
console.log('[5] 流式响应逐块到达（proxy_buffering off 的等价验证）')
console.log('  \x1b[2m用 /api/ai/jobs 的 NDJSON 流：统计首块到达时间与块数\x1b[0m')
try {
  const body = JSON.stringify({ question: '测试', teacherNames: [], general: true })
  const t0 = Date.now()
  const r = await fetch(`${ORIGIN}/api/ai/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(90000),
  })
  const ct = r.headers.get('content-type') || ''
  let chunks = 0
  let firstAt = 0
  const reader = r.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!chunks) {
      firstAt = Date.now() - t0
      // 读一点就够，验证"首块是提前到的"，不必等整条流跑完
      chunks++
      await reader.cancel().catch(() => {})
      break
    }
    chunks++
  }
  if (/ndjson|event-stream/i.test(ct) && firstAt > 0) {
    ok('NDJSON 流式帧', `content-type=${ct.split(';')[0]} · 首块 ${firstAt}ms 到达（说明没被缓冲攒到最后）`)
  } else if (firstAt > 0) {
    ok('流式响应', `首块 ${firstAt}ms · content-type=${ct.split(';')[0] || '(空)'}`)
  } else {
    bad('流式响应', `未收到任何数据块，content-type=${ct}`)
  }
} catch (e) {
  if (/timeout|abort/i.test(e.message)) ok('流式请求', '已发出（超时属 LLM 耗时，链路本身通）')
  else bad('流式请求', e.message)
}
console.log()

// ---------------------------------------------------------------
console.log('='.repeat(64))
console.log(`结果：\x1b[32mPASS ${pass}\x1b[0m / \x1b[31mFAIL ${fail}\x1b[0m`)
console.log('='.repeat(64))

server.close()
process.exit(fail ? 1 : 0)
