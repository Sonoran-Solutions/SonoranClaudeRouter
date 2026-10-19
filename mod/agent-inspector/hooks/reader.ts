// Reads one run's files (the lifecycle file and its event segments) past
// their cursors. File access is injected, so this is tested without `$`.
// Layout: docs/LOG_CONTRACT.md (v1, segmented).
import type { DisplayEvent, FileCursor, RunEvents, RunSummary } from '../types'
import { clean, ingestLines, MAX_FILE_BYTES, pushBounded, takeCompleteLines } from './runlog'

/** What the directory listing said about one file. */
export type ListedFile = { size: number; mtimeMs: number }

/** One run's files as listed: the lifecycle file and segments by number. */
export type ListedRun = { lifecycle: ListedFile | null; segments: ReadonlyMap<number, ListedFile> }

export type ReadIo = { read: (path: string) => Promise<string> }

type Read = { cursor: FileCursor; lines: string[]; warnings: string[] }

/**
 * Reads the newly appended complete lines of one file. Never throws: a
 * failed read is a warning (once per distinct error) and leaves the cursor
 * where it was, so the next poll tries again.
 */
async function readFile(io: ReadIo, path: string, label: string, cursor: FileCursor, file: ListedFile): Promise<Read> {
  const same: Read = { cursor, lines: [], warnings: [] }
  if (cursor.isDone) return same
  if (file.size === cursor.size && file.mtimeMs === cursor.mtimeMs && !cursor.error) return same
  if (file.size > MAX_FILE_BYTES) {
    const mib = (file.size / 1024 / 1024).toFixed(1)
    return {
      ...same,
      cursor: { ...cursor, isSkipped: true },
      warnings: cursor.isSkipped ? [] : [`telemetry: ${label} is ${mib} MiB, over the 4 MiB read limit; skipped`],
    }
  }
  let text: string
  try {
    text = await io.read(path)
  } catch (error) {
    const message = clean(error instanceof Error ? error.message : String(error), 300)
    return {
      ...same,
      cursor: { ...cursor, error: message },
      warnings: message === cursor.error ? [] : [`telemetry: could not read ${label} (${message}); retrying`],
    }
  }
  const warnings: string[] = []
  let consumed = cursor.consumed
  if (file.size < cursor.size || consumed > text.length) {
    warnings.push(`telemetry: ${label} shrank or was replaced; reading it again from the start`)
    consumed = 0
  }
  const taken = takeCompleteLines(text, consumed)
  return {
    cursor: { size: file.size, mtimeMs: file.mtimeMs, consumed: taken.consumed, error: null },
    lines: taken.lines,
    warnings,
  }
}

function typeOf(line: string): unknown {
  try {
    return (JSON.parse(line) as { type?: unknown } | null)?.type
  } catch {
    return undefined
  }
}

function rotatedAway(from: number, to: number): string {
  return from === to
    ? `telemetry: segment ${from} rotated away before it was read; its events are omitted`
    : `telemetry: segments ${from}–${to} rotated away before they were read; their events are omitted`
}

/**
 * Advances one run: the lifecycle file's start record, then its event
 * segments in ascending order, then the lifecycle's final/exit records (the
 * wrapper writes exit after the event stream is flushed). Segments that
 * rotated away unread, or are over the read limit, are counted as omitted
 * with a warning; nothing here stops the lifecycle file from being read.
 */
export async function advanceRunFiles(
  io: ReadIo,
  dir: string,
  run: RunSummary,
  events: RunEvents,
  listed: ListedRun | undefined,
  now: number,
): Promise<{ run: RunSummary; events: RunEvents }> {
  if (listed === undefined) return { run: run.isGone ? run : { ...run, isGone: true, isAlive: null }, events }
  let r: RunSummary = { ...run, isGone: false, segments: { ...run.segments } }
  let ev = events
  const wasExited = run.exit !== null

  const warn = (text: string, omitted = 0) => {
    const one: DisplayEvent = { seq: ev.nextSeq, kind: 'warning', at: now, text }
    ev = pushBounded(ev, [one])
    r = { ...r, warnings: r.warnings + 1, segmentsOmitted: r.segmentsOmitted + omitted }
  }
  const ingest = (lines: readonly string[]) => {
    if (lines.length === 0) return
    const done = ingestLines(r, ev, lines, now)
    r = done.run
    ev = done.events
  }

  // 1. Lifecycle file: small, read whenever it changed; it alone decides exit.
  let closing: string[] = []
  if (listed.lifecycle !== null) {
    const read = await readFile(io, `${dir}/${r.id}.jsonl`, 'lifecycle file', r.lifecycle, listed.lifecycle)
    r = { ...r, lifecycle: read.cursor }
    for (const text of read.warnings) warn(text)
    const at = read.lines.findIndex(line => {
      const type = typeOf(line)
      return type === 'orchestrator.final' || type === 'orchestrator.exit'
    })
    ingest(at === -1 ? read.lines : read.lines.slice(0, at))
    closing = at === -1 ? [] : read.lines.slice(at)
  }

  // 2. Segments that vanished: fine once read to their end, else omitted.
  for (const key of Object.keys(r.segments)) {
    const n = Number(key)
    if (listed.segments.has(n)) continue
    const cursor = r.segments[key]!
    delete r.segments[key]
    // Done segments were read to their end; skipped ones were counted when skipped.
    if (!cursor.isDone && !cursor.isSkipped) warn(rotatedAway(n, n), 1)
  }

  // 3. Present segments, ascending; numbers jumped past were never seen.
  const present = [...listed.segments.keys()].sort((a, b) => a - b)
  for (const n of present) {
    const key = String(n)
    if (r.segments[key] === undefined) {
      if (n > r.highestSegment + 1) {
        const from = r.highestSegment + 1
        warn(rotatedAway(from, n - 1), n - from)
      }
      r = { ...r, highestSegment: Math.max(r.highestSegment, n), segments: { ...r.segments, [key]: { size: 0, mtimeMs: 0, consumed: 0 } } }
    }
    const before = r.segments[key]!
    const file = listed.segments.get(n)!
    const read = await readFile(io, `${dir}/${r.id}.${n}.jsonl`, `segment ${n}`, before, file)
    const isNewlySkipped = read.cursor.isSkipped === true && before.isSkipped !== true
    for (const text of read.warnings) warn(text, isNewlySkipped ? 1 : 0)
    ingest(read.lines)
    // The wrapper starts n+1 only after n is full, so with a successor listed,
    // n is closed: read up to its listed size (or skipped), it is finished.
    const c = read.cursor
    const isCaughtUp = !c.error && c.size === file.size && c.mtimeMs === file.mtimeMs
    const isFinished = present.some(m => m > n) && (c.isSkipped === true || isCaughtUp)
    r = { ...r, segments: { ...r.segments, [key]: isFinished ? { ...c, isDone: true } : c } }
  }

  // 4. The lifecycle's final and exit records, after the events they close.
  ingest(closing)

  // 5. Exit said more segments were written than were ever listed here. Only
  // checked once the exit was already known before this poll's listing.
  const last = r.exit?.segments ?? null
  if (wasExited && last !== null && last > r.highestSegment) {
    warn(rotatedAway(r.highestSegment + 1, last), last - r.highestSegment)
    r = { ...r, highestSegment: last }
  }
  return { run: r, events: ev }
}
