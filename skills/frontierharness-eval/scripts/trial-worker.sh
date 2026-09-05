#!/usr/bin/env bash
# Runs inside the restored runtime, detached from the Runta exec connection.
set -euo pipefail
state=$1
limit=$2
command=$3
mkdir -p "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0
# A launch acknowledgement can be lost. Reattaching must never execute the task twice,
# including when the worker itself died before it could write completion.json.
[ ! -f "$state/started" ] || exit 0
started=$(date +%s)
printf '%s\n' "$started" > "$state/started"
export PATH="$HOME/.local/bin:$PATH"
cd "${FH_WORK_DIR:-/work}"
exit_code=0
timeout --kill-after=30 "$limit" bash -lc "$command" >"$state/runner.log" 2>&1 || exit_code=$?
duration=$(( $(date +%s) - started ))
jq -n --argjson exit_code "$exit_code" --argjson duration "$duration" \
  '{exit_code:$exit_code, duration_seconds:$duration}' > "$state/completion.json.tmp"
mv "$state/completion.json.tmp" "$state/completion.json"
