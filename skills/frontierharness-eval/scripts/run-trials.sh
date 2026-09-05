#!/usr/bin/env bash
# Run benchmark tasks against a harness, one fresh golden-checkpoint restore per task,
# collecting trajectories and verifier logs as evidence.
set -euo pipefail

# shellcheck source=providers.sh
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/providers.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"

# The benchmark is fixed to Kimi K3; the provider is free. See providers.sh.
PROVIDER="fireworks"

CHECKPOINT=""
HARNESS=""
MODEL=""
RUN_ID=""
TASKS="tasks"
OUT="runs"
CMD_TEMPLATE=""
TIMEOUT=5400
SECRET_NAME=""
SECRET_HOST=""

usage() {
  cat <<EOF
Usage: run-trials.sh --checkpoint NAME --harness NAME --run-id ID
                     [--tasks PATH] [--provider NAME] [--model ID] [--out DIR]
                     [--cmd TEMPLATE] [--timeout SEC]

  --tasks PATH    Either a directory of <task>/task.toml definitions, or a file with
                  one task id per line: terminal-bench/<id> or datacurve/<id>.
                  Defaults to the repo's tasks/ directory, i.e. the full published set.
  --provider NAME Kimi K3 provider, must match the golden checkpoint's provider.
                  Default fireworks. One of: $PROVIDER_LIST
  --model ID      Override the model route. Must still be Kimi K3; the benchmark does
                  not vary the model. Required with --provider custom.
  --out DIR       Root output directory (default runs)
  --cmd TEMPLATE  Override the runner command. Placeholders: {task} {suite} {harness}
                  {model} {jobs}. Default templates are per suite, see reference.md.
  --timeout SEC   Per-task timeout in seconds (default 5400, matching task.toml)
  --secret-name NAME  Provider key to inject on egress. Defaults to the provider preset.
  --secret-host HOST  Host the key is injected for. Defaults to the provider preset.
                  Credential injection rules are per-runtime and are not carried by a
                  checkpoint, so each restored trial runtime needs the rule reapplied.

Re-running an existing --run-id resumes pending evidence collection, skips valid
trials, and retries infra-invalid trials. Use a new --run-id for a new experiment.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --checkpoint) CHECKPOINT=$2; shift 2 ;;
    --harness) HARNESS=$2; shift 2 ;;
    --provider) PROVIDER=$2; shift 2 ;;
    --model) MODEL=$2; shift 2 ;;
    --run-id) RUN_ID=$2; shift 2 ;;
    --tasks) TASKS=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --cmd) CMD_TEMPLATE=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --secret-name) SECRET_NAME=$2; shift 2 ;;
    --secret-host) SECRET_HOST=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$TIMEOUT" in
  ''|*[!0-9]*|0) echo "--timeout must be a positive integer" >&2; exit 2 ;;
esac

for required in CHECKPOINT HARNESS RUN_ID; do
  if [ -z "${!required}" ]; then
    echo "missing --$(echo "$required" | tr 'A-Z_' 'a-z-')" >&2
    usage >&2
    exit 2
  fi
done

if ! resolve_provider "$PROVIDER"; then
  echo "unknown --provider $PROVIDER; expected one of: $PROVIDER_LIST" >&2
  exit 2
fi
MODEL=${MODEL:-$PROVIDER_MODEL}
SECRET_NAME=${SECRET_NAME:-$PROVIDER_SECRET}
SECRET_HOST=${SECRET_HOST:-$PROVIDER_HOST}
if [ -z "$MODEL" ]; then
  echo "--provider custom needs --model" >&2
  exit 2
fi
warn_unless_kimi_k3 "$MODEL"

require_runta_auth || exit 1

# The task list is either a directory of task definitions or a plain list file. A
# directory is the normal case: every tasks/<task>/task.toml already carries its
# suite-prefixed id in [task] name, so the set that runs is exactly the set that is
# defined, with no second list to keep in sync.
TASK_LIST=$(mktemp)
CURRENT_RUNTIME=""
cleanup() {
  rm -f "$TASK_LIST"
  if [ -n "$CURRENT_RUNTIME" ]; then
    echo "Runtime retained for recovery: $CURRENT_RUNTIME. Re-run the same command to resume." >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -d "$TASKS" ]; then
  for toml in "$TASKS"/*/task.toml; do
    [ -r "$toml" ] || continue
    awk -F'"' '/^\[/ { in_task = ($0 == "[task]") }
               in_task && /^name *=/ { print $2; exit }' "$toml"
  done | sort -u > "$TASK_LIST"
  [ -s "$TASK_LIST" ] && echo "running $(wc -l < "$TASK_LIST" | tr -d ' ') tasks from $TASKS/" >&2
elif [ -r "$TASKS" ]; then
  cat "$TASKS" > "$TASK_LIST"
else
  echo "cannot read task list: $TASKS (expected a task directory or a list file)" >&2
  exit 1
fi
[ -s "$TASK_LIST" ] || { echo "no tasks found in $TASKS" >&2; exit 1; }

RUN_DIR="$OUT/$RUN_ID"
mkdir -p "$RUN_DIR/trials"

if [ -f "$RUN_DIR/run.json" ]; then
  jq -e --arg checkpoint "$CHECKPOINT" --arg harness "$HARNESS" --arg model "$MODEL" \
    --arg provider "$PROVIDER" --arg cmd "$CMD_TEMPLATE" --argjson timeout "$TIMEOUT" \
    '.checkpoint == $checkpoint and .harness == $harness and .model == $model
     and .provider == $provider and (.cmd_template // "") == $cmd
     and (.timeout_seconds // 5400) == $timeout' "$RUN_DIR/run.json" >/dev/null \
    || { echo "run configuration differs; use a new --run-id" >&2; exit 2; }
else
jq -n --arg run_id "$RUN_ID" --arg checkpoint "$CHECKPOINT" --arg harness "$HARNESS" \
      --arg model "$MODEL" --arg provider "$PROVIDER" \
      --arg cmd "$CMD_TEMPLATE" --argjson timeout "$TIMEOUT" \
      --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{run_id:$run_id, checkpoint:$checkpoint, harness:$harness, model:$model,
    provider:$provider, cmd_template:$cmd, timeout_seconds:$timeout, started_at:$started}' \
  > "$RUN_DIR/run.json"
fi

# Harbor drives Terminal-Bench tasks; Pier drives DeepSWE tasks in air-gapped mode.
default_cmd() {
  case "$1" in
    terminal-bench)
      # terminal-bench@2.0 is the legacy-registry name that actually holds the benchmark's
      # 21 terminal-bench tasks. terminal-bench/terminal-bench@4.0.0 is a different corpus
      # of 66 tasks that shares none of these ids, so it silently evaluates nothing.
      # Harbor 0.22 selects tasks with -i, not the removed --task-id, and the compose
      # overlay gives the container the egress CA its verifier needs to fetch uv.
      # -r 2 retries agent-level exceptions. A well-behaved adapter raises only when its
      # harness crashed, never when the agent merely failed the task, so retries buy back
      # trials lost to flaky infrastructure without ever masking a real wrong answer.
      echo "harbor run -d terminal-bench@2.0 -i {task} -a {harness} -m {model} --jobs-dir {jobs} --extra-docker-compose /work/runta-ca-overlay.yaml -r 2 -y" ;;
    datacurve)
      echo "pier run -p /work/deep-swe/tasks/{task} --agent {harness} --model {model} --jobs-dir {jobs}" ;;
    *)
      echo "" ;;
  esac
}

render() {
  local rendered=$1
  rendered=${rendered//\{task\}/$(shell_quote "$2")}
  rendered=${rendered//\{suite\}/$(shell_quote "$3")}
  rendered=${rendered//\{harness\}/$(shell_quote "$HARNESS")}
  rendered=${rendered//\{model\}/$(shell_quote "$MODEL")}
  rendered=${rendered//\{jobs\}/$(shell_quote "$4")}
  printf '%s\n' "$rendered"
}

# Prefer runner result documents, then the rest, always in sorted path order so
# extraction is deterministic. Only explicit result fields are read: walking every
# nested object used to pick up a passing unit test or trajectory event.
json_files_ordered() {
  local dir=$1 all preferred rest
  [ -d "$dir" ] || return 0
  all=$(find "$dir" -name '*.json' -size -8M 2>/dev/null | LC_ALL=C sort) || return 0
  [ -n "$all" ] || return 0
  preferred=$(printf '%s\n' "$all" | grep -E '/(result|results|eval|verifier)[^/]*\.json$' || true)
  rest=$(printf '%s\n' "$all" | grep -vE '/(result|results|eval|verifier)[^/]*\.json$' || true)
  printf '%s\n%s\n' "$preferred" "$rest" | sed '/^$/d'
}

extract() {
  local dir=$1 filter=$2 file value
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    value=$(jq -c "$filter" "$file" 2>/dev/null) || continue
    if [ -n "$value" ] && [ "$value" != "null" ]; then
      printf '%s' "$value"
      return 0
    fi
  done < <(json_files_ordered "$dir")
}

runtime_name() {
  local raw hash
  raw=$(printf 'fh-%s' "$1" | tr -c 'a-zA-Z0-9-' '-')
  if [ "${#raw}" -le 52 ]; then
    printf '%s' "$raw"
    return
  fi
  hash=$(printf '%s' "$1" | openssl dgst -sha256 2>/dev/null | awk '{print $NF}')
  [ -n "$hash" ] || hash=$(printf '%s' "$1" | cksum | awk '{print $1}')
  printf 'fh-%s' "$(printf '%s' "$hash" | cut -c1-16)"
}

record_infra() {
  local error=$1 recovery=$2
  jq -n --arg id "$entry" --arg task "$task" --arg suite "$suite" \
    --arg runtime "$runtime" --arg checkpoint "$CHECKPOINT" --arg error "$error" \
    --arg command "$command" --argjson recovery "$recovery" \
    '{id:$id, title:$task, suite:$suite, status:"infra_invalid", success:false,
      runtime:$runtime, checkpoint:$checkpoint, error:$error, recovery:$recovery,
      runner_command:$command}' > "$trial_dir/trial.json.tmp"
  mv "$trial_dir/trial.json.tmp" "$trial_dir/trial.json"
  echo "$entry: $error (runtime: $runtime)" >&2
}

# Pull only this task's image while the fresh runtime still has bootstrap egress.
# DeepSWE's pinned corpus is authoritative for its image (not the public metadata,
# which predates the separate-verifier image layout).
prepare_image() {
  local image toml
  if [ "$suite" = datacurve ]; then
    image=$(retry_transport runta exec "$runtime" -- sh -lc \
      "awk -F '\"' '/^docker_image *=/ { print \$2; exit }' /work/deep-swe/tasks/$(shell_quote "$task")/task.toml") || return 1
  else
    toml="$TASKS/$task/task.toml"
    # A Skills CLI install has no adjacent task data. For a subset list, resolve
    # task images from the benchmark workspace before trying a repository install.
    [ -f "$toml" ] || toml="tasks/$task/task.toml"
    [ -f "$toml" ] || toml="$SCRIPT_DIR/../../../tasks/$task/task.toml"
    [ -f "$toml" ] || return 0 # A custom --cmd may prepare its own environment.
    image=$(awk -F'"' '/^docker_image *=/ { print $2; exit }' "$toml")
  fi
  [ -n "$image" ] || return 0
  retry_transport runta exec "$runtime" -- sh -lc "timeout 1800 docker pull $(shell_quote "$image")"
}

total=0
passed=0

while IFS= read -r entry || [ -n "$entry" ]; do
  entry=$(echo "$entry" | tr -d '\r' | sed 's/#.*//; s/^ *//; s/ *$//')
  [ -n "$entry" ] || continue
  if [[ ! "$entry" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$ ]]; then
    echo "invalid task id: $entry" >&2
    exit 2
  fi

  suite=${entry%%/*}
  task=${entry#*/}
  slug=$(echo "$entry" | tr '/' '-')
  trial_dir="$RUN_DIR/trials/$slug"
  runtime=$(runtime_name "$RUN_ID-$slug")
  jobs_dir="/work/jobs/$slug"
  state_dir="/work/fh-trials/$slug"
  template=${CMD_TEMPLATE:-$(default_cmd "$suite")}
  [ -n "$template" ] || { echo "no runner template for suite '$suite'; pass --cmd" >&2; exit 2; }
  command=$(render "$template" "$task" "$suite" "$jobs_dir")
  total=$((total + 1))
  CURRENT_RUNTIME=""

  # Preserve the first valid attempt, whether it passed or failed.
  if [ -f "$trial_dir/trial.json" ] && jq -e \
    '.status == "success" or .status == "failure" or .status == "timeout"' "$trial_dir/trial.json" >/dev/null; then
    echo "[$entry] keeping first valid attempt" >&2
    if jq -e '.success == true' "$trial_dir/trial.json" >/dev/null; then passed=$((passed + 1)); fi
    continue
  fi

  resume=false
  if [ -f "$trial_dir/trial.json" ] && jq -e '.recovery == true' "$trial_dir/trial.json" >/dev/null; then
    resume=true
    runtime=$(jq -r '.runtime' "$trial_dir/trial.json")
    # Reconnect using the exact command recorded before launch, even if templates changed.
    command=$(jq -r '.runner_command' "$trial_dir/trial.json")
    echo "[$entry] resuming $runtime" >&2
  else
    if [ -d "$trial_dir" ]; then
      mkdir -p "$RUN_DIR/attempts/$slug"
      mv "$trial_dir" "$RUN_DIR/attempts/$slug/$(date +%s)-$$"
    fi
    mkdir -p "$trial_dir"
    printf '\n=== [%s] restoring %s\n' "$entry" "$CHECKPOINT" >&2
    if ! runta checkpoint restore "$CHECKPOINT" "$runtime" >"$trial_dir/restore.log" 2>&1; then
      record_infra "checkpoint restore failed; inspect for an accepted restore before retrying" false
      continue
    fi
  fi
  CURRENT_RUNTIME=$runtime

  ready=0
  for _ in $(seq 1 60); do
    if runta exec "$runtime" -- sh -lc 'exit 0' >>"$trial_dir/restore.log" 2>&1; then
      ready=1
      break
    fi
    sleep "${FH_POLL_INTERVAL:-5}"
  done
  if [ "$ready" -ne 1 ]; then
    record_infra "restored runtime never became ready" "$resume"
    if [ "$resume" = false ]; then runta rm "$runtime" >>"$trial_dir/restore.log" 2>&1 || true; fi
    CURRENT_RUNTIME=""
    continue
  fi

  if [ "$resume" = false ]; then
    if ! prepare_image >>"$trial_dir/restore.log" 2>&1; then
      record_infra "task image pull failed" false
      runta rm "$runtime" >>"$trial_dir/restore.log" 2>&1 || true
      CURRENT_RUNTIME=""
      continue
    fi
    if [ -n "$SECRET_HOST" ] && ! retry_transport apply_provider_egress "$runtime" "$SECRET_HOST" >>"$trial_dir/restore.log" 2>&1; then
      record_infra "egress policy failed" false
      runta rm "$runtime" >>"$trial_dir/restore.log" 2>&1 || true
      CURRENT_RUNTIME=""
      continue
    fi
    if [ -n "$SECRET_NAME" ] && [ -n "$SECRET_HOST" ]; then
      if ! retry_transport runta secret rule set "$runtime" --secret "$SECRET_NAME" --host "$SECRET_HOST" \
        --header Authorization --template 'Bearer ${secret}' >>"$trial_dir/restore.log" 2>&1; then
        record_infra "credential injection rule failed" false
        runta rm "$runtime" >>"$trial_dir/restore.log" 2>&1 || true
        CURRENT_RUNTIME=""
        continue
      fi
    fi
    if ! retry_transport runta exec "$runtime" -- sh -lc \
      "mkdir -p $jobs_dir $state_dir; command -v flock && command -v setsid && command -v timeout" >>"$trial_dir/transport.log" 2>&1 \
      || ! retry_transport runta cp "$SCRIPT_DIR/trial-worker.sh" "$runtime:$state_dir/worker.sh" >>"$trial_dir/transport.log" 2>&1; then
      record_infra "detached runner preparation failed" false
      runta rm "$runtime" >>"$trial_dir/transport.log" 2>&1 || true
      CURRENT_RUNTIME=""
      continue
    fi
  fi

  # Persist recovery information BEFORE launch. EXIT/SIGINT must leave the runtime
  # alive so an interrupted controller can reattach without rerunning the harness.
  record_infra "runner or evidence collection pending; re-run the same command to resume" true
  retry_transport runta exec "$runtime" -- sh -lc \
    "if command -v systemd-run >/dev/null; then
       env_flags=\$(python3 -c 'import os,re; print(\" \".join(\"--setenv=\" + k for k in os.environ if re.fullmatch(\"[A-Za-z_][A-Za-z_0-9]*\", k)))')
       systemd-run --quiet --collect --unit=fh-$slug \$env_flags \\
         --property=StandardOutput=append:$state_dir/worker.log \\
         --property=StandardError=append:$state_dir/worker.log \\
         /bin/bash $state_dir/worker.sh $state_dir $TIMEOUT $(shell_quote "$command")
     else
       nohup setsid bash $state_dir/worker.sh $state_dir $TIMEOUT $(shell_quote "$command") </dev/null >>$state_dir/worker.log 2>&1 &
     fi" \
    >>"$trial_dir/transport.log" 2>&1 || true

  completed=false
  polling_started=$(date +%s)
  poll_failures=0
  while [ "$(( $(date +%s) - polling_started ))" -le "$((TIMEOUT + 120))" ]; do
    if completion=$(runta exec "$runtime" -- sh -lc \
      "if [ -f $state_dir/completion.json ]; then cat $state_dir/completion.json; else echo pending; fi" \
      2>>"$trial_dir/transport.log"); then
      poll_failures=0
      if printf '%s' "$completion" | jq -e \
        '.exit_code | type == "number"' >/dev/null 2>&1; then
        completed=true
        break
      fi
    else
      poll_failures=$((poll_failures + 1))
      [ "$poll_failures" -lt "${FH_TRANSPORT_ATTEMPTS:-3}" ] || break
    fi
    sleep "${FH_POLL_INTERVAL:-5}"
  done
  if [ "$completed" = false ]; then
    record_infra "completion could not be confirmed; runtime retained for recovery" true
    CURRENT_RUNTIME=""
    continue
  fi

  # Bundle only once the worker has finished. Verify the whole bundle before scoring
  # or deleting anything: a result.json alone does not prove trajectories copied too.
  archive_hash=$(retry_transport runta exec "$runtime" -- sh -lc \
    "set -eu
     if [ ! -f $state_dir/evidence.tar.gz ]; then
       tar -czf $state_dir/evidence.tar.gz.tmp -C $state_dir completion.json runner.log -C /work manifest.json -C /work/jobs $slug
       mv $state_dir/evidence.tar.gz.tmp $state_dir/evidence.tar.gz
     fi
     sha256sum $state_dir/evidence.tar.gz" 2>>"$trial_dir/transport.log" | awk '{print $1}') || archive_hash=""
  if [ -z "$archive_hash" ] || ! copy_verified "$runtime:$state_dir/evidence.tar.gz" \
    "$trial_dir/evidence.tar.gz" "$archive_hash" >>"$trial_dir/transport.log" 2>&1; then
    record_infra "evidence transfer incomplete; runtime retained for recovery" true
    CURRENT_RUNTIME=""
    continue
  fi
  rm -rf "$trial_dir/collected"
  mkdir -p "$trial_dir/collected"
  if ! tar -xzf "$trial_dir/evidence.tar.gz" -C "$trial_dir/collected"; then
    record_infra "evidence archive could not be extracted; runtime retained for recovery" true
    CURRENT_RUNTIME=""
    continue
  fi
  rm -rf "$trial_dir/jobs"
  mv "$trial_dir/collected/$slug" "$trial_dir/jobs"
  mv "$trial_dir/collected/runner.log" "$trial_dir/collected/manifest.json" \
    "$trial_dir/collected/completion.json" "$trial_dir/"
  rmdir "$trial_dir/collected"
  exit_code=$(jq -er '.exit_code' "$trial_dir/completion.json")
  duration=$(jq -er '.duration_seconds' "$trial_dir/completion.json")

  # Support the pinned runners' explicit verifier field, as well as custom runners'
  # top-level rewards. Do not search arbitrary nested events for a passing unit test.
  reward=$(extract "$trial_dir/jobs" '[.resolved, .is_resolved, .reward, .passed, .verifier_result.rewards.reward] | map(select(. != null)) | .[0] | select(. != null)')
  cost=$(extract "$trial_dir/jobs" '.total_cost_usd // .total_cost // .cost_usd // .usage.total_cost_usd | select(type == "number")')
  turns=$(extract "$trial_dir/jobs" '.n_steps // .num_turns // .turns // .agent_info.n_steps // .agent_info.num_turns | select(type == "number")')
  cache=$(extract "$trial_dir/jobs" '.cache_hit_rate // .cache_read_ratio | select(type == "number")')
  exception=$(extract "$trial_dir/jobs" '.exception_info | select(. != null)')
  environment_failure=$(extract "$trial_dir/jobs" 'select(.exception_info != null and .environment_setup != null and .agent_setup == null and .agent_execution == null) | true')
  success=$(jq -n --argjson r "${reward:-null}" '($r == true) or ($r == 1)' 2>/dev/null) || success=false
  if [ "$environment_failure" = true ]; then
    status=infra_invalid
    success=false
  elif [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ]; then
    status=timeout
    success=false
  elif [ "$success" = true ]; then
    status=success
    passed=$((passed + 1))
  else
    status=failure # A confirmed harness crash is still a scoreable failure.
  fi

  jq -n \
    --arg id "$entry" --arg task "$task" --arg suite "$suite" --arg status "$status" \
    --arg runtime "$runtime" --arg checkpoint "$CHECKPOINT" \
    --argjson success "$success" --argjson duration "$duration" --argjson exit_code "$exit_code" \
    --argjson cost "${cost:-null}" --argjson turns "${turns:-null}" --argjson cache "${cache:-null}" \
    --argjson exception "${exception:-null}" \
    '{id:$id, title:$task, suite:$suite, status:$status, success:$success,
      duration_seconds:$duration, cost_first_cold_usd:$cost, turns:$turns,
      cache_hit_rate_normalized:$cache, exit_code:$exit_code,
      runtime:$runtime, checkpoint:$checkpoint,
      harness_exception:$exception,
      included_in_efficiency:$success}' > "$trial_dir/trial.json.tmp"
  mv "$trial_dir/trial.json.tmp" "$trial_dir/trial.json"
  runta rm "$runtime" >>"$trial_dir/transport.log" 2>&1 || echo "failed to delete runtime $runtime" >&2
  CURRENT_RUNTIME=""
  printf '=== [%s] %s in %ss (exit %s)\n' "$entry" "$status" "$duration" "$exit_code" >&2
done < "$TASK_LIST"

echo >&2
echo "$passed/$total passed. Evidence in $RUN_DIR/trials/" >&2
echo "Next: node $(dirname "$0")/normalize-results.mjs --run $RUN_DIR --label \"$HARNESS\"" >&2
