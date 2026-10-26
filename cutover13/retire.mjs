// Retire a running orcad WITHOUT letting its process exit.
//
// orcad is the direct child of the container's docker-init, so its exit ends the container and
// SIGKILLs every PTY in it. This opens the Node inspector (SIGUSR1), neutralizes process.exit,
// then sends SIGTERM so orcad runs its own graceful stop (RPC server down, profile flush, daemon
// *disconnect*, lock + profile admission released). The process then idles as a namespace keeper
// and the terminal daemon it spawned keeps every session alive for the next orcad to adopt.
//
//   node retire.mjs <pid-in-this-pid-namespace> [inspector-port]
const pid = Number(process.argv[2])
const port = Number(process.argv[3] ?? 9229)
if (!Number.isInteger(pid) || pid <= 1) {
  console.error('usage: node retire.mjs <pid> [port]')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  process.kill(pid, 'SIGUSR1')
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (list[0]?.webSocketDebuggerUrl) return new WebSocket(list[0].webSocketDebuggerUrl)
    } catch {}
    await sleep(200)
  }
  throw new Error('inspector did not open')
}

const ws = await connect()
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function evaluate(expression) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  return new Promise((res) => pending.set(id, res)).then((msg) => {
    if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails))
    return msg.result?.result?.value
  })
}

const armed = await evaluate(`(() => {
  if (globalThis.__orcaRetire) return 'already-armed'
  const state = (globalThis.__orcaRetire = { exits: [], errors: [], armedAt: Date.now() })
  process.exit = function (code) {
    state.exits.push({ code: code ?? process.exitCode ?? 0, at: Date.now() })
    console.error('[orca-retire] process.exit(' + code + ') suppressed: staying alive as PID-namespace keeper')
  }
  process.on('uncaughtException', (e) => { state.errors.push(String(e?.stack ?? e)); console.error('[orca-retire] uncaught', e) })
  process.on('unhandledRejection', (e) => { state.errors.push(String(e?.stack ?? e)); console.error('[orca-retire] unhandled', e) })
  state.keepAlive = setInterval(() => {}, 3600e3)
  return 'armed'
})()`)
console.log('arm:', armed)
const check = await evaluate(`process.exit.toString().includes('orca-retire')`)
if (!check) throw new Error('process.exit patch did not take; NOT sending SIGTERM')

await evaluate(`(process.kill(process.pid, 'SIGTERM'), 'sigterm-sent')`)
console.log('SIGTERM sent; waiting for graceful stop')
let state
for (let i = 0; i < 120; i++) {
  await sleep(500)
  state = await evaluate(`JSON.stringify({ exits: globalThis.__orcaRetire.exits, errors: globalThis.__orcaRetire.errors })`)
  if (JSON.parse(state).exits.length) break
}
console.log('state:', state)
// Close the inspector so nothing local can attach later. Closing it drops this very socket, so
// the reply never arrives; give it a moment, then verify from outside that 9229 stopped listening.
evaluate(`process.mainModule.require('node:inspector').close()`).catch(() => {})
await sleep(1500)
const stillOpen = await fetch(`http://127.0.0.1:${port}/json/list`).then(() => true, () => false)
console.log(stillOpen ? 'WARNING: inspector still listening' : 'inspector closed')
process.exit(JSON.parse(state).exits[0]?.code === 0 ? 0 : 1)
