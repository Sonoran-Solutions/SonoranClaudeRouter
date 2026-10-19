# Integration evidence and references

Date: 2026-10-19  
Scope: documentation adjusted to the [owner-machine review of PR #1](https://github.com/Sonoran-Solutions/SonoranClaudeRouter/pull/1#issuecomment-6272603341), not a fresh test performed by this repository.

## Native Claude Code mod API: established on installed build

The review inspected local Claude Code **2.1.299** mod/plugin type definitions:

- `$.ui.open({ id, title })` and `ui.render` with `{ component: 'Pane' }` create a native UI pane.
- `turn.step` is an actual streaming event; `agent.spawn` covers the Agent tool, and `$.agent.list()` exposes live agent IDs/models.
- `$.process.spawn` can stream subprocess chunks, but taking over wrapper process ownership is **not needed** for the proposed file-tail design.
- `$.state` / `$.store` are available for session/global mod state, and `$.fs` plus `$.clock.every` are the proposed local-file polling path.

**Action:** build from the installed `plugin-authoring/pane.tsx` example and verify desktop rendering. Native panel availability is **not** an open feasibility gate. The event payloads and actual file-tail performance still require implementation tests.

## Current router: already located

The active orchestration skill lives at `~/.claude/skills/orchestrator`. These are current local findings from the review, not claims derived from repository code (the repo only contains this proposal):

| Executor | Current command shape | What needs to change |
| --- | --- | --- |
| Claude | Native Agent tool | Later correlate existing IDs/events; no separate launcher |
| Codex | One-shot `codex exec … -o <file>`, stdout discarded | Add `--json` and tee JSONL without replacing `-o` result |
| Pi | One-shot `pi -p --mode json`, JSONL buffered in shell variable | Tee existing JSONL and preserve post-exit parsing |
| agy / Antigravity | One-shot `agy --output-format json -p=…` | Emit start/exit metadata and final-only result |

The existing `usage.sh` checks Codex rate limits through `codex app-server account/rateLimits/read`, agy quotas through `/quota` and `/credits`, OpenRouter through `/api/v1/credits`, and Claude usage through `mcp__ccd_session_mgmt__get_usage` in the desktop app. agy has its **own quota buckets**. These quota queries are not evidence that a direct OpenRouter worker loop exists.

Pi is used with **OpenRouter** in this setup. OpenRouter is a provider/credits source, **not** a fifth executor or independent live-event adapter.

## Technical references and what they do *not* imply

- [Codex non-interactive JSON mode](https://developers.openai.com/codex/non-interactive-mode) documents `codex exec --json`. Confirm emitted event granularity with the installed CLI; do not infer token-level tool output.
- [Codex app-server](https://developers.openai.com/codex/app-server) documents richer streaming APIs but is currently used for quota lookup, **not** to launch this router's workers. No app-server executor migration is planned.
- [Pi RPC reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) describes a **different persistent mode**. It is background research only; the active wrapper uses `--mode json` and remains one-shot.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [programmatic mode](https://code.claude.com/docs/en/headless) are supplementary references; the native installed mod API and Agent tool already address this project's Claude path.
- [OpenRouter streaming](https://openrouter.ai/docs/api/reference/streaming) is not a direct integration requirement because the model calls run through Pi.

## Still to prove during implementation

1. The real mod pane opens and updates on the owner's desktop build, and polling `$.fs` does not block UI.
2. Codex and Pi emit useful JSONL **before process completion** with the current authentication/flags.
3. Tee/log failures cannot alter the original wrapper's exit code, `-o` output, Pi extraction, or worker lifetime.
4. agy displays explicitly as **final-only** and every source keeps accurate task/usage attribution.

No collector, Unix socket, browser security layer, direct API adapter, persistent Pi RPC loop, or unverified alternative hosting remains in the proposed implementation.
