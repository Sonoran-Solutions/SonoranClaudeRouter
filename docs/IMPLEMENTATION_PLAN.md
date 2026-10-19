# Agent Inspector: small implementation plan

Date: 2026-10-19  
Status: proposed tasks, not implementation authorization. No phases have started.

This plan supersedes the larger collector-and-adapters proposal. The current launcher contracts and native mod API were identified in the [owner-machine review](https://github.com/Sonoran-Solutions/SonoranClaudeRouter/pull/1#issuecomment-6272603341). Preserve existing orchestration policy and worker result/exit semantics.

## Phase 0 — native pane skeleton

Use the installed Claude Code 2.1.299 `plugin-authoring` skill's `pane.tsx` example. Open a read-only `Pane` with `$.ui.open` and `ui.render`, render a synthetic worker list, then prove that it opens and updates in the owner's desktop app. No alternate browser/terminal UI or interface-feasibility study.

**Gate:** pane smoke test with version, screenshot, and proof that closing it does not change the parent session.

## Phase 1 — external runners first

Edit only the existing one-shot wrappers at `~/.claude/skills/orchestrator`:

- **Codex:** add `--json` to `codex exec`, tee stdout JSONL into `$XDG_RUNTIME_DIR/orchestrator/<run-id>.jsonl`, and retain `-o` plus the existing final return behavior.
- **Pi:** tee the existing `pi -p --mode json` stream rather than buffering it invisibly; keep the current final parsing. **Do not switch to RPC**. Its model traffic uses OpenRouter through Pi.
- **agy:** retain `agy --output-format json`. Emit run metadata while active and one final JSONL result only after completion; label it **final-only**.

Build the pane's `$.fs` / `$.clock.every` polling view for these per-run files. Keep a bounded recent-event display in `$.state` and handle incomplete trailing lines and corrupt JSON visibly. Ensure start and end markers use unique run IDs, original exit statuses, private directory/file permissions (`0700`/`0600`), and explicit unavailability if logging fails.

**Gate:** Codex and Pi show at least one genuine event **before** their one-shot process exits; agy shows honest start/final-only status. Compare normal output, final result, and exit code with monitoring disabled. Inject an unwritable log destination and verify the worker still finishes normally.

## Phase 2 — Claude-native attribution

Add `agent.spawn` and `$.agent.list()` worker IDs and parent/task links to the same pane, using `turn.step` only for content it actually exposes. Do not duplicate native transcripts or invent unavailable reasoning. Display existing `usage.sh` quota data separately with a source timestamp, only if doing so does not invoke new model calls.

**Gate:** simultaneous Claude, Codex, and Pi work remains correctly attributed to separate runs; missing source fields are labelled unavailable.

## Phase 3 — hardening and owner acceptance

Test concurrent sessions, two workers with the same task name, partial/malformed records, file permission errors, a long-running noisy worker, and closing/reopening the pane. Check bounded UI memory, safe rendering of hostile terminal text, private log permissions, and clearly distinguish event silence from worker failure.

**Gate:** one evidence report with installed versions, exact wrappers, before/after result equivalence, live-event screenshots/timestamps, known final-only/streaming limits, checks run/not run, and owner approval.

## Not in scope

No collector, socket, browser viewer, persistent ingestion cursor, direct OpenRouter adapter, persistent Pi RPC, process relaunch, model switching, prompt steering, permission approvals, or cancellation. These add complexity without solving the immediate blind spot.

**Merge policy:** implementation PRs remain unmerged, with auto-merge off, until explicitly approved. This documentation PR does not authorize wrapper changes.
