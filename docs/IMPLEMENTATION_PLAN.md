# Agent Inspector implementation plan

Date: 2026-10-19  
Status: proposed, not implementation authorization

All milestones are unstarted. Use separate reviewable changes and record actual evidence. A passing documentation review does not establish runtime compatibility.

## Phase 0: compatibility and launch-boundary spike

Inspect the existing orchestrator skill locally with owner authorization. Document how it starts Claude, Codex, Pi, and OpenRouter-backed tasks; where process ownership lives; how results return; and which component supplies usage availability. Do not publish private prompts, quota values, credentials, or local auth paths.

Record installed versions and exact supported interfaces. Demonstrate a minimal supported Claude Code panel if one exists. If not, document the limitation and propose a companion terminal/browser viewer without patching Claude Code internals. Keep UI hosting and event capture as separate findings.

For one Claude path and one Codex path, run a small owner-approved task that emits at least two separated updates. Capture timestamped, sanitized evidence that the viewer receives an update before the task finishes. Determine which tool output is buffered. Confirm that the same task still returns its normal final result to the orchestrator.

**Exit gate:** a short compatibility report, sanitized source-event samples, the chosen frontend, a worker ownership diagram, and known gaps. No migration of the routing policy. No broad implementation until this gate is reviewed.

## Phase 1: read-only vertical slice

Implement the minimal event envelope, one adapter, local collector, bounded persistence, and worker selector with a transcript view. Prefer the Claude path proven in Phase 0, but use recorded synthetic fixtures while building the renderer.

Support lifecycle states, last-event age, follow/pause-follow, basic output expansion, final results, and connection health. Keep provider-specific parsing out of the view. Close and reopen the viewer while a worker continues running.

**Exit gate:** one real worker can be followed while active, its final state remains inspectable, and restarting the UI does not interrupt execution or create duplicate transcript items.

## Phase 2: Codex integration and correlation

Add the proven Codex source. Retain the existing launcher where possible; do not silently replace an interactive or persistent integration with a one-shot `exec` process. Use app-server only when its additional streaming/session capabilities are needed and its integration cost is justified.

Run Claude and Codex workers concurrently under one parent task. Verify that tool output, usage, and terminal outcomes never cross between workers. Record capture granularity visibly: streamed text, streamed command output, item-level updates, or final-only data.

**Exit gate:** both worker types display real activity concurrently, preserve their existing result contracts, and remain correctly attributed across retries and reconnects.

## Phase 3: Pi and OpenRouter coverage

Add the Pi adapter using the installed version's documented event/RPC definitions. Distinguish command acceptance from run completion and correctly handle automatic retry or continuation. For OpenRouter through Pi, reuse the Pi adapter rather than observing and counting the same event twice.

Add a direct OpenRouter streaming adapter only if the current router owns a direct API loop. Capture both model events and the host's actual tool-execution events. Do not display a model-issued tool-call request as a completed command.

**Exit gate:** a capability table for every supported launch path, tests for unsupported reasoning fields and missing usage, and one sanitized live demonstration per implemented adapter. Unsupported paths stay explicit.

## Phase 4: reliability and daily-use acceptance

Harden replay, retention, search, filtering, large-output handling, and crash recovery. Reuse approved usage metadata with source timestamps and clear scope. Use an actual long-running task for a soak test after fixture-based failure testing.

**Exit gate:** the acceptance matrix below is completed with evidence, and the owner confirms that routine status requests are no longer needed for supported tasks.

## Acceptance matrix

| Check | Required evidence |
| --- | --- |
| Live, not completion-only | At least one update appears before task completion, with source and receive timestamps. Label any buffered event categories. |
| Update latency | Proposed target: 95% of normal-sized events render within one second of adapter receipt on the test machine. Measure separately from provider buffering. |
| Correct attribution | Two sessions with similarly named concurrent workers, nested tasks, and retries show no cross-contamination. |
| Replay | Disconnect/reconnect preserves order and avoids duplicated deltas or final messages. Expired cursors report missing history. |
| Honest status | Waiting, retrying, failed, cancelled, quiet, and disconnected cases remain distinguishable. No inferred success after losing a process. |
| Normal execution | Monitoring off versus on preserves launcher arguments, permissions, final-result shape, and exit behavior in controlled fixtures. |
| Viewer independence | Closing the viewer leaves workers running and returning results normally. |
| Resource limits | High-volume output and slow consumers keep telemetry memory bounded; dropped observation data is marked. |
| Failure isolation | Collector unavailable, disk full, malformed JSON, partial records, and adapter exceptions do not deadlock or terminate workers. |
| Security | Synthetic secrets are removed; malicious terminal sequences and HTML are inert; unauthorized local clients cannot read telemetry. |
| Usage accuracy | Missing values remain unavailable; estimates have scope/source; cumulative and per-turn figures are not double-counted. |
| Read-only boundary | No UI path can approve tools, send prompts, switch models, cancel work, or bypass routing policy. |

Acceptance thresholds are proposed targets, not benchmark results. Choose the supported concurrency and retention limits during Phase 0 and report the test environment alongside measurements.

## Deferred work

Interactive steering, cancellation, permission prompts, remote access, a Sonoran Hub frontend, and advanced routing analytics require separate authorization and design. They are not prerequisites for useful observability.

## Review handoff

For each implementation PR, report the base/head commits, actual adapter versions, checks run, checks not run, known buffering or compatibility limits, and evidence paths. Use synthetic or sanitized artifacts only. Keep the PR unmerged unless the owner authorizes merging; do not enable auto-merge as part of implementation.
