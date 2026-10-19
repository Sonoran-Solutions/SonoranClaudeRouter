# Agent Inspector MVP: evidence

Date: 2026-10-19. Machine: owner's Linux workstation. Versions: Claude Code 2.1.299 (desktop app bundle;
`claude` on PATH is 2.1.289), codex-cli 0.163.0, pi 0.86.0, jq 1.7, GNU coreutils `tee`.
Paths and run ids below are shortened; no prompts, keys or logs are committed.

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Wrapper behaviour (fakes, no network) | `bash tests/wrappers.test.sh` | all checks PASS, `0 checks failed` |
| Mod manifest/hooks | `claude plugin validate mod/agent-inspector` (2.1.299) | passed; only warning: no `author` field |
| Mod unit + pane tests | `claude plugin test mod/agent-inspector` (2.1.299) | 18 pass, 0 fail (terminal and desktop surfaces) |
| Mod types | `tsc` 5.6.3 with the types header `tsconfig.json` | no errors |

`claude plugin validate` lists the hooks as `session.start`, `command.run{agent-inspector}`, `agent.spawn`
(observe-only, pass-through `.catch`), `ui.render{Pane, agent-inspector}`; env reads `XDG_RUNTIME_DIR` only;
no `tool.call`, `tool.check`, `prompt.*` or `session.append` hooks.

The wrapper suite covers: identical stdout/stderr/exit code with `ORCH_RUNLOG=0` vs on (exit 0 and 3) for all
three wrappers; start-first/exit-last records with the returned exit code; `0700` directory and `0600` file; run-id
format; codex `-o` result; pi trims (no `message_update`, system message reduced to `(trimmed)` without
`sections`, empty `agent_end.messages`); pi provider record present while the fake worker still runs; agy
`orchestrator.final` and `parse_error` on garbage; redaction of the contract patterns and the literal
`OPENROUTER_API_KEY`; unwritable directory, mid-run write failure (worker still drained), unset/invalid
`XDG_RUNTIME_DIR` (no file anywhere); timeout → 124 and `timed_out: true`; two concurrent runs → distinct files;
explicit `ORCH_LABEL`/`ORCH_PARENT`; worker umask preserved; retention limited to top-level `*.jsonl`; argument
errors still logged.

## Live gate, phase 1: real workers through the instrumented wrappers

Task: "run `sleep 6` and then `ls`, then reply with exactly: done", in a scratch directory. Timings are from
launch; "lines" is the run log's line count as polled every 100 ms.

**Codex** (`run_codex.sh`, `gpt-6-luna`, `ORCH_CODEX_SANDBOX=read-only`):

| t | lines | newest record |
| --- | --- | --- |
| +0.1 s | 1 | `orchestrator.start` |
| +0.3 s | 2 | `thread.started` |
| +3.4 s | 4 | `item.completed` (agent_message) |
| +3.8 s | 5 | `item.started` (command_execution) |
| +9.6 s | 6 | `item.completed` (command_execution) |
| +11.9 s | 10 | `turn.completed` |
| +12.9 s | 11 | exit |

**Pi** (`run_pi.sh`, default model `deepseek/deepseek-v4.1-flash-1017`), three runs:

| run | first `tool_execution_*` record | wrapper exit | rc / stdout |
| --- | --- | --- | --- |
| 1 | +1.7 s | +9.6 s | 0 / `done` |
| 2 | +1.4 s | +8.1 s | 0 / `done` |
| 3 | +2.2 s | +9.0 s | 0 / `done` |

Granularity observed: Codex emits one record per item start/completion (no token deltas); Pi emits per message,
per tool start/update/end (its per-token `message_update` records are dropped from the log by design).

Monitoring on/off with real workers (`ls` task): Codex rc 0 / `done` both ways; Pi rc 0 / `done` and the same
cost line both ways. Directory `0700`, files `0600`.

**agy** was not run live: the session's permission classifier refused a direct `agy --dangerously-skip-permissions`
call. Its wrapper is covered by the fake-worker suite only.

## Observations and caveats

- One earlier Pi run (same task) produced only the start record and then hit the 200 s timeout; pi had emitted no
  record at all (not even its first `session` line, which normally appears at ~0.5 s). It did not reproduce in
  four later runs. Root cause unknown; not attributed to the wrappers, but not proven otherwise.
- That timed-out Pi run was recorded as `exit_code: 1`, not 124. This is the **existing** `run_pi.sh` behaviour:
  its failure branch runs `printf | grep -i error | tail | cut` under `set -euo pipefail`, and when no line
  matches `error` the script exits 1 before `exit $rc`. The instrumented wrapper preserves it (the log reports what
  the wrapper returns). Fixing it is a separate router change.

## Live gate, phase 0: native pane in the desktop app

Not yet observed by a person at the time of writing. To check: enable the mod (see
[`mod/agent-inspector/README.md`](../mod/agent-inspector/README.md)), run `/agent-inspector`, launch a wrapper run,
and confirm the run appears, updates while running, and the pane closes cleanly.
