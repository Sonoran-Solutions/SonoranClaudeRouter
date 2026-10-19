# Agent Inspector MVP: evidence

Date: 2026-10-19. Machine: owner's Linux workstation. Versions: Claude Code 2.1.299 (desktop app bundle;
`claude` on PATH is 2.1.289), codex-cli 0.163.0, pi 0.86.0, jq 1.7, GNU coreutils `tee`.
Paths and run ids below are shortened; no prompts, keys or logs are committed.

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Wrapper behaviour (fakes, no network) | `bash tests/wrappers.test.sh` | all checks PASS, `0 checks failed` |
| Mod manifest/hooks | `claude plugin validate mod/agent-inspector` (2.1.299) | passed; only warning: no `author` field |
| Mod unit + pane tests | `claude plugin test mod/agent-inspector` (2.1.299) | 30 pass, 0 fail across 3 files (terminal and desktop surfaces); 18 at the first submission, 27 after the first review |
| Mod types | `tsc` 5.6.3 with the types header `tsconfig.json` | no errors |

`claude plugin validate` lists the hooks as `session.start`, `command.run{agent-inspector}`, `agent.spawn`
(observe-only, `gating hook without .catch`: it forwards the spawn exactly once, see the review table below),
`ui.render{Pane, agent-inspector}`; env reads `XDG_RUNTIME_DIR` only; no `tool.call`, `tool.check`, `prompt.*` or
`session.append` hooks.

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

**agy** (`run_agy.sh`, agy 1.4.2, `gemini-3.8-flash-low`, prompt "Reply with exactly: pong", empty scratch
workdir; run on 2026-10-19 with the owner's explicit approval, since the wrapper uses `--dangerously-skip-permissions`):
the lifecycle file appeared +0.2 s after launch with only `orchestrator.start` (`granularity: final-only`); after agy
returned (~7 s) it held `orchestrator.final` (`status SUCCESS`, `response "pong\n"`, `response_truncated false`,
`response_chars 5`) and `orchestrator.exit` (`exit_code 0`, `segments 0`); file mode `0600`, 757 bytes, no
segments. With `ORCH_RUNLOG=0` the same call printed the same stdout (`pong`), the same empty stderr and rc 0. The
workdir stayed empty.

## Observations and caveats

- **Fixed: Pi startup stall (root cause: inherited stdin).** `pi -p` reads all of a non-TTY stdin before starting
  and waits for EOF with no timeout (pi 0.86.0 `dist/main.js:705-708`, `readPipedStdin()`). `run_pi.sh` passed the
  prompt as an argument but left stdin inherited; the desktop app's tool shells sometimes hand over a socket that
  never reaches EOF (other calls get `/dev/null`, hence the intermittency), so pi printed nothing and hung until the
  timeout. Ruled out: the logging wrapper (direct runs stall identically: 12/12 in an A/B run), the network (under
  `strace` a stalled pi made **no `connect` call at all**), the unknown-model warning (local fallback) and pi's lock
  directories. Proof: with an inherited open stdin, 3/3 direct runs stalled while 3/3 with `< /dev/null` finished in
  0.9–2.5 s; with stdin held open on a FIFO, the original wrapper hung to the timeout and the fixed one answered in
  1.4 s. Fix: `< /dev/null` on the pi call. Regression test: a fake pi that reads stdin to EOF, run with stdin held
  open on a FIFO (fails before the fix, passes after). `run_codex.sh` is unaffected (prompt on stdin from a file).
  The same one-line fix was applied to the owner's live `~/.claude/skills/orchestrator/scripts/run_pi.sh` on
  2026-10-19 with a dated backup.
- **Fixed: Pi timeout status.** The original `run_pi.sh` failure branch ran `printf | grep -i error | tail | cut`
  under `set -euo pipefail`; with no `error` line, grep's status 1 ended the script before `exit $rc`, so a silent
  timeout returned 1 instead of 124. The pipeline now uses `{ grep -i error || true; }`. A test with a fake pi that
  prints nothing proves 124 with logging on and off; a live stalled run above was recorded as `exit_code 124`,
  `timed_out true`. `run_codex.sh` and `run_agy.sh` failure branches do not have this problem.

## Revision after senior review (2026-10-19)

| Finding | Change | Proof |
| --- | --- | --- |
| P1 spawn could be forwarded twice | `agent.spawn` hook calls `next(e)` once, bookkeeping in try/catch, **no `.catch`** (per the 2.1.299 types, a hook that fails after `next` was answered "is skipped by name and its last `next` stands") | `tests/spawn.test.ts`: normal, rejecting, denied and failing-bookkeeping paths each forward exactly once |
| P1 logs over 4 MiB lose the exit status | Contract now separates a tiny lifecycle file (`<run-id>.jsonl`: start/final/exit) from rotating event segments (`<run-id>.<n>.jsonl`, 1 MiB each, newest 4 kept, oversize lines replaced by a placeholder); the mod reads the lifecycle file every change and segments independently, with a per-file read limit | wrapper tests: Codex and Pi runs printing >4 MiB then exiting 3 keep a <8 KiB lifecycle file with `exit_code 3`, ≤3 segments each ≤2× segment size; mod tests: exit after partly rotated >4 MiB segments shows `exited 3` with omitted counts, and an oversized live segment doesn't block the exit |
| P2 one unreadable log blocks all runs | per-run and per-file error isolation; warning on the affected run, retried next poll | mod test: EACCES on run A, run B still reaches `exited 0` in the same poll |
| P2 Pi silent timeout masked | see "Fixed: Pi timeout status" above | wrapper test with a silent fake pi |
| P2 no rollback path | `orchestrator/README.md`: diff, dated backup, install, check, rollback commands | doc review |

Checks after the revision: `bash tests/wrappers.test.sh` → 0 checks failed (180+ checks); `claude plugin test` → 27
pass; `claude plugin validate` → passed (no author field warning only); tsc clean. Live: a real Codex run through the
revised wrapper wrote a 527-byte lifecycle file (`exit_code 0`, `segments 1`) and its events to `.1.jsonl`, all
`0600`.

**Concurrent attribution (phase 2 gate), file level:** while a Claude Opus agent was revising the mod, a Pi worker
(`revise wrappers…`, 595 records) and a Codex worker (`concurrency gate (codex)`) ran through the instrumented
wrappers at the same time; each wrote its own run files with its own label and exit. Whether the pane displayed
them correctly side by side has not yet been confirmed by a person.

## Re-review revision (2026-10-19, review 5576337736)

| Finding | Change | Proof |
| --- | --- | --- |
| P1 agy final response could push the lifecycle file over the read limit | `orchestrator.final` redacts first, then caps `response` at `ORCH_RUNLOG_FINAL_MAX_CHARS` (default 65536) and `status` at 200 characters, and records `response_truncated` / `response_chars`; the caller's stdout is untouched. The mod shows a truncation warning beside the final, and a lifecycle file that is still over the limit (old uncapped logs) yields one "status unknown (not failed)" warning instead of silence. | wrapper tests: a 5,000,000-character agy response leaves stdout identical to logging off and complete, keeps the lifecycle file under 512 KiB with the exit record last, records the truncation, and never logs a secret placed across the cut; cap is configurable; small responses are flagged untruncated. Mod tests (30 pass): capped final + exit 0 shows `exited 0`, the final and the warning on terminal and desktop; an oversized lifecycle file shows `unknown` with one warning and is never read |
| P3 stale evidence and PR description | test counts and the `.catch` wording corrected above; PR description rewritten to the current state | — |

## Live gate, phase 0: native pane in the desktop app

The owner ran `/agent-inspector` in the desktop app with the mod hot-loaded; the command answered "Agent Inspector opened (read-only)." That the pane **updates and closes cleanly** has not yet been reported by a person. To check: enable the mod (see
[`mod/agent-inspector/README.md`](../mod/agent-inspector/README.md)), run `/agent-inspector`, launch a wrapper run,
and confirm the run appears, updates while running, and the pane closes cleanly.
