// Minimal CDP driver: click the "新建角色" button and dump the dialog DOM.
// Reusable for verifying anything that only renders after interaction.
const PORT = process.env.CDP_PORT || 9222
const CLICK = process.env.CLICK_SELECTOR || '.thread-head button'
const READ = process.env.READ_SELECTOR || '.role-create-dialog'

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text)
  return res.result?.result?.value
}

if (process.env.EXPR) {
  console.log(await evaluate(process.env.EXPR))
  process.exit(0)
}

const before = await evaluate(`Boolean(document.querySelector(${JSON.stringify(READ)}))`)
const clicked = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(CLICK)}); if (!el) return false; el.click(); return true })()`)
await new Promise((r) => setTimeout(r, 600))
const html = await evaluate(`document.querySelector(${JSON.stringify(READ)})?.outerHTML || ''`)

console.log('dialog before click:', before)
console.log('click dispatched    :', clicked)
console.log('dialog after click  :', Boolean(html))
console.log('--- dialog markup ---')
console.log(html.replace(/></g, '>\n<'))

if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log('screenshot ->', process.env.SHOT)
}
process.exit(0)
