# Agent Inspector design

Date: 2026-10-19  
Status: proposed design; implementation not started

## 1. Purpose and brief

Make delegated coding work inspectable while it happens. The user already has a Claude Code orchestration skill that selects workers using task complexity and available usage. The missing capability is a direct view into those workers, comparable to following an ordinary coding-agent conversation.

The discussion establishes the need for live visibility, mixed-provider support, and the supplied visual direction. The specific architecture, milestone order, and acceptance thresholds below are proposals, not separately approved owner decisions.

Success means the user can answer, without prompting the orchestrator:

- Which workers are active, what were they assigned, and what spawned them?
- What did a selected worker most recently say, run, edit, or report?
- Is it working, waiting for input, retrying, finished, or simply no longer observable?

## 2. Visual direction

![Agent Inspector concept with worker cards and a selected worker's live output.](assets/agent-inspector-mockup.webp)

The mockup is a visual reference, not an implementation contract. It depicts a desktop-style shell; the production layout must adapt to the actual host's capabilities and available terminal width.

### Agent list

Show task title, harness, provider, model, parent task, runtime, lifecycle status, and time since the last observed event. Distinguish the harness from the provider: a Pi worker can use an OpenRouter-hosted model. Group workers by orchestration session so simultaneous projects do not mix.

Selecting a worker opens its transcript without losing the parent conversation. Keep completed and failed workers available in session history. Preserve selection and scroll position when another worker emits an event.

### Live transcript

Render messages, tool invocations, tool results, command output, reported file changes, and errors as distinct event types. Offer follow-tail, pause-follow, search, filtering, expandable output blocks, and a full-log view. Pausing follow only pauses scrolling, never the worker or event collection.

Provide keyboard navigation and textual status labels; do not rely on color alone. Fit a compact view into a narrow terminal and avoid taking over the orchestrator's existing shortcuts. Exact keybindings depend on the selected host.

### Reasoning and evidence labels

Use labels such as `message`, `reasoning summary`, and `exposed reasoning`, according to what the source actually provides. Never infer private reasoning from tool activity or promise complete internal thinking. Encrypted or opaque reasoning data is not display text. Missing reasoning should read as unavailable, not an empty loading panel.

The mockup's generic `[thought]` label must be replaced by these source-specific labels. Its test-pass line is illustrative; in the product, a worker's claimed outcome and a tool's captured exit status are separate pieces of evidence. A successful worker run is not the same as owner acceptance or a completed code review.

### Metrics and freshness

Show observed tool counts and elapsed time. Display token usage and cost only when supplied or derived from a documented source. Mark estimates, specify their scope, and timestamp them. Do not add a cumulative session total to per-turn totals and double-count usage.

Subscription quota, monetary API spend, context consumption, and token counts are different measurements. Reuse the existing router's approved quota source where available, displaying its age. Do not infer remaining Claude/Codex allowance from token counts or show missing data as zero.

Display worker lifecycle and telemetry freshness separately. A quiet worker is not necessarily stuck. The UI may say `No events for 3m` while the last known lifecycle remains `running`; loss of observation must not manufacture a failure or success.

### Excluded mockup controls

The message composer and provider/model selector in the illustration are future concepts. Hide or visibly disable them in a read-only release. No steering, cancellation, permission approval, or model switching belongs in the MVP.

## 3. Proposed architecture

```text
Existing Claude orchestrator and routing policy
                    |
      Existing worker owner / instrumented launch boundary
                    |
     +--------------+---------------+----------------+
     |                              |                |
 Claude adapter                Codex adapter    Pi / API adapter
     |                              |                |
     +----------- normalized observation events -----+
                                    |
                     Local collector and bounded store
                                    |
                     Read-only subscription / replay
                                    |
              Claude Code inspector, if host support is proven
                or companion terminal / local browser viewer
```

**Keep execution ownership where it already lives.** The orchestrator or current supervisor remains responsible for worker stdin/stdout, permissions, cancellation, and process lifetime. The monitor receives an observation copy. Closing the viewer must not close a worker's input or send a termination signal.

The launch boundary assigns correlation IDs before work starts and registers the actual session/process identifiers when available. It also records a short routing reason and the quota snapshot used by the existing router, without changing that router's decisions.

Provider adapters translate supported source events into a shared envelope while retaining useful source-specific fields. Capture should use structured streams rather than scraping an interactive terminal whenever possible. Do not launch a duplicate agent merely to obtain a second view of the same task.

The collector owns ingestion, validation, redaction, persistence, and subscriber replay. A single writer with an append-only JSONL log is a reasonable initial implementation; an indexed store can follow demonstrated search needs. Storage format and implementation language remain open until the existing skill's integration points have been inspected.

The frontend depends on the normalized protocol, not provider-specific subprocess handling. That separation leaves room for a later Sonoran Hub frontend without making Hub integration part of this project phase.

## 4. Adapter boundaries

See [integration research](INTEGRATION_RESEARCH.md) for primary sources and compatibility caveats.

| Path | Proposed capture strategy | Boundary to prove |
| --- | --- | --- |
| Claude-native subagents | Documented lifecycle/tool hooks; supported stream or scoped transcript access for content. | Correct parent/child attribution and visibility during execution, not just at completion. |
| Separately launched Claude worker | Programmatic structured output from the existing launcher. | Preserve its authentication, settings, permissions, result contract, and nested-worker behavior. |
| Codex worker | Start with the existing supported structured integration; `exec --json` is a lightweight candidate. | Determine which items arrive live and which are buffered. Use app-server if required for finer output deltas. |
| Pi worker | Existing JSON event or RPC mode, depending on how it is currently launched. | Respect asynchronous command responses, actual run completion, framing, and continuous stream draining. |
| OpenRouter-backed worker | Observe the harness first; add direct API streaming only when the router itself owns that API loop. | API text/tool-call requests are not proof that a local tool executed. Observe local execution separately. |

Hooks alone do not establish access to every live message. A hook can provide lifecycle information while transcript content is delayed. Native UI support must be proven separately from event capture. Do not depend on an assumed `turn.step` event or arbitrary sidebar API without an installed-version demonstration.

## 5. Proposed event contract

The following is an illustrative envelope, not a published provider schema:

```json
{
  "schema_version": 1,
  "event_id": "evt-example-018",
  "session_id": "session-example",
  "task_id": "task-roster",
  "worker_id": "worker-codex-01",
  "attempt_id": "attempt-01",
  "parent_worker_id": null,
  "source_sequence": 18,
  "observed_at": "2026-10-19T16:14:28Z",
  "harness": "codex",
  "provider": "openai",
  "model": null,
  "kind": "tool.output.delta",
  "payload": {
    "tool_call_id": "tool-test-01",
    "stream": "stdout",
    "text": "42 tests passed\n"
  }
}
```

The collector assigns a persistent ingestion cursor for replay. Preserve source sequence and source timestamps when provided; ingestion order across independent workers does not imply causal order. Associate text deltas and final snapshots with stable item IDs, so reconnecting does not duplicate the same output.

Use separate logical worker and attempt IDs. Retries or resumed invocations may reuse a provider session but must not overwrite the previous attempt's history. Scope all lookup keys to their orchestration session.

Candidate event families are `worker.*`, `message.*`, `reasoning.*`, `tool.*`, `artifact.reported`, `usage.reported`, and `telemetry.*`. Each adapter declares its supported families and whether capture is live, buffered, or summary-only. Unknown or malformed provider records generate diagnostics, not invented task results.

Candidate lifecycle states are `queued`, `starting`, `running`, `waiting_input`, `retrying`, `succeeded`, `failed`, `cancelled`, and `unknown`. Do not equate a turn completion with worker completion for a persistent session. Apply the adapter's verified terminal condition and retain exit status separately when a process exists.

## 6. Reliability and non-interference

The worker owner must continuously drain its protocol streams independently of UI rendering or disk writes. Use a bounded telemetry queue, batch updates, virtualize long transcripts, and place limits on event size and retention. A slow subscriber must not stall the provider subprocess.

When observation capacity is exceeded, emit a visible telemetry-gap marker and retain the best available lifecycle metadata. Avoid silent loss. If the collector cannot persist a gap immediately, report it when storage recovers. The worker's authoritative result channel remains separate from the lossy observation copy.

Parser errors, collector crashes, disk-full conditions, and viewer disconnects must degrade monitoring, not trigger permission changes, retries, or worker termination. This is a testable design goal, not a claim of zero overhead.

Reconnect using the last durable cursor. Detect an expired cursor and request an explicit history snapshot rather than pretending replay was complete. Show incomplete final records, unavailable history, and unknown process outcomes honestly after crashes.

## 7. Privacy and security

Keep telemetry local by default, outside source repositories. Never commit real transcripts, credentials, auth files, or environment dumps to this public repository. Use synthetic fixtures for development and tests.

Prefer a local Unix-domain socket with per-user access controls. A browser frontend would require loopback binding, authentication, origin checks, and safe handling of local file references; do not expose an unauthenticated network listener. These are requirements to implement and test, not existing protections.

Allowlist useful fields and redact secrets before persistence or display, including retained provider payloads. Redaction is imperfect, so also minimize capture, restrict local file permissions, and make retention/deletion configurable. Raw unredacted capture is outside the MVP.

Treat every transcript and tool result as untrusted text. Escape rendered content, strip unsafe terminal control sequences, reject path traversal in artifact access, and never execute commands embedded in a log. A transcript must not automatically become instructions to another agent.

No new model calls are required to summarize status in the MVP. Event-driven activity labels avoid consuming usage merely to learn how much usage a worker is consuming.

## 8. Open decisions

Before implementation, inspect the current orchestration skill and identify its real launch/return contracts. Confirm supported Claude Code UI APIs and installed versions; choose the initial frontend and first Claude adapter path; establish retention limits; and identify an approved source for quota metadata.

Future write controls need a separate design for ownership, approval routing, interrupted turns, and cancellation. Do not enable them simply because a provider exposes a command or the mockup contains an input box.
