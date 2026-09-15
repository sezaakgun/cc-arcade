/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'
import { pickAuto, pickRandom, type AutoContext } from './games/auto.ts'
import { isBetter } from './games/best.ts'
import { MODES, SHAPE, SPAN_BUDGET, type Key, type Mode } from './games/doom.ts'
import { feed, level, newPet, petEvent, stage, type Pet } from './games/pet.ts'

// One command, /arcade. With no argument it shows a picker above the prompt; `/arcade <game>` starts
// a game, `random` picks one, `auto` picks one for the moment, `list` prints them, `stop` closes.
// Each board in ./boards is a surface module that runs on the drawing thread; this module mounts the
// board, keeps each game's best score in $.store, pauses the open game when Claude finishes a turn,
// and feeds the pet from Claude's tool calls.

type Game = { title: string; blurb: string; lowerIsBetter?: boolean; unit?: string }

const GAMES: Record<string, Game> = {
  snake: { title: 'Snake', blurb: 'eat, grow, and keep off the walls and yourself' },
  tetris: { title: 'Tetris', blurb: 'fit the falling pieces and clear lines' },
  '2048': { title: '2048', blurb: 'slide and merge tiles up to 2048' },
  minesweeper: { title: 'Minesweeper', blurb: 'open every cell that is not a mine', lowerIsBetter: true, unit: 's' },
  flappy: { title: 'Flappy', blurb: 'flap through the gaps in the pipes' },
  pong: { title: 'Pong', blurb: 'first to 5 against the computer' },
  typing: { title: 'Typing test', blurb: 'retype a line of code as fast as you can', unit: ' wpm' },
  invaders: { title: 'Space Invaders', blurb: 'shoot each wave before it lands' },
  doom: { title: 'Doom', blurb: 'the 1993 original, run for real (needs bun)' },
  pet: { title: 'Pet', blurb: 'grows as Claude tests, commits and edits' },
}
// spelled out: Object.keys would put the integer-like '2048' first
const NAMES = ['snake', 'tetris', '2048', 'minesweeper', 'flappy', 'pong', 'typing', 'invaders', 'doom', 'pet']
// random never lands on the pet: it is not a game you play
const PLAYABLE = NAMES.filter(n => n !== 'pet')
const PICKER = 'picker'
const isGame = (name: unknown): name is string => typeof name === 'string' && Object.hasOwn(GAMES, name)

// a game name, PICKER, or nothing open
let active: string | undefined
let lastGame: string | undefined
let turnStartedAt: number | undefined
// bumped at each finished turn; the open game pauses when it sees a new value
let turnsDone = 0
const best: Record<string, number> = {}
let pet: Pet | undefined

// Doom is the original engine in a process of its own, doom/server.mjs, reached over localhost.
// This module runs the game: while the board is open, ten times a second (as often as a band may
// redraw) it sends the keys the strips posted, fetches the picture and redraws the band, handing
// each strip of the picture its rows. The picture is drawn in strips, each a Client of its own,
// since a board may draw only so much at once; a strip is small enough never to have to merge
// colours. The pause, the idle pause and the drawing mode live here, so every strip agrees.
const DOOM_URL = 'http://127.0.0.1:47321'
const DOOM_IDLE_MS = 10_000
// the picture's height in rows to start with, and the least; ] and [ change it four at a time.
// Every cell is drawn again ten times a second, so bigger is slower
const DOOM_ROWS = 32
const DOOM_MIN_ROWS = 12
const DOOM_STEP = 4
type DoomFrame = { rows?: string[]; w?: number; h?: number; mode?: string }
type DoomLayout = { cols: number; rows: number; perStrip: number; strips: number }
const doom = {
  mode: MODES[0] as Mode,
  size: DOOM_ROWS,
  playing: true,
  idle: false,
  banner: false,
  lastKeyAt: 0,
  keys: [] as Key[],
  // the last press number seen from each strip
  seen: {} as Record<number, number>,
  frame: undefined as DoomFrame | undefined,
  // the last answer as text and the status line as drawn, to know when nothing changed
  drawnText: '',
  statusText: '',
  fetchedAt: 0,
  fetching: undefined as Promise<void> | undefined,
  starting: false,
  error: undefined as string | undefined,
  layout: undefined as DoomLayout | undefined,
  timer: undefined as { cancel: () => void } | undefined,
}
const isMode = (m: unknown): m is Mode => typeof m === 'string' && Object.hasOwn(SHAPE, m)
const nextMode = () => MODES[(MODES.indexOf(doom.mode) + 1) % MODES.length]

// the picture less the buttons, the border and the status line, 1.6 times as wide as tall like
// the engine's 640×400 (a cell is twice as tall as wide), cut into strips of at most SPAN_BUDGET
// cells, so a strip draws every colour it is given
function doomLayout(cols: number, maxRows: number): DoomLayout {
  const most = Math.max(4, maxRows - 5)
  const rows = Math.min(most, Math.max(Math.min(DOOM_MIN_ROWS, most), doom.size))
  const c = Math.max(16, Math.min(cols - 2, Math.round(rows * 3.2)))
  const perStrip = Math.max(1, Math.floor(SPAN_BUDGET / c))
  return { cols: c, rows, perStrip, strips: Math.ceil(rows / perStrip) }
}

const doomStatus = () => doom.error ? `doom · ${doom.error}`
  : !doom.frame ? 'doom · starting the game (the first time fetches the engine, 7 MB)…'
  : !doom.playing ? `doom · paused${doom.idle ? ' while you were away' : ''} · click the picture, then any key resumes`
  : `doom · click the picture, then ←→↑↓ move · a d strafe · space fires · e opens · enter menu · bksp esc · tab map · h ${nextMode()} · [ ] size · p pause`

// one step: the keys out, the picture in, the band redrawn; calls while one runs share it
function doomRefresh($: EngineInterface): Promise<void> {
  if (doom.fetching) return doom.fetching
  doom.fetching = (async () => {
    try {
      const layout = doom.layout
      if (!layout) return
      // elapsed time on this environment's own monotonic clock
      const now = performance.now()
      if (doom.playing && now - doom.lastKeyAt > DOOM_IDLE_MS) {
        doom.idle = true
        doom.playing = false
        $.ui.log('cc-arcade: doom paused, no key for ten seconds')
      }
      const { cw, ch } = SHAPE[doom.mode]
      const keys = doom.keys
      doom.keys = []
      const body = JSON.stringify({ w: layout.cols * cw, h: layout.rows * ch, mode: doom.mode, keys, paused: !doom.playing })
      const res = await $.http.fetch(`${DOOM_URL}/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => undefined)
      const before = doom.drawnText
      if (res?.ok) {
        try {
          doom.frame = JSON.parse(res.text) as DoomFrame
          doom.error = undefined
          doom.drawnText = res.text
        } catch { doom.error = 'the game server answered nonsense' }
      } else if (!doom.starting) {
        doom.frame = undefined
        doom.error = res ? `the game server answered ${res.status}` : 'the game server is not running · /arcade doom starts it again'
      }
      doom.fetchedAt = performance.now()
      // a redraw costs the whole screen a redraw: none while the picture stands still
      if (doom.drawnText !== before || doom.error || doom.statusText !== doomStatus()) $.ui.invalidate('ui.render')
    } finally {
      doom.fetching = undefined
    }
  })()
  return doom.fetching
}

// the game runs while its board is open: the loop starts when the board opens and stops when it
// closes, and the server pauses the game by itself once the requests stop
function doomOpen($: EngineInterface) {
  if (!doom.timer) doom.timer = $.clock.every(100, () => { void doomRefresh($) })
  doom.lastKeyAt = performance.now()
  doom.playing = true
  doom.idle = false
  void ensureDoom($)
}
function doomClose() {
  doom.timer?.cancel()
  doom.timer = undefined
}

// starts the server when none answers, and waits until it does
async function ensureDoom($: EngineInterface) {
  const ping = () => $.http.fetch(`${DOOM_URL}/ping`).then(r => r.ok).catch(() => false)
  if (doom.starting || (await ping())) return
  doom.starting = true
  doom.error = undefined
  doom.frame = undefined
  try {
    // this module's own path (the declarations leave import.meta untyped; the runtime has it)
    const here = (import.meta as unknown as { url: string }).url
    const launch = decodeURIComponent(new URL('../doom/launch.mjs', here).pathname)
    // the plugin's own environment has no WebAssembly, so the engine needs a runtime of its own:
    // bun, or node, whichever the PATH has
    let why = ''
    let started = false
    for (const runtime of ['bun', 'node']) {
      try {
        // the first start fetches the engine, which takes a moment
        const run = await $.process.run([runtime, launch], { timeoutMs: 120_000 })
        if (run.exitCode === 0) { started = true; break }
        why = run.stderr.trim() || `${runtime} exited ${run.exitCode}`
      } catch (err) {
        why = err instanceof Error ? err.message : String(err)
      }
    }
    if (!started) throw new Error(why)
    for (let i = 0; i < 50 && !(await ping()); i++) await new Promise<void>(resolve => $.clock.after(100, () => resolve()))
    if (!(await ping())) throw new Error('the server did not answer')
  } catch (err) {
    doom.error = `the game did not start (${err instanceof Error ? err.message : String(err)}) · it needs bun or node on the PATH`
    $.ui.log(`cc-arcade: doom: ${doom.error}`)
  } finally {
    doom.starting = false
    $.ui.invalidate('ui.render')
  }
}

// which board is open; Doom's loop runs only while it is
function activate($: EngineInterface, name: string | undefined) {
  if (active === 'doom' && name !== 'doom') doomClose()
  active = name
  if (name === 'doom') doomOpen($)
}

const isPet = (value: unknown): value is Pet => typeof value === 'object' && value !== null && typeof (value as Pet).xp === 'number'
const autoContext = (now: number): AutoContext => ({
  working: turnStartedAt !== undefined,
  turnMs: turnStartedAt === undefined ? 0 : now - turnStartedAt,
  lastEvent: pet?.last,
  lastEventAgoMs: pet ? now - pet.at : undefined,
  lastGame,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // a store that cannot be read or written costs the pet and the scores, never the games:
    // an unhandled rejection here would unmount the whole module
    const stored = (key: string) => $.store.get(key).catch(err => { $.ui.log(`cc-arcade: store read failed: ${err}`); return undefined })
    const saved = await stored('pet')
    pet = isPet(saved) ? saved : newPet($.clock.now())
    if (!isPet(saved)) await $.store.set('pet', pet).catch(err => $.ui.log(`cc-arcade: store write failed: ${err}`))
    for (const name of NAMES) {
      const score = Number(await stored(`best:${name}`))
      if (score) best[name] = score
    }
    await $.command.register({
      name: 'arcade',
      description: 'Games above the prompt: pick one, or list, random, auto, stop (cc-arcade)',
      argumentHint: '[game | list | random | auto | stop]',
      immediate: true,
    }).catch(err => $.ui.log(`cc-arcade: /arcade not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'arcade' }, async ($, e, next) => {
    const arg = e.args.trim().toLowerCase()
    const open = (name: string, why?: string) => {
      activate($, name)
      lastGame = name
      $.ui.invalidate('ui.render')
      const how = name === 'pet' ? 'click it to pet it' : 'click the board to play · Esc returns to the prompt'
      return { text: `${GAMES[name].title}${why ? ` (${why})` : ''} · ${how} · /arcade stop closes` }
    }
    if (arg === '') {
      activate($, PICKER)
      $.ui.invalidate('ui.render')
      return { text: 'arcade: click a game above the prompt · /arcade list describes them' }
    }
    if (arg === 'stop') {
      activate($, undefined)
      $.ui.invalidate('ui.render')
      return { text: 'arcade closed' }
    }
    if (arg === 'list') {
      const rows = NAMES.map(n => {
        const score = best[n] ? ` · best ${best[n]}${GAMES[n].unit ?? ''}` : ''
        return `${n.padEnd(12)}${GAMES[n].blurb}${score}`
      })
      return { text: [...rows, '', 'random      a game you did not just play', 'auto        a game for the moment', 'stop        close the arcade'].join('\n') }
    }
    if (arg === 'random') return open(pickRandom(PLAYABLE, lastGame))
    if (arg === 'auto') {
      const pick = pickAuto(autoContext($.clock.now()))
      return open(pick.game, `auto: ${pick.reason}`)
    }
    if (isGame(arg)) return open(arg)
    return { text: `no game called "${arg}" · /arcade list shows them` }
  })

  on('turn.start', async ($, e, next) => {
    turnStartedAt = $.clock.now()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    turnStartedAt = undefined
    if (active && active !== PICKER) {
      turnsDone++
      if (active === 'doom') { doom.playing = false; doom.banner = true }
      $.ui.invalidate('ui.render')
    }
    return r
  })

  // the pet feeds on work: a test run passing or failing, a commit, an edit. It is re-read from the
  // store first, so sessions running side by side feed the same pet instead of overwriting it.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const command = (e as { command?: unknown }).command
    const event = petEvent(e.tool, typeof command === 'string' ? command : undefined, 'deny' in r ? undefined : !r.isError)
    if (!event) return r
    const saved = await $.store.get('pet').catch(() => undefined)
    const current = isPet(saved) ? saved : pet ?? newPet($.clock.now())
    const fed = feed(current, event, $.clock.now())
    pet = fed
    await $.store.set('pet', fed).catch(err => $.ui.log(`cc-arcade: store write failed: ${err}`))
    if (level(fed.xp) > level(current.xp)) {
      const grew = stage(fed.xp) !== stage(current.xp) ? `, and is now ${stage(fed.xp) === 'adult' ? 'an adult' : `a ${stage(fed.xp)}`}` : ''
      $.ui.toast(`pet: reached level ${level(fed.xp)}${grew}`)
    }
    if (active === 'pet') $.ui.invalidate('ui.render')
    return r
  })

  // a finished round, posted by a board: keep the best score and hand it back with the next props
  on('ui.message', async ($, e, next) => {
    const data = e.data as { doom?: { strip?: unknown; presses?: unknown }; game?: unknown; score?: unknown } | null
    // a Doom strip's presses, each numbered so one sent twice counts once: any key wakes the game;
    // p, h, [ and ] are the board's own
    if (data?.doom) {
      const now = performance.now()
      const strip = typeof data.doom.strip === 'number' ? data.doom.strip : 0
      let seen = doom.seen[strip] ?? 0
      const presses = (Array.isArray(data.doom.presses) ? data.doom.presses : []) as { seq?: unknown; key?: unknown; toggle?: unknown }[]
      for (const p of presses) {
        if (typeof p?.seq !== 'number' || p.seq <= seen) continue
        seen = p.seq
        const t = p.toggle
        if (t === 'pause') { doom.playing = !doom.playing; doom.idle = false; doom.banner = false }
        else if (t === 'mode') doom.mode = nextMode()
        else if (t === 'bigger') doom.size = Math.min(200, doom.size + DOOM_STEP)
        else if (t === 'smaller') doom.size = Math.max(DOOM_MIN_ROWS, doom.size - DOOM_STEP)
        const k = p.key as Key | undefined
        if (typeof k === 'object' && k !== null && typeof k.code === 'number' && typeof k.hold === 'number') {
          doom.keys.push({ code: k.code, hold: k.hold })
          doom.playing = true
          doom.idle = false
          doom.banner = false
          doom.lastKeyAt = now
        }
      }
      doom.seen[strip] = seen
      // straight out, unless a step just went: a held key repeats faster than that is worth
      if (now - doom.fetchedAt > 70) void doomRefresh($)
      return next(e)
    }
    const name = data?.game
    const score = data?.score
    if (!isGame(name) || typeof score !== 'number') return next(e)
    const game = GAMES[name]
    if (isBetter(score, best[name], game.lowerIsBetter)) {
      best[name] = score
      await $.store.set(`best:${name}`, score).catch(err => $.ui.log(`cc-arcade: store write failed: ${err}`))
      $.ui.toast(`${name}: new best ${score}${game.unit ?? ''}`)
    }
    return { props: { best: best[name] ?? 0, done: turnsDone } }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // boards need a terminal's keys and mouse; the desktop and mobile surfaces draw their own band
    if (!active || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const { Box, Button, Client, Text } = await $.ui.resolve(e)

    if (active === PICKER) {
      // no hotkeys: a band hotkey would press on a digit typed as the first character of a prompt
      const choose = (name: string) => {
        if (name === 'close') activate($, undefined)
        else if (name === 'random') activate($, pickRandom(PLAYABLE, lastGame))
        else if (name === 'auto') {
          const pick = pickAuto(autoContext($.clock.now()))
          activate($, pick.game)
          $.ui.toast(`auto: ${pick.game}, ${pick.reason}`)
        } else activate($, name)
        if (active) lastGame = active
        $.ui.invalidate('ui.render')
      }
      return (
        <Box flexDirection="column">
          <Text dimColor>{'arcade · click a game · /arcade <game> works too · /arcade stop closes'}</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {[...NAMES, 'random', 'auto', 'close'].map(name => (
              <Button key={`pick:${name}`} label={name} onPress={() => choose(name)} />
            ))}
          </Box>
          {await next(e)}
        </Box>
      )
    }

    const cols = e.viewport?.columns ?? 80
    // one row for the back and close buttons, one for whatever else draws in the band
    const rows = Math.max(8, e.props.maxRows - 2)
    const tall = (max: number) => Math.min(rows, max)
    const props = { best: best[active] ?? 0, done: turnsDone }
    // the key names the board, so switching mounts a fresh one and a redraw keeps the running one;
    // module paths must be string literals, since the engine reads them off this source
    const key = `board:${active}`
    // Doom: the picture in strips inside one frame, each strip a Client with its rows of the last
    // picture fetched, and the status line under them; every redraw of the band is a new picture
    const doomBoard = () => {
      doom.layout = doomLayout(cols, e.props.maxRows)
      const { cols: width, rows: height, perStrip, strips } = doom.layout
      const f = doom.frame
      const mode = f && isMode(f.mode) ? f.mode : doom.mode
      const { ch } = SHAPE[mode]
      // strips are numbered from the bottom, so when the picture shrinks it is the top ones that
      // go and the one clicked, lower down, keeps the keyboard
      const strip = (i: number) => {
        const top = (strips - 1 - i) * perStrip, tall = Math.min(perStrip, height - top)
        const stripProps = f?.rows && f.w
          ? { strip: i, rows: f.rows.slice(top * ch, (top + tall) * ch), w: f.w, h: tall * ch, mode }
          : doom.error ? { strip: i, error: doom.error } : { strip: i }
        return <Client key={`doom:${i}`} module="./boards/doom.tsx" width={width} height={tall} props={stripProps} />
      }
      const text = doomStatus()
      doom.statusText = text
      return (
        <Box flexDirection="column">
          <Box flexDirection="column" borderStyle="round" borderColor={doom.error ? 'red' : 'white'} width={width + 2}>
            {Array.from({ length: strips }, (_, i) => strip(strips - 1 - i))}
          </Box>
          {doom.banner
            ? <Text color="yellow" bold wrap="truncate-end">{`● Claude is done · ${text}`}</Text>
            : <Text dimColor wrap="truncate-end">{text}</Text>}
        </Box>
      )
    }
    const board =
      active === 'snake' ? <Client key={key} module="./boards/snake.tsx" width={cols} height={rows} props={props} />
      : active === 'tetris' ? <Client key={key} module="./boards/tetris.tsx" width={cols} height={tall(23)} props={props} />
      : active === '2048' ? <Client key={key} module="./boards/twenty48.tsx" width={cols} props={props} />
      : active === 'minesweeper' ? <Client key={key} module="./boards/minesweeper.tsx" width={cols} height={tall(12)} props={props} />
      : active === 'flappy' ? <Client key={key} module="./boards/flappy.tsx" width={cols} height={tall(19)} props={props} />
      : active === 'pong' ? <Client key={key} module="./boards/pong.tsx" width={cols} height={tall(18)} props={props} />
      : active === 'invaders' ? <Client key={key} module="./boards/invaders.tsx" width={cols} height={tall(19)} props={props} />
      : active === 'doom' ? doomBoard()
      : active === 'pet' ? <Client key={key} module="./boards/pet.tsx" width={cols} props={{ pet, now: $.clock.now() }} />
      : <Client key={key} module="./boards/typing.tsx" width={cols} props={props} />
    // back to the picker, or close; click-only like the picker (no hotkeys: a band hotkey would press
    // on a digit typed as the first character of a prompt)
    const toPicker = () => {
      activate($, PICKER)
      $.ui.invalidate('ui.render')
    }
    const close = () => {
      activate($, undefined)
      $.ui.invalidate('ui.render')
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Button key="arcade:back" label="← games" onPress={toPicker} />
          <Button key="arcade:close" label="close" onPress={close} />
        </Box>
        {board}
        {await next(e)}
      </Box>
    )
  })
}
