// Pure run-log logic: names, line splitting, record -> display event mapping,
// sanitizing and bounding. No `$`, so `claude plugin test` covers it directly.
// The contract is docs/LOG_CONTRACT.md (v1).
import type {
  DisplayEvent,
  EventKind,
  Executor,
  RunEvents,
  RunSummary,
} from '../types'

export const MAX_EVENTS_PER_RUN = 200
export const MAX_RUNS = 50
/** Shown per event until expanded. */
export const SHOWN_CHARS = 2000
/** Kept per event; the expand control shows up to this. */
export const MAX_STORED_CHARS = 20000
/** `$.fs.read` rejects files over 4 MiB, so the reader stops there. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

const RUN_LOG_NAME = /^(([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{3})Z-(codex|pi|agy)-[0-9a-f]{8})\.jsonl$/

/** A contract run-log file name, or null. Every other name is ignored. */
export function parseRunLogName(
  name: string,
): { id: string; executor: Executor; startedAt: number } | null {
  const m = RUN_LOG_NAME.exec(name)
  if (m === null) return null
  const [, id, y, mo, d, h, mi, s, ms, ex] = m
  const startedAt = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, +ms!)
  if (!Number.isFinite(startedAt)) return null
  return { id: id!, executor: ex as Executor, startedAt }
}

/**
 * The complete lines of `text` past `consumed`; a trailing partial line is
 * left for the next read (its offset is not consumed).
 */
export function takeCompleteLines(
  text: string,
  consumed: number,
): { lines: string[]; consumed: number } {
  const end = text.lastIndexOf('\n')
  if (end < consumed) return { lines: [], consumed }
  const lines = text
    .slice(consumed, end)
    .split('\n')
    .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter(line => line.trim() !== '')
  return { lines, consumed: end + 1 }
}

// ESC sequences: CSI, OSC / DCS / SOS / PM / APC strings, then lone two-byte escapes.
const ANSI =
  /\x1b\[[0-?]*[ -\/]*[@-~]|\x9b[0-?]*[ -\/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|[\x90\x9d\x98\x9e\x9f][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|\x1b[ -\/]*[0-~]?/g
// C0 but \t and \n, DEL, C1, and bidi overrides / isolates.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g

/** Terminal escapes and control characters out; \n and \t stay. */
export function sanitize(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '')
}

const SECRETS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
]

/** The contract's redaction patterns, applied again before rendering. */
export function redact(text: string): string {
  return SECRETS.reduce((out, re) => out.replace(re, '[REDACTED]'), text)
}

/** Cuts to `max` characters, saying how many were left out. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [${text.length - max} more characters not kept]`
}

/** Untrusted text to display text: sanitize, redact, bound. */
export function clean(text: string, max = MAX_STORED_CHARS): string {
  return truncate(redact(sanitize(text)), max)
}

// ---------------------------------------------------------------------------
// Run state

export function newRun(name: { id: string; executor: Executor; startedAt: number }): RunSummary {
  return {
    id: name.id,
    executor: name.executor,
    model: null,
    label: null,
    parent: null,
    pid: null,
    granularity: name.executor === 'agy' ? 'final-only' : 'live',
    startedAt: name.startedAt,
    lastEventAt: null,
    exit: null,
    reported: null,
    isAlive: null,
    hasStart: false,
    warnings: 0,
    cursor: { size: 0, mtimeMs: 0, consumed: 0 },
    isTooLarge: false,
    isGone: false,
  }
}

export function emptyEvents(): RunEvents {
  return { items: [], omitted: 0, nextSeq: 0 }
}

type Draft = Omit<DisplayEvent, 'seq' | 'at'> & { at?: number }
type Mapped = { events: Draft[]; patch: Partial<RunSummary> }

/** Appends drafts, keeping the newest `cap` and counting what fell off. */
export function pushBounded(
  events: RunEvents,
  drafts: readonly DisplayEvent[],
  cap = MAX_EVENTS_PER_RUN,
): RunEvents {
  if (drafts.length === 0) return events
  const all = [...events.items, ...drafts]
  const over = Math.max(0, all.length - cap)
  const last = drafts[drafts.length - 1]!
  return { items: all.slice(over), omitted: events.omitted + over, nextSeq: last.seq + 1 }
}

/**
 * Feeds complete lines of one run's log into its summary and event buffer.
 * A malformed line is a telemetry warning on the run, never a failure.
 */
export function ingestLines(
  run: RunSummary,
  events: RunEvents,
  lines: readonly string[],
  now: number,
): { run: RunSummary; events: RunEvents } {
  let next = run
  let seq = events.nextSeq
  const out: DisplayEvent[] = []
  for (const line of lines) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      record = undefined
    }
    if (!isObject(record)) {
      next = { ...next, warnings: next.warnings + 1 }
      out.push({
        seq: seq++,
        kind: 'warning',
        at: now,
        text: `telemetry: skipped a malformed log line (${line.length} characters)`,
      })
      continue
    }
    const mapped = mapRecord(record, next)
    next = { ...next, ...mapped.patch }
    for (const draft of mapped.events) out.push({ ...draft, seq: seq++, at: draft.at ?? now })
  }
  if (lines.length > 0) next = { ...next, lastEventAt: now }
  const bounded = pushBounded(events, out)
  const hasExited = run.exit === null && next.exit !== null
  return { run: next, events: hasExited ? relabelFinal(bounded) : bounded }
}

/** On exit, the last assistant message of a live run is its final answer. */
function relabelFinal(events: RunEvents): RunEvents {
  if (events.items.some(one => one.kind === 'final')) return events
  const items = [...events.items]
  for (let i = items.length - 1; i >= 0; i--) {
    const one = items[i]!
    if (one.kind === 'message' && one.role === undefined) {
      items[i] = { ...one, kind: 'final' }
      return { ...events, items }
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Record mapping

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function tsOf(record: Obj): number | undefined {
  const ts = str(record.ts)
  const ms = ts === null ? NaN : Date.parse(ts)
  return Number.isFinite(ms) ? ms : undefined
}
function json(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}
function ev(kind: EventKind, text: string, extra: Partial<Draft> = {}): Draft {
  return { kind, text: clean(text), ...extra }
}
function textParts(content: unknown, type = 'text', field = 'text'): string {
  if (typeof content === 'string') return type === 'text' ? content : ''
  if (!Array.isArray(content)) return ''
  return content
    .filter(isObject)
    .filter(part => part.type === type)
    .map(part => str(part[field]) ?? '')
    .filter(text => text.trim() !== '')
    .join('\n')
}

/** Maps one parsed record (wrapper or provider) to display events. */
export function mapRecord(record: Obj, run: RunSummary): Mapped {
  const type = str(record.type)
  if (type === null) return { events: [ev('other', 'other: (record without a type)')], patch: {} }
  if (type.startsWith('orchestrator.')) return mapWrapper(type, record, run)
  if (run.executor === 'codex') return mapCodex(type, record)
  if (run.executor === 'pi') return mapPi(type, record, run)
  return { events: [ev('other', `other: ${type}`)], patch: {} }
}

function mapWrapper(type: string, r: Obj, run: RunSummary): Mapped {
  const at = tsOf(r)
  if (type === 'orchestrator.start') {
    const executor = str(r.executor)
    const pid = num(r.pid)
    const patch: Partial<RunSummary> = {
      hasStart: true,
      model: str(r.model) === null ? run.model : clean(str(r.model)!, 200),
      label: str(r.label) === null ? null : clean(str(r.label)!, 200),
      parent: str(r.parent) === null ? null : clean(str(r.parent)!, 200),
      pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
      // agy is final-only whatever the record says; the others as recorded.
      granularity: run.executor === 'agy' || r.granularity === 'final-only' ? 'final-only' : 'live',
    }
    if (at !== undefined) patch.startedAt = at
    const bits = [
      `started ${executor ?? run.executor}`,
      `model ${patch.model ?? 'executor default'}`,
      patch.label === null ? null : `label ${patch.label}`,
    ].filter(Boolean)
    return { events: [ev('status', bits.join(' · '), { at })], patch }
  }
  if (type === 'orchestrator.final') {
    const status = str(r.status)
    const events: Draft[] = []
    if (r.parse_error === true) {
      events.push(ev('warning', 'agy output was not JSON; no final response recorded', { at }))
    }
    const response = r.response === null || r.response === undefined ? null : json(r.response)
    events.push(
      ev('final', response ?? '(no response)', {
        at,
        role: status === null ? undefined : `reported ${clean(status, 80)}`,
      }),
    )
    return { events, patch: { reported: status === null ? run.reported : clean(status, 80) } }
  }
  if (type === 'orchestrator.exit') {
    const code = num(r.exit_code) ?? -1
    const timedOut = r.timed_out === true || code === 124
    const durationMs = num(r.duration_ms)
    const took = durationMs === null ? '' : ` after ${formatDuration(durationMs)}`
    return {
      events: [
        ev('status', timedOut ? `timed out (exit ${code})${took}` : `exited ${code}${took}`, {
          at,
          isError: code !== 0,
        }),
      ],
      patch: { exit: { code, timedOut, durationMs }, isAlive: false },
    }
  }
  return { events: [ev('other', `other: ${type}`, { at })], patch: {} }
}

function mapCodex(type: string, r: Obj): Mapped {
  const none: Mapped = { events: [], patch: {} }
  switch (type) {
    case 'thread.started':
      return { events: [ev('status', 'thread started')], patch: {} }
    case 'turn.started':
      return { events: [ev('status', 'turn started')], patch: {} }
    case 'turn.completed':
      return { events: [ev('status', `turn completed${usageText(r.usage)}`)], patch: {} }
    case 'turn.failed': {
      const message = isObject(r.error) ? str(r.error.message) : null
      return {
        events: [ev('status', `turn failed${message ? `: ${message}` : ''}`, { isError: true })],
        patch: { reported: 'turn failed' },
      }
    }
    case 'error':
      return { events: [ev('status', `error: ${str(r.message) ?? json(r)}`, { isError: true })], patch: {} }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      if (!isObject(r.item)) return { events: [ev('other', `other: ${type}`)], patch: {} }
      const one = mapCodexItem(type, r.item)
      return one === null ? none : { events: [one], patch: {} }
    }
    default:
      return { events: [ev('other', `other: ${type}`)], patch: {} }
  }
}

function mapCodexItem(type: string, item: Obj): Draft | null {
  const kind = str(item.type) ?? '?'
  const isStart = type === 'item.started'
  const isDone = type === 'item.completed'
  switch (kind) {
    case 'agent_message':
      return isDone ? ev('message', str(item.text) ?? '') : null
    case 'reasoning': {
      // Only readable content the provider supplied; nothing is synthesized.
      const text = str(item.text) ?? ''
      return isDone && text.trim() !== '' ? ev('reasoning summary', text) : null
    }
    case 'command_execution':
      if (isStart) return ev('tool call', `$ ${str(item.command) ?? ''}`)
      if (!isDone) return null
      return ev(
        'tool output',
        `${str(item.aggregated_output) ?? ''}${exitSuffix(item.exit_code, item.status)}`,
        { isError: (num(item.exit_code) ?? 0) !== 0 || item.status === 'failed' },
      )
    case 'mcp_tool_call': {
      const name = `${str(item.server) ?? '?'}.${str(item.tool) ?? '?'}`
      if (isStart) return ev('tool call', `mcp ${name} ${json(item.arguments ?? '')}`.trim())
      if (!isDone) return null
      const failed = item.error !== undefined && item.error !== null
      return ev('tool output', `${name}: ${json(failed ? item.error : (item.result ?? ''))}`, {
        isError: failed || item.status === 'failed',
      })
    }
    case 'web_search':
      if (isStart) return ev('tool call', `web search: ${str(item.query) ?? ''}`)
      return isDone ? ev('tool output', `web search done: ${str(item.query) ?? ''}`) : null
    case 'file_change': {
      const changes = Array.isArray(item.changes)
        ? item.changes
            .filter(isObject)
            .map(c => `${str(c.kind) ?? 'change'} ${str(c.path) ?? '?'}`)
            .join('\n')
        : ''
      if (isStart) return ev('tool call', `file change\n${changes}`.trim())
      return isDone
        ? ev('tool output', `file change ${str(item.status) ?? 'done'}\n${changes}`.trim(), {
            isError: item.status === 'failed',
          })
        : null
    }
    case 'todo_list': {
      const items = Array.isArray(item.items)
        ? item.items
            .filter(isObject)
            .map(t => `${t.completed === true ? '[x]' : '[ ]'} ${str(t.text) ?? ''}`)
            .join('\n')
        : ''
      return ev('status', `todo list\n${items}`.trim())
    }
    case 'error':
      return ev('status', `error: ${str(item.message) ?? ''}`, { isError: true })
    default:
      return ev('other', `other: ${type} ${kind}`)
  }
}

function exitSuffix(code: unknown, status: unknown): string {
  const n = num(code)
  if (n !== null) return `\n(exit ${n})`
  return typeof status === 'string' && status !== 'completed' ? `\n(${status})` : ''
}

function usageText(usage: unknown): string {
  if (!isObject(usage)) return ''
  const parts = [
    ['in', usage.input_tokens],
    ['cached', usage.cached_input_tokens],
    ['out', usage.output_tokens],
    ['reasoning', usage.reasoning_output_tokens],
  ]
    .filter(([, v]) => num(v) !== null)
    .map(([k, v]) => `${k} ${v}`)
  return parts.length === 0 ? '' : ` · tokens ${parts.join(', ')}`
}

const PI_SILENT = new Set(['message_start', 'message_update', 'tool_execution_update'])

function mapPi(type: string, r: Obj, run: RunSummary): Mapped {
  if (PI_SILENT.has(type)) {
    // Not shown (an empty start, token deltas, partial tool output), but the
    // assistant's model is the fallback when the start record named none.
    const model = isObject(r.message) ? str(r.message.model) : null
    return { events: [], patch: run.model === null && model ? { model: clean(model, 200) } : {} }
  }
  switch (type) {
    case 'session':
      return { events: [ev('status', 'session started')], patch: {} }
    case 'agent_start':
      return { events: [ev('status', 'agent started')], patch: {} }
    case 'turn_start':
      return { events: [ev('status', 'turn started')], patch: {} }
    case 'agent_end':
      return { events: [ev('status', 'agent ended')], patch: {} }
    case 'agent_settled':
      return { events: [ev('status', 'agent settled')], patch: {} }
    case 'turn_end': {
      const message = isObject(r.message) ? r.message : {}
      return { events: [ev('status', `turn ended${piUsage(message.usage)}`)], patch: {} }
    }
    case 'message_end':
      return mapPiMessage(isObject(r.message) ? r.message : {}, run)
    case 'tool_execution_start':
      // The call as it starts running; the assistant's toolCall content is the
      // same call, so it is not shown twice.
      return {
        events: [ev('tool call', `${str(r.toolName) ?? '?'} ${json(r.args ?? '')}`.trim())],
        patch: {},
      }
    case 'tool_execution_end': {
      const result = isObject(r.result) ? r.result : {}
      const text = textParts(result.content) || json(r.result ?? '')
      return {
        events: [ev('tool output', `${str(r.toolName) ?? '?'}: ${text}`, { isError: r.isError === true })],
        patch: {},
      }
    }
    default:
      return { events: [ev('other', `other: ${type}`)], patch: {} }
  }
}

function mapPiMessage(m: Obj, run: RunSummary): Mapped {
  const role = str(m.role)
  if (role === 'user') {
    const text = textParts(m.content)
    return { events: text ? [ev('message', text, { role: 'user' })] : [], patch: {} }
  }
  if (role !== 'assistant') return { events: [], patch: {} } // system (trimmed), toolResult (shown at tool_execution_end)
  const events: Draft[] = []
  const thinking = textParts(m.content, 'thinking', 'thinking')
  if (thinking) events.push(ev('reasoning summary', thinking))
  const text = textParts(m.content)
  if (text) events.push(ev('message', text))
  if (m.stopReason === 'error' || m.stopReason === 'aborted') {
    events.push(ev('status', `stopped: ${str(m.errorMessage) ?? str(m.stopReason)}`, { isError: true }))
  }
  const model = str(m.model)
  return { events, patch: run.model === null && model ? { model: clean(model, 200) } : {} }
}

function piUsage(usage: unknown): string {
  if (!isObject(usage)) return ''
  const parts: string[] = []
  if (num(usage.input) !== null) parts.push(`in ${usage.input}`)
  if (num(usage.output) !== null) parts.push(`out ${usage.output}`)
  const cost = isObject(usage.cost) ? num(usage.cost.total) : null
  const tokens = parts.length ? ` · tokens ${parts.join(', ')}` : ''
  return `${tokens}${cost === null ? '' : ` · cost $${cost.toFixed(4)}`}`
}

// ---------------------------------------------------------------------------
// Labels

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** running / unknown / exited N / timed out. Unknown is never "failed". */
export function stateLabel(run: RunSummary): string {
  if (run.exit !== null) return run.exit.timedOut ? 'timed out' : `exited ${run.exit.code}`
  return run.isAlive === true ? 'running' : 'unknown'
}

/** Clock time of an event, local to the plugin environment. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Newest first (run ids start with their UTC start time). */
export function orderRuns(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * Keeps at most `cap` runs: the oldest exited (or vanished) runs go first,
 * then the oldest of the rest. Returns the ids dropped.
 */
export function boundRuns(
  runs: readonly RunSummary[],
  cap = MAX_RUNS,
): { kept: RunSummary[]; dropped: string[] } {
  const ordered = orderRuns(runs)
  if (ordered.length <= cap) return { kept: ordered, dropped: [] }
  const isDone = (run: RunSummary) => run.exit !== null || run.isGone
  const oldestFirst = [...ordered].reverse()
  const victims = [...oldestFirst.filter(isDone), ...oldestFirst.filter(run => !isDone(run))]
  const dropped = new Set(victims.slice(0, ordered.length - cap).map(run => run.id))
  return { kept: ordered.filter(run => !dropped.has(run.id)), dropped: [...dropped] }
}
