#!/usr/bin/env bash
# run_codex.sh <prompt-file> <workdir> [model]   -> final agent message on stdout
# env: ORCH_TIMEOUT (s, default 900), ORCH_CODEX_SANDBOX (default workspace-write)
# Image generation: Codex's image_generation feature is on; ask for the file path in the prompt.
set -euo pipefail
. "$(dirname "$0")/_runlog.sh" codex "$@"
p=${1:?prompt file}; w=${2:?workdir}; m=${3:-}
_runlog_init codex "$p" "$w" "$m"
out=$(mktemp); trap '_runlog_exit "$?"; rm -f "$out"' EXIT
_runlog_run timeout "${ORCH_TIMEOUT:-900}" codex exec -C "$w" -s "${ORCH_CODEX_SANDBOX:-workspace-write}" \
  --json --ephemeral --skip-git-repo-check --color never ${m:+-m "$m"} -o "$out" - < "$p" >/dev/null 2>&1 \
  || { rc=$?; echo "codex failed or timed out (rc=$rc)" >&2; [ -s "$out" ] && cat "$out"; exit $rc; }
cat "$out"
