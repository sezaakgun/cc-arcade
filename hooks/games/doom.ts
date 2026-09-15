// Doom: the pure parts of the Doom board in ../boards/doom.tsx. The game itself is the original
// engine, run by ../../doom/server.mjs; this is how its picture becomes cells and how the keys the
// terminal reports are named for it.

export type Cell = readonly [glyph: string, color?: string, bg?: string]
export type Key = { code: number; hold: number }
// how many pixels a cell shows: two (a half block over its background), four (a quadrant glyph,
// which every font has) or six (a sextant, which needs a font with them)
export type Mode = 'half' | 'quad' | 'sextant'
export const MODES: Mode[] = ['quad', 'sextant', 'half']
export const SHAPE: Record<Mode, { cw: number; ch: number }> = { half: { cw: 1, ch: 2 }, quad: { cw: 2, ch: 2 }, sextant: { cw: 2, ch: 3 } }

// how long a press holds its key: a movement key long enough to bridge the terminal's repeat
// delay, so a held arrow reads as held; anything else a tap
export const HOLD = 250
export const TAP = 100
// Doom's own key numbers: the arrows as the engine names them, Ctrl to fire, Space to use, the
// comma and full stop that strafe, Escape for the menu (the terminal never hands Escape over)
const KEY_CTRL = 0x80 + 0x1d
const KEY_SHIFT = 0x80 + 0x36
const KEY_F1 = 0x80 + 0x3b
export const KEYS: Record<string, Key> = {
  left: { code: 0xac, hold: HOLD }, right: { code: 0xae, hold: HOLD }, up: { code: 0xad, hold: HOLD }, down: { code: 0xaf, hold: HOLD },
  w: { code: 0xad, hold: HOLD }, s: { code: 0xaf, hold: HOLD }, a: { code: 44, hold: HOLD }, d: { code: 46, hold: HOLD },
  ' ': { code: KEY_CTRL, hold: TAP }, space: { code: KEY_CTRL, hold: TAP }, e: { code: 32, hold: TAP },
  return: { code: 13, hold: TAP }, backspace: { code: 27, hold: TAP }, delete: { code: 27, hold: TAP }, tab: { code: 9, hold: TAP },
}
export const FIRE: Key = KEYS[' ']

// the presses one terminal key becomes: none for a key Doom has no use for; a movement key with
// Shift held also holds Shift, which runs
export function keyFor(name: string, shift = false): Key[] {
  const k = name.length === 1 ? name.toLowerCase() : name
  const fn = /^f(\d{1,2})$/.exec(k)
  const key = KEYS[k] ?? (fn ? { code: KEY_F1 + Number(fn[1]) - 1, hold: TAP } : k.length === 1 && k >= ' ' && k <= '~' ? { code: k.charCodeAt(0), hold: TAP } : undefined)
  if (!key) return []
  return shift && key.hold === HOLD ? [key, { code: KEY_SHIFT, hold: HOLD }] : [key]
}

// a row of the server's picture: runs of one colour, four base64 digits each, the colour as 18
// bits (6 a channel) in three and the run's length less one in the fourth
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGIT: Record<string, number> = Object.fromEntries([...B64].map((ch, i) => [ch, i]))
export function decodeRow(row: string, w: number): number[] {
  const out: number[] = []
  for (let i = 0; i + 3 < row.length && out.length < w; i += 4) {
    const c = (DIGIT[row[i]] << 12) | (DIGIT[row[i + 1]] << 6) | DIGIT[row[i + 2]]
    for (let k = DIGIT[row[i + 3]] + 1; k > 0 && out.length < w; k--) out.push(c)
  }
  while (out.length < w) out.push(0)
  return out
}

const hexes = new Map<number, string>()
export function hex(c: number): string {
  let s = hexes.get(c)
  if (!s) {
    s = '#' + [(c >> 12) & 63, (c >> 6) & 63, c & 63].map(v => Math.round((v * 255) / 63).toString(16).padStart(2, '0')).join('')
    hexes.set(c, s)
  }
  return s
}

// the quadrant for four pixels, bit 1 the top left, 2 the top right, 4 and 8 the bottom
const QUADS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']
// the sextant for six pixels, bit 1 the top left, 2 the top right, 4 and 8 the middle, 16 and 32
// the bottom: Unicode's block, which leaves out the two halves and the full block found elsewhere
export function sextant(bits: number): string {
  if (bits === 0) return ' '
  if (bits === 63) return '█'
  if (bits === 21) return '▌'
  if (bits === 42) return '▐'
  return String.fromCodePoint(0x1fb00 + bits - 1 - (bits > 21 ? 1 : 0) - (bits > 42 ? 1 : 0))
}
const glyph = (mode: Mode, bits: number) => (mode === 'half' ? (bits ? '▀' : ' ') : mode === 'quad' ? QUADS[bits] : sextant(bits))

const lum = (c: number) => 3 * ((c >> 12) & 63) + 6 * ((c >> 6) & 63) + (c & 63)
const apart = (a: number, b: number) => (((a >> 12) & 63) - ((b >> 12) & 63)) ** 2 + (((a >> 6) & 63) - ((b >> 6) & 63)) ** 2 + ((a & 63) - (b & 63)) ** 2

// a cell before it is drawn: its two colours and which of its pixels take the first; bits 0 is a
// cell of one colour, `bg`
type Pair = { fg: number; bg: number; bits: number }

// a cell's pixels as two colours, the darkest and the brightest, each pixel drawn in whichever
// it is nearer
function pair(p: number[]): Pair {
  let lo = p[0], hi = p[0]
  for (const c of p) {
    if (lum(c) < lum(lo)) lo = c
    if (lum(c) > lum(hi)) hi = c
  }
  if (lo === hi) return { fg: lo, bg: lo, bits: 0 }
  let bits = 0
  p.forEach((c, i) => { if (apart(c, hi) < apart(c, lo)) bits |= 1 << i })
  return { fg: hi, bg: lo, bits }
}

function pairs(px: number[][], w: number, h: number, mode: Mode): Pair[][] {
  const { cw, ch } = SHAPE[mode]
  const cols = Math.floor(w / cw), lines = Math.floor(h / ch)
  return Array.from({ length: lines }, (_, r) => Array.from({ length: cols }, (_, x) => {
    if (mode === 'half') {
      const top = px[2 * r]?.[x] ?? 0, bottom = px[2 * r + 1]?.[x] ?? 0
      return top === bottom ? { fg: top, bg: top, bits: 0 } : { fg: top, bg: bottom, bits: 1 }
    }
    const p: number[] = []
    for (let dy = 0; dy < ch; dy++) for (let dx = 0; dx < cw; dx++) p.push(px[ch * r + dy]?.[cw * x + dx] ?? 0)
    return pair(p)
  }))
}

// along each row, a cell whose colours are within `tolerance` of the run before it takes that
// run's colours, so the row draws as fewer runs. A run of one-colour cells has no foreground of
// its own and takes the first two-colour cell's.
function merged(rows: Pair[][], tolerance: number): Pair[][] {
  return rows.map(row => {
    const out: Pair[] = []
    let start = 0
    let free = true
    for (const cell of row) {
      const run = out[out.length - 1]
      if (run) {
        if (cell.bits === 0 ? apart(cell.bg, run.bg) <= tolerance : apart(cell.bg, run.bg) <= tolerance && (free || apart(cell.fg, run.fg) <= tolerance)) {
          if (free && cell.bits) {
            for (let i = start; i < out.length; i++) out[i] = { ...out[i], fg: cell.fg }
            free = false
          }
          out.push({ fg: out[out.length - 1].fg, bg: run.bg, bits: cell.bits })
          continue
        }
      }
      start = out.length
      free = cell.bits === 0
      out.push({ ...cell })
    }
    return out
  })
}

const draw = (mode: Mode, rows: Pair[][]): Cell[][] =>
  rows.map(row => row.map((c): Cell => (c.fg === c.bg ? [' ', undefined, hex(c.bg)] : [glyph(mode, c.bits), hex(c.fg), hex(c.bg)])))

// what a picture costs the drawing: the styled runs, one per change of colours along a row, each
// a node of the tree, and the characters the tree serializes to, about ninety a run plus its text
export function spans(picture: Cell[][]): number {
  let n = 0
  for (const row of picture) {
    let last: string | undefined
    for (const [, color, bg] of row) {
      const k = `${color}|${bg}`
      if (k !== last) { n++; last = k }
    }
  }
  return n
}
export function weight(picture: Cell[][]): number {
  let chars = 400 + picture.length * 60
  for (const row of picture) {
    let last: string | undefined
    for (const [text, color, bg] of row) {
      const k = `${color}|${bg}`
      if (k !== last) { chars += 90; last = k }
      chars += text.length
    }
  }
  return chars
}

// a tree holds at most 2000 nodes and serializes to at most 100000 characters; the picture keeps
// under both with room for the rows, the frame and the status line
export const SPAN_BUDGET = 900
export const CHAR_BUDGET = 88_000
const TOLERANCES = [0, 12, 48, 108, 192, 300, 432, 588, 768, 972, 1200, 1600, 2400, 3600, 5400, 8100, 12000]
// every run is an element drawn again ten times a second, and Doom's textures make one of nearly
// every cell; merging colours this close (about a tenth of a channel) takes out two runs in three
// and shows hardly at all
export const MERGE = 108

// the picture as cells, in the mode's glyphs, merged along each row with as little tolerance as
// keeps it within the budgets, starting from `tolerance`; at the last one every row is one run,
// so it always fits
export function cells(rows: string[], w: number, h: number, mode: Mode, budget = { spans: SPAN_BUDGET, chars: CHAR_BUDGET }, tolerance = MERGE): Cell[][] {
  const exact = pairs(rows.map(row => decodeRow(row, w)), w, h, mode)
  let picture: Cell[][] = []
  for (const t of TOLERANCES) {
    if (t < tolerance) continue
    picture = draw(mode, t === 0 ? exact : merged(exact, t))
    if (spans(picture) <= budget.spans && weight(picture) <= budget.chars) return picture
  }
  return picture
}
