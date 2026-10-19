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

# Lifecycle file only: start, final, exit. A failed open/write must be silent, and the input drained.
_runlog_append() {
  { ORCH_RUNLOG_KEY=${OPENROUTER_API_KEY:-} jq --unbuffered -c "$_runlog_redact" >> "$_runlog_file"; } 2>/dev/null \
    || cat >/dev/null
}

# Provider records go to segments. $1 = extra jq program applied before redaction.
_runlog_segment_append() {
  { ORCH_RUNLOG_KEY=${OPENROUTER_API_KEY:-} jq --unbuffered -Rc --arg executor "$_runlog_executor" \
      "fromjson? | select(type == \"object\") | ($1) | $_runlog_redact" | _runlog_rotate; } 2>/dev/null \
    || cat >/dev/null
}

# Start segment $1 (if not yet created for this run) and drop all but the newest KEEP segments.
_runlog_segment_open() {
  local n=$1
  if ((n <= _runlog_segments)); then return 0; fi
  local seg=$_runlog_dir/$_runlog_id.$n.jsonl
  if ! { (umask 077; set -C; : > "$seg") && [[ -f $seg && -O $seg && -w $seg ]]; } 2>/dev/null; then
    return 1
  fi
  _runlog_segments=$n
  _runlog_segment_bytes=0
  _runlog_segment=$seg
  # Retention: keep only the newest _runlog_keep segments so a run stays bounded.
  local keep=$_runlog_keep old n2
  for ((n2 = n - keep; n2 >= 1; n2--)); do
    old=$_runlog_dir/$_runlog_id.$n2.jsonl
    if [[ -e $old ]]; then rm -f -- "$old" 2>/dev/null || true; fi
  done
  return 0
}

# Read redacted lines on stdin; write them to the current segment, rotating at the segment size.
# Never blocks or fails the caller: a segment error only stops logging and drains the rest.
_runlog_rotate() {
  local LC_ALL=C line bytes # C locale: ${#line} counts bytes, so sizes need no stat per line
  if [[ -z $_runlog_segment ]] && ! _runlog_segment_open 1; then
    cat >/dev/null
    return 0
  fi
  while IFS= read -r line; do
    bytes=$(( ${#line} + 1 ))
    if ((_runlog_segment_bytes > 0 && _runlog_segment_bytes + bytes > _runlog_segment_bytes_max)); then
      _runlog_segment_open $((_runlog_segments + 1)) || { cat >/dev/null; return 0; }
    fi
    if ((bytes > _runlog_segment_bytes_max)); then
      _runlog_oversize "$line" "$bytes"
      continue
    fi
    { printf '%s\n' "$line" >> "$_runlog_segment"; } 2>/dev/null || { cat >/dev/null; return 0; }
    _runlog_segment_bytes=$((_runlog_segment_bytes + bytes))
  done
  return 0
}

# Replace an over-long provider line by one orchestrator.oversize record (same segment).
_runlog_oversize() {
  local line=$1 bytes=$2 rec
  rec=$(printf '%s' "$line" | ORCH_RUNLOG_KEY=${OPENROUTER_API_KEY:-} jq -Rsc --arg run_id "$_runlog_id" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" --argjson bytes "$bytes" '
    (fromjson? | if type == "object" then (.type | strings) else null end) as $ptype
    | {v:1, type:"orchestrator.oversize", $run_id, $ts, $bytes, provider_type:($ptype // null)}' 2>/dev/null) \
    || return 0
  [[ -n $rec ]] || return 0
  { printf '%s\n' "$rec" >> "$_runlog_segment"; } 2>/dev/null || return 0
  _runlog_segment_bytes=$((_runlog_segment_bytes + ${#rec} + 1))
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
  _runlog_dir=$dir
  _runlog_segment=
  _runlog_segments=0
  _runlog_segment_bytes=0
  _runlog_segment_bytes_max=${ORCH_RUNLOG_SEGMENT_BYTES:-1048576}
  [[ $_runlog_segment_bytes_max =~ ^[1-9][0-9]*$ ]] || _runlog_segment_bytes_max=1048576
  _runlog_keep=${ORCH_RUNLOG_KEEP_SEGMENTS:-4}
  [[ $_runlog_keep =~ ^[1-9][0-9]*$ ]] || _runlog_keep=4
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
  _runlog_segment_append '
      if $executor == "pi" then
        select(.type != "message_update")
        | (if .message.role? == "system" then .message = {role: "system", content: "(trimmed)"} else . end)
        | (if .type == "agent_end" then .messages = [] else . end)
      else . end'
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
  # Highest segment number that exists now (older ones may have been rotated away), or the
  # highest the logger ever wrote if they are all gone.
  local segments=$_runlog_segments n
  for n in "$_runlog_dir/$_runlog_id".*.jsonl; do
    [[ -e $n ]] || continue
    n=${n##*/}; n=${n#"$_runlog_id".}; n=${n%.jsonl}
    [[ $n =~ ^[1-9][0-9]{0,5}$ ]] || continue
    if ((n > segments)); then segments=$n; fi
  done
  jq -nc --arg run_id "$_runlog_id" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    --argjson exit_code "$rc" --argjson duration_ms "$(($(date +%s%3N) - _runlog_started))" \
    --argjson segments "$segments" '
    {v:1, type:"orchestrator.exit", $run_id, $ts, $exit_code,
     timed_out:($exit_code == 124), $duration_ms, $segments}' | _runlog_append || true
}
