import axios from 'axios'

// Single axios instance. In dev, /api is proxied to the FastAPI backend (:8000).
export const http = axios.create({ baseURL: '/', timeout: 20000 })

// JSON snapshot fetch with the same merge/timeout semantics as the React prototype.
const cache = new Map()

export async function fetchSnapshot(url, { timeout = 20000 } = {}) {
  const cached = cache.get(url)
  if (cached && (cached.pending || Date.now() - cached.at < 1000)) return cached.promise
  const entry = { pending: true, at: Date.now() }
  entry.promise = http
    .get(url, { params: { _t: Date.now() }, timeout })
    .then((r) => r.data)
    .finally(() => {
      entry.pending = false
      entry.at = Date.now()
    })
  cache.set(url, entry)
  return entry.promise
}

// Read an NDJSON streaming AI job. Resolves with { accepted, reader } where
// reader yields parsed JSON frames (mirrors reference-react ai-job-connection).
export async function startAiJob(payload) {
  const resp = await fetch('/api/ai/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!resp.headers.get('content-type')?.includes('application/x-ndjson')) {
    return { accepted: await resp.json(), reader: null }
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (!buffer.includes('\n')) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('会诊连接在任务确认前中断，请重试。')
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  const nl = buffer.indexOf('\n')
  const accepted = JSON.parse(buffer.slice(0, nl))
  // Keep any frames that arrived in the same chunk as the accepted line.
  return { accepted, reader, leftover: buffer.slice(nl + 1) }
}

export async function readNdjsonFrame(reader, decoder = new TextDecoder(), initial = '') {
  let buffer = initial
  while (true) {
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) return JSON.parse(line)
    }
    const chunk = await reader.read()
    if (chunk.done) return null
    buffer += decoder.decode(chunk.value, { stream: true })
  }
}

export default http
