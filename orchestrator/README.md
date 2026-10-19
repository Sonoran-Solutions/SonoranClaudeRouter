# Instrumented orchestrator wrappers

Drop-in replacements for the three external-worker wrappers in `~/.claude/skills/orchestrator/scripts/`. Each
launch also writes a private per-run log for the Agent Inspector mod, as specified in
[`docs/LOG_CONTRACT.md`](../docs/LOG_CONTRACT.md). Arguments, environment variables, stdout, stderr and exit codes
are unchanged (deliberate exceptions: the two `run_pi.sh` bug fixes below); logging is a side channel that can fail without affecting the worker.

| File | Change from the live wrapper |
| --- | --- |
| `scripts/_runlog.sh` | new: lifecycle file (start/final/exit), rotating event segments, directory and permission checks, retention, redaction, `tee -p` side branch |
| `scripts/run_codex.sh` | adds `--json`; the JSONL stream goes to the log instead of `/dev/null`; `-o` result unchanged |
| `scripts/run_pi.sh` | tees the existing `--mode json` stream into the log (trimmed, redacted); final parsing unchanged; a timeout with no `error` output now exits 124 instead of 1, and pi gets `< /dev/null` so an inherited never-closing stdin can't hang it (bug fixes) |
| `scripts/run_agy.sh` | start record, then one `orchestrator.final` record after agy exits (final-only) |

`_env.sh`, `usage.sh`, `models.sh` and `selfcheck.sh` are not part of this repository and are not modified.

## Install (not done by this PR)

The live router is not touched until its owner copies the files in. Run these from the repository root, one
step at a time.

1. Review what will change (the diff is against the live copies; expect only logging changes plus the `run_pi.sh`
   timeout-status fix):

   ```bash
   for f in run_codex.sh run_pi.sh run_agy.sh _runlog.sh; do diff -u ~/.claude/skills/orchestrator/scripts/$f orchestrator/scripts/$f; done
   ```

2. Take a dated backup of the live wrappers (`cp -p` keeps modes and times; the directory name is printed):

   ```bash
   bak=~/.claude/skills/orchestrator/scripts/backup-$(date +%Y%m%d-%H%M%S) && mkdir "$bak" && cp -p ~/.claude/skills/orchestrator/scripts/run_codex.sh ~/.claude/skills/orchestrator/scripts/run_pi.sh ~/.claude/skills/orchestrator/scripts/run_agy.sh "$bak"/ && echo "$bak"
   ```

3. Install:

   ```bash
   install -m 0755 orchestrator/scripts/run_codex.sh orchestrator/scripts/run_pi.sh orchestrator/scripts/run_agy.sh orchestrator/scripts/_runlog.sh ~/.claude/skills/orchestrator/scripts/
   ```

4. Check: `~/.claude/skills/orchestrator/scripts/selfcheck.sh` should still print `ALL PASS`, and
   `ls $XDG_RUNTIME_DIR/orchestrator/` should list the dry runs' logs.

**Rollback** (replace `<backup-dir>` with the directory step 2 printed): restore the saved wrappers and remove the
helper they no longer source.

```bash
cp -p <backup-dir>/run_codex.sh <backup-dir>/run_pi.sh <backup-dir>/run_agy.sh ~/.claude/skills/orchestrator/scripts/ && rm ~/.claude/skills/orchestrator/scripts/_runlog.sh
```

`ORCH_RUNLOG=0` only turns logging off; it is not a rollback; the instrumented wrappers (including `--json` on
Codex) stay in place.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `ORCH_RUNLOG` | `1` | `0` disables logging |
| `ORCH_LABEL` | prompt file basename | task label shown in the pane |
| `ORCH_PARENT` | unset (`null`) | parent task/session id, only when the caller has one |
| `ORCH_RUNLOG_RETENTION_MIN` | `1440` | logs older than this are deleted at the next launch |
| `ORCH_RUNLOG_SEGMENT_BYTES` | `1048576` | provider records rotate to a new `<run-id>.<n>.jsonl` segment at this size |
| `ORCH_RUNLOG_KEEP_SEGMENTS` | `4` | older segments of a run are deleted after a rotation |

## Tests

```bash
bash tests/wrappers.test.sh
```

Uses fake `codex`/`pi`/`agy` executables replaying [`tests/fixtures/`](../tests/fixtures), a temporary
`XDG_RUNTIME_DIR`, and an empty stub `_env.sh`; no network. Run it from a filesystem that supports Unix
permissions (it copies the scripts to `$TMPDIR`).
