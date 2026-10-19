import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'
import { paneBudget } from '../hooks/register'
import type { PaneBudgetInput } from '../hooks/register'

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
type World = {
  isOpen: boolean; runs: Run[]; stdout: string; fail: string | null
  files: Map<string, string> // run-log files under DIR (name -> text)
  gate: Promise<void> | null // when set, process.run waits for it
}
const DIR = '/run/user/1000/orchestrator'

function world(on: On): World {
  const w: World = { isOpen: true, runs: [], stdout: SNAPSHOT, fail: null, files: new Map(), gate: null }
  mock.env(on, { HOME: '/home/dq', XDG_RUNTIME_DIR: '/run/user/1000' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({
    value: [...w.files].map(([name, text]) => ({ name, kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false })),
  }))
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path.slice(DIR.length + 1))
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', () => ({ value: true }))
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
  on('process.run', async ($, e) => {
    w.runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    if (w.gate !== null) await w.gate
    if (w.fail !== null) return { deny: w.fail }
    return { value: { exitCode: 0, stdout: w.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const mount = ($: Engine, surface: (typeof SURFACES)[number], bodyRows = 40) =>
  $.ui.mount({
    plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector',
    props: { ...PANE, scroll: { offset: 0, bodyRows } }, viewport: { columns: 140, rows: 44 },
  })

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
    expect((await ui.find({ type: 'Box', key: 'usage:agy' }))?.text).toMatch(/gemini 60% \(week\) · claude\/gpt 80% \(week\) · argon 100% \(week\) left/)
    await ui.unmount()
  }
})

test('agy shows the tighter of the 5h and week windows per group', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const snap = JSON.parse(SNAPSHOT)
  snap.google = {
    status: 'ok', used_pct: 40, note: '',
    gemini: { weekly_used_pct: 40, five_hour_used_pct: 100, weekly_resets_at: '2026-10-24T00:00:00Z' },
  }
  w.stdout = JSON.stringify(snap)
  await $.session.start(BOOT)
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Box', key: 'usage:agy' }))?.text).toMatch(/gemini 0% \(5h\)/)
    await ui.unmount()
  }
})

test('agy with no groups falls back to the overall figure', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const snap = JSON.parse(SNAPSHOT)
  snap.google = { status: 'ok', used_pct: 30, note: '' }
  w.stdout = JSON.stringify(snap)
  await $.session.start(BOOT)
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const text = (await ui.find({ type: 'Box', key: 'usage:agy' }))?.text ?? ''
    expect(text).toMatch(/agy 70% \(overall\) left/)
    expect(text).not.toMatch(/week/)
    await ui.unmount()
  }
})

test('schema-invalid usage.sh JSON shows an error and keeps the last good figures', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(BOOT)
  await clock.advance(1000)
  for (const bad of ['{}', 'null', '42']) {
    w.stdout = bad
    await clock.advance(5 * 60_000)
    const ui = await mount($, 'terminal')
    expect(await ui.find({ text: /malformed JSON/ })).toBeDefined()
    expect((await ui.find({ type: 'Box', key: 'usage:openrouter' }))?.text).toMatch(/\$16\.31 left/)
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

// Five running workers; the newest (5) is selected. Each has a lifecycle start and six messages.
function addRuns(w: World): void {
  for (let i = 1; i <= 5; i++) {
    const id = `20261019T1719${String(i).padStart(2, '0')}000Z-codex-0000000${i}`
    const rec = (r: object) => `${JSON.stringify(r)}\n`
    w.files.set(`${id}.jsonl`, rec({
      v: 1, type: 'orchestrator.start', run_id: id, executor: 'codex', model: 'gpt-5.5', label: `task-${i}`,
      parent: null, workdir: '/tmp/w', pid: 4242, granularity: 'live', ts: '2026-10-19T17:19:00.000Z',
    }))
    w.files.set(`${id}.1.jsonl`, [1, 2, 3, 4, 5, 6].map(k => rec({ type: 'item.completed', item: { id: `${i}-${k}`, type: 'agent_message', text: `msg ${i}-${k}` } })).join(''))
  }
}

test('short panes: Usage is one compact line, the refresh button stays, and the selected worker keeps its events', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  addRuns(w)
  const snap = JSON.parse(SNAPSHOT)
  snap.google = { status: 'ok', used_pct: 40, note: '', gemini: { weekly_used_pct: 40, five_hour_used_pct: 100, weekly_resets_at: '2026-10-24T00:00:00Z' } }
  w.stdout = JSON.stringify(snap)
  await $.session.start(BOOT)
  await clock.advance(1000)

  for (const surface of SURFACES) {
    for (const bodyRows of [12, 20]) {
      const ui = await mount($, surface, bodyRows)
      expect((await ui.find({ type: 'Box', key: 'usage:compact' }))?.text).toMatch(/Usage.*Claude 49%.*Codex 69%.*agy 0% \(5h\).*OR \$16\.31/)
      expect(await ui.find({ type: 'Box', key: 'usage:claude' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
      // Workers (5) and their events both fit: the selected worker's newest event is shown.
      expect(await ui.find({ type: 'Box', key: `row:20261019T171905000Z-codex-00000005` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^msg 5-\d$/ })).toBeDefined()
      await ui.unmount()
    }
    const tall = await mount($, surface, 40)
    expect(await tall.find({ type: 'Box', key: 'usage:compact' })).toBeUndefined()
    expect(await tall.find({ type: 'Box', key: 'usage:claude' })).toBeDefined()
    expect(await tall.find({ type: 'Box', key: 'usage:openrouter' })).toBeDefined()
    expect(await tall.find({ type: 'Button', key: 'refresh' })).toBeDefined()
    expect(await tall.find({ type: 'Text', text: /^msg 5-\d$/ })).toBeDefined()
    await tall.unmount()
  }

  // A failing run only adds a short marker to the compact line.
  w.fail = 'boom'
  await clock.advance(5 * 60_000)
  const ui = await mount($, 'terminal', 12)
  expect((await ui.find({ type: 'Box', key: 'usage:compact' }))?.text).toMatch(/· error/)
  expect(await ui.find({ text: /usage\.sh: / })).toBeUndefined()
  await ui.unmount()
})

test('paneBudget never budgets more rows than the body has', () => {
  const selections: PaneBudgetInput['selection'][] = ['run', 'claude', 'none']
  for (let rows = 12; rows <= 40; rows++) {
    for (const width of [70, 100]) {
      for (const hasNotice of [false, true]) {
        for (const hasUsageError of [false, true]) {
          for (const groups of [1, 2]) {
            for (const ids of [1, 5]) {
              for (const selection of selections) {
                const input = { rows, width, hasNotice, hasUsageError, groups, ids, selection }
                const b = paneBudget(input)
                const at = JSON.stringify(input)
                const total = b.fixed + groups + Math.min(b.listRoom, ids) + b.eventRoom
                expect(total <= rows, `${at} -> ${total} > ${rows}`).toBe(true)
                expect(Math.min(b.listRoom, ids) >= 1, at).toBe(true)
                if (selection === 'run') expect(b.eventRoom >= 3, at).toBe(true)
                expect(b.isCompact).toBe(rows < 24)
              }
            }
          }
        }
      }
    }
  }
  // The reviewer's case: 12 rows, one worker, its compact summary and events.
  const b = paneBudget({ rows: 12, width: 100, hasNotice: false, hasUsageError: false, groups: 1, ids: 1, selection: 'run' })
  expect(b.isCompact).toBe(true)
  expect(b.fixed + 1 + Math.min(b.listRoom, 1) + b.eventRoom <= 12).toBe(true)
  expect(b.eventRoom >= 3).toBe(true)
})

/**
 * How many rows a tree estimates to: a Text is one line (wrapping at `width`),
 * a Button one line, and a Box stacks its children unless it lays them in a row
 * (then its texts and buttons share one line, the tallest winning).
 */
function drawnRows(tree: unknown, width: number): number {
  if (typeof tree === 'string') return 1
  if (tree === null || typeof tree !== 'object') return 0
  const el = tree as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const children = el.children ?? []
  if (el.type === 'Button') return 1
  if (el.type === 'Text') {
    let longest = 1
    for (const child of children) {
      if (typeof child === 'string') longest = Math.max(longest, ...child.split('\n').map(line => line.length))
    }
    return Math.max(1, Math.ceil(longest / width))
  }
  if (el.props?.flexDirection === 'row') {
    // Strings and inline Texts share the line; a nested Box starts its own.
    let rows = 1
    for (const child of children) {
      if (typeof child !== 'object' || child === null) continue
      if ((child as { type?: string }).type === 'Box') rows += drawnRows(child, width)
    }
    return rows
  }
  let rows = 0
  for (const child of children) rows += drawnRows(child, width)
  return rows
}

test('a 12-row, 70-column pane draws within its body, even for one very long newest event', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const id = '20261019T171901000Z-codex-00000001'
  const line = (r: object) => `${JSON.stringify(r)}\n`
  w.files.set(`${id}.jsonl`, line({
    v: 1, type: 'orchestrator.start', run_id: id, executor: 'codex', model: 'gpt-5.5', label: 'a-very-long-task-label-that-would-wrap',
    parent: null, workdir: '/tmp/w', pid: 4242, granularity: 'live', ts: '2026-10-19T17:19:00.000Z',
  }))
  w.files.set(`${id}.1.jsonl`, line({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'word '.repeat(1200) } }))
  await $.session.start(BOOT)
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector',
      props: { ...PANE, bodyColumns: 70, scroll: { offset: 0, bodyRows: 12 } }, viewport: { columns: 80, rows: 14 },
    })
    const tree = await ui.drawn()
    const parts = (tree as { children?: unknown[] }).children ?? []
    expect(drawnRows(tree, 70), parts.map(one => drawnRows(one, 70)).join(',')).toBeLessThanOrEqual(12)
    // The compact run summary is one line, and the newest event is cut to fit.
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    expect(texts.some(one => /running · live · last event .* · reported —$/.test(one))).toBe(true)
    const cut = texts.find(one => /… \[x to expand\]$/.test(one)) ?? ''
    expect(cut).toMatch(/^word /)
    // It is cut to the room, not just to the 2000-character display limit.
    expect(cut.length).toBeLessThan(2000)
    // Compact controls fit one 70-column line.
    const labels = (await ui.findAll({ type: 'Button' })).map(one => one.text)
    expect(labels).toContain('f on')
    expect(labels.join(' ').length).toBeLessThanOrEqual(70)
    await ui.unmount()
  }
})

/** A process.run that stays pending until `release()`. */
function hold(w: World): () => void {
  let release!: () => void
  w.gate = new Promise<void>(resolve => (release = resolve))
  return release
}

test('closing the pane mid-refresh: the run finishes quietly, nothing restarts, reopening past 5 minutes runs once more', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const release = hold(w)
  await $.session.start(BOOT)
  await clock.advance(1000)
  expect(w.runs.length).toBe(1)
  const open = await mount($, 'terminal')
  expect(await open.find({ type: 'Button', text: /refreshing…/ })).toBeDefined()
  await open.unmount()

  w.isOpen = false
  await clock.advance(10 * 60_000)
  expect(w.runs.length).toBe(1) // closed pane: no new run, and the pending one is not duplicated

  release()
  await clock.advance(1000)
  const closed = await mount($, 'terminal')
  expect(await closed.find({ text: /refreshing…/ })).toBeUndefined()
  expect((await closed.find({ type: 'Box', key: 'usage:openrouter' }))?.text).toMatch(/\$16\.31 left/)
  expect(await closed.find({ text: /usage\.sh: / })).toBeUndefined()
  await closed.unmount()
  expect(w.runs.length).toBe(1)

  // The attempt began 10+ minutes ago (the 5-minute rule counts from the start), so reopening runs it once.
  w.isOpen = true
  await clock.advance(1000)
  expect(w.runs.length).toBe(2)
  await clock.advance(1000)
  expect(w.runs.length).toBe(2)
})

test('closing the pane mid-refresh and reopening within 5 minutes shows the late figures without a new run', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const release = hold(w)
  await $.session.start(BOOT)
  await clock.advance(1000)
  expect(w.runs.length).toBe(1)

  w.isOpen = false
  await clock.advance(2 * 60_000)
  release()
  await clock.advance(1000)
  w.isOpen = true
  await clock.advance(2000)
  expect(w.runs.length).toBe(1)
  const ui = await mount($, 'desktop')
  expect(await ui.find({ text: /refreshing…/ })).toBeUndefined()
  expect((await ui.find({ type: 'Box', key: 'usage:openrouter' }))?.text).toMatch(/\$16\.31 left/)
  expect(await ui.find({ text: /updated \d\d:\d\d:\d\d/ })).toBeDefined()
  await ui.unmount()
})
