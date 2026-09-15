// Real Doom for the arcade. This is the original engine, id Software's linuxdoom-1.10, as
// diekmann's port of it to WebAssembly with the shareware WAD inside (doom.wasm, next to this
// file), run headless by engine.mjs on a worker thread of this process. Plain JavaScript on node's
// modules, so it runs under Bun or Node, whichever the plugin finds; it needs nothing else. An
// HTTP door on the loopback interface is how the plugin reaches it: POST /step hands over the keys
// pressed and answers the picture, scaled to the size asked for. Terminals report no key releases,
// so each press holds its key a moment and lets go unless it repeats. Nothing here talks to
// anything but localhost.
//
// With no request for a second and a half the game pauses (its clock stops, so nothing catches up
// when you come back); with none for half an hour the server quits.

import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const PORT = Number(process.env.CC_ARCADE_DOOM_PORT ?? 47321)
const HERE = dirname(fileURLToPath(import.meta.url))
// what the engine draws: 320×200 doubled, four bytes a pixel
const SCREEN_W = 640
const SCREEN_H = 400
const SIZE = SCREEN_W * SCREEN_H * 4
const PAUSE_AFTER_MS = 1500
const QUIT_AFTER_MS = 30 * 60_000
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// the engine's picture is dark on a terminal's black; this lifts the shadows a little (its own F11
// lifts them more, in steps). CC_ARCADE_DOOM_GAMMA=1 leaves it as drawn, 1.5 lifts it a lot.
const GAMMA = Number(process.env.CC_ARCADE_DOOM_GAMMA) || 1.2
const LIFT = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (v / 255) ** (1 / GAMMA)))
// a picture that encodes longer than this is sent with fewer bits a channel, which makes its runs
// longer, and smaller if that is not enough: a bound on what one request can cost
const PAYLOAD_LIMIT = 500_000

const frames = new SharedArrayBuffer(2 * SIZE)
const state = new SharedArrayBuffer(8)
const shared = new Int32Array(state)
const engine = new Worker(new URL('./engine.mjs', import.meta.url), { workerData: { wasm: process.env.CC_ARCADE_DOOM_WASM || join(HERE, 'doom.wasm'), frames, state, size: SIZE } })
engine.on('error', err => { console.error(`cc-arcade doom: the engine failed: ${err?.stack ?? err}`); process.exit(1) })
engine.on('exit', code => { console.error(`cc-arcade doom: the engine stopped (${code})`); process.exit(1) })
const drawn = () => Atomics.load(shared, 1)

// the latest screen scaled to w × h pixels, a row per string: runs of one colour, four characters
// each, the colour as 18 bits (6 a channel) in three base64 digits and the run's length less one
// in the fourth
function picture(w, h, bits = 6) {
  const src = new Uint8Array(frames, Atomics.load(shared, 0) * SIZE, SIZE)
  const keep = 63 & ~((1 << (6 - bits)) - 1)
  const rows = []
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * SCREEN_H) / h), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * SCREEN_H) / h))
    const ys = Math.max(1, Math.floor((y1 - y0) / 3))
    let out = ''
    let last = -1
    let run = 0
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor((tx * SCREEN_W) / w), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * SCREEN_W) / w))
      const xs = Math.max(1, Math.floor((x1 - x0) / 3))
      let r = 0, g = 0, b = 0, n = 0
      for (let y = y0; y < y1; y += ys) {
        for (let x = x0; x < x1; x += xs) {
          const i = (y * SCREEN_W + x) * 4
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++
        }
      }
      const c = (((LIFT[Math.round(r / n)] >> 2) & keep) << 12) | (((LIFT[Math.round(g / n)] >> 2) & keep) << 6) | ((LIFT[Math.round(b / n)] >> 2) & keep)
      if (c === last && run < 64) run++
      else {
        if (run) out += B64[last >> 12] + B64[(last >> 6) & 63] + B64[last & 63] + B64[run - 1]
        last = c
        run = 1
      }
    }
    out += B64[last >> 12] + B64[(last >> 6) & 63] + B64[last & 63] + B64[run - 1]
    rows.push(out)
  }
  if (rows.reduce((n, row) => n + row.length, 0) <= PAYLOAD_LIMIT) return { rows, w, h }
  // fewer bits first; a picture too big even at four a channel is sent smaller than asked for
  return bits > 4 ? picture(w, h, bits - 1) : picture(Math.floor(w * 0.8), Math.floor(h * 0.8))
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(n) || lo)))
let paused = false
let lastStep = performance.now()
let lastRequest = performance.now()
const setPaused = next => {
  if (next === paused) return
  paused = next
  engine.postMessage({ paused })
}

const server = createServer(async (req, res) => {
  lastRequest = performance.now()
  const reply = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/ping') return reply(200, { ok: true, ready: drawn() > 0, drawn: drawn() })
  if (url.pathname === '/quit') {
    setTimeout(() => process.exit(0), 10)
    return reply(200, { ok: true })
  }
  if (url.pathname !== '/step' || req.method !== 'POST') return reply(404, { error: 'not found' })
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body = {}
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { body = {} }
  lastStep = performance.now()
  setPaused(body.paused === true)
  const keys = (Array.isArray(body.keys) ? body.keys : [])
    .map(k => ({ code: clamp(k?.code, 0, 255), hold: clamp(k?.hold ?? 120, 20, 2000) }))
    .filter(k => k.code)
  if (keys.length) engine.postMessage({ keys })
  const mode = typeof body.mode === 'string' ? body.mode : 'half'
  // the size sent is smaller than asked for when the picture had to shrink to fit
  const shot = drawn() ? picture(clamp(body.w, 8, SCREEN_W), clamp(body.h, 4, SCREEN_H)) : { rows: [], w: 0, h: 0 }
  reply(200, { ...shot, drawn: drawn(), mode, paused })
})
server.on('error', err => {
  // one is running already, likely from another session; it serves this one too
  console.error(`cc-arcade doom: cannot listen on ${PORT}: ${err.message}`)
  process.exit(0)
})
server.listen(PORT, '127.0.0.1', () => console.log(`cc-arcade doom: listening on http://127.0.0.1:${PORT}`))

setInterval(() => {
  const now = performance.now()
  if (now - lastRequest > QUIT_AFTER_MS) process.exit(0)
  if (!paused && now - lastStep > PAUSE_AFTER_MS) setPaused(true)
}, 500)
