# agent-inspector

A Claude Code (2.1.299) mod: a pane that shows what delegated workers are doing, with a Usage section on top.

- **Usage**: the REMAINING (100 - used) quota for Claude Code (5-hour and weekly windows, from the session's
  rate limits), Codex, Antigravity (agy) and the dollars left on OpenRouter, coloured by the orchestrator's
  routing thresholds (used >= 80% or < $5: warning; used >= 95% or < $1: error). Codex, agy and OpenRouter come from
  the orchestrator's read-only status script `~/.claude/skills/orchestrator/scripts/usage.sh`. A provider that
  cannot be read shows `unknown` and its note, never a guess.
- **External workers** (Codex, Pi, agy): read from the per-run logs the orchestrator wrappers write to
  `$XDG_RUNTIME_DIR/orchestrator/` ([log contract](../../docs/LOG_CONTRACT.md)): the lifecycle file
  `<run-id>.jsonl` (start, final, exit) and the event segments `<run-id>.<n>.jsonl`. Per run: executor,
  model, label, parent (or "not available"), start time, when the last event was *seen*, state (`running`,
  `unknown`, `exited N`, `timed out`), granularity (`live` / `final-only`), the worker-reported result next to the
  observed exit status, and telemetry warnings. Below the list, the selected run's events, each labelled `message`,
  `reasoning summary`, `tool call`, `tool output`, `status`, `final`, `warning` or `other: <type>`.
- **Claude agents**: what `agent.spawn` and `$.agent.list()` expose (id, type, model, description, status,
  parent). No transcript scraping.

## Install for development

Pick one, then start a new session (an interactive session hot-reloads the folder on save):

```sh
# a: name the folder in the environment (or in the env block of ~/.claude/settings.json)
export CLAUDE_CODE_PLUGIN_DIRS=/path/to/SonoranClaudeRouter/mod/agent-inspector

# b: one session only
claude --plugin-dir /path/to/SonoranClaudeRouter/mod/agent-inspector

# c: symlink it into a dev-mods folder that is itself listed in CLAUDE_CODE_PLUGIN_DIRS
ln -s /path/to/SonoranClaudeRouter/mod/agent-inspector ~/.claude/dev-mods/agent-inspector
```

Open it with `/agent-inspector`; it also opens itself when the `/orchestrator` skill runs (a `skill.prompt` hook
that leaves the skill text untouched). Keys while the pane has focus: `k`/`j` previous/next
worker, `u`/`d` scroll events older/newer, `f` follow the tail on/off (on by default), `x` expand long events
(2,000 characters shown, up to 20,000 kept), `r` refresh usage.

Checks: `claude plugin validate mod/agent-inspector` and `claude plugin test mod/agent-inspector`.

## Limitations

- **Pane size.** The supported minimum pane size is 12 rows x 70 columns; below 24 rows the usage line, worker rows,
  run summary and controls are single truncated lines.
- **Read-only.** No tool or session-append hooks; no steering, cancellation, model switching or file writes. The
  only process it runs is `usage.sh` (a read-only status script that prints one JSON line and never prints keys),
  only while the pane is placed. The `agent.spawn` hook only observes: it forwards the spawn exactly once and returns
  its result (or rejection) unchanged; its own bookkeeping cannot fail it. Closing the pane changes nothing.
- **Usage refresh.** Claude's windows are re-read every second while the pane is placed. `usage.sh` takes 10-70 s,
  so it runs in the background: when the pane is first seen with no data or data older than 5 minutes, then every
  5 minutes while it stays placed, and on `r`; never while the pane is closed. The cadence and the script path
  (`$HOME/.claude/skills/orchestrator/scripts/usage.sh`) are constants in `hooks/register.tsx`. A failed run (non-zero
  exit, 3-minute timeout, unreadable output) shows an error line and keeps the last good figures with their age.
  A refresh already started finishes (up to the 180 s timeout) even if the pane is closed; its result is kept and
  no new one starts while the pane is closed. `usage.sh` only reads: codex `app-server` `account/rateLimits/read`,
  `agy -p /quota` and `/credits` (slash commands; the script requires `num_turns` 0 and zero tokens) and two
  OpenRouter GET endpoints. No model completions, and no writes beyond those CLIs' own logs.
  On short panes (under 24 body rows) Usage collapses to one line with each provider's tightest remaining figure.
  Claude's figures come from the session's rate-limit windows: they are empty off a subscription, and before the
  first API response of a session. Only display fields are kept in state (no key sources, no raw output).
- **Polling.** A 1 s timer runs for the session, but while the pane is not placed each tick is a single
  `$.ui.panes()` call with no file system work. A log is read only when its size or mtime changed.
- **No ranged reads.** `$.fs.read` in 2.1.299 returns a whole file and refuses files over 4 MiB, so the mod
  re-reads a changed file and slices it at the consumed offset. The limit is per file: a segment over 4 MiB is
  skipped with a warning, and the lifecycle file and later segments are still read, so the terminal status always
  shows.
- **Segments and rotation.** The wrapper keeps only the newest few segments (default 4 of about 1 MiB each). A
  segment deleted before the mod finished reading it, segment numbers that never appeared, and skipped segments are
  shown as "events of N log segments omitted" with a warning each. Their event count is unknown, so it is not
  counted. A provider record too large to log appears as a warning (`orchestrator.oversize`).
- **Read errors stay local.** A file that cannot be read (EACCES, a transient I/O error) is a warning on its run,
  retried on the next poll. Other runs keep updating, and the run is never shown as failed because of it.
- **Bounded.** At most 200 recent events per run and 50 runs (the oldest exited runs go first). Older events are
  counted as omitted, not shown. All of it lives in session state and goes when the session ends.
- **Liveness is a guess.** `running` means the wrapper PID from the start record exists under `/proc` (Linux
  only). Elsewhere, or with PID reuse, the state may read `unknown` or stay `running`. `unknown` never means failed,
  and a quiet run is not a stalled one.
- **agy is final-only.** It shows start, a final record and the exit, never live output.
- **Pi tool calls** are shown when they start executing (`tool_execution_start`); a tool call the model asked for
  that never ran is not listed.
- **Untrusted text.** Log text is shown as plain text. ANSI and control characters are stripped, and the contract's
  redaction patterns are applied again before display. Redaction is best effort.
- `$XDG_RUNTIME_DIR` unset: the pane says the log directory is unavailable. There is no fallback path.
