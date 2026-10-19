// Agent Inspector: a read-only pane over the orchestrator's per-run logs
// ($XDG_RUNTIME_DIR/orchestrator/<run-id>.jsonl, docs/LOG_CONTRACT.md) and
// over the Claude-native agents `agent.spawn` / `$.agent.list()` expose.
//
// Read-only by construction: it hooks session.start, command.run (its own
// command), agent.spawn (observe only, pass-through) and ui.render (its own
// pane). It never writes files, spawns processes, steers, cancels or gates.
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
    await pollRunLogs($, now)
  } catch (error) {
    // Monitoring degrades; nothing else is touched.
    const detail = clean(error instanceof Error ? error.message : String(error), 300)
    await update($, STATUS, (s): InspectorStatus => ({ ...s, dir: 'error', detail }))
  } finally {
    isPolling = false
  }
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
    const [runsRaw, claude, view, status] = await Promise.all([
      read($, RUNS),
      read($, CLAUDE),
      read($, VIEW),
      read($, STATUS),
    ])
    const now = await $.clock.now()
    const runs = orderRuns(runsRaw)
    const ids = [...runs.map(run => run.id), ...claude.map(agent => `claude:${agent.id}`)]
    const selected = currentSelection(view, ids)
    const width = Math.max(24, e.props.bodyColumns)
    const rows = Math.max(12, e.props.scroll.bodyRows)
    let used = 0

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>
          {TITLE} <Text dimColor>· read-only · {runs.length} run{runs.length === 1 ? '' : 's'} · {claude.length} Claude agent{claude.length === 1 ? '' : 's'}</Text>
        </Text>
        {status.polledAt !== null && <Text dimColor>polled {clockTime(status.polledAt)}</Text>}
      </Box>
    )
    used += 1

    const notice = dirNotice(status)
    if (notice !== null) used += 1

    // Worker list: a window around the selection, at most a third of the room.
    const listRoom = Math.max(3, Math.floor(rows / 3))
    const window = listWindow(ids, selected, listRoom)
    used += window.length + (runs.length > 0 ? 1 : 0) + (claude.length > 0 ? 1 : 0) + 1
    const runRows = runs.filter(run => window.includes(run.id))
    const claudeRows = claude.filter(agent => window.includes(`claude:${agent.id}`))

    const controls = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="prev" plain hotkey="k" label="prev" onPress={() => moveSelection($, -1)} />
        <Button key="next" plain hotkey="j" label="next" onPress={() => moveSelection($, 1)} />
        <Button key="older" plain hotkey="u" label="older" onPress={() => scrollEvents($, -5)} />
        <Button key="newer" plain hotkey="d" label="newer" onPress={() => scrollEvents($, 5)} />
        <Button
          key="follow"
          plain
          hotkey="f"
          label={view.anchorSeq === null ? 'follow: on' : 'follow: off'}
          onPress={() => toggleFollow($)}
        />
        <Button
          key="expand"
          plain
          hotkey="x"
          label={view.isExpanded ? 'expand: on' : 'expand: off'}
          onPress={() => update($, VIEW, v => ({ ...v, isExpanded: !v.isExpanded }))}
        />
      </Box>
    )
    used += width < 70 ? 2 : 1

    let detail: RenderElement | null = null
    if (selected === null) {
      detail = <Text dimColor>{emptyText(status)}</Text>
    } else if (selected.startsWith('claude:')) {
      const agent = claude.find(one => `claude:${one.id}` === selected)
      detail = agent === undefined ? null : claudeDetail(Text, Box, agent)
    } else {
      const run = runs.find(one => one.id === selected)!
      const events = await readEvents($, run.id)
      const summary = runDetail(Text, Box, run, now)
      used += 4
      detail = (
        <Box flexDirection="column">
          {summary}
          {eventList(Text, Box, events, view, Math.max(3, rows - used), width, run.segmentsOmitted ?? 0)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {header}
        {notice !== null && <Text color="warning">{notice}</Text>}
        {runRows.length > 0 && <Text dimColor>External workers</Text>}
        {runRows.map(run => (
          <Button
            key={`sel:${run.id}`}
            plain
            onPress={() => update($, VIEW, v => ({ ...v, selected: run.id, anchorSeq: null }))}
          >
            {run.id === selected ? '▸ ' : '  '}
            {run.executor} <Text dimColor>{run.model ?? 'default model'}</Text> {run.label ?? run.id.slice(-8)}{' '}
            <Text dimColor>{formatDuration(now - run.startedAt)}</Text> <Text color={stateColor(run)}>{stateLabel(run)}</Text>{' '}
            <Text color={run.granularity === 'final-only' ? 'warning' : 'subtle'}>[{run.granularity}]</Text>
            {run.warnings > 0 ? <Text color="warning"> ⚠{run.warnings}</Text> : ''}
          </Button>
        ))}
        {claudeRows.length > 0 && <Text dimColor>Claude agents</Text>}
        {claudeRows.map(agent => (
          <Button
            key={`sel:claude:${agent.id}`}
            plain
            onPress={() => update($, VIEW, v => ({ ...v, selected: `claude:${agent.id}`, anchorSeq: null }))}
          >
            {`claude:${agent.id}` === selected ? '▸ ' : '  '}
            {agent.type} <Text dimColor>{agent.model ?? 'model not reported'}</Text> {agent.description}{' '}
            <Text dimColor>{agent.status ?? 'status not reported'}</Text>
          </Button>
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
  room: number,
  width: number,
  segmentsOmitted: number,
): RenderElement {
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
  // Fill the room from the anchor backwards, estimating wrapped lines.
  const shown: DisplayEvent[] = []
  let left = room - 1
  for (let i = end - 1; i >= 0; i--) {
    const one = items[i]!
    const cost = 1 + lineCount(shownText(one, limit), width)
    if (shown.length > 0 && cost > left) break
    shown.unshift(one)
    left -= cost
  }
  const above = end - shown.length
  const below = items.length - end
  const older = [
    lost,
    events.omitted > 0 ? `${events.omitted} older event${events.omitted === 1 ? '' : 's'} omitted (only the newest ${items.length} are kept)` : '',
    above > 0 ? `${above} more above (u to scroll)` : '',
  ].filter(Boolean)
  return (
    <Box flexDirection="column">
      {older.length > 0 && <Text dimColor>{older.join(' · ')}</Text>}
      {shown.map(one => (
        <Box key={`ev:${one.seq}`} flexDirection="column">
          <Text>
            <Text dimColor>{clockTime(one.at)} </Text>
            <Text bold color={one.isError ? 'error' : KIND_COLOR[one.kind]}>
              {one.kind}
            </Text>
            {one.role !== undefined ? <Text dimColor> ({one.role})</Text> : ''}
          </Text>
          <Text>{shownText(one, limit)}</Text>
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

function claudeDetail(Text: TextC, Box: BoxC, agent: ClaudeAgent): RenderElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Claude agent</Text> {agent.type} · {agent.model ?? 'model not reported'} · {agent.status ?? 'status not reported'}
      </Text>
      <Text>{agent.description || '(no description)'}</Text>
      <Text dimColor>
        id {agent.id} · parent {agent.parentId ?? 'main conversation'}
        {agent.spawnedAt !== null ? ` · seen ${clockTime(agent.spawnedAt)}` : ''}
      </Text>
      <Text dimColor>Only what agent.spawn and the agent list expose; open its transcript from the tasks list.</Text>
    </Box>
  )
}
