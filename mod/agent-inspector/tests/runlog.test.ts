import { describe, expect, test } from 'claude-code/testing'

import type { RunSummary } from '../types'
import {
  boundRuns,
  clean,
  emptyEvents,
  ingestLines,
  MAX_EVENTS_PER_RUN,
  MAX_STORED_CHARS,
  newRun,
  parseRunLogName,
  redact,
  sanitize,
  stateLabel,
  takeCompleteLines,
} from '../hooks/runlog'
import { AGY_FINAL_JSON, CODEX_EXEC_JSONL, PI_JSON_JSONL } from './fixtures'

const NOW = Date.UTC(2026, 9, 19, 17, 20, 0)

function runFor(executor: 'codex' | 'pi' | 'agy'): RunSummary {
  const name = parseRunLogName(`20261019T171939660Z-${executor}-3f9a1c2e.jsonl`)
  if (name === null) throw new Error('fixture name did not parse')
  return newRun(name)
}

function start(executor: string, model: string | null = null): string {
  return JSON.stringify({
    v: 1,
    type: 'orchestrator.start',
    run_id: `20261019T171939660Z-${executor}-3f9a1c2e`,
    executor,
    model,
    label: 'task.md',
    parent: null,
    workdir: '/tmp/w',
    pid: 4242,
    granularity: 'live', // agy must still come out final-only
    ts: '2026-10-19T17:19:39.660Z',
  })
}

function exit(code: number): string {
  return JSON.stringify({
    v: 1,
    type: 'orchestrator.exit',
    run_id: 'x',
    ts: '2026-10-19T17:19:45.000Z',
    exit_code: code,
    timed_out: code === 124,
    duration_ms: 5340,
  })
}

function linesOf(text: string): string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

function ingest(executor: 'codex' | 'pi' | 'agy', lines: string[]) {
  return ingestLines(runFor(executor), emptyEvents(), lines, NOW)
}

describe('run-log names', () => {
  test('accepts the contract run-id and nothing else', () => {
    expect(parseRunLogName('20261019T171939660Z-pi-3f9a1c2e.jsonl')).toEqual({
      id: '20261019T171939660Z-pi-3f9a1c2e',
      executor: 'pi',
      startedAt: Date.UTC(2026, 9, 19, 17, 19, 39, 660),
    })
    for (const bad of [
      '../x.jsonl',
      '../20261019T171939660Z-pi-3f9a1c2e.jsonl',
      'x.jsonl',
      '20261019T171939660Z-pi-3f9a1c2e.jsonl.bak',
      '20261019T171939660Z-pi-3F9A1C2E.jsonl',
      '20261019T171939660Z-claude-3f9a1c2e.jsonl',
      '20261019T17193966Z-pi-3f9a1c2e.jsonl',
      '20261019T171939660Z-pi-3f9a1c2e.json',
      'sub/20261019T171939660Z-pi-3f9a1c2e.jsonl',
      '',
    ]) {
      expect(parseRunLogName(bad)).toBeNull()
    }
  })
})

describe('line splitting', () => {
  test('holds back a partial trailing line until its newline arrives', () => {
    const first = '{"type":"turn.started"}\n{"type":"item.comp'
    const a = takeCompleteLines(first, 0)
    expect(a.lines).toEqual(['{"type":"turn.started"}'])
    expect(a.consumed).toBe('{"type":"turn.started"}\n'.length)

    const same = takeCompleteLines(first, a.consumed)
    expect(same.lines).toEqual([])
    expect(same.consumed).toBe(a.consumed)

    const grown = `${first}leted"}\r\n`
    const b = takeCompleteLines(grown, a.consumed)
    expect(b.lines).toEqual(['{"type":"item.completed"}'])
    expect(b.consumed).toBe(grown.length)
  })
})

describe('record mapping', () => {
  test('codex fixture maps to the expected kinds, last message final on exit', () => {
    const { run, events } = ingest('codex', [start('codex'), ...linesOf(CODEX_EXEC_JSONL), exit(0)])
    expect(events.items.map(one => one.kind)).toEqual([
      'status', // orchestrator.start
      'status', // thread.started
      'status', // turn.started
      'message',
      'tool call',
      'tool output',
      'final', // item_2 "done", relabelled at exit
      'status', // turn.completed with usage
      'status', // orchestrator.exit
    ])
    expect(events.items[4]?.text).toBe('$ /bin/bash -lc ls')
    expect(events.items[5]?.text).toBe('a.txt\n\n(exit 0)')
    expect(events.items[6]?.text).toBe('done')
    expect(events.items[7]?.text).toContain('in 40353')
    expect(run.granularity).toBe('live')
    expect(run.exit).toEqual({ code: 0, timedOut: false, durationMs: 5340 })
    expect(stateLabel(run)).toBe('exited 0')
    expect(run.reported).toBeNull()
    expect(run.warnings).toBe(0)
  })

  test('pi fixture: message, tool call, tool output; model from the assistant', () => {
    const { run, events } = ingest('pi', [start('pi'), ...linesOf(PI_JSON_JSONL), exit(0)])
    const kinds = events.items.map(one => one.kind)
    expect(kinds).toContain('message')
    expect(kinds).toContain('tool call')
    expect(kinds).toContain('tool output')
    expect(kinds).toContain('final')
    expect(kinds).not.toContain('other')
    expect(kinds).not.toContain('reasoning summary') // the fixture has no thinking content
    const calls = events.items.filter(one => one.kind === 'tool call')
    expect(calls).toHaveLength(1) // toolCall content and tool_execution_start are one call
    expect(calls[0]?.text).toBe('bash {"command":"ls","timeout":30}')
    expect(events.items.find(one => one.kind === 'tool output')?.text).toBe('bash: a.txt\n')
    expect(events.items.find(one => one.role === 'user')?.text).toContain('Run the shell command')
    expect(events.items.find(one => one.kind === 'final')?.text).toBe('done')
    expect(events.items.some(one => one.kind === 'status' && one.text.includes('cost $'))).toBe(true)
    expect(run.model).toBe('deepseek/deepseek-v4.1-flash-1017')
  })

  test('pi thinking is a reasoning summary only when it has readable text', () => {
    const msg = (content: unknown[]) =>
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content, model: 'm' } })
    const { events } = ingest('pi', [
      msg([{ type: 'thinking', thinking: 'compare both files first' }]),
      msg([{ type: 'thinking', thinking: '' }, { type: 'toolCall', id: 'c', name: 'bash', arguments: {} }]),
    ])
    expect(events.items.map(one => one.kind)).toEqual(['reasoning summary'])
    expect(events.items[0]?.text).toBe('compare both files first')
  })

  test('agy is final-only, even while running', () => {
    const final = JSON.stringify({
      v: 1,
      type: 'orchestrator.final',
      run_id: 'x',
      ts: '2026-10-19T17:19:44.000Z',
      ...JSON.parse(AGY_FINAL_JSON),
      parse_error: false,
    })
    const running = ingest('agy', [start('agy')])
    expect(running.run.granularity).toBe('final-only')
    expect(running.run.exit).toBeNull()

    const { run, events } = ingest('agy', [start('agy'), final, exit(0)])
    expect(events.items.map(one => one.kind)).toEqual(['status', 'final', 'status'])
    expect(events.items[1]?.text).toBe('done')
    expect(run.granularity).toBe('final-only')
    expect(run.reported).toBe('SUCCESS') // worker-reported, kept apart from...
    expect(run.exit?.code).toBe(0) // ...the observed exit status
  })

  test('a timed-out run says so', () => {
    const { run } = ingest('codex', [start('codex'), exit(124)])
    expect(stateLabel(run)).toBe('timed out')
  })

  test('a malformed line is a telemetry warning, not a failure', () => {
    const { run, events } = ingest('codex', [start('codex'), '{"type":"turn.sta', '[1,2]', '{"type":"turn.started"}'])
    expect(events.items.map(one => one.kind)).toEqual(['status', 'warning', 'warning', 'status'])
    expect(run.warnings).toBe(2)
    expect(run.exit).toBeNull()
    expect(stateLabel(run)).toBe('unknown') // pid not seen alive yet: unknown, never failed
  })

  test('unknown record types become a compact other row', () => {
    const { events } = ingest('codex', ['{"type":"brand.new","payload":"x"}', '{"no":"type"}'])
    expect(events.items.map(one => one.text)).toEqual(['other: brand.new', 'other: (record without a type)'])
  })
})

describe('untrusted text', () => {
  test('strips ANSI and control characters, keeps newline and tab', () => {
    const raw = '\x1b[31mred\x1b[0m\x1b]0;evil title\x07 ok\tTAB\nnext\r\x07\x00\x9b2J‮end'
    expect(sanitize(raw)).toBe('red ok\tTAB\nnextend')
  })

  test('redacts the contract secret patterns', () => {
    const raw = [
      'key sk-abcdefghijklmnopqrstuvwxyz012345',
      'gh ghp_abcdefghijklmnopqrstuvwxyz',
      'pat github_pat_abcdefghijklmnopqrstuv_123',
      'g AIzaabcdefghijklmnopqrstuvwxyz012345678',
      's xoxb-1234567890-abc',
      'fine sk-short',
    ].join('\n')
    expect(redact(raw)).toBe(
      [
        'key [REDACTED]',
        'gh [REDACTED]',
        'pat [REDACTED]',
        'g [REDACTED]',
        's [REDACTED]',
        'fine sk-short',
      ].join('\n'),
    )
  })

  test('secrets split by escapes are still redacted, and long text is cut', () => {
    expect(clean('sk-\x1b[0mabcdefghijklmnopqrstuvwxyz')).toBe('[REDACTED]')
    const long = clean('a'.repeat(MAX_STORED_CHARS + 10))
    expect(long.startsWith('a'.repeat(MAX_STORED_CHARS))).toBe(true)
    expect(long).toContain('[10 more characters not kept]')
  })
})

describe('bounds', () => {
  test('keeps the newest events per run and counts the omitted', () => {
    const lines = Array.from({ length: 250 }, () => '{"type":"turn.started"}')
    const { events } = ingest('codex', lines)
    expect(events.items).toHaveLength(MAX_EVENTS_PER_RUN)
    expect(events.omitted).toBe(50)
    expect(events.items[0]?.seq).toBe(50)
    expect(events.nextSeq).toBe(250)
  })

  test('drops the oldest exited runs first', () => {
    const id = (minute: number) => `20261019T17${minute}000000Z-pi-0000000${minute}`
    const run = (minute: number, isExited: boolean): RunSummary => ({
      ...newRun({ id: id(minute), executor: 'pi', startedAt: minute }),
      exit: isExited ? { code: 0, timedOut: false, durationMs: 1 } : null,
    })
    const { kept, dropped } = boundRuns([run(1, false), run(2, true), run(3, true), run(4, false)], 2)
    expect(dropped.sort()).toEqual([id(2), id(3)])
    expect(kept.map(one => one.id)).toEqual([id(4), id(1)])
  })
})
