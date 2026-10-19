# Agent Inspector: minimal design

Date: 2026-10-19  
Status: proposal only; no runtime implementation

## 1. Purpose and scope

Give the owner a direct, read-only view of delegated work without asking Claude for updates. The immediate blind spots are the **one-shot Codex and Pi wrappers**, followed by the **agy final-only runner**. Claude-native subagents already have some visibility in the desktop app, so their attribution comes after external runners.

The current router remains at `~/.claude/skills/orchestrator`; no change to task selection, quota policy, permissions, worker ownership, cancellation, or final-result contracts is proposed.

## 2. Visual reference and native hosting

![Agent Inspector concept illustration](assets/agent-inspector-mockup.webp)

The image is a visual direction, not a working screenshot. It shows Claude, Codex, and Pi but predates **agy**; the real worker list must include agy. Hide/disable the concept's message composer and model selector. The mockup's generic “thought” lines must never be presented as raw private reasoning.

The owner's Claude Code **2.1.299** mod definitions include `$.ui.open({ id, title })` and a `ui.render` hook with a `Pane` component. Use the installed `plugin-authoring/pane.tsx` example to build the native pane; a separate browser or terminal frontend is not in scope. `$.state` supports session-local UI data. The installed API also exposes `turn.step`, `agent.spawn`, `$.agent.list()`, and streaming `$.process.spawn`; the first implementation does **not** need to take over worker process spawning.

The pane should offer a worker list and selected transcript with executor, model if reported, task label, run age, last event, state, stream granularity, and exit/result details. Support follow-tail versus manual scrolling, bounded output expansion, and keyboard navigation. Quiet does not mean stalled; unknown does not mean failed.

## 3. Existing execution boundaries

| Runner | Source today | Proposed observation | Honest limitation |
| --- | --- | --- | --- |
| Codex | One-shot `codex exec -o <result-file>`, stdout discarded | Add `--json`; tee stdout JSONL to one per-run file; continue reading the existing `-o` result | Item/event granularity depends on actual CLI stream |
| Pi | One-shot `pi -p --mode json` captured in a shell variable | Tee existing JSONL as it is produced, then preserve today's result extraction | **Not RPC mode**; OpenRouter is Pi's model provider |
| agy | One-shot `agy --output-format json -p=…` | Write start/exit metadata; wrap the completed final JSON into a single JSONL record | **Final-only**, not continuous model output |
| Claude-native | Agent tool | Later use `agent.spawn` / `$.agent.list()` IDs and `turn.step` observation as supported | Show only actually exposed content; no transcript scraping requirement |

Quota metadata already comes from the router's `usage.sh`. Its sources include Codex app-server rate limits, agy quota/credits, OpenRouter credits, and Claude session-management usage. Label different quota buckets and measurement ages. Do not pretend token counts are remaining subscription quota. **No direct OpenRouter agent/API loop exists** to instrument.

## 4. Minimal data flow

```text
~/.claude/skills/orchestrator
  ├─ Claude Agent tool ──────────> native agent events (Phase 2)
  ├─ Codex one-shot wrapper ─┐
  ├─ Pi one-shot wrapper ────┼──> $XDG_RUNTIME_DIR/orchestrator/<run-id>.jsonl
  └─ agy one-shot wrapper ───┘                   │
                                         native Claude Code mod
                                      $.fs + $.clock.every polling
                                          Pane + $.state buffer
```

Each external run receives a unique filename and a small namespaced start record with a run ID, executor, task label, and timestamp. Keep the provider's emitted JSONL records intact where possible. Add a namespaced exit record containing the **original worker exit status**; for agy, include a final-only result record once its command exits. Record a parent task or session ID only when the wrapper already has or is explicitly passed that identifier; otherwise display “not available”, not an invented relationship.

A file contains complete newline-delimited JSON records. The mod reads newly appended complete lines and waits on partial trailing lines. It tracks reading position and a bounded display buffer in `$.state`; **there is no durable collector, ingestion cursor, database, subscriber replay, socket, or network service**. The per-run files themselves are the local session record, subject to cleanup. Parser errors become visible telemetry warnings and must not be mistaken for agent failures.

Codex must retain its `-o` file output. Pi must retain its final parsing semantics. Instrumentation must not turn a successful run into a failure or a failed run into success, including when logging fails. Preserve the worker's own exit code across tee/pipeline handling and ensure the stream keeps draining even if the telemetry destination becomes unwritable. Do not add a second model invocation just to monitor one.

## 5. Trust, retention, and UI honesty

Create the runtime directory with owner-only access (mode `0700`) and logs with mode `0600` (for example using `umask 077`). Do not create a world-readable fallback if `$XDG_RUNTIME_DIR` is absent. Never commit real logs, prompts, tokens, credentials, or quota snapshots into this public repository. Raw provider output may still contain secrets: minimize logged fields, redact known secrets before writing where feasible, redact before rendering, and clean up completed logs on a defined local retention policy. File permissions are necessary, not sufficient.

Treat output as **untrusted text**: escape rich markup, strip unsafe terminal control characters, never execute transcript text, and do not let file names choose arbitrary read paths. Store only a bounded number of recent rendered events per worker in session state; show that older displayed events were omitted instead of implying complete coverage.

Display `reasoning summary` or `exposed reasoning` only if supplied as readable content. Do not synthesize “thinking” from tool calls. Distinguish worker-reported success, observed process exit status, and independently verified tests. agy must say `final-only`, even while running; last-event timestamps are observation freshness, not progress percentages.

The mod is read-only: it must not register a `tool.call` handler that denies or approves work, rewrite `prompt.submit`, steer workers, switch models, or send cancellation signals. Closing the pane must leave execution and result return unchanged. If the log path is unavailable or malformed, only monitoring degrades.

## 6. Deferred

Interactive messaging/cancellation, persistent Pi RPC, Codex app-server as an executor, direct OpenRouter streaming, remote access, Sonoran Hub integration, and a collector service are not part of the minimal implementation. Reconsider any of them only after observed limitations justify the extra architecture.

See [implementation plan](IMPLEMENTATION_PLAN.md) for the abbreviated phase sequence and [integration notes](INTEGRATION_RESEARCH.md) for the owner-machine review evidence.
