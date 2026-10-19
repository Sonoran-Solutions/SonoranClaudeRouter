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

export type PaneBudget = { isCompact: boolean; fixed: number; listRoom: number; eventRoom: number }

/**
 * The rows every non-list section claims, one per rendered line in compact
 * mode and the full-sized sections above it.
 */
export function paneBudget(input: PaneBudgetInput): PaneBudget {
  const { rows, width, hasNotice, hasUsageError, groups, ids, selection } = input
  const isCompact = rows < COMPACT_BELOW_ROWS
  const usage = isCompact ? 1 : 5 + (hasUsageError ? 1 : 0)
  const controls = isCompact ? 1 : width < 70 ? 2 : 1
  // claudeDetail and runDetail are 4 lines; compact panes draw one line each.
  const summary = selection === 'none' ? 1 : isCompact ? 1 : 4
  const fixed = 1 + (hasNotice ? 1 : 0) + usage + 1 + controls + summary
  const spare = rows - fixed - groups
  const cap = Math.max(3, Math.floor(rows / 3))
  const listRoom = Math.max(1, Math.min(cap, spare - 3, ids))
  let eventRoom = Math.max(isCompact ? 1 : 3, spare - Math.min(listRoom, ids))
  if (fixed + groups + Math.min(listRoom, ids) + eventRoom > rows) eventRoom -= 1
  return { isCompact, fixed, listRoom, eventRoom }
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
    const runs = orderRuns(runsRaw)
    const ids = [...runs.map(run => run.id), ...claude.map(agent => `claude:${agent.id}`)]
    const selected = currentSelection(view, ids)
    const width = Math.max(24, e.props.bodyColumns)
    const rows = Math.max(1, e.props.scroll.bodyRows)
    // Short panes: Usage collapses to one line so the event list keeps its room, and
    // every fixed row is drawn on exactly one line (truncated at the edge).
    const isCompact = rows < COMPACT_BELOW_ROWS
    const truncate = isCompact ? ('truncate-end' as const) : undefined
    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold wrap={truncate}>
          {TITLE} <Text dimColor>· read-only · {runs.length} run{runs.length === 1 ? '' : 's'} · {claude.length} Claude agent{claude.length === 1 ? '' : 's'}</Text>
        </Text>
        {status.polledAt !== null && <Text dimColor wrap={truncate}>polled {clockTime(status.polledAt)}</Text>}
      </Box>
    )

    const notice = dirNotice(status)

    const refresh = (
      <Button key="refresh" plain hotkey="r" label={usage.isRefreshing ? 'refreshing…' : isCompact ? 'r' : 'r refresh'} onPress={() => refreshNow($)} />
    )
    const usageHeader = (
      <Box flexDirection="row" columnGap={1}>
        <Text bold>Usage</Text>
        <Text dimColor>
          · {usage.updatedAt === null ? 'not loaded yet' : `updated ${clockTime(usage.updatedAt)} (${span(now - usage.updatedAt)} ago)`}
        </Text>
        {refresh}
      </Box>
    )

    // Fixed rows first (header, notice, usage, separator, controls, run detail
    // summary); the worker list and the event list share what is left (see
    // paneBudget).
    const hasError = usage.error !== null
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
    const window = listWindow(ids, selected, budget.listRoom)
    const runRows = runs.filter(run => window.includes(run.id))
    const claudeRows = claude.filter(agent => window.includes(`claude:${agent.id}`))

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
      detail = agent === undefined ? null : claudeDetail(Text, Box, agent, truncate)
    } else {
      const run = runs.find(one => one.id === selected)!
      const events = await readEvents($, run.id)
      const summary = isCompact ? runDetailLine(Text, run, now) : runDetail(Text, Box, run, now)
      detail = (
        <Box flexDirection="column">
          {summary}
          {eventList(Text, Box, events, view, budget, width, run.segmentsOmitted ?? 0)}
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
        {isCompact ? compactUsage(Text, Box, usage, refresh) : usageHeader}
        {!isCompact && hasError && <Text color="error">usage.sh: {usage.error} (showing the last good figures)</Text>}
        {!isCompact && usageRows(Text, Box, usage, now)}
        {runRows.length > 0 && (
          <Text dimColor wrap={truncate}>
            External workers
          </Text>
        )}
        {runRows.map(run => (
          <Box key={`row:${run.id}`} flexDirection="row" columnGap={1}>
            <Button
              key={`sel:${run.id}`}
              plain
              label={`${run.id === selected ? '▸' : ' '} ${run.executor}`}
              onPress={() => update($, VIEW, v => ({ ...v, selected: run.id, anchorSeq: null }))}
            />
            <Text wrap={truncate}>
              <Text dimColor>{run.model ?? 'default model'}</Text> {run.label ?? run.id.slice(-8)}{' '}
              <Text dimColor>{formatDuration(now - run.startedAt)}</Text> <Text color={stateColor(run)}>{stateLabel(run)}</Text>{' '}
              <Text color={run.granularity === 'final-only' ? 'warning' : 'subtle'}>[{run.granularity}]</Text>
              {run.warnings > 0 ? <Text color="warning"> ⚠{run.warnings}</Text> : ''}
            </Text>
          </Box>
        ))}
        {claudeRows.length > 0 && (
          <Text dimColor wrap={truncate}>
            Claude agents
          </Text>
        )}
        {claudeRows.map(agent => (
          <Box key={`row:claude:${agent.id}`} flexDirection="row" columnGap={1}>
            <Button
              key={`sel:claude:${agent.id}`}
              plain
              label={`${`claude:${agent.id}` === selected ? '▸' : ' '} ${agent.type}`}
              onPress={() => update($, VIEW, v => ({ ...v, selected: `claude:${agent.id}`, anchorSeq: null }))}
            />
            <Text wrap={truncate}>
              <Text dimColor>{agent.model ?? 'model not reported'}</Text> {agent.description}{' '}
              <Text dimColor>{agent.status ?? 'status not reported'}</Text>
            </Text>
          </Box>
        ))}
        <Text dimColor>{'─'.repeat(Math.min(width, 80))}</Text>
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

/** "1h 8m", "5d 12h": a coarse span for resets and ages. */
function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Same thresholds as the orchestrator's routing; `usedPct` and `remainingUsd` are optional. */
function usageColor(usedPct: number | null, remainingUsd?: number): string {
  if ((usedPct ?? 0) >= 95 || (remainingUsd ?? Infinity) < 1) return 'error'
  if ((usedPct ?? 0) >= 80 || (remainingUsd ?? Infinity) < 5) return 'warning'
  return 'success'
}

function usageRow(Text: TextC, Box: BoxC, name: string, key: string, body: RenderElement | null, note: string | null): RenderElement {
  return (
    <Box key={`usage:${key}`} flexDirection="row">
      <Text dimColor>{name.padEnd(12)}</Text>
      {body ?? <Text dimColor>{note}</Text>}
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

function usageRows(Text: TextC, Box: BoxC, usage: UsageState, now: number): RenderElement {
  const s: ScriptUsage | null = usage.script
  const pending = usage.isRefreshing ? 'loading…' : 'not loaded yet'
  const credits = s?.openrouter.credits ?? null
  return (
    <Box flexDirection="column">
      {usageRow(Text, Box, 'Claude', 'claude', windowsBody(Text, usage.claude, now, false), 'no rate-limit windows reported (not on a subscription, or no API response yet)')}
      {usageRow(Text, Box, 'Codex', 'codex', windowsBody(Text, s?.codex.windows ?? [], now, false), s === null ? pending : s.codex.note)}
      {usageRow(Text, Box, 'Antigravity', 'agy', windowsBody(Text, s?.agy.windows ?? [], now, true), s === null ? pending : s.agy.note)}
      {usageRow(
        Text,
        Box,
        'OpenRouter',
        'openrouter',
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

function runDetail(Text: TextC, Box: BoxC, run: RunSummary, now: number): RenderElement {
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
        ? ' (no exit record and no wrapper pid; not a failure)'
        : ' (no exit record and the wrapper is not seen alive; not a failure)'
      : ''
  const exit = run.exit === null ? '—' : run.exit.timedOut ? `timed out (exit ${run.exit.code})` : `exit ${run.exit.code}`
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{run.executor}</Text> · {run.model ?? 'executor default model'} · {run.label ?? 'no label'} · parent{' '}
        {run.parent ?? 'not available'}
      </Text>
      <Text dimColor>
        started {clockTime(run.startedAt)} ({formatDuration(now - run.startedAt)} ago) · {freshness}
      </Text>
      <Text>
        <Text color={stateColor(run)}>{state}</Text>
        {stateNote} · <Text color={run.granularity === 'final-only' ? 'warning' : 'subtle'}>{run.granularity}</Text>
        {run.granularity === 'final-only' ? ' (no incremental output; a final record after exit)' : ''}
      </Text>
      <Text dimColor>
        worker reported: {run.reported ?? '—'} · observed exit status: {exit} · telemetry warnings: {run.warnings}
        {run.isGone ? ' · log file removed' : ''}
        {run.segmentsOmitted > 0 ? ` · segments omitted: ${run.segmentsOmitted}` : ''}
      </Text>
    </Box>
  )
}

/** The compact run summary: one truncated line instead of runDetail's four. */
function runDetailLine(Text: TextC, run: RunSummary, now: number): RenderElement {
  const last = run.lastEventAt
  return (
    <Text wrap="truncate-end">
      <Text color={stateColor(run)}>{stateLabel(run)}</Text> · <Text color={run.granularity === 'final-only' ? 'warning' : 'subtle'}>{run.granularity}</Text> · last event{' '}
      {last === null ? 'none' : `${formatDuration(now - last)} ago`} · reported {run.reported ?? '—'}
    </Text>
  )
}

const KIND_COLOR: Record<string, string> = {
  message: 'text',
  'reasoning summary': 'remember',
  'tool call': 'suggestion',
  'tool output': 'subtle',
  status: 'inactive',
  final: 'success',
  warning: 'warning',
  other: 'inactive',
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
  const room = budget.eventRoom
  // Leave the last row for the "more above" marker; below two rows nothing fits.
  const lines = Math.max(0, room - 1)
  const items = events.items
  const lost =
    segmentsOmitted > 0
      ? `events of ${segmentsOmitted} log segment${segmentsOmitted === 1 ? '' : 's'} omitted (rotated away or over the read limit; not counted)`
      : ''
  if (items.length === 0) return <Text dimColor>{lost || 'No events yet.'}</Text>
  const end =
    view.anchorSeq === null
      ? items.length
      : Math.max(1, items.findIndex(one => one.seq > view.anchorSeq!) === -1 ? items.length : items.findIndex(one => one.seq > view.anchorSeq!))
  const limit = view.isExpanded ? MAX_STORED_CHARS : SHOWN_CHARS
  // The first (newest) event must fit too: if it does not, its text is cut so the
  // header and the text fit in room - 1 rows, the last row staying for the "more
  // above" marker. One that does not fit even then is dropped with a note.
  const fitted: DisplayEvent[] = []
  const shownLines = new Map<number, string>()
  let left = lines
  for (let i = end - 1; i >= 0; i--) {
    const one = items[i]!
    const text = shownText(one, limit)
    const cost = 1 + lineCount(text, width)
    if (fitted.length === 0 && cost > left) {
      // The newest event is taller than the room: keep its header and the
      // longest prefix, marker included, that fits in the rows left.
      if (left >= 2) {
        const keep = Math.min(text.length - CUT_MARKER.length, (left - 1) * width - CUT_MARKER.length)
        fitted.unshift(one)
        shownLines.set(one.seq, `${text.slice(0, keep).trimEnd()}${CUT_MARKER}`)
      }
      break
    }
    if (fitted.length > 0 && cost > left) break
    fitted.unshift(one)
    left -= cost
  }
  const above = end - fitted.length
  const below = items.length - end
  const older = [
    lost,
    events.omitted > 0 ? `${events.omitted} older event${events.omitted === 1 ? '' : 's'} omitted (only the newest ${items.length} are kept)` : '',
    above > 0 ? `${above} more above (u to scroll)` : '',
  ].filter(Boolean)
  return (
    <Box flexDirection="column">
      {older.length > 0 && <Text dimColor>{older.join(' · ')}</Text>}
      {fitted.map(one => (
        <Box key={`ev:${one.seq}`} flexDirection="column">
          <Text wrap="truncate-end">
            <Text dimColor>{clockTime(one.at)} </Text>
            <Text bold color={one.isError ? 'error' : KIND_COLOR[one.kind]}>
              {one.kind}
            </Text>
            {one.role !== undefined ? <Text dimColor> ({one.role})</Text> : ''}
          </Text>
          <Text>{shownLines.get(one.seq) ?? shownText(one, limit)}</Text>
        </Box>
      ))}
      {below > 0 && <Text dimColor>{below} newer event{below === 1 ? '' : 's'} below (f to follow)</Text>}
    </Box>
  )
}

function shownText(one: DisplayEvent, limit: number): string {
  if (one.text.length <= limit) return one.text
  return `${one.text.slice(0, limit)}… [${one.text.length - limit} more; x to expand]`
}

function lineCount(text: string, width: number): number {
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0)
}

/** Four one-line fields (truncated when the pane is compact), so four rows at most. */
function claudeDetail(Text: TextC, Box: BoxC, agent: ClaudeAgent, wrap?: 'truncate-end'): RenderElement {
  return (
    <Box flexDirection="column">
      <Text wrap={wrap}>
        <Text bold>Claude agent</Text> {agent.type} · {agent.model ?? 'model not reported'} · {agent.status ?? 'status not reported'}
      </Text>
      <Text wrap={wrap}>{agent.description || '(no description)'}</Text>
      <Text dimColor wrap={wrap}>
        id {agent.id} · parent {agent.parentId ?? 'main conversation'}
        {agent.spawnedAt !== null ? ` · seen ${clockTime(agent.spawnedAt)}` : ''}
      </Text>
      <Text dimColor wrap={wrap}>Only what agent.spawn and the agent list expose; open its transcript from the tasks list.</Text>
    </Box>
  )
}
