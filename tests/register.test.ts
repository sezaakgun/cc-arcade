import { expect, test } from 'bun:test'
import { register } from '../hooks/register.tsx'

// the band headless: a $ whose clock resolves, as $.clock.now() does from Claude Code 2.1.295 on,
// a store in memory, and the hooks kept by event name
type El = { tag: string; props: Record<string, any>; kids: El[] }
const hooks: Record<string, (...args: any[]) => Promise<any>> = {}
register(((event: string, a: any, b?: any) => { hooks[event] = b ?? a }) as any, undefined as any)
const store = new Map<string, unknown>()
const $ = {
  clock: { now: async () => 1_000_000 },
  store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) } },
  command: { register: async () => {} },
  ui: { log() {}, toast() {}, invalidate() {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
}
const next = async () => undefined
const client = (el: El | undefined): El | undefined => el?.tag === 'Client' ? el : el?.kids?.map(client).find(Boolean)
const board = async (props: object, viewport?: object) =>
  client(await hooks['ui.render']($, { surface: 'terminal', props: { hasSurvey: false, ...props }, viewport }, next))!.props

test('band: the clock, the board size and the scores a board posts', async () => {
  ;(globalThis as any).h = (tag: string, props: unknown, ...kids: unknown[]) =>
    ({ tag, props: props ?? {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) })
  await hooks['session.start']($, {}, next)
  // a pet born at a time, not at a Promise
  expect(store.get('pet')).toMatchObject({ at: 1_000_000, born: 1_000_000 })

  await hooks['command.run']($, { args: 'snake' }, next)
  // the band's own width wins over the viewport's, which the engine's [-] mark eats into
  expect(await board({ bodyColumns: 75, maxRows: 20 }, { columns: 80 })).toMatchObject({ width: 75, height: 18 })
  // a band that does not say: the viewport, then 80 columns and 24 rows, never NaN
  expect(await board({ maxRows: 20 }, { columns: 100 })).toMatchObject({ width: 100, height: 18 })
  expect(await board({})).toMatchObject({ width: 80, height: 22 })
  expect(await board({ bodyColumns: 5, maxRows: 0 })).toMatchObject({ width: 20, height: 22 })

  await hooks['command.run']($, { args: 'pet' }, next)
  expect((await board({ bodyColumns: 75, maxRows: 20 })).props.now).toBe(1_000_000)

  // a score that is not a finite number passes on and never becomes a best
  for (const score of [Infinity, -Infinity, NaN]) {
    expect(await hooks['ui.message']($, { data: { game: 'snake', score } }, next)).toBeUndefined()
  }
  expect(store.has('best:snake')).toBe(false)
  expect(await hooks['ui.message']($, { data: { game: 'snake', score: 7 } }, next)).toMatchObject({ props: { best: 7 } })
  expect(store.get('best:snake')).toBe(7)
})
