#!/usr/bin/env bash
# run_agy.sh <prompt-file> <workdir> [model]   -> final response text on stdout (Antigravity CLI `agy`)
# env: ORCH_TIMEOUT (s, default 900). Models: `agy models` (gemini-*/claude-*-{low,medium,high}).
# ponytail: runs with --dangerously-skip-permissions because print mode cannot answer approval
# prompts; the prompt file bounds what it may touch. Upgrade path: --mode accept-edits once agy
# print mode auto-denies instead of hanging on shell approvals.
set -euo pipefail
. "$(dirname "$0")/_runlog.sh" agy "$@"
p=${1:?prompt file}; w=${2:?workdir}; m=${3:-}
t=${ORCH_TIMEOUT:-900}
_runlog_init agy "$p" "$w" "$m"
cd "$w"
res=$(timeout $((t+30)) agy --output-format json --print-timeout "${t}s" --disable-slash-commands \
  --dangerously-skip-permissions ${m:+--model "$m"} -p="$(cat "$p")" 2>/dev/null) \
  || { rc=$?; echo "agy failed or timed out (rc=$rc)" >&2; printf '%s\n' "$res" | tail -c 2000 >&2; exit $rc; }
printf '%s' "$res" | jq -r 'if .status=="SUCCESS" then .response else ("agy status: "+.status+"\n"+(.response//"")) end'
