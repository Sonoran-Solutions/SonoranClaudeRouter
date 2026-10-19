export type Executor = 'codex' | 'pi' | 'agy'

export type Granularity = 'live' | 'final-only'

export type EventKind =
  | 'message'
  | 'reasoning summary'
  | 'tool call'
  | 'tool output'
  | 'status'
  | 'final'
  | 'warning'
  | 'other'

/** One display row, already sanitized, redacted and cut to MAX_STORED_CHARS. */
export type DisplayEvent = {
  seq: number
  kind: EventKind
  /** Record `ts` when it has one, else when the mod observed the line (ms). */
  at: number
  text: string
  /** Who said it, where that is not obvious from the kind (`user` prompt). */
  role?: string
  isError?: boolean
}

export type RunExit = {
  code: number
  timedOut: boolean
  durationMs: number | null
  /** Highest event segment the wrapper wrote (exit record), when given. */
  segments: number | null
}

/** Where the reader stands in one log file. `consumed` is a UTF-16 offset. */
export type FileCursor = {
  size: number
  mtimeMs: number
  consumed: number
  /** A segment read to its end after its successor existed: never read again. */
  isDone?: boolean
  /** Over the read limit; warned once. */
  isSkipped?: boolean
  /** The last read error, so a repeat is not warned about every poll. */
  error?: string | null
}

export type RunSummary = {
  id: string
  executor: Executor
  model: string | null
  label: string | null
  parent: string | null
  pid: number | null
  granularity: Granularity
  startedAt: number
  /** Observation freshness: when the mod last saw a new line. Not progress. */
  lastEventAt: number | null
  exit: RunExit | null
  /** What the worker itself said about its result (agy status, codex turn.failed). */
  reported: string | null
  /** Wrapper PID alive at the last poll; null when unknown or not checked. */
  isAlive: boolean | null
  hasStart: boolean
  warnings: number
  /** The lifecycle file `<run-id>.jsonl`: start, final, exit. */
  lifecycle: FileCursor
  /** Event segments `<run-id>.<n>.jsonl` still present, keyed by `n`. */
  segments: Record<string, FileCursor>
  /** The highest segment number seen so far (0: none). */
  highestSegment: number
  /** Segments whose events were never (fully) read: rotated away or over the read limit. */
  segmentsOmitted: number
  isGone: boolean
}

export type RunEvents = { items: DisplayEvent[]; omitted: number; nextSeq: number }

export type ClaudeAgent = {
  id: string
  type: string
  description: string
  model: string | null
  parentId: string | null
  status: string | null
  spawnedAt: number | null
}

export type InspectorView = {
  /** A run id, or `claude:<agent id>`. */
  selected: string | null
  /** null = follow the tail; else the seq of the last event shown. */
  anchorSeq: number | null
  isExpanded: boolean
}

export type InspectorStatus = {
  dir: 'pending' | 'ok' | 'unavailable' | 'missing' | 'error'
  detail: string | null
  polledAt: number | null
  /** Run ids dropped by the 50-run bound, so the next poll does not re-add them. */
  dropped: string[]
}

/** One usage window of a provider; `usedPct` is what is spent (the pane shows 100 - it). */
export type UsageWindow = {
  label: string
  usedPct: number
  /** ms since the epoch. */
  resetsAt: number | null
}

/** Windows when the provider answered; else `note` says why not. */
export type UsageRow = { windows: UsageWindow[]; note: string | null }

export type OpenRouterUsage = {
  credits: { remainingUsd: number; spentTodayUsd: number | null; usedPct: number | null } | null
  note: string | null
}

/** Display fields of `usage.sh` (Codex, agy, OpenRouter); never keys or raw output. */
export type ScriptUsage = { codex: UsageRow; agy: UsageRow; openrouter: OpenRouterUsage }

export type UsageState = {
  /** Claude Code's own rate-limit windows from `$.session.usage()`; empty off a subscription. */
  claude: UsageWindow[]
  /** The last good `usage.sh` snapshot. */
  script: ScriptUsage | null
  /** When `script` was fetched (ms). */
  updatedAt: number | null
  /** When `usage.sh` was last started (ms); paces the 5-minute refresh, failures included. */
  attemptedAt: number | null
  isRefreshing: boolean
  /** The last `usage.sh` failure; cleared by the next good run. */
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-inspector': {
      runs: RunSummary[]
      events: StateFamily<RunEvents>
      claude: ClaudeAgent[]
      view: InspectorView
      status: InspectorStatus
      usage: UsageState
    }
  }
}
