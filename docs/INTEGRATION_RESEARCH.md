# Integration research and compatibility notes

Checked: 2026-10-19  
Scope: primary-source documentation review, not an installed-runtime test

The original discussion proposed a native Claude Code mod. This research supports structured observation paths, but does **not** establish that the installed Claude Code build provides the exact sidebar or `turn.step` API assumed in that discussion. Keep native hosting behind the Phase 0 gate. Failure to verify an API here is not proof that no such API exists.

## Documented interfaces

### Claude Code hooks

The [official hooks reference](https://code.claude.com/docs/en/hooks) documents subagent lifecycle and tool events. `SubagentStart` identifies an agent; `SubagentStop` can include its transcript path and final-message metadata. These are useful correlation inputs, not proof of a complete live transcript. Hook handlers must remain observational and must not return permission decisions or instructions that alter the run.

### Programmatically launched Claude Code

The [official programmatic-use guide](https://code.claude.com/docs/en/headless) documents `stream-json`, verbose output, partial messages, and forwarding subagent text. It describes `parent_tool_use_id` for associating nested messages and version-dependent forwarding behavior. Some invocation paths deliver messages only after completion.

For an authorized compatibility experiment, the documented stream-related flags include:

```text
--output-format stream-json --verbose --include-partial-messages
--forward-subagent-text
```

These are candidate flags, not a replacement launch command. Verify support locally and preserve the existing worker's authentication, settings, permissions, and result-return contract. A programmatic stream does not itself prove that an existing interactive session can be attached to without changes.

### Codex

The [official non-interactive guide](https://developers.openai.com/codex/non-interactive-mode) documents `codex exec --json`, which emits JSONL lifecycle and item events. It is a candidate for one-shot workers, not a guarantee that every nested command's output arrives token by token.

The [official app-server reference](https://developers.openai.com/codex/app-server) documents a richer session interface, including message and command-output deltas, reasoning-summary events, and approval requests. Availability of readable reasoning depends on the model. Preserve opaque data as opaque; do not reconstruct hidden reasoning. A read-only viewer must not become an approval handler by accident.

### Pi

The [maintainer's RPC reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) documents a persistent subprocess controlled through JSONL, asynchronous responses, and session events. It requires continuous stdout consumption and separates diagnostics onto stderr. Command acceptance is not task completion; the documented `agent_settled` boundary differs from the lower-level `agent_end` event.

This page redirected from the earlier `badlogic/pi-mono` repository location during research. Check the installed CLI and its matching documentation rather than assuming names or event contracts from an older release. The design has not yet been tested against the user's Pi version.

### OpenRouter

The [official streaming reference](https://openrouter.ai/docs/api/reference/streaming) documents streamed API responses. The [reasoning reference](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) describes provider/model-dependent reasoning handling. An adapter should expose only readable fields actually returned and tolerate absent, summarized, or opaque reasoning.

OpenRouter is an API/provider layer, not by itself a local coding-agent runtime. Tool execution and filesystem changes must be observed from the harness that performs them. A Pi-to-OpenRouter task normally needs one Pi adapter, not a second duplicate transcript.

## Findings that remain unverified

| Question | Required proof |
| --- | --- |
| Native Claude Code panel support | Installed-version documentation and a minimal panel that opens, updates, and closes without affecting the session. |
| Exact existing router integration | Inspect the actual orchestration skill and launcher contracts; none were present in this initially empty repository. |
| Live Claude-native text capture | Observe a real subagent before completion and verify parent/child IDs. |
| Fine-grained Codex output | Demonstrate the exact chosen integration's live event categories; do not infer them from the normal chat UI. |
| Quota availability | Identify the router's approved source, update cadence, and scope. Do not infer subscription allowance from API-token usage. |
| Runtime compatibility | Record local versions, authentication paths, permission behavior, and sanitized event fixtures. |

This file intentionally does not recommend third-party mods from the earlier discussion as verified dependencies. Evaluate their actual code, maintenance, and permissions separately before adoption.
