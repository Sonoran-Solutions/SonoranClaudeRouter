// Agent Inspector: a read-only pane over the orchestrator's per-run logs
// ($XDG_RUNTIME_DIR/orchestrator/<run-id>.jsonl, docs/LOG_CONTRACT.md) and
// over the Claude-native agents `agent.spawn` / `$.agent.list()` expose.
//
// Read-only by construction: it hooks session.start, command.run (its own
// command), skill.prompt (opens the pane for /orchestrator; the skill text is
// untouched), agent.spawn (observe only, pass-through) and ui.render (its own
// pane). It never writes files, steers, cancels or gates. The one process it
// runs is the orchestrator's read-only status script usage.sh (via
// $.process.run, only while the pane is placed) for the Usage section.
import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  BoxProps,
  ElementConstructor,
  EngineInterface,
  Register,
  RenderElement,
  TextProps,
} from 'claude-code'

import type {
  ClaudeAgent,
  DisplayEvent,
  InspectorStatus,
  InspectorView,
  RunEvents,
  RunSummary,
  ScriptUsage,
  UsageRow,
  UsageState,
  UsageWindow,
} from '../types'
import type { ListedFile, ListedRun } from './reader'
import { advanceRunFiles } from './reader'
import type { RunLogName } from './runlog'
import {
  boundRuns,
  clean,
  clockTime,
  emptyEvents,
  formatDuration,
  MAX_RUNS,
  MAX_STORED_CHARS,
  newRun,
  orderRuns,
  parseRunLogName,
  pushBounded,
  SHOWN_CHARS,
  stateLabel,
} from './runlog'

const PANE = 'agent-inspector'
const TITLE = 'Agent Inspector'
const POLL_MS = 1000
/** No new line for this long reads "quiet", which is not "stalled". */
const QUIET_MS = 30_000
// ponytail: fixed 5-minute cadence and a hardcoded script path. Ceiling: a user
// with another skills dir or a different cadence edits these two constants;
// upgrade path is a userConfig field (plugin.json) read with $.settings.
const USAGE_REFRESH_MS = 5 * 60_000
/** The marker an event cut to fit its room ends with. */
const CUT_MARKER = '… [x to expand]'
/** Below this many body rows the Usage section is a single line. */
const COMPACT_BELOW_ROWS = 24
const USAGE_SCRIPT = '.claude/skills/orchestrator/scripts/usage.sh' // under $HOME

// ---------------------------------------------------------------------------
// Pane budget: how many rows each section may take, so the drawing never
// outgrows the body (supported minimum: 12 rows x 70 columns).

export type PaneBudgetInput = {
  rows: number
  width: number
  hasNotice: boolean
  hasUsageError: boolean
  groups: number
  ids: number
  selection: 'none' | 'run' | 'claude'
}

export type PaneBudget = { isCompact: boolean; isRoomy: boolean; fixed: number; listRoom: number; eventRoom: number }

/** From this many body rows the Usage section and the detail are bordered cards and the header has a subtitle. */
const ROOMY_FROM_ROWS = 32
/** One-line fields of a run's detail (title, stats, origin, times, result) outside compact mode. */
const RUN_DETAIL_ROWS = 5
/** One-line fields of a Claude agent's detail. */
const CLAUDE_DETAIL_ROWS = 4

/**
 * The rows every non-list section claims, one per rendered line (each fixed
 * line is drawn truncated), borders included, so the drawing never outgrows
 * the body. Three tiers: compact (< 24 rows: one line per section, no borders,
 * no separator), medium (a separator line, no borders) and roomy (>= 32 rows:
 * a subtitle, and the Usage section and the detail as bordered cards).
 */
export function paneBudget(input: PaneBudgetInput): PaneBudget {
  const { rows, width, hasNotice, hasUsageError, groups, ids, selection } = input
  const isCompact = rows < COMPACT_BELOW_ROWS
  const isRoomy = rows >= ROOMY_FROM_ROWS
  const border = isRoomy ? 2 : 0
  const header = isRoomy ? 2 : 1
  const usage = isCompact ? 1 : 5 + (hasUsageError ? 1 : 0) + border
  const separator = isCompact || isRoomy ? 0 : 1
  const controls = isCompact ? 1 : width < 70 ? 2 : 1
  // Compact: a run gets its status line plus its origin line, a Claude agent one
  // line (its other lines only use the unused event room); otherwise a card.
  const summary =
    selection === 'none' ? 1 : isCompact ? (selection === 'run' ? 2 : 1) : (selection === 'run' ? RUN_DETAIL_ROWS : CLAUDE_DETAIL_ROWS) + border
  const fixed = header + (hasNotice ? 1 : 0) + usage + separator + controls + summary
  const spare = rows - fixed - groups
  const cap = Math.max(3, Math.floor(rows / 3))
  const listRoom = Math.max(1, Math.min(cap, spare - 3, ids))
  let eventRoom = Math.max(isCompact ? 1 : 3, spare - Math.min(listRoom, ids))
  if (fixed + groups + Math.min(listRoom, ids) + eventRoom > rows) eventRoom -= 1
  return { isCompact, isRoomy, fixed, listRoom, eventRoom }
}

const RUNS = atom({ plugin: 'agent-inspector', key: 'runs' } as const, [])
const CLAUDE = atom({ plugin: 'agent-inspector', key: 'claude' } as const, [])
const VIEW = atom({ plugin: 'agent-inspector', key: 'view' } as const, {
  selected: null,
  anchorSeq: null,
  isExpanded: false,
})
const STATUS = atom({ plugin: 'agent-inspector', key: 'status' } as const, {
  dir: 'pending',
  detail: null,
  polledAt: null,
  dropped: [],
})
const USAGE = atom({ plugin: 'agent-inspector', key: 'usage' } as const, {
  claude: [],
  script: null,
  updatedAt: null,
  attemptedAt: null,
  isRefreshing: false,
  error: null,
})
const EVENTS = { plugin: 'agent-inspector', key: 'events' } as const

type $ = EngineInterface

async function readEvents($: $, id: string): Promise<RunEvents> {
  const { value } = await $.state.get({ ...EVENTS, id })
  return value ?? emptyEvents()
}

// ---------------------------------------------------------------------------
// Polling

let isPolling = false // ponytail: per-environment re-entry guard; a reload starts a fresh one.

async function poll($: $): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    // Cheap when nobody looks: one host call, no file system work.
    const panes = await $.ui.panes()
    if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) return
    const now = await $.clock.now()
    await refreshClaude($, now)
    await refreshUsage($, now)
    await pollRunLogs($, now)
  } catch (error) {
    // Monitoring degrades; nothing else is touched.
    const detail = clean(error instanceof Error ? error.message : String(error), 300)
    await update($, STATUS, (s): InspectorStatus => ({ ...s, dir: 'error', detail }))
  } finally {
    isPolling = false
  }
}

// ---------------------------------------------------------------------------
// Usage: Claude's windows every tick (free); usage.sh (10-70 s) in the
// background, at most once at a time, never while the pane is not placed.

let isUsageRunning = false // ponytail: per-environment guard, like isPolling.

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}
const win = (label: string, used: unknown, resets?: unknown, scope?: string): UsageWindow[] => {
  const usedPct = num(used)
  return usedPct === null ? [] : [{ label, usedPct, resetsAt: time(resets), ...(scope === undefined ? {} : { scope }) }]
}

/** One agy window per group from its tighter (larger) of 5h and week. */
function groupWin(label: string, g: Record<string, unknown>): UsageWindow[] {
  const fiveHour = num(g.five_hour_used_pct)
  const weekly = num(g.weekly_used_pct)
  if (fiveHour === null && weekly === null) return []
  const isFiveHour = fiveHour !== null && (weekly === null || fiveHour > weekly)
  return isFiveHour
    ? [{ label, usedPct: fiveHour, resetsAt: null, scope: '5h' }]
    : [{ label, usedPct: weekly as number, resetsAt: time(g.weekly_resets_at), scope: 'week' }]
}

function row(p: Record<string, unknown>, windows: UsageWindow[]): UsageRow {
  if (p.status === 'ok' && windows.length > 0) return { windows, note: null }
  const status = typeof p.status === 'string' ? p.status : 'unknown'
  return { windows: [], note: clean(`${status} — ${typeof p.note === 'string' ? p.note : 'no figures reported'}`, 200) }
}

/** Throws on stdout that is not the script's JSON; everything else is tolerated. */
function parseUsage(stdout: string): ScriptUsage {
  const last = stdout.trim().split('\n').pop() ?? ''
  let json: unknown
  try {
    json = JSON.parse(last)
  } catch {
    throw new Error('usage.sh printed no JSON')
  }
  const root = obj(json)
  const isSection = (v: unknown): boolean => typeof obj(v).status === 'string'
  // Valid JSON with no provider sections at all is not a snapshot: keep the last good one.
  if (![root.codex, root.google, root.openrouter].some(isSection)) throw new Error('usage.sh printed malformed JSON (no provider sections)')
  const codex = obj(root.codex)
  const hours = num(codex.window_h)
  const label = hours === 168 ? 'week' : hours === 5 ? '5h' : hours === null ? 'window' : `${hours}h`
  const agy = obj(root.google)
  const groups: [string, string][] = [['gemini', 'gemini'], ['claude/gpt', 'claude_gpt'], ['argon', 'argon']]
  let agyWindows = groups.flatMap(([name, key]) => groupWin(name, obj(agy[key])))
  if (agyWindows.length === 0) agyWindows = win('agy', agy.used_pct, undefined, 'overall')
  const or = obj(root.openrouter)
  const remaining = num(or.credits_remaining_usd)
  return {
    codex: row(codex, [...win(label, codex.used_pct, codex.resets_at), ...(hours === 168 ? [] : win('week', codex.secondary_used_pct))]),
    agy: row(agy, agyWindows),
    openrouter:
      or.status === 'ok' && remaining !== null
        ? { credits: { remainingUsd: remaining, spentTodayUsd: num(or.spent_today_usd), usedPct: num(or.used_pct) }, note: null }
        : { credits: null, note: row(or, []).note },
  }
}

async function refreshUsage($: $, now: number): Promise<void> {
  try {
    const { rateLimits } = await $.session.usage()
    const claude = rateLimits.flatMap(limit =>
      win(limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? 'week' : clean(limit.kind, 30), limit.percentUsed, limit.resetsAt),
    )
    await update($, USAGE, (u): UsageState => ({ ...u, claude }))
  } catch {
    // Keep what is shown; Claude's figures are best effort.
  }
  const { attemptedAt } = await read($, USAGE)
  if (attemptedAt === null || now - attemptedAt >= USAGE_REFRESH_MS) void runUsageScript($, now)
}

async function runUsageScript($: $, now: number): Promise<void> {
  if (isUsageRunning) return
  isUsageRunning = true
  try {
    await update($, USAGE, (u): UsageState => ({ ...u, isRefreshing: true, attemptedAt: now }))
    const home = await $.env.get('HOME')
    if (home === undefined || !home.startsWith('/')) throw new Error('HOME is not set')
    const result = await $.process.run(['bash', `${home.replace(/\/+$/, '')}/${USAGE_SCRIPT}`], { timeoutMs: 180_000 })
    if (result.exitCode !== 0) throw new Error(`usage.sh exited ${result.exitCode}`)
    const script = parseUsage(result.stdout)
    const updatedAt = await $.clock.now()
    await update($, USAGE, (u): UsageState => ({ ...u, script, updatedAt, error: null }))
  } catch (error) {
    const detail = clean(error instanceof Error ? error.message : String(error), 200)
    await update($, USAGE, (u): UsageState => ({ ...u, error: detail })).catch(() => {})
  } finally {
    isUsageRunning = false
    await update($, USAGE, (u): UsageState => ({ ...u, isRefreshing: false })).catch(() => {})
  }
}

function refreshNow($: $): void {
  void $.clock.now().then(now => runUsageScript($, now))
}

async function pollRunLogs($: $, now: number): Promise<void> {
  const xdg = await $.env.get('XDG_RUNTIME_DIR')
  if (xdg === undefined || !xdg.startsWith('/')) {
    // The contract has no fallback path, and neither does the reader.
    await update($, STATUS, (s): InspectorStatus => ({ ...s, dir: 'unavailable', detail: 'XDG_RUNTIME_DIR is not set', polledAt: now }))
    return
  }
  const dir = `${xdg.replace(/\/+$/, '')}/orchestrator`

  let entries
  try {
    entries = await $.fs.list(dir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isMissing = /ENOENT|no such file|not found/i.test(message)
    await update($, STATUS, (s): InspectorStatus => ({
      ...s,
      dir: isMissing ? 'missing' : 'error',
      detail: isMissing ? `${dir} does not exist yet` : clean(message, 300),
      polledAt: now,
    }))
    return
  }

  // Only contract names, only regular files (no links): a read path is the
  // directory plus a name that matched the run-id pattern, never file content.
  const files = new Map<string, { name: RunLogName; lifecycle: ListedFile | null; segments: Map<number, ListedFile> }>()
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.isLink) continue
    const name = parseRunLogName(entry.name)
    if (name === null) continue
    const run = files.get(name.id) ?? { name, lifecycle: null, segments: new Map() }
    const listed = { size: entry.size, mtimeMs: entry.mtimeMs }
    if (name.segment === null) run.lifecycle = listed
    else run.segments.set(name.segment, listed)
    files.set(name.id, run)
  }

  const status = await read($, STATUS)
  const dropped = new Set(status.dropped.filter(id => files.has(id)))
  const known = new Map<string, RunSummary>()
  for (const run of await read($, RUNS)) {
    // A summary from before the segmented layout (hot reload): start that run over.
    if (run.segments === undefined || run.lifecycle === undefined) {
      await $.state.set({ ...EVENTS, id: run.id }, emptyEvents())
      continue
    }
    known.set(run.id, run)
  }
  for (const [id, file] of files) {
    if (!known.has(id) && !dropped.has(id)) known.set(id, newRun(file.name))
  }
  const bounded = boundRuns([...known.values()])
  for (const id of bounded.dropped) {
    dropped.add(id)
    await $.state.set({ ...EVENTS, id }, emptyEvents())
  }

  // One run's failure never starves the others: RUNS and STATUS update every poll.
  const runs: RunSummary[] = []
  for (const run of bounded.kept) runs.push(await advanceRunSafely($, dir, run, files.get(run.id), now))

  await update($, RUNS, () => runs)
  await update($, STATUS, (): InspectorStatus => ({ dir: 'ok', detail: null, polledAt: now, dropped: [...dropped] }))
}

async function advanceRunSafely($: $, dir: string, run: RunSummary, listed: ListedRun | undefined, now: number): Promise<RunSummary> {
  try {
    return await advanceRun($, dir, run, listed, now)
  } catch (error) {
    // Keep the previous summary and cursors (retried next poll); say so on the run.
    const text = `telemetry: could not update this run (${clean(error instanceof Error ? error.message : String(error), 300)}); retrying`
    try {
      const events = await readEvents($, run.id)
      await $.state.set({ ...EVENTS, id: run.id }, pushBounded(events, [{ seq: events.nextSeq, kind: 'warning', at: now, text }]))
    } catch {
      // The warning count below still says it.
    }
    return { ...run, warnings: run.warnings + 1 }
  }
}

async function advanceRun($: $, dir: string, run: RunSummary, listed: ListedRun | undefined, now: number): Promise<RunSummary> {
  const events = await readEvents($, run.id)
  // ponytail: $.fs has no ranged read in 2.1.299, so a changed file is read
  // whole and sliced at its consumed offset. Ceiling: 4 MiB per file (segments
  // stay near 2 x ORCH_RUNLOG_SEGMENT_BYTES); a ranged read would lift it.
  const io = { read: (path: string) => $.fs.read(path) }
  const advanced = await advanceRunFiles(io, dir, run, events, listed, now)
  if (advanced.events !== events) await $.state.set({ ...EVENTS, id: run.id }, advanced.events)
  let next = advanced.run

  if (next.exit === null && next.pid !== null && !next.isGone) {
    // Read-only liveness: does /proc/<pid> exist (pid is a validated integer).
    const isAlive = await $.fs.exists(`/proc/${next.pid}`).catch(() => null)
    if (isAlive !== next.isAlive) next = { ...next, isAlive }
  }
  return next
}

// ---------------------------------------------------------------------------
// Claude-native agents: only what agent.spawn and $.agent.list() expose.

async function refreshClaude($: $, now: number): Promise<void> {
  let live: AgentInfo[]
  try {
    live = await $.agent.list()
  } catch {
    return
  }
  await update($, CLAUDE, list => {
    const byId = new Map(list.map(agent => [agent.id, agent]))
    for (const info of live) {
      const had = byId.get(info.id)
      byId.set(info.id, {
        id: info.id,
        type: clean(info.type, 120),
        description: clean(info.description, 300),
        model: had?.model ?? null,
        parentId: info.parentId ?? had?.parentId ?? null,
        status: info.status,
        spawnedAt: had?.spawnedAt ?? now,
      })
    }
    const liveIds = new Set(live.map(info => info.id))
    const merged = [...byId.values()].map(agent =>
      liveIds.has(agent.id) || agent.status === 'no longer listed'
        ? agent
        : { ...agent, status: 'no longer listed' },
    )
    return boundClaude(merged)
  })
}

function boundClaude(list: ClaudeAgent[]): ClaudeAgent[] {
  const newest = [...list].sort((a, b) => (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0))
  return newest.slice(0, MAX_RUNS)
}

async function recordSpawn(
  $: $,
  e: { subagentType: string; description: string; parentAgentId?: string },
  agentId: string,
  model: string,
): Promise<void> {
  const now = await $.clock.now()
  await update($, CLAUDE, list =>
    boundClaude([
      {
        id: agentId,
        type: clean(e.subagentType, 120),
        description: clean(e.description, 300),
        model: clean(model, 120),
        parentId: e.parentAgentId ?? null,
        status: 'spawned',
        spawnedAt: now,
      },
      ...list.filter(agent => agent.id !== agentId),
    ]),
  )
}

// ---------------------------------------------------------------------------
// Selection and scrolling (handlers read fresh state, never draw-time values)

async function selectableIds($: $): Promise<string[]> {
  const runs = orderRuns(await read($, RUNS))
  const claude = await read($, CLAUDE)
  return [...runs.map(run => run.id), ...claude.map(agent => `claude:${agent.id}`)]
}

function currentSelection(view: InspectorView, ids: readonly string[]): string | null {
  return view.selected !== null && ids.includes(view.selected) ? view.selected : (ids[0] ?? null)
}

async function moveSelection($: $, step: number): Promise<void> {
  const ids = await selectableIds($)
  if (ids.length === 0) return
  await update($, VIEW, view => {
    const at = ids.indexOf(currentSelection(view, ids) ?? '')
    const to = Math.min(ids.length - 1, Math.max(0, at + step))
    return { ...view, selected: ids[to] ?? null, anchorSeq: null }
  })
}

async function scrollEvents($: $, step: number): Promise<void> {
  const ids = await selectableIds($)
  const selected = currentSelection(await read($, VIEW), ids)
  if (selected === null || selected.startsWith('claude:')) return
  const { items } = await readEvents($, selected)
  if (items.length === 0) return
  const seqs = items.map(one => one.seq)
  await update($, VIEW, view => {
    const at = view.anchorSeq === null ? seqs.length - 1 : Math.max(0, seqs.findIndex(seq => seq >= view.anchorSeq!))
    const to = Math.min(seqs.length - 1, Math.max(0, at + step))
    return { ...view, anchorSeq: seqs[to] ?? null }
  })
}

async function toggleFollow($: $): Promise<void> {
  const view = await read($, VIEW)
  // Off: hold the window where it stands (the newest event now); on: follow the tail.
  if (view.anchorSeq === null) await scrollEvents($, 0)
  else await update($, VIEW, v => ({ ...v, anchorSeq: null }))
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-inspector',
      description: 'Open the read-only Agent Inspector pane (orchestrator workers and Claude agents)',
    })
    // A reload drops an in-flight usage.sh with the old environment; clear its flag.
    await update($, USAGE, (u): UsageState => ({ ...u, isRefreshing: false }))
    // Timers die with this environment on reload; session.start runs again then.
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'agent-inspector' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced
        ? 'Agent Inspector opened (read-only).'
        : `Agent Inspector is open but not drawn yet: ${opened.reason}`,
    }
  })

  // `/orchestrator` (typed or via the Skill tool) opens the pane. The skill's
  // text passes through untouched; opening is best effort and never fails it.
  on('skill.prompt', { skill: 'orchestrator' }, async ($, e, next) => {
    const result = await next(e)
    try {
      await $.ui.open({ id: PANE, title: TITLE })
    } catch {
      // No surface to open on; the skill runs as before.
    }
    return result
  })

  // Observe only. `next(e)` is called exactly once, first; its result is
  // returned as is and its rejection propagates unchanged (the await rethrows).
  // Bookkeeping runs after it inside try/catch, so it can never fail the hook.
  // Deliberately no `.catch`: without one, a hook that fails after `next` is
  // skipped with its last `next` standing (nothing re-dispatched), and one
  // asked beneath its own frame (re-entry) is left out, so the spawn passes
  // straight through. A handler could only add a second path to `next`.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny === undefined && result.agentId !== undefined) {
        await recordSpawn($, e, result.agentId, result.model)
      }
    } catch {
      // Bookkeeping only; the spawn's result is unaffected.
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [runsRaw, claude, view, status, usage] = await Promise.all([
      read($, RUNS),
      read($, CLAUDE),
      read($, VIEW),
      read($, STATUS),
      read($, USAGE),
    ])
    const now = await $.clock.now()
    let me: string | null = null
    try {
      me = await $.session.id()
    } catch {
      // The origin line shows without "(this chat)".
    }
    const runs = orderRuns(runsRaw)
    const ids = [...runs.map(run => run.id), ...claude.map(agent => `claude:${agent.id}`)]
    const selected = currentSelection(view, ids)
    const width = Math.max(24, e.props.bodyColumns)
    const rows = Math.max(1, e.props.scroll.bodyRows)
    const notice = dirNotice(status)
    const hasError = usage.error !== null

    // Fixed rows first (header, notice, usage, separator, run detail, controls);
    // the worker list and the event list share what is left (see paneBudget).
    // Every fixed row is drawn on exactly one line (truncated at the edge).
    const groups = (runs.length > 0 ? 1 : 0) + (claude.length > 0 ? 1 : 0)
    const budget = paneBudget({
      rows,
      width,
      hasNotice: notice !== null,
      hasUsageError: hasError,
      groups,
      ids: ids.length,
      selection: selected === null ? 'none' : selected.startsWith('claude:') ? 'claude' : 'run',
    })
    const { isCompact, isRoomy } = budget
    const truncate = 'truncate-end' as const
    // Inside a card: a round border and one column of padding on each side.
    const inner = isRoomy ? width - 4 : width
    const cardProps = (borderColor: string) => (isRoomy ? { borderStyle: 'round', borderColor, paddingX: 1 } : {})
    const window = listWindow(ids, selected, budget.listRoom)
    const runRows = runs.filter(run => window.includes(run.id))
    const claudeRows = claude.filter(agent => window.includes(`claude:${agent.id}`))

    // Header: title and a "● N running" chip; a dim subtitle on roomy panes.
    const running = runs.filter(run => stateLabel(run) === 'running').length + claude.filter(agent => agent.status === 'running').length
    const chip = `${running > 0 ? '●' : '○'} ${running} running`
    const counts = `${runs.length} run${runs.length === 1 ? '' : 's'} · ${claude.length} Claude agent${claude.length === 1 ? '' : 's'}`
    const polled = status.polledAt === null ? '' : ` · polled ${clockTime(status.polledAt)}`
    const chipText = <Text color={running > 0 ? 'success' : 'inactive'}>{chip}</Text>
    const header = isRoomy ? (
      <Box key="head" flexDirection="column">
        {splitRow(
          Box,
          'title',
          <Text bold wrap={truncate}>
            {TITLE}
          </Text>,
          <Text wrap={truncate}>{chipText}</Text>,
        )}
        <Text dimColor wrap={truncate}>
          Read-only view of delegated workers · {counts}
          {polled}
        </Text>
      </Box>
    ) : (
      splitRow(
        Box,
        'head',
        <Text wrap={truncate}>
          <Text bold>{TITLE}</Text>
          <Text dimColor> · read-only · {counts}</Text>
        </Text>,
        <Text wrap={truncate}>
          {chipText}
          <Text dimColor>{polled}</Text>
        </Text>,
      )
    )

    const refresh = (
      <Button key="refresh" plain hotkey="r" label={usage.isRefreshing ? 'refreshing…' : isCompact ? '↻' : 'refresh'} onPress={() => refreshNow($)} />
    )
    const usageSection = isCompact ? (
      compactUsage(Text, Box, usage, refresh)
    ) : (
      <Box key="usage" flexDirection="column" {...cardProps('subtle')}>
        <Box flexDirection="row" columnGap={1}>
          <Text bold>Usage</Text>
          <Text dimColor wrap={truncate}>
            · remaining · {usage.updatedAt === null ? 'not loaded yet' : `updated ${clockTime(usage.updatedAt)} (${span(now - usage.updatedAt)} ago)`}
          </Text>
          {refresh}
        </Box>
        {hasError && (
          <Text color="error" wrap={truncate}>
            usage.sh: {usage.error} (showing the last good figures)
          </Text>
        )}
        {usageRows(Text, Box, usage, now, inner >= 96)}
      </Box>
    )

    const controls = (
      <Box flexDirection="row" flexWrap={isCompact ? 'nowrap' : 'wrap'} columnGap={1}>
        <Button key="prev" plain hotkey="k" label={isCompact ? 'k' : 'prev'} onPress={() => moveSelection($, -1)} />
        <Button key="next" plain hotkey="j" label={isCompact ? 'j' : 'next'} onPress={() => moveSelection($, 1)} />
        <Button key="older" plain hotkey="u" label={isCompact ? 'u' : 'older'} onPress={() => scrollEvents($, -5)} />
        <Button key="newer" plain hotkey="d" label={isCompact ? 'd' : 'newer'} onPress={() => scrollEvents($, 5)} />
        <Button
          key="follow"
          plain
          hotkey="f"
          label={isCompact ? (view.anchorSeq === null ? 'f on' : 'f off') : view.anchorSeq === null ? 'follow: on' : 'follow: off'}
          onPress={() => toggleFollow($)}
        />
        <Button
          key="expand"
          plain
          hotkey="x"
          label={isCompact ? (view.isExpanded ? 'x on' : 'x off') : view.isExpanded ? 'expand: on' : 'expand: off'}
          onPress={() => update($, VIEW, v => ({ ...v, isExpanded: !v.isExpanded }))}
        />
      </Box>
    )

    let detail: RenderElement | null = null
    if (selected === null) {
      detail = (
        <Text dimColor wrap={truncate}>
          {emptyText(status)}
        </Text>
      )
    } else if (selected.startsWith('claude:')) {
      const agent = claude.find(one => `claude:${one.id}` === selected)
      // Compact: one budgeted line; the rest only fills the event room it leaves unused.
      const lines = agent === undefined ? [] : claudeDetail(Text, Box, agent).slice(0, isCompact ? 1 + budget.eventRoom : CLAUDE_DETAIL_ROWS)
      detail = (
        <Box key="detail" flexDirection="column" {...cardProps('claude')}>
          {lines}
        </Box>
      )
    } else {
      const run = runs.find(one => one.id === selected)!
      const events = await readEvents($, run.id)
      const summary = isCompact
        ? [runDetailLine(Text, run, now), originLine(Text, run, me)]
        : runDetail(Text, Box, run, events, view, now, me)
      detail = (
        <Box key="detail" flexDirection="column" {...cardProps('claude')}>
          {summary}
          {eventList(Text, Box, events, view, budget, inner, run.segmentsOmitted ?? 0)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {header}
        {notice !== null && (
          <Text color="warning" wrap={truncate}>
            {notice}
          </Text>
        )}
        {usageSection}
        {runRows.length > 0 && sectionTitle(Text, 'External workers', runs.length)}
        {runRows.map(run => {
          const isSelected = run.id === selected
          const chat = width >= 100 && run.sessionTitle ? ` · ${run.sessionTitle}` : ''
          return (
            <Box key={`row:${run.id}`} flexDirection="row" columnGap={1}>
              {/* Left: marker, dot and the pressable executor stay whole; the rest truncates. */}
              <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                <Box flexDirection="row" flexShrink={0}>
                  <Text color="claude" bold>
                    {isSelected ? '▸ ' : '  '}
                  </Text>
                  <Text color={stateColor(run)}>● </Text>
                  <Button
                    key={`sel:${run.id}`}
                    plain
                    label={run.executor}
                    onPress={() => update($, VIEW, v => ({ ...v, selected: run.id, anchorSeq: null }))}
                  />
                </Box>
                <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                  <Text wrap={truncate}>
                    <Text bold> · {shortModel(run.model) ?? 'default model'}</Text>
                    {'  '}
                    {run.label ?? run.id.slice(-8)}
                    <Text dimColor>{chat}</Text>
                  </Text>
                </Box>
              </Box>
              {/* Right: fixed-width columns, so they line up on a proportional font too. */}
              <Box flexDirection="row" flexShrink={0} columnGap={2}>
                <Box flexDirection="row" width={7} justifyContent="flex-end">
                  <Text dimColor wrap={truncate}>
                    {runtime(run, now)}
                  </Text>
                </Box>
                <Box flexDirection="row" width={13}>
                  <Text wrap={truncate}>
                    <Text color={stateColor(run)}>{stateLabel(run)}</Text>
                    {run.warnings > 0 ? <Text color="warning"> ⚠{run.warnings}</Text> : ''}
                  </Text>
                </Box>
                <Box flexDirection="row" width={12}>
                  <Text color={run.granularity === 'final-only' ? 'warning' : 'subtle'} wrap={truncate}>
                    [{run.granularity}]
                  </Text>
                </Box>
              </Box>
            </Box>
          )
        })}
        {claudeRows.length > 0 && sectionTitle(Text, 'Claude agents', claude.length)}
        {claudeRows.map(agent => {
          const isSelected = `claude:${agent.id}` === selected
          return (
            <Box key={`row:claude:${agent.id}`} flexDirection="row" columnGap={1}>
              <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                <Box flexDirection="row" flexShrink={0}>
                  <Text color="claude" bold>
                    {isSelected ? '▸ ' : '  '}
                  </Text>
                  <Text color={agentColor(agent)}>● </Text>
                  <Button
                    key={`sel:claude:${agent.id}`}
                    plain
                    label={agent.type}
                    onPress={() => update($, VIEW, v => ({ ...v, selected: `claude:${agent.id}`, anchorSeq: null }))}
                  />
                </Box>
                <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                  <Text wrap={truncate}>
                    <Text bold> · {shortModel(agent.model) ?? 'model not reported'}</Text>
                    {'  '}
                    {agent.description}
                  </Text>
                </Box>
              </Box>
              <Box flexDirection="row" flexShrink={0}>
                <Text color={agentColor(agent)} wrap={truncate}>
                  {agent.status ?? 'status not reported'}
                </Text>
              </Box>
            </Box>
          )
        })}
        {!isCompact && !isRoomy && <Text dimColor wrap={truncate}>{'─'.repeat(width)}</Text>}
        {detail}
        {controls}
      </Box>
    )
  })
}

// ---------------------------------------------------------------------------
// Drawing helpers (the element constructors come from the surface's table)

type TextC = ElementConstructor<TextProps>
type BoxC = ElementConstructor<BoxProps>

/**
 * One line, `left` filling what `right` leaves and truncated by the layout,
 * `right` never shrunk: aligned on the terminal and on a proportional font.
 */
function splitRow(Box: BoxC, key: string, left: RenderElement, right: RenderElement): RenderElement {
  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        {left}
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        {right}
      </Box>
    </Box>
  )
}

/** A model id without its vendor prefix (`deepseek/deepseek-v4.1-flash` -> `deepseek-v4.1-flash`), for rows. */
function shortModel(model: string | null): string | null {
  return model === null ? null : model.slice(model.lastIndexOf('/') + 1) || model
}

function sectionTitle(Text: TextC, title: string, count: number): RenderElement {
  return (
    <Text wrap="truncate-end">
      <Text bold>{title}</Text>
      <Text dimColor> · {count}</Text>
    </Text>
  )
}

/** "1h 8m", "5d 12h": a coarse span for resets and ages. */
function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Wall time of a run: its recorded duration once exited, else time since its start. */
function runtime(run: RunSummary, now: number): string {
  if (run.exit === null) return formatDuration(now - run.startedAt)
  return run.exit.durationMs === null ? '—' : formatDuration(run.exit.durationMs)
}

/** Same thresholds as the orchestrator's routing; `usedPct` and `remainingUsd` are optional. */
function usageColor(usedPct: number | null, remainingUsd?: number): string {
  if ((usedPct ?? 0) >= 95 || (remainingUsd ?? Infinity) < 1) return 'error'
  if ((usedPct ?? 0) >= 80 || (remainingUsd ?? Infinity) < 5) return 'warning'
  return 'success'
}

const METER_CELLS = 10

/** A remaining-share bar (`████░░░░░░ `); blank cells when nothing is known. */
function meter(Text: TextC, usedPct: number | null, remainingUsd?: number): RenderElement {
  if (usedPct === null) return <Text> </Text>
  const filled = Math.max(0, Math.min(METER_CELLS, Math.round(((100 - usedPct) / 100) * METER_CELLS)))
  return (
    <Text>
      <Text color={usageColor(usedPct, remainingUsd)}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(METER_CELLS - filled)} </Text>
    </Text>
  )
}

/** Fixed-width name and bar columns, so bars and figures line up on a proportional font too. */
function usageRow(Text: TextC, Box: BoxC, name: string, key: string, bar: RenderElement | null, body: RenderElement | null, note: string | null): RenderElement {
  return (
    <Box key={`usage:${key}`} flexDirection="row">
      <Box flexDirection="row" width={12} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {name}
        </Text>
      </Box>
      {bar === null ? (
        ''
      ) : (
        <Box flexDirection="row" width={METER_CELLS + 1} flexShrink={0}>
          {bar}
        </Box>
      )}
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        {body === null ? (
          <Text dimColor wrap="truncate-end">
            {note}
          </Text>
        ) : (
          <Text wrap="truncate-end">{body}</Text>
        )}
      </Box>
    </Box>
  )
}

/** Remaining, not used. `compact` (agy): "gemini 60% (week) · argon 100% (week) left", no resets. */
function windowsBody(Text: TextC, windows: readonly UsageWindow[], now: number, compact: boolean): RenderElement | null {
  if (windows.length === 0) return null
  return (
    <Text>
      {windows.map((w, i) => (
        <Text key={w.label}>
          {i > 0 ? ' · ' : ''}
          {w.label} <Text color={usageColor(w.usedPct)}>{Math.max(0, Math.round(100 - w.usedPct))}%</Text>
          {compact ? (w.scope !== undefined ? ` (${w.scope})` : '') : ' left'}
          {!compact && w.resetsAt !== null ? <Text dimColor> (resets {span(w.resetsAt - now)})</Text> : ''}
        </Text>
      ))}
      {compact ? ' left' : ''}
    </Text>
  )
}

/** Tightest window of a provider: the one with the least left. */
const tightest = (windows: readonly UsageWindow[]): UsageWindow | undefined => windows.reduce<UsageWindow | undefined>((a, w) => (a === undefined || w.usedPct > a.usedPct ? w : a), undefined)

/** One line: "Usage · Claude 49% · Codex 69% · agy 0% (5h) · OR $16.31 · r" (remaining; ? when unknown). */
function compactUsage(Text: TextC, Box: BoxC, usage: UsageState, refresh: RenderElement): RenderElement {
  const s = usage.script
  const T = ({ children, ...props }: { children: RenderElement | string; dimColor?: boolean; color?: string; bold?: boolean }) => (
    <Text wrap="truncate-end" {...props}>
      {children}
    </Text>
  )
  const pct = (name: string, windows: readonly UsageWindow[], withScope = false): RenderElement => {
    const w = tightest(windows)
    if (w === undefined)
      return (
        <Text dimColor wrap="truncate-end">
          {name} ?
        </Text>
      )
    return (
      <Text wrap="truncate-end">
        {name}{' '}
        <Text color={usageColor(w.usedPct)}>{Math.max(0, Math.round(100 - w.usedPct))}%</Text>
        {withScope && w.scope !== undefined ? ` (${w.scope})` : ''}
      </Text>
    )
  }
  const credits = s?.openrouter.credits ?? null
  return (
    <Box key="usage:compact" flexDirection="row" flexWrap="nowrap" columnGap={1}>
      <T bold>Usage</T>
      <T dimColor>·</T>
      {pct('Claude', usage.claude)}
      <T dimColor>·</T>
      {pct('Codex', s?.codex.windows ?? [])}
      <T dimColor>·</T>
      {pct('agy', s?.agy.windows ?? [], true)}
      <T dimColor>·</T>
      {credits === null ? (
        <T dimColor>OR ?</T>
      ) : (
        <Text wrap="truncate-end">
          OR <Text color={usageColor(null, credits.remainingUsd)}>${credits.remainingUsd.toFixed(2)}</Text>
        </Text>
      )}
      {usage.error !== null && <T dimColor>· error</T>}
      {refresh}
    </Box>
  )
}

/** The four provider rows, each one truncated line; `withMeter` adds a bar of the tightest window. */
function usageRows(Text: TextC, Box: BoxC, usage: UsageState, now: number, withMeter: boolean): RenderElement {
  const s: ScriptUsage | null = usage.script
  const pending = usage.isRefreshing ? 'loading…' : 'not loaded yet'
  const credits = s?.openrouter.credits ?? null
  const bar = (windows: readonly UsageWindow[]) => (withMeter ? meter(Text, tightest(windows)?.usedPct ?? null) : null)
  return (
    <Box flexDirection="column">
      {usageRow(Text, Box, 'Claude', 'claude', bar(usage.claude), windowsBody(Text, usage.claude, now, false), 'no rate-limit windows reported (not on a subscription, or no API response yet)')}
      {usageRow(Text, Box, 'Codex', 'codex', bar(s?.codex.windows ?? []), windowsBody(Text, s?.codex.windows ?? [], now, false), s === null ? pending : s.codex.note)}
      {usageRow(Text, Box, 'Antigravity', 'agy', bar(s?.agy.windows ?? []), windowsBody(Text, s?.agy.windows ?? [], now, true), s === null ? pending : s.agy.note)}
      {usageRow(
        Text,
        Box,
        'OpenRouter',
        'openrouter',
        withMeter ? meter(Text, credits?.usedPct ?? null, credits?.remainingUsd) : null,
        credits === null ? null : (
          <Text>
            <Text color={usageColor(null, credits.remainingUsd)}>${credits.remainingUsd.toFixed(2)}</Text> left
            {credits.spentTodayUsd !== null ? ` · $${credits.spentTodayUsd.toFixed(2)} spent today` : ''}
          </Text>
        ),
        s === null ? pending : s.openrouter.note,
      )}
    </Box>
  )
}

function dirNotice(status: InspectorStatus): string | null {
  if (status.dir === 'unavailable') return `Log directory unavailable (${status.detail}); external runs are not shown.`
  if (status.dir === 'error') return `Could not read run logs: ${status.detail}`
  return null
}

function emptyText(status: InspectorStatus): string {
  if (status.dir === 'pending') return 'Reading run logs…'
  if (status.dir === 'unavailable') return 'No external runs can be shown without a log directory.'
  if (status.dir === 'missing') return `No orchestrator runs yet (${status.detail}).`
  return 'No orchestrator runs yet.'
}

function listWindow(ids: readonly string[], selected: string | null, room: number): string[] {
  if (ids.length <= room) return [...ids]
  const at = Math.max(0, ids.indexOf(selected ?? ''))
  const start = Math.min(Math.max(0, at - Math.floor(room / 2)), ids.length - room)
  return ids.slice(start, start + room)
}

function stateColor(run: RunSummary): string {
  if (run.exit === null) return run.isAlive === true ? 'success' : 'subtle'
  return run.exit.code === 0 ? 'success' : 'error'
}

function agentColor(agent: ClaudeAgent): string {
  if (agent.status === 'running') return 'success'
  return agent.status === 'no longer listed' ? 'inactive' : 'subtle'
}

/**
 * "Chat <title> (this chat) · Project <basename> (<path>)": which Claude Code
 * chat launched the run, from its start record. Old logs recorded neither, and
 * a summary from before these fields (hot reload) has them undefined.
 */
function originLine(Text: TextC, run: RunSummary, me: string | null): RenderElement {
  const id = run.sessionId ?? null
  const title = run.sessionTitle ?? null
  const project = run.project ?? null
  const chat = title ?? (id === null ? null : `untitled chat ${id.slice(0, 8)}`)
  const base = project === null ? null : project.replace(/\/+$/, '').split('/').pop() || project
  return (
    <Text key="origin" wrap="truncate-end">
      {chat === null ? (
        <Text dimColor>chat not recorded</Text>
      ) : (
        <Text>
          <Text dimColor>Chat </Text>
          {chat}
        </Text>
      )}
      {id !== null && id === me ? <Text color="success"> (this chat)</Text> : ''}
      <Text dimColor> · </Text>
      {base === null ? (
        <Text dimColor>project not recorded</Text>
      ) : (
        <Text>
          <Text dimColor>Project </Text>
          {base}
          <Text dimColor> ({project})</Text>
        </Text>
      )}
    </Text>
  )
}

/** RUN_DETAIL_ROWS one-line fields: title and chips, stats, origin, times, result. */
function runDetail(
  Text: TextC,
  Box: BoxC,
  run: RunSummary,
  events: RunEvents,
  view: InspectorView,
  now: number,
  me: string | null,
): RenderElement[] {
  const wrap = 'truncate-end' as const
  const last = run.lastEventAt
  const quiet = last !== null && now - last >= QUIET_MS && run.exit === null
  const freshness =
    last === null
      ? 'no events seen yet'
      : `last event seen ${clockTime(last)} (${formatDuration(now - last)} ago${quiet ? ', quiet — not necessarily stalled' : ''})`
  const state = stateLabel(run)
  const stateNote =
    state === 'unknown'
      ? run.pid === null
        ? ' · unknown is not failed: no exit record and no wrapper pid'
        : ' · unknown is not failed: no exit record and the wrapper is not seen alive'
      : ''
  const exit = run.exit === null ? '—' : run.exit.timedOut ? `timed out (exit ${run.exit.code})` : `exit ${run.exit.code}`
  const isFinalOnly = run.granularity === 'final-only'

  // Title: executor · model, label on the left; state, granularity, follow chips on the right.
  // The full model id here; rows drop the vendor prefix.
  const isFollowing = view.anchorSeq === null

  // Stats from what the mod has: events seen, tool calls among the kept events, wall time, freshness.
  const isPartial = events.omitted > 0 || run.segmentsOmitted > 0
  const toolCalls = events.items.filter(one => one.kind === 'tool call').length
  const stat = (key: string, value: string, color?: string) => (
    <Text key={key}>
      <Text dimColor>{key} </Text>
      <Text bold color={color}>
        {value}
      </Text>
      {'   '}
    </Text>
  )
  return [
    splitRow(
      Box,
      'title',
      <Text wrap={wrap}>
        <Text bold>
          {run.executor} · {run.model ?? 'executor default model'}
        </Text>
        {'  '}
        {run.label ?? 'no label'}
      </Text>,
      <Text wrap={wrap}>
        <Text color={stateColor(run)}>● {state}</Text>
        {'  '}
        <Text color={isFinalOnly ? 'warning' : 'subtle'}>{run.granularity}</Text>
        {'  '}
        <Text color={isFollowing ? 'success' : 'warning'}>{isFollowing ? '● following' : '○ follow off'}</Text>
      </Text>,
    ),
    <Text key="stats" wrap={wrap}>
      {stat('Events', `${events.items.length + events.omitted}${run.segmentsOmitted > 0 ? '+' : ''}`)}
      {isFinalOnly ? '' : stat('Tool calls', `${isPartial ? '≥' : ''}${toolCalls}`)}
      {stat('Runtime', runtime(run, now))}
      {stat('Last event', last === null ? 'none' : `${formatDuration(now - last)} ago`, quiet ? 'warning' : undefined)}
      {run.warnings > 0 ? stat('Warnings', String(run.warnings), 'warning') : ''}
      {isFinalOnly ? <Text dimColor>final-only: no incremental output; a final record after exit</Text> : ''}
    </Text>,
    originLine(Text, run, me),
    <Text key="times" dimColor wrap={wrap}>
      started {clockTime(run.startedAt)} ({formatDuration(now - run.startedAt)} ago) · {freshness} · parent {run.parent ?? 'not available'}
    </Text>,
    <Text key="result" dimColor wrap={wrap}>
      worker reported: {run.reported ?? '—'} · observed exit status: {exit}
      {run.isGone ? ' · log file removed' : ''}
      {run.segmentsOmitted > 0 ? ` · segments omitted: ${run.segmentsOmitted}` : ''}
      {stateNote}
    </Text>,
  ]
}

/** The compact run summary: one truncated line instead of runDetail's five. */
function runDetailLine(Text: TextC, run: RunSummary, now: number): RenderElement {
  const last = run.lastEventAt
  return (
    <Text key="status" wrap="truncate-end">
      <Text color={stateColor(run)}>{stateLabel(run)}</Text> · <Text color={run.granularity === 'final-only' ? 'warning' : 'subtle'}>{run.granularity}</Text> · last event{' '}
      {last === null ? 'none' : `${formatDuration(now - last)} ago`} · reported {run.reported ?? '—'}
    </Text>
  )
}

const KIND_STYLE: Record<string, { color: string; glyph: string }> = {
  message: { color: 'text', glyph: '●' },
  'reasoning summary': { color: 'remember', glyph: '◦' },
  'tool call': { color: 'suggestion', glyph: '»' },
  'tool output': { color: 'subtle', glyph: '│' },
  status: { color: 'inactive', glyph: '·' },
  final: { color: 'success', glyph: '✓' },
  warning: { color: 'warning', glyph: '▲' },
  other: { color: 'inactive', glyph: '?' },
}

/** Event text sits under the kind, past the "HH:MM:SS  " column (outside compact mode). */
const EVENT_INDENT = 10
/** Tool output lines carry a "│ " gutter. */
const OUTPUT_GUTTER = '│ '

/**
 * Hard-wraps `text` into lines of at most `width` characters (newlines
 * respected, an empty line is one empty chunk) and keeps the first `maxRows`.
 * When anything is left out the last line ends with CUT_MARKER, still within
 * `width`.
 */
export function fitLines(text: string, width: number, maxRows: number): { lines: string[]; isCut: boolean } {
  const w = Math.max(1, width)
  const lines: string[] = []
  let isCut = false
  outer: for (const line of text.split('\n')) {
    const chunks = Math.max(1, Math.ceil(line.length / w))
    for (let i = 0; i < chunks; i++) {
      if (lines.length >= maxRows) {
        isCut = true
        break outer
      }
      lines.push(line.slice(i * w, (i + 1) * w))
    }
  }
  if (isCut && lines.length > 0) {
    const last = lines.length - 1
    lines[last] = `${lines[last]!.slice(0, Math.max(0, w - CUT_MARKER.length)).trimEnd()}${CUT_MARKER}`.slice(0, w)
  }
  return { lines, isCut }
}

function eventList(
  Text: TextC,
  Box: BoxC,
  events: RunEvents,
  view: InspectorView,
  budget: PaneBudget,
  width: number,
  segmentsOmitted: number,
): RenderElement {
  const isCompact = budget.isCompact
  const wrap = 'truncate-end' as const
  const items = events.items
  const lost =
    segmentsOmitted > 0
      ? `events of ${segmentsOmitted} log segment${segmentsOmitted === 1 ? '' : 's'} omitted (rotated away or over the read limit; not counted)`
      : ''
  if (items.length === 0) return <Text dimColor wrap={wrap}>{lost || 'No events yet.'}</Text>
  const end =
    view.anchorSeq === null
      ? items.length
      : Math.max(1, items.findIndex(one => one.seq > view.anchorSeq!) === -1 ? items.length : items.findIndex(one => one.seq > view.anchorSeq!))
  const below = items.length - end
  const limit = view.isExpanded ? MAX_STORED_CHARS : SHOWN_CHARS
  // Text is wrapped at the room it is drawn in: the pane (or card) width, less
  // the indent under the timestamp and the tool output gutter.
  const isOutput = (one: DisplayEvent) => one.kind === 'tool output'
  const textWidth = (one: DisplayEvent) => width - (isCompact ? 0 : EVENT_INDENT) - (isOutput(one) ? OUTPUT_GUTTER.length : 0)
  // One row for the "older" notices (when there may be any) and one for the
  // "below" line come off the room before the events are fitted.
  const hasOlderRow = end > 1 || events.omitted > 0 || segmentsOmitted > 0
  let left = budget.eventRoom - (hasOlderRow ? 1 : 0) - (below > 0 ? 1 : 0)
  // The first (newest) event must fit too: if it does not, its text is cut so the
  // header and the text fit in the rows left. One that does not fit even then is
  // dropped (the "more above" note says so). Compact events and tool output are
  // drawn as the pre-wrapped lines counted here, so rendered rows equal counted rows.
  const fitted: DisplayEvent[] = []
  const shownLines = new Map<number, string[]>()
  for (let i = end - 1; i >= 0; i--) {
    const one = items[i]!
    const text = shownText(one, limit)
    const all = fitLines(text, textWidth(one), Infinity).lines
    const cost = 1 + all.length
    if (cost > left) {
      if (fitted.length === 0 && left >= 2) {
        fitted.unshift(one)
        shownLines.set(one.seq, fitLines(text, textWidth(one), left - 1).lines)
      }
      break
    }
    fitted.unshift(one)
    if (isCompact || isOutput(one)) shownLines.set(one.seq, all)
    left -= cost
  }
  const above = end - fitted.length
  const older = [
    above > 0 ? `${above} more above (u to scroll)` : '',
    events.omitted > 0 ? `${events.omitted} older event${events.omitted === 1 ? '' : 's'} omitted (only the newest ${items.length} are kept)` : '',
    lost,
  ].filter(Boolean)
  const line = (one: DisplayEvent, text: string, n: number) => (
    <Text key={`evline:${one.seq}:${n}`} wrap="truncate-end" dimColor={isOutput(one)}>
      {isOutput(one) ? `${OUTPUT_GUTTER}${text}` : text}
    </Text>
  )
  return (
    <Box flexDirection="column">
      {older.length > 0 && <Text key="ev:older" dimColor wrap={wrap}>{older.join(' · ')}</Text>}
      {fitted.map(one => {
        const style = KIND_STYLE[one.kind] ?? KIND_STYLE.other!
        const color = one.isError ? 'error' : style.color
        const lines = shownLines.get(one.seq)
        return (
          <Box key={`ev:${one.seq}`} flexDirection="column">
            <Text wrap="truncate-end">
              <Text dimColor>{clockTime(one.at)}  </Text>
              <Text color={color}>{style.glyph} </Text>
              <Text bold color={color}>
                {one.kind}
              </Text>
              {one.role !== undefined ? <Text dimColor> ({one.role})</Text> : ''}
            </Text>
            {isCompact ? (
              lines!.map((text, n) => line(one, text, n))
            ) : (
              <Box flexDirection="column" paddingLeft={EVENT_INDENT}>
                {lines === undefined ? (
                  <Text>{shownText(one, limit)}</Text>
                ) : isOutput(one) ? (
                  lines.map((text, n) => line(one, text, n))
                ) : (
                  <Text>{lines.join('\n')}</Text>
                )}
              </Box>
            )}
          </Box>
        )
      })}
      {below > 0 && <Text key="ev:below" dimColor wrap={wrap}>{below} newer event{below === 1 ? '' : 's'} below (f to follow)</Text>}
    </Box>
  )
}

function shownText(one: DisplayEvent, limit: number): string {
  if (one.text.length <= limit) return one.text
  return `${one.text.slice(0, limit)}… [${one.text.length - limit} more; x to expand]`
}

/** CLAUDE_DETAIL_ROWS one-line fields; the caller keeps as many as it has room for. */
function claudeDetail(Text: TextC, Box: BoxC, agent: ClaudeAgent): RenderElement[] {
  const wrap = 'truncate-end' as const
  return [
    splitRow(
      Box,
      'title',
      <Text bold wrap={wrap}>
        Claude agent · {agent.type} · {agent.model ?? 'model not reported'}
      </Text>,
      <Text color={agentColor(agent)} wrap={wrap}>
        ● {agent.status ?? 'status not reported'}
      </Text>,
    ),
    <Text key="description" wrap={wrap}>
      {agent.description || '(no description)'}
    </Text>,
    <Text key="ids" dimColor wrap={wrap}>
      id {agent.id} · parent {agent.parentId ?? 'main conversation'}
      {agent.spawnedAt !== null ? ` · seen ${clockTime(agent.spawnedAt)}` : ''}
    </Text>,
    <Text key="note" dimColor wrap={wrap}>
      Only what agent.spawn and the agent list expose; open its transcript from the tasks list.
    </Text>,
  ]
}
