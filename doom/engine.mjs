// The Doom engine, on a worker thread of server.mjs: doom.wasm run at its own 35 tics a second,
// its picture copied into shared memory each time it draws, the keys the server hands over held
// and let go. On its own thread because the engine blocks while it draws a screen melt, and the
// server must keep answering meanwhile.
import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'

const { wasm, frames, state, size } = workerData
// two copies of the screen: the engine writes the one the server is not reading, then points at it
const copies = [new Uint8Array(frames, 0, size), new Uint8Array(frames, size, size)]
// [0] which copy is the latest, [1] how many screens have been drawn
const shared = new Int32Array(state)

// the engine's clock: real time, less the time spent paused, so a pause freezes the game
const started = performance.now()
let paused = false
let pausedAt = 0
let frozen = 0
const clock = () => (paused ? pausedAt : performance.now()) - started - frozen
function setPaused(next) {
  if (next === paused) return
  if (next) pausedAt = performance.now()
  else frozen += performance.now() - pausedAt
  paused = next
}

const memory = new WebAssembly.Memory({ initial: 108 })
const noop = () => {}
const { instance } = await WebAssembly.instantiate(await readFile(wasm), {
  js: {
    js_console_log: noop, js_stdout: noop, js_stderr: noop,
    js_milliseconds_since_start: clock,
    js_draw_screen: ptr => {
      const next = 1 - Atomics.load(shared, 0)
      copies[next].set(new Uint8Array(memory.buffer, ptr, size))
      Atomics.store(shared, 0, next)
      Atomics.add(shared, 1, 1)
    },
  },
  env: { memory },
})
const doom = instance.exports
doom.main()
setInterval(() => { if (!paused) doom.doom_loop_step() }, 4)

// a press holds the key until `hold` ms pass without another press of it
const held = new Map()
function press(code, hold) {
  const timer = held.get(code)
  if (timer) clearTimeout(timer)
  else doom.add_browser_event(0, code)
  held.set(code, setTimeout(() => { held.delete(code); doom.add_browser_event(1, code) }, hold))
}

parentPort.on('message', m => {
  if (typeof m.paused === 'boolean') setPaused(m.paused)
  for (const k of m.keys ?? []) press(k.code, k.hold)
})
