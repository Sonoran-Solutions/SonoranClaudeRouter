# Agent Inspector: implementation plan

Date: 2026-10-19  
**Status: proposal only; no implementation authorized.** The existing router is at `~/.claude/skills/orchestrator`. The [owner-machine review](https://github.com/Sonoran-Solutions/SonoranClaudeRouter/pull/1#issuecomment-6272603341) established the native mod and one-shot wrapper interfaces.

## 0. Native pane

Copy the installed Claude Code 2.1.299 `plugin-authoring/pane.tsx` example. Use `$.ui.open` + `ui.render` to display a read-only `Pane` with synthetic workers.

**Gate:** pane opens, updates, and closes cleanly in the desktop app. Record a screenshot and installed version; no fallback frontend.

## 1. External runners first

Preserve the current wrappers and their process ownership. Give every launch a unique `$XDG_RUNTIME_DIR/orchestrator/<run-id>.jsonl` (private directory `0700`; files `0600`), with start/exit markers and **original exit code**.

| Runner | Minimal change | Expected visibility |
| --- | --- | --- |
| Codex | Add `--json` to one-shot `codex exec`; tee JSONL; keep `-o` output | Live structured events |
| Pi | Tee current one-shot `pi -p --mode json` stream; retain final parsing | Live JSONL; **no RPC** |
| agy | Keep `agy --output-format json`; record final JSON after exit | Start/exit and **final-only** |

Pane polls files with `$.fs` / `$.clock.every`, renders complete records, tolerates partial/malformed lines, and bounds recent displayed events in `$.state`. No collector, socket, database, or durable replay protocol.

**Gate:** Codex and Pi each show a real event *before exit*; agy is accurately marked final-only. Verify same final result and exit code with monitoring on/off, including when log writing fails.

## 2. Claude attribution

Show Claude-native agent IDs/models and parent/task relationships through `agent.spawn`, `$.agent.list()`, and only supported `turn.step` content. Do not invent raw reasoning or scrape transcripts. Any quota display reads existing `usage.sh` data with source age; OpenRouter is Pi's backend, not another worker.

**Gate:** concurrent Claude/Codex/Pi work remains correctly separated.

## 3. Acceptance

Exercise two simultaneous runs with identical titles, noisy output, incomplete JSONL, unwritable logs, pane close/reopen, and untrusted terminal text. Verify private permissions, bounded UI memory, honest error/status labels, preserved wrapper behavior, and no permission, steering, or cancellation hooks.

**Gate:** attach sanitized evidence, commands, versions, observed latency/granularity, tests run/not run, and owner decision. Keep implementation PRs unmerged with auto-merge off pending approval.

**Deferred:** process takeover, interactive controls, persistent Pi RPC, direct OpenRouter loop, remote viewer, Sonoran Hub, and any separate collector. See [design](AGENT_INSPECTOR_DESIGN.md).
