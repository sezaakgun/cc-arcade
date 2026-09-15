import { expect, test } from 'bun:test'
import { cells, CHAR_BUDGET, decodeRow, FIRE, hex, HOLD, keyFor, sextant, SPAN_BUDGET, spans, TAP, weight } from '../hooks/games/doom.ts'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// a picture as the server encodes one, a run of one per pixel
const encode = (px: number[][]) => px.map(row => row.map(c => B64[c >> 12] + B64[(c >> 6) & 63] + B64[c & 63] + 'A').join(''))
const RED = 0x3f << 12, WHITE = 0x3ffff, BLACK = 0

test('doom keys', () => {
  // the arrows as Doom numbers them, held; w a s d the same, with the strafe keys
  expect(keyFor('left')).toEqual([{ code: 0xac, hold: HOLD }])
  expect(keyFor('w')).toEqual([{ code: 0xad, hold: HOLD }])
  expect(keyFor('d')).toEqual([{ code: 46, hold: HOLD }])
  // the space bar, by name or as the character, fires (Doom's Ctrl); e uses (Doom's Space)
  expect(keyFor('space')).toEqual([FIRE])
  expect(keyFor(' ')).toEqual([FIRE])
  expect(keyFor('e')).toEqual([{ code: 32, hold: TAP }])
  // Backspace stands in for Escape, which the terminal keeps; F-keys and digits pass through
  expect(keyFor('backspace')).toEqual([{ code: 27, hold: TAP }])
  expect(keyFor('f1')).toEqual([{ code: 0xbb, hold: TAP }])
  expect(keyFor('3')).toEqual([{ code: 51, hold: TAP }])
  expect(keyFor('Y')).toEqual([{ code: 121, hold: TAP }])
  // Shift with a movement key runs; alone with a tap it does nothing; unknown keys are nothing
  expect(keyFor('up', true)).toEqual([{ code: 0xad, hold: HOLD }, { code: 0xb6, hold: HOLD }])
  expect(keyFor('e', true)).toEqual([{ code: 32, hold: TAP }])
  expect(keyFor('pageup')).toEqual([])
})

test('doom picture', () => {
  // four digits a run: red for one pixel, then black for two, padded to the width
  expect(decodeRow('/AAA', 1)).toEqual([RED])
  expect(decodeRow('/AAAAAAB', 4)).toEqual([RED, 0, 0, 0])
  expect(decodeRow('/AAAAAAB', 2)).toEqual([RED, 0])
  expect(hex(RED)).toBe('#ff0000')
  expect(hex(WHITE)).toBe('#ffffff')
  expect(hex((32 << 12) | (48 << 6) | 16)).toBe('#82c241')
  // sextants: the six bits, with the halves and the full block taken from the older blocks
  expect(sextant(0)).toBe(' ')
  expect(sextant(1)).toBe('\u{1fb00}')
  expect(sextant(20)).toBe('\u{1fb13}')
  expect(sextant(21)).toBe('▌')
  expect(sextant(22)).toBe('\u{1fb14}')
  expect(sextant(42)).toBe('▐')
  expect(sextant(43)).toBe('\u{1fb28}')
  expect(sextant(62)).toBe('\u{1fb3b}')
  expect(sextant(63)).toBe('█')
  // two pixels a cell: a half block over the background, or one colour when they match
  expect(cells(encode([[RED], [BLACK]]), 1, 2, 'half')).toEqual([[['▀', '#ff0000', '#000000']]])
  expect(cells(encode([[RED], [RED]]), 1, 2, 'half')).toEqual([[[' ', undefined, '#ff0000']]])
  // four a cell: white on the top left and bottom right of black is the ▚ quadrant, white over black
  expect(cells(encode([[WHITE, BLACK], [BLACK, WHITE]]), 2, 2, 'quad')).toEqual([[['▚', '#ffffff', '#000000']]])
  // six a cell: a white top-left pixel on black is sextant 1
  expect(cells(encode([[WHITE, BLACK], [BLACK, BLACK], [BLACK, BLACK]]), 2, 3, 'sextant')).toEqual([[['\u{1fb00}', '#ffffff', '#000000']]])
  expect(cells(encode([[BLACK, BLACK], [BLACK, BLACK], [BLACK, BLACK]]), 2, 3, 'sextant')).toEqual([[[' ', undefined, '#000000']]])
  // a short or missing row reads as black
  expect(cells(encode([[RED]]), 1, 2, 'half')).toEqual([[['▀', '#ff0000', '#000000']]])
})

test('doom budget', () => {
  // a tree holds 2000 nodes and 100000 characters; a picture of noise, every pixel its own colour,
  // is merged along its rows until it fits, and a flat picture is left as it is, one run a row
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 0x40000
  const noise = encode(Array.from({ length: 60 }, () => Array.from({ length: 96 }, rand)))
  const loose = cells(noise, 96, 60, 'half', { spans: 1e9, chars: 1e9 })
  expect(spans(loose)).toBeGreaterThan(SPAN_BUDGET)
  for (const mode of ['half', 'quad', 'sextant'] as const) {
    const picture = cells(noise, 96, 60, mode)
    expect(spans(picture)).toBeLessThanOrEqual(SPAN_BUDGET)
    expect(weight(picture)).toBeLessThanOrEqual(CHAR_BUDGET)
  }
  expect(spans(cells(noise, 96, 60, 'half', { spans: 120, chars: 1e9 }))).toBeLessThanOrEqual(120)
  const flat = encode(Array.from({ length: 60 }, () => Array.from({ length: 96 }, () => RED)))
  expect(spans(cells(flat, 96, 60, 'half'))).toBe(30)
  // merging keeps the colours it merges into, near ones: a gentle gradient becomes a few bands of
  // its own colours, not black and white
  const gradient = encode(Array.from({ length: 2 }, () => Array.from({ length: 64 }, (_, x) => (x << 12) | (x << 6) | x)))
  const bands = cells(gradient, 64, 2, 'half', { spans: 8, chars: 1e9 })
  expect(spans(bands)).toBeLessThanOrEqual(8)
  const greys = new Set(bands[0].map(c => c[2]))
  expect(greys.size).toBeGreaterThan(2)
  for (const g of greys) expect(g).toMatch(/^#([0-9a-f]{2})\1\1$/)
  // colours a shade apart merge from the start, so a texture of near colours is a few runs, not
  // one a cell; with no tolerance every cell is its own run, and colours far apart never merge
  const shades = encode(Array.from({ length: 2 }, () => Array.from({ length: 64 }, (_, x) => ((32 + (x % 3)) << 12) | (32 << 6) | 32)))
  expect(spans(cells(shades, 64, 2, 'half'))).toBe(1)
  expect(spans(cells(shades, 64, 2, 'half', undefined, 0))).toBe(64)
  const checks = encode(Array.from({ length: 2 }, () => Array.from({ length: 64 }, (_, x) => (x % 2 ? RED : WHITE))))
  expect(spans(cells(checks, 64, 2, 'half'))).toBe(64)
})
