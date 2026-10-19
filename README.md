# SonoranClaudeRouter

**Status: Agent Inspector design proposal. No implementation is included.** This repository documents a read-only inspector for the existing Claude Code orchestration skill at `~/.claude/skills/orchestrator`. That skill is not copied into this repository and its execution or routing logic has not been changed.

## Why build it?

The orchestrator already chooses workers by task complexity and available quota. Claude-native subagents are visible in the desktop app, but Codex, Pi, and agy jobs currently run without useful live transcripts in the parent conversation. Agent Inspector would let the user select an external worker and follow its emitted activity instead of repeatedly requesting status.

## Current execution paths

| Executor | Existing launch | Visibility to add |
| --- | --- | --- |
| Claude | Native Agent tool | Correlate native `agent.spawn` / `$.agent.list()` details inside the pane (later phase). |
| Codex | One-shot `codex exec` with `-o` result file; stdout discarded | Enable `--json` and tee its JSONL to a per-run log while retaining `-o` and the result contract. |
| Pi | One-shot `pi -p --mode json`; stdout buffered by the wrapper | Tee the existing JSONL as it arrives; keep the wrapper's final parsing and exit behavior. |
| agy (Antigravity) | One-shot `agy --output-format json -p=…` | Show start/exit plus final JSON only; no claim of live incremental model output. |

**OpenRouter is not a separate executor here.** Pi uses OpenRouter-hosted models; `usage.sh` also checks OpenRouter credits. agy has separate quota buckets. Model backends, executors, and quota sources must not be conflated.

## Concept mockup

![Dark Agent Inspector concept with worker cards, a selected worker transcript, tool output, and usage cards.](docs/assets/agent-inspector-mockup.webp)

*AI-generated concept, not an implementation screenshot. The illustration predates agy coverage and contains fictional models, metrics, commands, and test results. Its message composer and model selector are not part of the read-only MVP. See [image notes](docs/assets/README.md).*

## Minimal proposed solution

The owner's installed Claude Code build (2.1.299) provides a native mod pane via `$.ui.open` and `ui.render` with a `Pane` component. Start from the installed `plugin-authoring` skill's `pane.tsx` example.

1. Each existing **external** worker wrapper writes a private per-run JSONL log under `$XDG_RUNTIME_DIR/orchestrator/`. Codex and Pi can report events before completion; agy is explicitly final-only.
2. The mod pane polls those files using `$.fs` and `$.clock.every`, shows per-worker activity, and keeps a bounded **in-memory** display buffer with `$.state`.
3. Later, the pane associates Claude-native workers using `agent.spawn`, `$.agent.list()`, and supported `turn.step` events.

There is **no collector service, socket, browser viewer, persistent ingestion cursor, Pi RPC conversion, or direct OpenRouter streaming adapter** in the proposed MVP. Worker processes remain owned by their existing wrappers. The mod observes them without steering, approving tools, or changing routing.

## Documentation

- [Small implementation plan](docs/IMPLEMENTATION_PLAN.md): native pane, external runners first, Claude attribution second, then tests.
- [Design and safety boundaries](docs/AGENT_INSPECTOR_DESIGN.md): UI, log contract, honesty, privacy, and non-interference.
- [Local integration evidence](docs/INTEGRATION_RESEARCH.md): installed APIs, current wrappers, quota source, and remaining checks.
- [Mockup asset notes](docs/assets/README.md): committed image and interpretation.

**Next task proposed, not authorized by these documents:** implement the native pane from `pane.tsx` and demonstrate that it opens in the desktop app. Keep the current routing policy intact.
