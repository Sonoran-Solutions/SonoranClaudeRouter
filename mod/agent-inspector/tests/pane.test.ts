import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import type { RunEvents, RunSummary } from '../types'
import { stateLabel } from '../hooks/runlog'
import { CODEX_EXEC_JSONL } from './fixtures'

const NOW = Date.UTC(2026, 9, 19, 17, 20, 0)
const XDG = '/run/user/1000'
const DIR = `${XDG}/orchestrator`
const AGY = '20261019T171939660Z-agy-3f9a1c2e'
const CODEX = '20261019T171900000Z-codex-0badc0de'
const BIG = '20261019T171800000Z-codex-0000b16e'
const MIB = 1024 * 1024

const PANE: RenderPropsOf['Pane'] = {
  title: 'Agent Inspector',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const line = (record: object) => `${JSON.stringify(record)}\n`
const start = (id: string, executor: string, model: string | null) =>
  line({
    v: 1, type: 'orchestrator.start', run_id: id, executor, model, label: `${executor}-task`,
    parent: null, workdir: '/tmp/w', pid: 4242, granularity: executor === 'agy' ? 'final-only' : 'live',
    ts: '2026-10-19T17:19:00.000Z',
  })
const exit = (id: string, code: number, segments: number) =>
  line({ v: 1, type: 'orchestrator.exit', run_id: id, ts: '2026-10-19T17:19:10.000Z', exit_code: code, timed_out: false, duration_ms: 10000, segments })
const message = (text: string) => line({ type: 'item.completed', item: { id: text, type: 'agent_message', text } })

type File = { text: string; size?: number; error?: string }
type World = { files: Map<string, File>; reads: string[]; isOpen: boolean; state: Map<string, unknown> }

function baseFiles(): Map<string, File> {
  return new Map<string, File>([
    // agy still running: lifecycle start only; agy writes no segments.
    [`${AGY}.jsonl`, { text: start(AGY, 'agy', null) }],
    // codex finished: lifecycle start + exit, provider records in segment 1
    // (the real sample, then a partial line still being written).
    [`${CODEX}.jsonl`, { text: start(CODEX, 'codex', 'gpt-5.5') + exit(CODEX, 0, 1) }],
    [`${CODEX}.1.jsonl`, { text: `${CODEX_EXEC_JSONL}{"type":"partial` }],
    // Ignored: not contract names.
    ['notes.jsonl', { text: '{"type":"orchestrator.start"}\n' }],
    [`${AGY}.jsonl.tmp`, { text: 'x\n' }],
    [`${CODEX}.0.jsonl`, { text: 'x\n' }],
  ])
}

function world(on: On, files = baseFiles(), env: Record<string, string> = { XDG_RUNTIME_DIR: XDG }): World {
  const w: World = { files, reads: [], isOpen: true, state: watchState(on) }
  mock.env(on, env)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.list', ($, e) =>
    e.path === DIR
      ? {
          value: [...w.files].map(([name, file]) => ({
            name, kind: 'file' as const, size: file.size ?? file.text.length, mtimeMs: 1, isLink: false,
          })),
        }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.read', ($, e) => {
    w.reads.push(e.path)
    const file = w.files.get(e.path.slice(DIR.length + 1))
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    if (file.error !== undefined) return { deny: file.error }
    if ((file.size ?? 0) > 4 * MIB) return { deny: 'over the 4 MiB read limit' }
    return { value: file.text }
  })
  on('fs.exists', ($, e) => ({ value: e.path === '/proc/4242' }))
  on('ui.panes', () => ({
    value: w.isOpen
      ? [{ id: 'agent-inspector', title: 'Agent Inspector', isShown: true, isFocused: true, isPlaced: true }]
      : [],
  }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  return w
}

const BOOT = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const


/** Records the plugin's `$.state` writes (the test's hook sits beneath it). */
function watchState(on: On): Map<string, unknown> {
  const values = new Map<string, unknown>()
  on('state.set', ($, e, next) => {
    const ref = e as unknown as { key: string; id?: string; value: unknown }
    values.set(ref.id === undefined ? ref.key : `${ref.key}:${ref.id}`, ref.value)
    return next(e)
  })
  return values
}

const SURFACES = ['terminal', 'desktop'] as const

test('the pane lists workers and labels agy final-only on terminal and desktop', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(BOOT)
  await clock.advance(1000)

  // Only contract names were read, each once, all under the run dir.
  expect([...w.reads].sort()).toEqual([`${DIR}/${AGY}.jsonl`, `${DIR}/${CODEX}.1.jsonl`, `${DIR}/${CODEX}.jsonl`].sort())

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector',
      props: PANE, viewport: { columns: 140, rows: 44 },
    })
    expect((await ui.find({ type: 'Box', key: `row:${AGY}` }))?.text).toMatch(/agy.*running.*\[final-only\]/)
    expect((await ui.find({ type: 'Box', key: `row:${CODEX}` }))?.text).toMatch(/codex.*gpt-5\.5.*exited 0.*\[live\]/)
    expect(await ui.find({ text: /no incremental output/ })).toBeDefined()

    // j selects the codex run; its events from segment 1 and its final answer show.
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /^\$ \/bin\/bash -lc ls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^final$/ })).toBeDefined()
    expect(await ui.find({ text: /worker reported: — · observed exit status: exit 0/ })).toBeDefined()
    await ui.press({ key: 'prev' })
    await ui.unmount()
  }
})

test('the detail names the chat and project that launched a run, or says they were not recorded', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'session-mine' }))
  const withOrigin = line({
    v: 1, type: 'orchestrator.start', run_id: CODEX, executor: 'codex', model: 'openai/gpt-5.5', label: 'codex-task',
    parent: null, workdir: '/tmp/w', pid: 4242, session_id: 'session-mine', session_title: 'Fix the router',
    project: '/home/dq/SonoranClaudeRouter', granularity: 'live', ts: '2026-10-19T17:19:00.000Z',
  })
  // agy (newest, selected first) is an old log without the fields; codex has them.
  const files = new Map<string, File>([
    [`${AGY}.jsonl`, { text: start(AGY, 'agy', null) }],
    [`${CODEX}.jsonl`, { text: withOrigin + exit(CODEX, 0, 0) }],
  ])
  const w = world(on, files)
  await $.session.start(BOOT)
  await clock.advance(1000)

  const runs = new Map((w.state.get('runs') as RunSummary[]).map(run => [run.id, run]))
  expect(runs.get(CODEX)).toMatchObject({ sessionId: 'session-mine', sessionTitle: 'Fix the router', project: '/home/dq/SonoranClaudeRouter' })
  expect(runs.get(AGY)).toMatchObject({ sessionId: null, sessionTitle: null, project: null })
  expect((w.state.get(`events:${CODEX}`) as RunEvents).items[0]?.text).toBe('started codex · model openai/gpt-5.5 · label codex-task · from chat Fix the router')

  for (const surface of SURFACES) {
    for (const bodyRows of [40, 12]) {
      const ui = await $.ui.mount({ plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector', props: { ...PANE, scroll: { offset: 0, bodyRows } } })
      expect(await ui.find({ type: 'Text', text: /^chat not recorded · project not recorded$/ })).toBeDefined()
      // Rows drop the vendor prefix of a model id; the detail keeps it.
      const row = (await ui.find({ type: 'Box', key: `row:${CODEX}` }))?.text ?? ''
      expect(row).toMatch(/codex · gpt-5\.5.*exited 0.*\[live\]/)
      expect(row).not.toMatch(/openai/)
      await ui.press({ key: 'next' })
      if (bodyRows === 40) expect(await ui.find({ type: 'Text', text: /^codex · openai\/gpt-5\.5$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Chat Fix the router \(this chat\) · Project SonoranClaudeRouter \(\/home\/dq\/SonoranClaudeRouter\)$/ })).toBeDefined()
      expect(await ui.find({ text: /chat not recorded/ })).toBeUndefined()
      await ui.press({ key: 'prev' })
      await ui.unmount()
    }
  }
})

test('nothing is read while the pane is closed, and an unchanged file is not re-read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.isOpen = false
  await $.session.start(BOOT)
  await clock.advance(3000)
  expect(w.reads).toEqual([])

  w.isOpen = true
  await clock.advance(1000)
  expect(w.reads.length).toBe(3)
  await clock.advance(2000)
  expect(w.reads.length).toBe(3)
})

test('exit after >4 MiB of partly rotated segments: exited, omitted counted, later events shown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // 6 segments were written (> 4 MiB in all); 1-2 rotated away; 4 is over the read limit.
  const files = new Map<string, File>([
    [`${BIG}.jsonl`, { text: start(BIG, 'codex', null) + exit(BIG, 3, 6) }],
    [`${BIG}.3.jsonl`, { text: line({ type: 'turn.started' }), size: 1 * MIB }],
    [`${BIG}.4.jsonl`, { text: '', size: 5 * MIB }],
    [`${BIG}.5.jsonl`, { text: message('five'), size: 1 * MIB }],
    [`${BIG}.6.jsonl`, { text: message('six'), size: 1 * MIB }],
  ])
  const w = world(on, files)
  await $.session.start(BOOT)
  await clock.advance(1000)

  const run = (w.state.get('runs') as RunSummary[])[0]!
  expect(stateLabel(run)).toBe('exited 3')
  expect(run.segmentsOmitted).toBe(3) // 1, 2 rotated away; 4 skipped
  expect(run.highestSegment).toBe(6)
  expect(w.reads).not.toContain(`${DIR}/${BIG}.4.jsonl`)

  const events = w.state.get(`events:${BIG}`) as RunEvents
  const warnings = events.items.filter(one => one.kind === 'warning').map(one => one.text)
  expect(warnings).toEqual([
    'telemetry: segments 1–2 rotated away before they were read; their events are omitted',
    'telemetry: segment 4 is 5.0 MiB, over the 4 MiB read limit; skipped',
  ])
  expect(run.warnings).toBe(2)
  expect(events.items.map(one => `${one.kind}:${one.text}`)).toEqual([
    'status:started codex · model executor default · label codex-task',
    `warning:${warnings[0]}`,
    'status:turn started',
    `warning:${warnings[1]}`,
    'message:five',
    'final:six',
    'status:exited 3 after 10s',
  ])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector', props: PANE })
    expect(await ui.find({ text: /events of 3 log segments omitted/ })).toBeDefined()
    await ui.unmount()
  }

  // Nothing changes on the next poll: no repeated warnings, no re-reads.
  const reads = w.reads.length
  await clock.advance(1000)
  expect(w.reads.length).toBe(reads)
  expect((w.state.get('runs') as RunSummary[])[0]?.warnings).toBe(2)
})

test('a live segment over the read limit does not block the lifecycle exit', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, File>([
    [`${BIG}.jsonl`, { text: start(BIG, 'pi', null) }],
    [`${BIG}.1.jsonl`, { text: '', size: 5 * MIB }],
  ])
  const w = world(on, files)
  await $.session.start(BOOT)
  await clock.advance(1000)
  let run = (w.state.get('runs') as RunSummary[])[0]!
  expect(stateLabel(run)).toBe('running')

  files.set(`${BIG}.jsonl`, { text: start(BIG, 'pi', null) + exit(BIG, 0, 1) })
  files.set(`${BIG}.1.jsonl`, { text: '', size: 5 * MIB + 10 })
  await clock.advance(1000)
  run = (w.state.get('runs') as RunSummary[])[0]!
  expect(stateLabel(run)).toBe('exited 0')
  expect(run.segmentsOmitted).toBe(1)
  expect(run.warnings).toBe(1) // the skip is warned about once
})

test('a segment rotated away after a partial read is omitted with one warning', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, File>([
    [`${BIG}.jsonl`, { text: start(BIG, 'codex', null) }],
    [`${BIG}.1.jsonl`, { text: message('one') }],
    [`${BIG}.2.jsonl`, { text: `${message('two')}{"type":"item.comp` }],
  ])
  const w = world(on, files)
  await $.session.start(BOOT)
  await clock.advance(1000)

  // Rotation: 1 (finished: 2 existed) and 2 (still open when read) are gone.
  files.delete(`${BIG}.1.jsonl`)
  files.delete(`${BIG}.2.jsonl`)
  files.set(`${BIG}.3.jsonl`, { text: message('three') })
  await clock.advance(1000)

  const run = (w.state.get('runs') as RunSummary[])[0]!
  expect(run.segmentsOmitted).toBe(1)
  expect(run.warnings).toBe(1)
  expect(stateLabel(run)).toBe('running')
  const events = w.state.get(`events:${BIG}`) as RunEvents
  expect(events.items.map(one => one.text)).toEqual([
    'started codex · model executor default · label codex-task',
    'one',
    'two',
    'telemetry: segment 2 rotated away before it was read; its events are omitted',
    'three',
  ])
})

test('a read error on one run is a warning there; the other run still advances', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, File>([
    [`${BIG}.jsonl`, { text: start(BIG, 'codex', null), error: 'EACCES: permission denied' }],
    [`${CODEX}.jsonl`, { text: start(CODEX, 'codex', 'gpt-5.5') + exit(CODEX, 0, 1) }],
    [`${CODEX}.1.jsonl`, { text: CODEX_EXEC_JSONL }],
  ])
  const w = world(on, files)
  await $.session.start(BOOT)
  await clock.advance(1000)

  const byId = async () => new Map((w.state.get('runs') as RunSummary[]).map(run => [run.id, run]))
  let runs = await byId()
  expect(stateLabel(runs.get(CODEX)!)).toBe('exited 0')
  const a = runs.get(BIG)!
  expect(a.warnings).toBe(1)
  expect(a.exit).toBeNull()
  expect(stateLabel(a)).toBe('unknown') // never "failed"
  const events = w.state.get(`events:${BIG}`) as RunEvents
  expect(events.items).toHaveLength(1)
  expect(events.items[0]?.kind).toBe('warning')
  expect(events.items[0]?.text).toMatch(/^telemetry: could not read lifecycle file \(.*EACCES: permission denied\); retrying$/)

  // The same error again is not warned twice; once readable, the run catches up.
  await clock.advance(1000)
  expect((await byId()).get(BIG)?.warnings).toBe(1)
  files.set(`${BIG}.jsonl`, { text: start(BIG, 'codex', null) })
  await clock.advance(1000)
  runs = await byId()
  expect(runs.get(BIG)?.hasStart).toBe(true)
  expect(stateLabel(runs.get(BIG)!)).toBe('running')
})

const AGY2 = '20261019T171700000Z-agy-0000ca9e'
const cappedFinal = (id: string) =>
  line({
    v: 1, type: 'orchestrator.final', run_id: id, ts: '2026-10-19T17:19:09.000Z', status: 'SUCCESS',
    response: 'a'.repeat(65536), parse_error: false, response_truncated: true, response_chars: 4500000,
  })

test('agy with a capped final response: exited 0, final and truncation warning shown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, File>([[`${AGY2}.jsonl`, { text: start(AGY2, 'agy', null) + cappedFinal(AGY2) + exit(AGY2, 0, 0) }]])
  const w = world(on, files)
  await $.session.start(BOOT)
  await clock.advance(1000)
  const run = (w.state.get('runs') as RunSummary[])[0]!
  expect(stateLabel(run)).toBe('exited 0')
  expect(run.reported).toBe('SUCCESS')
  const events = w.state.get(`events:${AGY2}`) as RunEvents
  expect(events.items.map(one => one.kind)).toEqual(['status', 'final', 'warning', 'status'])
  for (const surface of SURFACES) {
    // Taller than PANE: the bordered Usage card takes 8 rows (HOME is unset, so with its error line), the
    // detail card 7, and the 2,000-char final ~25 at the card's indented text width.
    const ui = await $.ui.mount({ plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector', props: { ...PANE, scroll: { offset: 0, bodyRows: 56 } } })
    expect((await ui.find({ type: 'Box', key: `row:${AGY2}` }))?.text).toMatch(/exited 0.*\[final-only\]/)
    expect(await ui.find({ type: 'Text', text: /^final$/ })).toBeDefined()
    expect(await ui.find({ text: /agy final response was 4500000 characters; the log keeps the first 65536/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a lifecycle file over the read limit (old uncapped log): status unknown with a clear warning', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, File>([[`${AGY2}.jsonl`, { text: '', size: 5 * MIB }]])
  const w = world(on, files)
  await $.session.start(BOOT)
  await clock.advance(1000)
  await clock.advance(1000)
  const run = (w.state.get('runs') as RunSummary[])[0]!
  expect(stateLabel(run)).toBe('unknown')
  expect(run.exit).toBeNull()
  expect(run.warnings).toBe(1) // once, not every poll
  expect(w.reads).toEqual([])
  const events = w.state.get(`events:${AGY2}`) as RunEvents
  expect(events.items.map(one => one.text)).toEqual([
    "telemetry: lifecycle file is 5.0 MiB, over the 4 MiB read limit; its start/exit records cannot be read, so this run's status is unknown (not failed)",
  ])
})

test('no XDG_RUNTIME_DIR: the pane says the log directory is unavailable', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, baseFiles(), {})
  await $.session.start(BOOT)
  await clock.advance(1000)
  expect(w.reads).toEqual([])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector', props: PANE })
    expect(await ui.find({ text: /Log directory unavailable/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/agent-inspector opens the pane and answers with text', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on)
  await $.session.start(BOOT)
  const ran = await $.command.run({
    command: 'agent-inspector', args: '',
    origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 },
  })
  expect(ran.text).toBe('Agent Inspector opened (read-only).')
})

test('/orchestrator opens the pane and leaves the skill text unchanged', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opened: string[] = []
  on('ui.open', ($, e) => (opened.push(e.id), { value: { isPlaced: true as const } }))
  on('skill.prompt', () => ({ text: 'orchestrate this' }))
  const other = await $.skill.prompt({ skill: 'commit', text: 'x' })
  expect(opened).toEqual([])
  const ran = await $.skill.prompt({ skill: 'orchestrator', text: 'x' })
  expect(ran.text).toBe('orchestrate this')
  expect(other.text).toBe('orchestrate this')
  expect(opened).toEqual(['agent-inspector'])
})
