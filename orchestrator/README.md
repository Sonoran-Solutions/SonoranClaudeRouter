# Instrumented orchestrator wrappers

Drop-in replacements for the three external-worker wrappers in `~/.claude/skills/orchestrator/scripts/`. Each
launch also writes a private per-run log for the Agent Inspector mod, as specified in
[`docs/LOG_CONTRACT.md`](../docs/LOG_CONTRACT.md). Arguments, environment variables, stdout, stderr and exit codes
are unchanged; logging is a side channel that can fail without affecting the worker.

| File | Change from the live wrapper |
| --- | --- |
| `scripts/_runlog.sh` | new: start/exit records, directory and permission checks, retention, redaction, `tee -p` side branch |
| `scripts/run_codex.sh` | adds `--json`; the JSONL stream goes to the log instead of `/dev/null`; `-o` result unchanged |
| `scripts/run_pi.sh` | tees the existing `--mode json` stream into the log (trimmed, redacted); final parsing unchanged |
| `scripts/run_agy.sh` | start record, then one `orchestrator.final` record after agy exits (final-only) |

`_env.sh`, `usage.sh`, `models.sh` and `selfcheck.sh` are not part of this repository and are not modified.

## Install (not done by this PR)

The live router is not touched until its owner copies the files in:

```bash
install -m 0755 orchestrator/scripts/run_codex.sh orchestrator/scripts/run_pi.sh orchestrator/scripts/run_agy.sh orchestrator/scripts/_runlog.sh ~/.claude/skills/orchestrator/scripts/
```

Rollback: restore the previous three `run_*.sh` files (or set `ORCH_RUNLOG=0` to disable logging while keeping
the new files).

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `ORCH_RUNLOG` | `1` | `0` disables logging |
| `ORCH_LABEL` | prompt file basename | task label shown in the pane |
| `ORCH_PARENT` | unset (`null`) | parent task/session id, only when the caller has one |
| `ORCH_RUNLOG_RETENTION_MIN` | `1440` | logs older than this are deleted at the next launch |

## Tests

```bash
bash tests/wrappers.test.sh
```

Uses fake `codex`/`pi`/`agy` executables replaying [`tests/fixtures/`](../tests/fixtures), a temporary
`XDG_RUNTIME_DIR`, and an empty stub `_env.sh`; no network. Run it from a filesystem that supports Unix
permissions (it copies the scripts to `$TMPDIR`).
