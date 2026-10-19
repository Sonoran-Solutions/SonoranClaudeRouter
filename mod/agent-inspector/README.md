# agent-inspector

A read-only Claude Code (2.1.299) mod: a pane that shows what delegated workers are doing.

- **External workers** (Codex, Pi, agy): read from the per-run logs the orchestrator wrappers write to
  `$XDG_RUNTIME_DIR/orchestrator/<run-id>.jsonl` ([log contract](../../docs/LOG_CONTRACT.md)). Per run: executor,
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

Open it with `/agent-inspector`. It never opens itself. Keys while the pane has focus: `k`/`j` previous/next
worker, `u`/`d` scroll events older/newer, `f` follow the tail on/off (on by default), `x` expand long events
(2,000 characters shown, up to 20,000 kept).

Checks: `claude plugin validate mod/agent-inspector` and `claude plugin test mod/agent-inspector`.

## Limitations

- **Read-only.** No tool, prompt or session-append hooks; no steering, cancellation, model switching, file
  writes or process spawning. The `agent.spawn` hook only observes, and passes the spawn through even if it fails.
  Closing the pane changes nothing.
- **Polling.** A 1 s timer runs for the session, but while the pane is not placed each tick is a single
  `$.ui.panes()` call with no file system work. A log is read only when its size or mtime changed.
- **No ranged reads.** `$.fs.read` in 2.1.299 returns a whole file and refuses files over 4 MiB, so the mod
  re-reads a changed log and slices it at the consumed offset. A log over 4 MiB gets a warning and is not read
  further.
- **Bounded.** At most 200 recent events per run and 50 runs (the oldest exited runs go first); older events are
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
