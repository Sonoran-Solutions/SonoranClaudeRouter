import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const NOW = Date.UTC(2026, 9, 19, 19, 32, 0)
const SCRIPT = '/home/dq/.claude/skills/orchestrator/scripts/usage.sh'

// A real usage.sh snapshot (rule/notes shortened); agy is logged out.
const SNAPSHOT = JSON.stringify({
  generated_at: '2026-10-19T19:30:13Z',
  rule: '...',
  claude: { status: 'unknown', used_pct: null, plan: 'claude_max', note: 'no readable usage source from a shell' },
  codex: { status: 'ok', used_pct: 31, window_h: 168, resets_at: '2026-10-24T23:43:05Z', secondary_used_pct: null, plan: 'prolite', limit_reached: false, note: 'account/rateLimits/read via codex app-server' },
  google: { status: 'unknown', used_pct: null, note: 'agy /quota gave no read-only reply (logged out or old agy <1.1.11?); treat as available' },
  openrouter: { status: 'ok', key_source: 'pi', credits_remaining_usd: 16.31, purchased_usd: 45, spent_total_usd: 28.69, spent_today_usd: 1.27, spent_week_usd: 1.27, spent_month_usd: 2.19, key_limit_usd: null, used_pct: 63, note: '...' },
})

const PANE: RenderPropsOf['Pane'] = {
  title: 'Agent Inspector', isFocused: true, bodyColumns: 100, placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 }, view: {},
}
const BOOT = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const SURFACES = ['terminal', 'desktop'] as const

type Run = { argv: readonly string[]; timeoutMs?: number }
type World = { isOpen: boolean; runs: Run[]; stdout: string; fail: string | null }

function world(on: On): World {
  const w: World = { isOpen: true, runs: [], stdout: SNAPSHOT, fail: null }
  mock.env(on, { HOME: '/home/dq', XDG_RUNTIME_DIR: '/run/user/1000' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({
    value: w.isOpen ? [{ id: 'agent-inspector', title: 'Agent Inspector', isShown: true, isFocused: true, isPlaced: true }] : [],
  }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW, context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 51, resetsAt: '2026-10-19T20:40:00Z' },
        { kind: 'seven_day', percentUsed: 30, resetsAt: '2026-10-25T08:00:00Z' },
      ],
    },
  }))
  on('process.run', ($, e) => {
    w.runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    if (w.fail !== null) return { deny: w.fail }
    return { value: { exitCode: 0, stdout: w.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const mount = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector', props: PANE, viewport: { columns: 140, rows: 44 } })

test('the pane shows remaining usage from session.usage and usage.sh on both surfaces', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(BOOT)
  await clock.advance(1000)
  expect(w.runs).toEqual([{ argv: ['bash', SCRIPT], timeoutMs: 180_000 }])

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Box', key: 'usage:claude' }))?.text).toMatch(/5h 49% left \(resets 1h 8m\).*week 70% left \(resets 5d 12h\)/)
    expect((await ui.find({ type: 'Box', key: 'usage:codex' }))?.text).toMatch(/week 69% left \(resets 5d 4h\)/)
    expect((await ui.find({ type: 'Box', key: 'usage:agy' }))?.text).toMatch(/unknown — agy \/quota gave no read-only reply/)
    expect((await ui.find({ type: 'Box', key: 'usage:openrouter' }))?.text).toMatch(/\$16\.31 left · \$1\.27 spent today/)
    expect(await ui.find({ text: /updated \d\d:\d\d:\d\d \(<1m ago\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('agy figures show as remaining per group', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const snap = JSON.parse(SNAPSHOT)
  snap.google = {
    status: 'ok', used_pct: 40, note: '',
    gemini: { weekly_used_pct: 40, five_hour_used_pct: 10, weekly_resets_at: '2026-10-24T00:00:00Z' },
    claude_gpt: { weekly_used_pct: 20, weekly_resets_at: '2026-10-24T00:00:00Z' },
    argon: { weekly_used_pct: 0, weekly_resets_at: '2026-10-24T00:00:00Z' },
  }
  w.stdout = `warming up\n${JSON.stringify(snap)}\n`
  await $.session.start(BOOT)
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Box', key: 'usage:agy' }))?.text).toMatch(/gemini 60% · claude\/gpt 80% · argon 100% left \(week\)/)
    await ui.unmount()
  }
})

test('usage.sh never runs while the pane is not placed; reopening runs it once, then every 5 minutes, and r forces it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.isOpen = false
  await $.session.start(BOOT)
  await clock.advance(5000)
  expect(w.runs).toEqual([])

  w.isOpen = true
  await clock.advance(1000)
  expect(w.runs.length).toBe(1)
  await clock.advance(60_000)
  expect(w.runs.length).toBe(1)
  await clock.advance(5 * 60_000)
  expect(w.runs.length).toBe(2)

  const ui = await mount($, 'terminal')
  await ui.press({ key: 'refresh' })
  expect(w.runs.length).toBe(3)
  await ui.unmount()
})

test('a failing usage.sh shows an error, keeps the last good figures, and does not throw', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.fail = 'spawn bash ENOENT'
  await $.session.start(BOOT)
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: /usage\.sh: .*ENOENT/ })).toBeDefined()
    // Claude's own windows do not depend on the script.
    expect((await ui.find({ type: 'Box', key: 'usage:claude' }))?.text).toMatch(/5h 49% left/)
    await ui.unmount()
  }

  // A good run, then a failure: the last good data stays, with the error beside it.
  w.fail = null
  await clock.advance(5 * 60_000)
  w.stdout = 'not json'
  await clock.advance(5 * 60_000)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ text: /usage\.sh: usage\.sh printed no JSON/ })).toBeDefined()
  expect((await ui.find({ type: 'Box', key: 'usage:openrouter' }))?.text).toMatch(/\$16\.31 left/)
  await ui.unmount()
})
