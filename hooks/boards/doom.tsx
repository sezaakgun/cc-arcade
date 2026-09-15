/* @jsx h */
import type { ClientSurface, JsonValue } from 'claude-code'
import { grid } from './common.tsx'
import { cells, FIRE, keyFor, SHAPE, type Key, type Mode } from '../games/doom.ts'

// One strip of the Doom picture. The hooks module runs the game: ten times a second it fetches the
// picture from ../../doom/server.mjs and redraws the band, handing each strip its rows as props; a
// strip draws them, and sends back the keys pressed while a click has given it the focus. Strips,
// because a board may draw only so much at once (2000 nodes, 100000 characters) and a big picture
// is worth several times that; each strip is small enough to draw every colour it is given.

export type Props = { strip?: number; rows?: string[]; w?: number; h?: number; mode?: string; error?: string } | undefined
// what was pressed, numbered, so the hooks module can tell a press it has seen from a new one:
// a press goes out at once, and again with the next until it is surely delivered
export type Press = { seq: number; at: number } & ({ key: Key } | { toggle: string })
type State = { presses: Press[]; seq: number }
const isMode = (m: unknown): m is Mode => typeof m === 'string' && Object.hasOwn(SHAPE, m)
// how long a press is sent along with later ones before it is taken as delivered
const KEEP_MS = 300

export default function DoomStrip(props: Props, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements

  if (surface.state === undefined) {
    surface.setState({ presses: [], seq: 0 })
    const strip = props?.strip ?? 0
    const post = (s: State) => surface.post({
      doom: {
        strip,
        presses: s.presses.map(p => {
          const sent: Record<string, JsonValue> = { seq: p.seq }
          if ('key' in p) sent.key = { code: p.key.code, hold: p.key.hold }
          else sent.toggle = p.toggle
          return sent
        }),
      },
    })
    const press = (s: State, items: ({ key: Key } | { toggle: string })[]) => {
      const now = performance.now()
      let seq = s.seq
      const presses = [...s.presses.filter(p => now - p.at < KEEP_MS), ...items.map(item => ({ seq: ++seq, at: now, ...item }))]
      const next = { presses, seq }
      surface.setState(next)
      post(next)
    }
    // whatever is still pending goes again, in case a post was dropped for a later one
    surface.every(100, () => {
      const s = surface.state
      if (!s?.presses.length) return
      const presses = s.presses.filter(p => performance.now() - p.at < KEEP_MS)
      surface.setState({ ...s, presses })
      if (presses.length) post({ ...s, presses })
    })
    surface.onKey(ev => {
      const s = surface.state
      if (!s) return
      const k = ev.key === 'space' ? ' ' : ev.key
      const toggle = k === 'p' || k === 'P' ? 'pause' : k === 'h' || k === 'H' ? 'mode' : k === ']' ? 'bigger' : k === '[' ? 'smaller' : undefined
      press(s, toggle ? [{ toggle }] : keyFor(k, ev.shift).map(key => ({ key })))
    })
    // a click gives the strip the keyboard, and fires
    surface.onPointer(ev => {
      const s = surface.state
      if (s && ev.type === 'down') press(s, [{ key: FIRE }])
    })
  }

  const cols = surface.columns || 1, rows = surface.rows || 1
  const picture = props?.rows?.length && props.w && props.h ? cells(props.rows, props.w, props.h, isMode(props.mode) ? props.mode : 'half') : undefined
  const lines = picture
    ? grid(Text, picture[0]?.length ?? cols, picture.length, (x, y) => picture[y]?.[x] ?? [' '])
    : grid(Text, cols, rows, () => [' ', undefined, '#000000'])
  return <Box flexDirection="column">{lines}</Box>
}
