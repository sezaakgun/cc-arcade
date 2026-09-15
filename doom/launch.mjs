// Starts the Doom server (server.mjs) in the background with the same runtime this runs under, and
// returns at once, so the plugin's `$.process.run`, which waits for its command to exit, comes
// back while the game keeps running. Its output goes nowhere; run server.mjs by hand to see it.
//
// The engine, doom.wasm, is not in the repository: it is id Software's Doom under the GPL with the
// shareware WAD inside, built by diekmann. The first start fetches his build (6.8 MB) and keeps it
// here, checked against its SHA-256. CC_ARCADE_DOOM_WASM names another file to use instead.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.CC_ARCADE_DOOM_WASM || join(HERE, 'doom.wasm')
const SOURCE = 'https://diekmann.github.io/wasm-fizzbuzz/doom/doom.wasm'
const SHA256 = '568bb18489f9071957f133d7d12ed6d753dfd27a62733442fd80261a217df3f1'

const exists = path => access(path).then(() => true, () => false)

if (!(await exists(WASM))) {
  console.log(`cc-arcade doom: fetching the engine from ${SOURCE}`)
  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`fetching doom.wasm: ${res.status} ${res.statusText}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const sum = createHash('sha256').update(bytes).digest('hex')
  if (sum !== SHA256) throw new Error(`doom.wasm from ${SOURCE} is not the build expected (sha256 ${sum})`)
  await writeFile(`${WASM}.part`, bytes)
  await rename(`${WASM}.part`, WASM)
  console.log(`cc-arcade doom: kept the engine at ${WASM} (${bytes.length} bytes)`)
}

const child = spawn(process.execPath, [join(HERE, 'server.mjs')], { detached: true, stdio: 'ignore', env: { ...process.env, CC_ARCADE_DOOM_WASM: WASM } })
child.unref()
console.log(`cc-arcade doom: started pid ${child.pid} with ${process.execPath}`)
