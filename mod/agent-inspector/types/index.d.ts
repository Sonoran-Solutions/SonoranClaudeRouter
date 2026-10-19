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

export type RunExit = { code: number; timedOut: boolean; durationMs: number | null }

/** Where the reader stands in one log file. `consumed` is a UTF-16 offset. */
export type RunCursor = { size: number; mtimeMs: number; consumed: number }

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
  cursor: RunCursor
  isTooLarge: boolean
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

declare module 'claude-code' {
  interface PluginState {
    'agent-inspector': {
      runs: RunSummary[]
      events: StateFamily<RunEvents>
      claude: ClaudeAgent[]
      view: InspectorView
      status: InspectorStatus
    }
  }
}
