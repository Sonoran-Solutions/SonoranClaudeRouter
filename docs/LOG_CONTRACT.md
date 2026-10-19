# Agent Inspector: run-log contract (v1, segmented)

The orchestrator's external wrappers (`run_codex.sh`, `run_pi.sh`, `run_agy.sh`) write one log per launch; the
Agent Inspector mod only reads them. This file is the single agreement between the two.

## Location and permissions

- Directory: `$XDG_RUNTIME_DIR/orchestrator/`, created with mode `0700`. If `XDG_RUNTIME_DIR` is unset, empty,
  not a directory, or not owned by the current user, **nothing is logged** (no fallback path).
- Each run writes two kinds of files, all created with mode `0600` (`umask 077`):
  - **Lifecycle file** `<run-id>.jsonl`: only the wrapper's own records (`orchestrator.start`, `orchestrator.final`,
    `orchestrator.exit`). It stays a few KiB, so the terminal status is always readable however much the worker
    printed.
  - **Event segments** `<run-id>.<n>.jsonl` (`n` = 1, 2, 3, … in decimal without leading zeros): the provider's
    records, in order. The wrapper starts segment `n+1` once segment `n` reaches `ORCH_RUNLOG_SEGMENT_BYTES`
    (default 1048576) and then deletes segments older than the newest `ORCH_RUNLOG_KEEP_SEGMENTS` (default 4), so a
    run's logs stay bounded. A provider line longer than the segment size (after redaction/trimming) is replaced
    by one `orchestrator.oversize` record. A reader therefore never meets a file larger than about
    2 × `ORCH_RUNLOG_SEGMENT_BYTES`.
- `run-id` matches `^[0-9]{8}T[0-9]{9}Z-(codex|pi|agy)-[0-9a-f]{8}$`, e.g. `20261019T171939660Z-pi-3f9a1c2e`
  (UTC start time with milliseconds, executor, 8 random hex digits). File names are exactly `<run-id>.jsonl` or
  `<run-id>.<n>.jsonl` with `n` matching `[1-9][0-9]{0,5}`; the mod ignores every other name.
- Retention: at each launch the wrapper deletes `*.jsonl` files (lifecycle and segments) in that directory older than
  `ORCH_RUNLOG_RETENTION_MIN` minutes (default 1440). `$XDG_RUNTIME_DIR` is also cleared at logout.
- `ORCH_RUNLOG=0` disables logging entirely (used to compare monitoring on/off).

## Records

Each line is one complete JSON object followed by `\n`. Wrapper records have a `type` starting with
`orchestrator.`. The lifecycle file holds only wrapper records; segments hold the provider's own records, passed
through (after redaction, and for pi after field trimming, below), plus `orchestrator.oversize` placeholders.

| `type` | When | Fields |
| --- | --- | --- |
| `orchestrator.start` | first line, before the worker starts | `v` (1), `run_id`, `executor` (`codex`/`pi`/`agy`), `model` (string or `null` = executor default), `label` (string or `null`), `parent` (string or `null`), `workdir`, `pid` (wrapper PID), `session_id` (the launching Claude Code session's `CLAUDE_CODE_SESSION_ID`, or `null` when absent/invalid), `session_title` (that session's last chat title, at most 200 characters, or `null`), `project` (that session's project directory, else `workdir`, else `null`), `granularity` (`live` for codex/pi, `final-only` for agy), `ts` |
| provider record (segments) | while the worker runs | codex: `codex exec --json` events; pi: `pi --mode json` events |
| `orchestrator.oversize` (segments) | in place of a provider line longer than the segment size | `v`, `run_id`, `ts`, `bytes` (the line's length), `provider_type` (its `.type`, or `null`) |
| `orchestrator.final` | agy only, after it exits | `v`, `run_id`, `ts`, `status` (agy `.status`, at most 200 characters, or `null`), `response` (agy `.response`, redacted and then cut to `ORCH_RUNLOG_FINAL_MAX_CHARS` characters, default 65536, or `null`), `response_truncated` (`true` when cut), `response_chars` (length of the redacted response before the cut, or `null`), `parse_error` (`true` when agy's stdout was not JSON). The wrapper's stdout always carries the full response. |
| `orchestrator.exit` | last line of the lifecycle file, always written when the wrapper exits (also on failure/timeout), after the event stream is flushed | `v`, `run_id`, `ts`, `exit_code` (the wrapper's own exit status, which is the worker's original status), `timed_out` (`exit_code == 124`), `duration_ms`, `segments` (highest segment number written, `0` if none) |

`ts` is an ISO-8601 UTC timestamp with milliseconds. `label` comes from `ORCH_LABEL`, else the prompt file's
basename. `parent` comes from `ORCH_PARENT` only; nothing infers it. `session_id`, `session_title` and `project` are
best effort: they are read once at start from `$CLAUDE_CODE_SESSION_ID` and that session's transcript under
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/*/<session-id>.jsonl` (last `custom-title` record and first `cwd`), and
are `null` (or `workdir`) when anything is missing or fails; the worker's behaviour and exit status never change.

A run whose lifecycle file has a start record and no exit record is **running** while the wrapper PID is alive;
the mod must otherwise show it as **unknown**, never as failed. A segment that disappears before the mod has read it
was rotated away: the mod counts its events as omitted, not lost silently.

## Provider records (as observed 2026-10-19)

- codex (`codex exec --json`, CLI 0.163): `thread.started`, `turn.started`, `item.started` / `item.completed`
  with `item.type` in `agent_message`, `reasoning`, `command_execution` (`command`, `aggregated_output`,
  `exit_code`, `status`), `file_change`, `mcp_tool_call`, `todo_list`, `web_search`; `turn.completed` (`usage`),
  `turn.failed`, `error`. Sample: [`tests/fixtures/codex-exec.jsonl`](../tests/fixtures/codex-exec.jsonl).
- pi (`pi -p --mode json`, 0.86): `session`, `agent_start`, `turn_start`, `message_start` / `message_end`
  (`message.role` `user`/`assistant`/`toolResult`; assistant `content[]` holds `text`, `thinking`, `toolCall`;
  `model`, `usage.cost.total`), `tool_execution_start` / `_update` / `_end` (`toolName`, `args`, `result`,
  `isError`), `turn_end`, `agent_end`, `agent_settled`. Sample:
  [`tests/fixtures/pi-json.jsonl`](../tests/fixtures/pi-json.jsonl).
  The wrapper logs pi records with three trims, all for size and privacy: `message_update` (per-token deltas)
  is dropped, a `system` message's content is replaced by `"(trimmed)"`, and `agent_end.messages` is emptied.
  The wrapper's own stdout parsing still sees the untrimmed stream.
- agy: no stream; one `orchestrator.final` record. [`tests/fixtures/agy-final.json`](../tests/fixtures/agy-final.json)
  is a synthetic example of the `{status, response}` envelope the wrapper already parses.

## Redaction

Before a line is written the wrapper replaces, with `[REDACTED]`: the literal value of `$OPENROUTER_API_KEY`
when set, and matches of `sk-[A-Za-z0-9_-]{20,}`, `gh[pousr]_[A-Za-z0-9]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`,
`AIza[0-9A-Za-z_-]{35}`, and `xox[abprs]-[A-Za-z0-9-]{10,}`. The mod applies the same patterns again before
rendering. This is best effort; file permissions remain the primary control.

## Failure rules

Logging is a side channel. If the directory or a file cannot be created or written at any point (including a segment rotation), the worker keeps
running, its stdout is still fully drained, and the wrapper's stdout, stderr summary, `-o` result (codex), final
parsing (pi, agy) and exit status are identical to a run with `ORCH_RUNLOG=0`.
