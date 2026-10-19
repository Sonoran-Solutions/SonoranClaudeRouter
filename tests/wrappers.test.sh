#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-wrappers.XXXXXX")
trap 'chmod -R u+rwX "$tmp"; rm -rf -- "$tmp"' EXIT
export TMPDIR="$tmp"
mkdir -p "$tmp/bin" "$tmp/scripts" "$tmp/work"
cp "$root"/orchestrator/scripts/{run_codex,run_pi,run_agy,_runlog}.sh "$tmp/scripts/"
: > "$tmp/scripts/_env.sh"
printf 'Test prompt\n' > "$tmp/prompt.txt"
export PATH="$tmp/bin:$PATH" FIXTURES="$root/tests/fixtures" ORCH_PI_MODEL=test/resolved
export FAKE_SECRET=sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export OPENROUTER_API_KEY='literal.key[with]*regex+characters'
export REAL_JQ
REAL_JQ=$(command -v jq)
unset ORCH_LABEL ORCH_PARENT ORCH_RUNLOG_RETENTION_MIN ORCH_TIMEOUT

# One fake implementation, installed under each provider's executable name.
cat > "$tmp/bin/provider" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
provider=${0##*/}
out= print_timeout= json=
while (($#)); do
  case $1 in
    -o) out=$2; shift ;;
    --print-timeout) print_timeout=$2; shift ;;
    --json) json=1 ;;
  esac
  shift
done
if [[ $provider == codex ]]; then [[ -n $out && -n $json ]]; fi
if [[ -n ${FAKE_UMASK_FILE:-} ]]; then : > "$FAKE_UMASK_FILE"; fi
if [[ -n ${FAKE_SLEEP:-} ]]; then
  [[ $provider != pi || -n ${FAKE_SILENT:-} ]] || printf '{"type":"error","error":"waiting for timeout"}\n'
  if [[ -n $print_timeout ]]; then timeout "$print_timeout" sleep "$FAKE_SLEEP"; else sleep "$FAKE_SLEEP"; fi
fi
if [[ -n ${FAKE_SILENT:-} ]]; then
  :
elif [[ -n ${FAKE_NOISY:-} ]]; then
  # Fast bulk stream: ~1 KiB per line, > 4 MiB total.
  for ((i=0; i<${FAKE_NOISY}; i++)); do printf '{"type":"test.noise","i":%d,"pad":"%0960d"}\n' "$i" "$i"; done
elif [[ -n ${FAKE_BIGLINE:-} ]]; then
  jq -nc --arg pad "$(head -c "$FAKE_BIGLINE" /dev/zero | tr '\0' 'x')" '{type:"test.big", $pad}'
elif [[ -n ${FAKE_GARBAGE:-} ]]; then
  printf 'not JSON\n'
else
  case $provider in
    codex) fixture=codex-exec.jsonl ;;
    pi) fixture=pi-json.jsonl ;;
    agy) fixture=agy-final.json ;;
  esac
  # Restore the fields deliberately trimmed in the sanitized pi fixture.
  while IFS= read -r line; do
    if [[ $provider == pi ]]; then
      line=$(jq -c 'if .message.role? == "system" then .message.content="private system prompt" | .message.sections={preamble:"private system prompt"}
                    elif .type == "agent_end" then .messages=[{"text":"untrimmed final"}] else . end' <<< "$line")
    elif [[ $provider == agy && -n ${FAKE_EMIT_SECRET:-} ]]; then
      line=$(jq -c --arg secret "$FAKE_SECRET $OPENROUTER_API_KEY ghp_aaaaaaaaaaaaaaaaaaaa github_pat_aaaaaaaaaaaaaaaaaaaa AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa xoxb-aaaaaaaaaa" '.response=$secret' <<< "$line")
    fi
    printf '%s\n' "$line"
    if [[ -n ${FAKE_READY:-} ]]; then
      : > "$FAKE_READY"
      sleep "${FAKE_PAUSE:-1}"
      unset FAKE_READY
    fi
    if [[ -n ${FAKE_LINE_SLEEP:-} ]]; then sleep "$FAKE_LINE_SLEEP"; fi
  done < "$FIXTURES/$fixture"
  if [[ -n ${FAKE_EMIT_SECRET:-} && $provider != agy ]]; then
    jq -nc --arg secret "$FAKE_SECRET" --arg key "$OPENROUTER_API_KEY" \
      '{type:"test.secret", text:($secret+" "+$key+" ghp_aaaaaaaaaaaaaaaaaaaa github_pat_aaaaaaaaaaaaaaaaaaaa AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa xoxb-aaaaaaaaaa" )}'
  fi
fi
if [[ $provider == pi && ${FAKE_RC:-0} != 0 ]]; then printf '{"type":"error","error":"fake failure"}\n'; fi
for ((i=0; i<${FAKE_BULK:-0}; i++)); do printf '{"type":"test.bulk","text":"%0100d"}\n' "$i"; done
if [[ -n $out ]]; then printf 'done\n' > "$out"; fi
[[ -z ${FAKE_FINISHED:-} ]] || : > "$FAKE_FINISHED"
exit "${FAKE_RC:-0}"
FAKE
chmod +x "$tmp/bin/provider"
for name in codex pi agy; do cp "$tmp/bin/provider" "$tmp/bin/$name"; done
for name in codex pi agy; do
  if [[ ! -x $tmp/bin/$name ]]; then
    printf 'FAIL temporary filesystem must support executable file permissions\n'
    exit 1
  fi
done
cat > "$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo 'Unexpected curl call' >&2
exit 99
FAKE
chmod +x "$tmp/bin/curl"
# Force an actual write error after start while leaving provider output/parsing alone.
cat > "$tmp/bin/jq" <<'FAKE'
#!/usr/bin/env bash
if [[ ${FAKE_LOG_WRITE_FAIL:-0} == 1 && $* == *'def redact:'* ]]; then
  IFS= read -r first || exit 0
  if [[ $first != *'"type":"orchestrator.'* ]]; then
    { printf '%s\n' "$first"; cat; } | "$REAL_JQ" "$@" > /dev/full
    exit $?
  fi
  { printf '%s\n' "$first"; cat; } | "$REAL_JQ" "$@"
else
  exec "$REAL_JQ" "$@"
fi
FAKE
chmod +x "$tmp/bin/jq"

failed=0 serial=0
check() {
  local name=$1; shift
  if "$@" >/dev/null; then printf 'PASS %s\n' "$name"; else printf 'FAIL %s\n' "$name"; failed=$((failed+1)); fi
}
run() {
  local executor=$1 enabled=$2 code=$3; shift 3
  serial=$((serial+1))
  runtime=$tmp/runtime-$serial
  mkdir -m 700 "$runtime"
  stdout=$tmp/stdout-$serial stderr=$tmp/stderr-$serial result=0
  env XDG_RUNTIME_DIR="$runtime" ORCH_RUNLOG="$enabled" FAKE_RC="$code" "$@" \
    bash "$tmp/scripts/run_$executor.sh" "$tmp/prompt.txt" "$tmp/work" > "$stdout" 2> "$stderr" || result=$?
  # Lifecycle file = <run-id>.jsonl; segments = <run-id>.<n>.jsonl.
  log=$(find "$runtime" -type f -name '*.jsonl' ! -name '*.*.jsonl' -print -quit)
  segs=()
  if [[ -n $log ]]; then
    base=${log##*/}
    while IFS= read -r seg; do
      [[ -n $seg ]] && segs+=("$seg")
    done < <(find "$runtime" -type f -name "${base%.jsonl}.[0-9]*.jsonl" \
      | sort -t. -k2 -n)
  fi
}
# Concatenated segment records equal the expected fixture, record for record.
seg_matches() {
  local expected=$1 f rc=0
  shift
  for f in "$@"; do jq -c . "$f" || return 1; done > "$tmp/seg-concat.jsonl"
  jq -c . "$expected" > "$tmp/seg-expected.jsonl"
  cmp -s "$tmp/seg-concat.jsonl" "$tmp/seg-expected.jsonl" || rc=1
  return "$rc"
}
# All lines of a run's segments, in segment order.
seg_records() {
  [[ ${#segs[@]} -gt 0 ]] && jq -sc '.' "${segs[@]}" || printf '[]\n'
}
records() {
  jq -se --arg executor "$1" --argjson code "$2" --arg workdir "$tmp/work" '
    .[0] as $s | .[-1] as $e
    | $s.type == "orchestrator.start" and $e.type == "orchestrator.exit"
    and $s.v == 1 and $e.v == 1 and $s.executor == $executor
    and ($s.run_id | test("^[0-9]{8}T[0-9]{9}Z-(codex|pi|agy)-[0-9a-f]{8}$"))
    and $s.run_id == $e.run_id and $s.workdir == $workdir
    and ($s.pid | type == "number" and . > 0)
    and $s.label == "prompt.txt" and $s.parent == null
    and $s.model == (if $executor == "pi" then "test/resolved" else null end)
    and $s.granularity == (if $executor == "agy" then "final-only" else "live" end)
    and $e.exit_code == $code and $e.timed_out == ($code == 124)
    and ($e.segments | type == "number" and . >= 0)
    and ($e.duration_ms | type == "number" and . >= 0)
    and ([.[] | select(.type | startswith("orchestrator.")) | .ts
          | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")] | all)
  ' "$log" >/dev/null
}
same_as() {
  [[ $result == "$baseline_rc" ]] && cmp -s "$stdout" "$baseline_out" && cmp -s "$stderr" "$baseline_err"
}
baseline() { baseline_rc=$result baseline_out=$stdout baseline_err=$stderr; }

for executor in codex pi agy; do
  for code in 0 3; do
    run "$executor" 0 "$code"
    baseline
    check "$executor rc=$code disabled creates no log" test -z "$log"
    run "$executor" 1 "$code"
    check "$executor rc=$code stdout/stderr/status unchanged" same_as
    check "$executor rc=$code returned status" test "$result" = "$code"
    check "$executor rc=$code start/exit contract" records "$executor" "$code"
    check "$executor rc=$code directory 0700" test "$(stat -c %a "$runtime/orchestrator")" = 700
    check "$executor rc=$code file 0600" test "$(stat -c %a "$log")" = 600
    check "$executor rc=$code filename matches run id" jq -se --arg name "${log##*/}" '.[0].run_id+".jsonl" == $name' "$log"
  done
done

run codex 1 0
check 'codex -o result printed' test "$(cat "$stdout")" = done
check 'codex provider events retained' seg_matches "$FIXTURES/codex-exec.jsonl" "${segs[@]}"

# Run the normal invocation in the background and inspect its file before completion.
live=$tmp/live
mkdir -m 700 "$live"
env XDG_RUNTIME_DIR="$live" ORCH_RUNLOG=1 FAKE_READY="$tmp/ready" FAKE_PAUSE=2 FAKE_FINISHED="$tmp/finished" \
  bash "$tmp/scripts/run_pi.sh" "$tmp/prompt.txt" "$tmp/work" > "$tmp/live.out" 2> "$tmp/live.err" &
worker=$!
seen=0
for ((i=0; i<100; i++)); do
  live_log=$(find "$live" -type f -name '*.jsonl' ! -name '*.*.jsonl' -print -quit)
  live_seg=$(find "$live" -type f -name '*.[0-9]*.jsonl' -print -quit)
  if [[ -n $live_log && -n $live_seg ]] && jq -se 'any(.[]; .type == "session")' "$live_seg" >/dev/null 2>&1; then
    [[ ! -e $tmp/finished ]] && kill -0 "$worker" 2>/dev/null && seen=1
    break
  fi
  sleep .02
done
check 'pi provider record appears while worker runs' test "$seen" = 1
wait "$worker"
log=$live_log
live_base=${log##*/}
segs=()
while IFS= read -r seg; do [[ -n $seg ]] && segs+=("$seg"); done \
  < <(find "$live" -type f -name "${live_base%.jsonl}.[0-9]*.jsonl" | sort -t. -k2 -n)
check 'pi stdout parse unchanged' test "$(cat "$tmp/live.out")" = done
check 'pi message_update dropped' bash -c 'jq -se "all(.[]; .type != \"message_update\")" "$@"' _ "${segs[@]}"
check 'pi system message content trimmed' bash -c 'jq -se \
  "[.[] | select(.message.role? == \"system\") | .message.content] == [\"(trimmed)\", \"(trimmed)\"]" "$@"' _ "${segs[@]}"
check 'pi system message sections dropped' bash -c 'jq -se "all(.[]; (.message.role? == \"system\" and (.message | has(\"sections\"))) | not)" "$@"' _ "${segs[@]}"
check 'pi agent_end messages emptied' bash -c 'jq -se "any(.[]; .type == \"agent_end\" and .messages == [])" "$@"' _ "${segs[@]}"
check 'pi lifecycle file holds only orchestrator records' bash -c 'jq -se "all(.[]; .type | startswith(\"orchestrator.\")) and .[0].type == \"orchestrator.start\" and .[-1].type == \"orchestrator.exit\"" "$1"' _ "$log"
live_base=${log##*/}
check 'pi provider records are in segment 1' test -s "$live/orchestrator/${live_base%.jsonl}.1.jsonl"

run agy 1 0
check 'agy final status/response' jq -se 'any(.[]; .type == "orchestrator.final" and .status == "SUCCESS" and .response == "done" and .parse_error == false)' "$log"
run agy 0 0 FAKE_GARBAGE=1
baseline
run agy 1 0 FAKE_GARBAGE=1
check 'agy invalid JSON output/status unchanged' same_as
check 'agy invalid JSON final parse_error' jq -se 'any(.[]; .type == "orchestrator.final" and .parse_error == true and .status == null and .response == null)' "$log"
check 'agy jq set-e abort records real status' records agy "$result"
run pi 0 0 FAKE_GARBAGE=1
baseline
run pi 1 0 FAKE_GARBAGE=1
check 'pi jq set-e abort output/status unchanged' same_as
check 'pi jq set-e abort records real status' records pi "$result"

for executor in codex pi agy; do
  run "$executor" 1 0 FAKE_EMIT_SECRET=1
  check "$executor secret absent" bash -c '! rg -F -e "$FAKE_SECRET" -e "$OPENROUTER_API_KEY" -e ghp_aaaaaaaaaaaaaaaaaaaa -e github_pat_aaaaaaaaaaaaaaaaaaaa -e AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -e xoxb-aaaaaaaaaa "$1" "${@:2}"' _ "$log" "${segs[@]}"
  check "$executor log remains valid JSON" jq -se 'length > 1' "$log" "${segs[@]}"
done
# agy has one JSON envelope; put secrets inside its response to exercise final redaction.
secret_fixture=$tmp/secret-fixture
mkdir "$secret_fixture"
jq -nc --arg response "$FAKE_SECRET $OPENROUTER_API_KEY" '{status:"SUCCESS", $response}' > "$secret_fixture/agy-final.json"
run agy 1 0 FIXTURES="$secret_fixture"
check 'agy final response redacted' jq -se 'any(.[]; .type == "orchestrator.final" and .response == "[REDACTED] [REDACTED]")' "$log"

for executor in codex pi agy; do
  for code in 0 3; do
    run "$executor" 0 "$code"
    baseline
    blocked=$tmp/blocked-$executor-$code
    mkdir -p "$blocked/orchestrator"
    chmod 500 "$blocked/orchestrator"
    run "$executor" 1 "$code" XDG_RUNTIME_DIR="$blocked"
    check "$executor rc=$code unwritable directory isolated" same_as
    check "$executor rc=$code unwritable directory creates no file" test -z "$(find "$blocked" -type f -print -quit)"
  done
  run "$executor" 0 0
  baseline
  before=$(find "$tmp" -name '*.jsonl' | sort)
  stdout=$tmp/unset-$executor.out stderr=$tmp/unset-$executor.err
  result=0
  env -u XDG_RUNTIME_DIR ORCH_RUNLOG=1 FAKE_RC=0 \
    bash "$tmp/scripts/run_$executor.sh" "$tmp/prompt.txt" "$tmp/work" > "$stdout" 2> "$stderr" || result=$?
  check "$executor unset runtime isolated" same_as
  check "$executor unset runtime no fallback log" test "$(find "$tmp" -name '*.jsonl' | sort)" = "$before"
  for invalid in '' "$tmp/missing" "$tmp/prompt.txt"; do
    run "$executor" 1 0 XDG_RUNTIME_DIR="$invalid"
    check "$executor invalid runtime '$invalid' isolated" same_as
  done
done

for executor in codex pi; do
  run "$executor" 0 3 FAKE_BULK=2000
  baseline
  run "$executor" 1 3 FAKE_BULK=2000 FAKE_LOG_WRITE_FAIL=1 FAKE_FINISHED="$tmp/drained-$executor"
  check "$executor mid-run log write failure isolated" same_as
  check "$executor mid-run log failure drains worker" test -f "$tmp/drained-$executor"
  check "$executor mid-run log failure exit status recorded" records "$executor" 3
done

for executor in codex pi agy; do
  run "$executor" 0 0 ORCH_TIMEOUT=1 FAKE_SLEEP=5
  baseline
  run "$executor" 1 0 ORCH_TIMEOUT=1 FAKE_SLEEP=5
  check "$executor timeout stdout/stderr/status unchanged" same_as
  check "$executor timeout returns 124" test "$result" = 124
  check "$executor timeout exit record" records "$executor" 124
done

# --- segmented event files ---
seg_count() { find "$1" -maxdepth 1 -type f -name "${2%.jsonl}.*.jsonl" | wc -l; }
seg_all_json() { jq -e . "$@" >/dev/null; }
seg_each_max() {
  local limit=$1 f; shift
  for f; do (( $(stat -c %s "$f") <= limit )) || return 1; done
}
seg_all_mode() {
  local f; for f; do [[ $(stat -c %a "$f") == 600 ]] || return 1; done
}
highest_seg() { local f n=0; for f; do f=${f##*/}; f=${f#*.}; f=${f%.jsonl}; ((f > n)) && n=$f; done; printf '%s' "$n"; }
exit_segments() { jq -s -r '.[-1].segments' "$1"; }

for executor in codex pi agy; do
  run "$executor" 1 0
  check "$executor lifecycle holds only orchestrator records" jq -se \
    'all(.[]; .type | startswith("orchestrator.")) and .[0].type == "orchestrator.start" and .[-1].type == "orchestrator.exit"' "$log"
  if [[ $executor == agy ]]; then
    check 'agy has no segments' test "${#segs[@]}" = 0
    check 'agy exit segments == 0' test "$(exit_segments "$log")" = 0
  else
    check "$executor provider records in segment 1" test -s "${log%.jsonl}.1.jsonl"
    check "$executor exit segments == 1" test "$(exit_segments "$log")" = 1
  fi
  check "$executor segment mode 0600" seg_all_mode "${segs[@]}"
done

# Noisy run: >4 MiB of provider JSON, small segments, few kept.
noise=5000
for executor in codex pi; do
  run "$executor" 0 3 FAKE_NOISY=$noise
  baseline
  run "$executor" 1 3 FAKE_NOISY=$noise ORCH_RUNLOG_SEGMENT_BYTES=262144 ORCH_RUNLOG_KEEP_SEGMENTS=3
  segdir=${log%/*}
  check "$executor noisy stdout/stderr/status unchanged" same_as
  check "$executor noisy exit code 3" test "$result" = 3
  check "$executor noisy lifecycle small (<8 KiB)" test "$(stat -c %s "$log")" -lt 8192
  check "$executor noisy lifecycle only orchestrator" jq -se 'all(.[]; .type | startswith("orchestrator."))' "$log"
  check "$executor noisy lifecycle exit_code 3" jq -se '.[-1].exit_code == 3' "$log"
  check "$executor noisy kept at most 3 segments" test "$(seg_count "$segdir" "${log##*/}")" -le 3
  check "$executor noisy at least 2 segments" test "$(seg_count "$segdir" "${log##*/}")" -ge 2
  check "$executor noisy segments bounded (2x size)" seg_each_max 524288 "${segs[@]}"
  check "$executor noisy every segment line valid JSON" seg_all_json "${segs[@]}"
  check "$executor noisy exit segments == highest segment" test "$(exit_segments "$log")" = "$(highest_seg "${segs[@]}")"
  check "$executor noisy final provider record in newest segment" \
    jq -e --argjson i $((noise-1)) 'select(.type == "test.noise" and .i == $i)' "${segs[${#segs[@]}-1]}"
done

# Oversize: one provider line larger than the segment size.
for executor in codex pi; do
  run "$executor" 0 0 FAKE_BIGLINE=8192
  baseline
  run "$executor" 1 0 FAKE_BIGLINE=8192 ORCH_RUNLOG_SEGMENT_BYTES=4096
  check "$executor oversize stdout/stderr/status unchanged" same_as
  check "$executor oversize provider line absent" bash -c '! cat -- "$@" | grep -q "xxxxxxxxxx"' _ "${segs[@]}"
  check "$executor oversize placeholder present" jq -se \
    'any(.[]; .type == "orchestrator.oversize" and .bytes > 4096 and .provider_type == "test.big" and .v == 1 and (.ts | type == "string"))' "${segs[@]}"
  check "$executor oversize segments bounded" seg_each_max 8192 "${segs[@]}"
done

# A segment that cannot be written mid-run must not disturb the wrapper.
for executor in codex pi; do
  run "$executor" 0 3 FAKE_BULK=3000
  baseline
  sfail=$tmp/segfail-$executor
  mkdir -m 700 "$sfail"
  # Make the log directory unwritable as soon as the lifecycle file exists.
  (
    for ((i=0; i<3000; i++)); do
      d=$sfail/orchestrator
      if [[ -d $d ]] && compgen -G "$d/*.jsonl" >/dev/null; then chmod 500 "$d"; exit 0; fi
      sleep .002
    done
    exit 1
  ) &
  watcher=$!
  stdout=$tmp/stdout-$serial stderr=$tmp/stderr-$serial result=0
  env XDG_RUNTIME_DIR="$sfail" ORCH_RUNLOG=1 FAKE_RC=3 FAKE_BULK=3000 FAKE_FINISHED="$tmp/segdrain-$executor" \
    ORCH_RUNLOG_SEGMENT_BYTES=262144 bash "$tmp/scripts/run_$executor.sh" "$tmp/prompt.txt" "$tmp/work" \
    > "$stdout" 2> "$stderr" || result=$?
  wait "$watcher"; segfail_armed=$?
  chmod 700 "$sfail/orchestrator" 2>/dev/null || true
  log=$(find "$sfail" -type f -name '*.jsonl' ! -name '*.*.jsonl' -print -quit)
  check "$executor segment failure stdout/stderr/status unchanged" same_as
  check "$executor segment failure drains worker" test -f "$tmp/segdrain-$executor"
  check "$executor segment failure exit still recorded" records "$executor" 3
  check "$executor segment failure was actually injected" test "$segfail_armed" = 0
  check "$executor segment failure wrote no segment" test -z "$(find "$sfail" -type f -name '*.jsonl' ! -name '*.jsonl.1.jsonl' -name '*.[0-9]*.jsonl' -print -quit)"
done

# Pi silent timeout: nothing on stdout, must still exit 124 (not 1).
run pi 0 0 ORCH_TIMEOUT=1 FAKE_SLEEP=5 FAKE_SILENT=1
baseline
check 'pi silent timeout (logging off) returns 124' test "$result" = 124
run pi 1 0 ORCH_TIMEOUT=1 FAKE_SLEEP=5 FAKE_SILENT=1
check 'pi silent timeout stdout/stderr/status unchanged' same_as
check 'pi silent timeout returns 124 (not 1)' test "$result" = 124
check 'pi silent timeout exit record 124/timed_out' jq -se \
  'any(.[]; .type == "orchestrator.exit" and .exit_code == 124 and .timed_out == true)' "$log"
check 'pi silent timeout lifecycle only orchestrator' jq -se 'all(.[]; .type | startswith("orchestrator."))' "$log"

parallel=$tmp/parallel
mkdir -m 700 "$parallel"
env XDG_RUNTIME_DIR="$parallel" ORCH_RUNLOG=1 bash "$tmp/scripts/run_codex.sh" "$tmp/prompt.txt" "$tmp/work" > "$tmp/parallel1.out" 2> "$tmp/parallel1.err" &
one=$!
env XDG_RUNTIME_DIR="$parallel" ORCH_RUNLOG=1 bash "$tmp/scripts/run_codex.sh" "$tmp/prompt.txt" "$tmp/work" > "$tmp/parallel2.out" 2> "$tmp/parallel2.err" &
two=$!
wait "$one"; wait "$two"
parallel_lifecycle() { find "$parallel" -type f -name '*.jsonl' ! -name '*.*.jsonl'; }
check 'concurrent launches create distinct files' test "$(parallel_lifecycle | wc -l)" = 2
check 'concurrent launches create distinct segments' \
  test "$(find "$parallel" -type f -name '*.[0-9]*.jsonl' | wc -l)" = 2
distinct_run_ids() {
  local f
  for f in $(parallel_lifecycle); do jq -r 'select(.type == "orchestrator.start") | .run_id' "$f"; done | sort -u | wc -l
}
check 'concurrent launches have distinct run ids' test "$(distinct_run_ids)" = 2

run codex 1 0 ORCH_LABEL='custom label' ORCH_PARENT=parent-task
check 'explicit label/parent' jq -se '.[0].label == "custom label" and .[0].parent == "parent-task"' "$log"
run codex 1 0 FAKE_UMASK_FILE="$tmp/work/umask-off"
touch "$tmp/work/expected-mode"
check 'worker umask preserved' test "$(stat -c %a "$tmp/work/umask-off")" = "$(stat -c %a "$tmp/work/expected-mode")"

retained=$tmp/retained
mkdir -p "$retained/orchestrator/nested"
printf '{}\n' > "$retained/orchestrator/old.jsonl"
printf '{}\n' > "$retained/orchestrator/keep.txt"
printf '{}\n' > "$retained/orchestrator/nested/old.jsonl"
touch -d '2 days ago' "$retained/orchestrator/old.jsonl" "$retained/orchestrator/keep.txt" "$retained/orchestrator/nested/old.jsonl"
run codex 1 0 XDG_RUNTIME_DIR="$retained"
check 'retention removes old top-level jsonl only' test ! -e "$retained/orchestrator/old.jsonl"
check 'retention keeps other files/subdirectories' test -f "$retained/orchestrator/keep.txt" -a -f "$retained/orchestrator/nested/old.jsonl"

for executor in codex pi agy; do
  early=$tmp/early-$executor
  mkdir "$early"
  early_rc=0
  env XDG_RUNTIME_DIR="$early" ORCH_RUNLOG=1 bash "$tmp/scripts/run_$executor.sh" \
    > "$tmp/early-$executor.out" 2> "$tmp/early-$executor.err" || early_rc=$?
  check "$executor argument validation abort logged" jq -se --argjson code "$early_rc" \
    'length == 2 and .[0].type == "orchestrator.start" and .[-1].type == "orchestrator.exit" and .[-1].exit_code == $code and $code != 0' \
    "$early"/orchestrator/*.jsonl
done

scripts=("$root"/orchestrator/scripts/{run_codex,run_pi,run_agy,_runlog}.sh "$root/tests/wrappers.test.sh")
check 'bash -n all scripts' bash -n "${scripts[0]}"
for script in "${scripts[@]:1}"; do check "bash -n ${script##*/}" bash -n "$script"; done
if command -v shellcheck >/dev/null; then
  check 'shellcheck all scripts' shellcheck -x -P "$tmp/scripts" "${scripts[@]}"
else
  printf 'PASS shellcheck (not installed; skipped)\n'
fi
printf '\n%d checks failed\n' "$failed"
((failed == 0))
