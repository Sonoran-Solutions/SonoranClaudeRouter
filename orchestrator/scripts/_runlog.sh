#!/usr/bin/env bash
# Private, best-effort side channel; none of these functions changes the worker's status.
_runlog_file=
_runlog_initialized=0
if (($#)); then
  _runlog_executor=$1 _runlog_prompt=${2:-} _runlog_workdir=${3:-$PWD} _runlog_model=${4:-}
  if [[ $1 == pi ]]; then _runlog_model=${4:-${ORCH_PI_MODEL:-}}; fi
  trap '_runlog_exit "$?"' EXIT
fi
_runlog_redact='
  def redact:
    (env.ORCH_RUNLOG_KEY // "") as $key
    | (if $key == "" then . else split($key) | join("[REDACTED]") end)
    | gsub("sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}"; "[REDACTED]");
  walk(if type == "string" then redact
       elif type == "object" then with_entries(.key |= redact) else . end)'

_runlog_append() {
  # A failed open/write must be silent, and the input must still be drained.
  { ORCH_RUNLOG_KEY=${OPENROUTER_API_KEY:-} jq --unbuffered -c "$_runlog_redact" >> "$_runlog_file"; } 2>/dev/null \
    || cat >/dev/null
}

_runlog_init() {
  _runlog_initialized=1
  _runlog_executor=$1
  trap '_runlog_exit "$?"' EXIT
  [[ ${ORCH_RUNLOG:-1} != 0 && -n ${XDG_RUNTIME_DIR:-} && -d $XDG_RUNTIME_DIR && -O $XDG_RUNTIME_DIR ]] || return 0
  local dir=$XDG_RUNTIME_DIR/orchestrator retention=${ORCH_RUNLOG_RETENTION_MIN:-1440}
  { (umask 077; mkdir -p -- "$dir") && [[ ! -L $dir && -O $dir && -w $dir ]] && chmod 700 -- "$dir"; } 2>/dev/null || return 0
  if [[ $retention =~ ^[0-9]+$ ]]; then
    find "$dir" -maxdepth 1 -type f -name '*.jsonl' -mmin "+$retention" -delete 2>/dev/null || true
  fi
  _runlog_started=$(date +%s%3N)
  local random workdir
  random=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
  _runlog_id=$(date -u +%Y%m%dT%H%M%S%3NZ)-$1-$random
  local file=$dir/$_runlog_id.jsonl
  (umask 077; set -C; : > "$file") 2>/dev/null || return 0
  _runlog_file=$file
  workdir=$(cd -- "$3" 2>/dev/null && pwd) || workdir=$3
  jq -nc --arg run_id "$_runlog_id" --arg executor "$1" --arg model "$4" \
    --arg label "${ORCH_LABEL-${2##*/}}" --arg parent "${ORCH_PARENT:-}" \
    --arg workdir "$workdir" --argjson pid "$$" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '
    {v:1, type:"orchestrator.start", $run_id, $executor,
     model:($model | select(. != "") // null), label:($label | select(. != "") // null),
     parent:($parent | select(. != "") // null), $workdir, $pid,
     granularity:(if $executor == "agy" then "final-only" else "live" end), $ts}' \
    | _runlog_append || true
}

_runlog_provider() {
  { jq --unbuffered -Rc '
      fromjson? | select(type == "object")
      | if $executor == "pi" then
          select(.type != "message_update")
          | (if .message.role? == "system" then .message = {role: "system", content: "(trimmed)"} else . end)
          | (if .type == "agent_end" then .messages = [] else . end)
        else . end' --arg executor "$_runlog_executor" | _runlog_append; } 2>/dev/null \
    || cat >/dev/null
}

_runlog_run() {
  if [[ -z $_runlog_file ]]; then "$@"; return $?; fi
  local fd logger rc=0
  exec {fd}> >(_runlog_provider)
  logger=$!
  # tee -p keeps draining stdout if the logging branch closes its pipe.
  "$@" {fd}>&- | tee -p /dev/fd/"$fd" 2>/dev/null || rc=${PIPESTATUS[0]}
  exec {fd}>&-
  wait "$logger" 2>/dev/null || true
  return "$rc"
}

_runlog_exit() {
  local rc=$1
  if [[ $_runlog_initialized == 0 ]]; then
    _runlog_init "$_runlog_executor" "$_runlog_prompt" "$_runlog_workdir" "$_runlog_model" || true
  fi
  [[ -n $_runlog_file ]] || return 0
  if [[ $_runlog_executor == agy && ${res+x} ]]; then
    printf '%s' "$res" | jq -Rsc --arg run_id "$_runlog_id" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '
      (try {value:fromjson, parse_error:false} catch {value:null, parse_error:true}) as $parsed
      | {v:1, type:"orchestrator.final", $run_id, $ts,
         status:($parsed.value | .status? // null), response:($parsed.value | .response? // null),
         parse_error:$parsed.parse_error}' | _runlog_append || true
  fi
  jq -nc --arg run_id "$_runlog_id" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    --argjson exit_code "$rc" --argjson duration_ms "$(($(date +%s%3N) - _runlog_started))" '
    {v:1, type:"orchestrator.exit", $run_id, $ts, $exit_code,
     timed_out:($exit_code == 124), $duration_ms}' | _runlog_append || true
}
