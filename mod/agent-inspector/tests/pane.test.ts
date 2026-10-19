import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { CODEX_EXEC_JSONL } from './fixtures'

const NOW = Date.UTC(2026, 9, 19, 17, 20, 0)
const XDG = '/run/user/1000'
const DIR = `${XDG}/orchestrator`
const AGY = '20261019T171939660Z-agy-3f9a1c2e'
const CODEX = '20261019T171900000Z-codex-0badc0de'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Agent Inspector',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const start = (id: string, executor: string, model: string | null) =>
  JSON.stringify({
    v: 1, type: 'orchestrator.start', run_id: id, executor, model, label: `${executor}-task`,
    parent: null, workdir: '/tmp/w', pid: 4242, granularity: executor === 'agy' ? 'final-only' : 'live',
    ts: '2026-10-19T17:19:00.000Z',
  })

const FILES: Record<string, string> = {
  // agy still running: start record only, no output until it exits.
  [`${AGY}.jsonl`]: `${start(AGY, 'agy', null)}\n`,
  // codex finished: start, the real provider sample, exit, plus a partial line.
  [`${CODEX}.jsonl`]:
    `${start(CODEX, 'codex', 'gpt-5.5')}\n${CODEX_EXEC_JSONL}` +
    `${JSON.stringify({ v: 1, type: 'orchestrator.exit', run_id: CODEX, ts: '2026-10-19T17:19:10.000Z', exit_code: 0, timed_out: false, duration_ms: 10000 })}\n` +
    '{"type":"partial',
  // Ignored: not contract names.
  'notes.jsonl': '{"type":"orchestrator.start"}\n',
  [`${AGY}.jsonl.tmp`]: 'x\n',
}

type World = { reads: string[]; isOpen: boolean }

function world(on: On, env: Record<string, string> = { XDG_RUNTIME_DIR: XDG }): World {
  const state: World = { reads: [], isOpen: true }
  mock.env(on, env)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.list', ($, e) =>
    e.path === DIR
      ? {
          value: Object.entries(FILES).map(([name, text]) => ({
            name, kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false,
          })),
        }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.read', ($, e) => {
    state.reads.push(e.path)
    const text = FILES[e.path.slice(DIR.length + 1)]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: e.path === '/proc/4242' }))
  on('ui.panes', () => ({
    value: state.isOpen
      ? [{ id: 'agent-inspector', title: 'Agent Inspector', isShown: true, isFocused: true, isPlaced: true }]
      : [],
  }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  return state
}

const SURFACES = ['terminal', 'desktop'] as const

test('the pane lists workers and labels agy final-only on terminal and desktop', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  // Only contract names were read, each at most once, all under the run dir.
  expect([...w.reads].sort()).toEqual([`${DIR}/${AGY}.jsonl`, `${DIR}/${CODEX}.jsonl`].sort())

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'agent-inspector', surface, component: 'Pane', requestId: 'agent-inspector',
      props: PANE, viewport: { columns: 140, rows: 44 },
    })
    expect(await ui.find({ type: 'Button', key: `sel:${AGY}` })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: `sel:${AGY}` }))?.text).toMatch(/agy.*running.*\[final-only\]/)
    expect((await ui.find({ type: 'Button', key: `sel:${CODEX}` }))?.text).toMatch(/codex.*gpt-5\.5.*exited 0.*\[live\]/)
    expect(await ui.find({ text: /no incremental output/ })).toBeDefined()

    // j selects the codex run; its final answer and tool call are shown.
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /^\$ \/bin\/bash -lc ls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^final$/ })).toBeDefined()
    expect(await ui.find({ text: /worker reported: — · observed exit status: exit 0/ })).toBeDefined()
    await ui.press({ key: 'prev' })
    await ui.unmount()
  }
})

test('nothing is read while the pane is closed, and an unchanged file is not re-read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.isOpen = false
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(w.reads).toEqual([])

  w.isOpen = true
  await clock.advance(1000)
  const first = w.reads.length
  expect(first).toBe(2)
  await clock.advance(2000)
  expect(w.reads.length).toBe(first)
})

test('no XDG_RUNTIME_DIR: the pane says the log directory is unavailable', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, {})
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
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
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({
    command: 'agent-inspector', args: '',
    origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 },
  })
  expect(ran.text).toBe('Agent Inspector opened (read-only).')
})
