# Bounded retries for idempotent transport operations only. Never wrap a foreground
# harness command in retry: a disconnect does not mean the harness stopped.
retry_transport() {
  local attempt
  for ((attempt = 1; attempt <= ${FH_TRANSPORT_ATTEMPTS:-3}; attempt++)); do
    if "$@"; then return 0; fi
    if [ "$attempt" -lt "${FH_TRANSPORT_ATTEMPTS:-3}" ]; then
      sleep "${FH_RETRY_DELAY:-2}"
    fi
  done
  return 1
}

shell_quote() {
  local escaped_quote="'\\''"
  printf "'%s'" "${1//\'/$escaped_quote}"
}

# runta cp can return an error even after delivering the entire file. A checksum
# distinguishes that case from an incomplete transfer; each retry has a fresh target.
file_sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

copy_verified() {
  local source=$1 target=$2 expected=$3 attempt actual
  for ((attempt = 1; attempt <= ${FH_TRANSPORT_ATTEMPTS:-3}; attempt++)); do
    rm -f "$target.part"
    runta cp "$source" "$target.part" || true
    actual=$(file_sha256 "$target.part" 2>/dev/null) || actual=""
    if [ "$actual" = "$expected" ] && [ -n "$actual" ]; then
      mv "$target.part" "$target"
      return 0
    fi
    if [ "$attempt" -lt "${FH_TRANSPORT_ATTEMPTS:-3}" ]; then
      sleep "${FH_RETRY_DELAY:-2}"
    fi
  done
  rm -f "$target.part"
  return 1
}

wait_for_checkpoint() {
  local name=$1 timeout=$2 started state
  started=$(date +%s)
  while :; do
    state=$(runta checkpoint ls --json | jq -r --arg name "$name" \
      '.checkpoints[] | select(.display_name == $name) | .state') || state=""
    case "$state" in
      ready) return 0 ;;
      error|failed) echo "checkpoint $name entered $state" >&2; return 1 ;;
    esac
    if [ "$(( $(date +%s) - started ))" -ge "$timeout" ]; then
      echo "checkpoint $name did not become ready within ${timeout}s (state: ${state:-unknown})" >&2
      return 1
    fi
    sleep "${FH_POLL_INTERVAL:-5}"
  done
}
