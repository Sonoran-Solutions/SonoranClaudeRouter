#!/usr/bin/env bash
# run_pi.sh <prompt-file> <workdir> [openrouter-model]  -> final assistant text on stdout, cost line on stderr
# env: ORCH_TIMEOUT (s, default 900), ORCH_PI_MODEL (default: newest deepseek/*flash* on OpenRouter, cached 6h;
#      fallback ~deepseek/deepseek-flash-latest). Never a google/* model: those go through agy.
# pi keeps its read/bash/edit/write tools and runs them without asking. ORCH_PI_NO_TOOLS=1 for text-only.
# Uses --mode json: text mode was seen to hang for minutes on tool-using briefs (2026-10-16).
set -euo pipefail
. "$(dirname "$0")/_runlog.sh" pi "$@"
. "$(dirname "$0")/_env.sh"
p=${1:?prompt file}; w=${2:?workdir}; m=${3:-${ORCH_PI_MODEL:-}}
if [ -z "$m" ]; then
  c=${XDG_CACHE_HOME:-$HOME/.cache}/orchestrator; mkdir -p "$c"; f=$c/deepseek_flash_newest
  if [ ! -s "$f" ] || [ -n "$(find "$f" -mmin +360 2>/dev/null)" ]; then
    curl -sS -m 15 https://openrouter.ai/api/v1/models 2>/dev/null \
      | jq -r '[.data[] | select(.id | test("^deepseek/.*flash") and (test("batch|vision|free")|not))] | sort_by(.created) | last | .id // empty' > "$f.tmp" 2>/dev/null \
      && [ -s "$f.tmp" ] && mv "$f.tmp" "$f" || rm -f "$f.tmp"
  fi
  m=$(cat "$f" 2>/dev/null || true); m=${m:-~deepseek/deepseek-flash-latest}
fi
_runlog_init pi "$p" "$w" "$m"
cd "$w"
ev=$(_runlog_run timeout "${ORCH_TIMEOUT:-900}" pi -p --provider openrouter --model "$m" --no-session --no-extensions \
  --no-skills --no-context-files ${ORCH_PI_NO_TOOLS:+--no-tools} --mode json "$(cat "$p")" 2>/dev/null) \
  || { rc=$?; echo "pi failed or timed out (rc=$rc)" >&2; printf '%s\n' "$ev" | { grep -i error || true; } | tail -3 | cut -c1-300 >&2; exit $rc; }
printf '%s\n' "$ev" | jq -r 'select(.type=="message_end" and .message.role=="assistant") | [.message.content[]? | select(.type=="text") | .text] | join("\n")' | awk 'NF' | tail -n 1
printf '%s\n' "$ev" | jq -rs '[.[] | select(.type=="message_end" and .message.role=="assistant") | .message.usage.cost.total // 0] | "pi cost_usd=\(add|.*1e6|round/1e6) model='"$m"'"' >&2 || true
