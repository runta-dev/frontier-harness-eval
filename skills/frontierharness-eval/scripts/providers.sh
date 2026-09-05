# Kimi K3 provider routes, shared by provision-golden-checkpoint.sh and run-trials.sh.
#
# The benchmark fixes the *model* at Kimi K3 so the harness is the only variable. The
# *provider* is free: the published baselines used Fireworks, but any provider serving
# the same model produces a comparable pass rate. Model strings use the LiteLLM provider
# route, which is what Harbor, Pier, and mini-swe-agent expect.

PROVIDER_LIST="fireworks moonshot openrouter together custom"

# Sets PROVIDER_MODEL, PROVIDER_SECRET, and PROVIDER_HOST. Returns 1 on unknown input.
resolve_provider() {
  case "$1" in
    fireworks)
      PROVIDER_MODEL="fireworks_ai/accounts/fireworks/models/kimi-k3"
      PROVIDER_SECRET="FIREWORKS_API_KEY"
      PROVIDER_HOST="api.fireworks.ai" ;;
    moonshot)
      PROVIDER_MODEL="moonshot/kimi-k3"
      PROVIDER_SECRET="MOONSHOT_API_KEY"
      PROVIDER_HOST="api.moonshot.ai" ;;
    openrouter)
      PROVIDER_MODEL="openrouter/moonshotai/kimi-k3"
      PROVIDER_SECRET="OPENROUTER_API_KEY"
      PROVIDER_HOST="openrouter.ai" ;;
    together)
      PROVIDER_MODEL="together_ai/moonshotai/Kimi-K3"
      PROVIDER_SECRET="TOGETHER_API_KEY"
      PROVIDER_HOST="api.together.xyz" ;;
    custom)
      # Anything else: --model and --secret-name must be supplied explicitly.
      PROVIDER_MODEL=""
      PROVIDER_SECRET=""
      PROVIDER_HOST="" ;;
    *)
      return 1 ;;
  esac
}

# The scripts need a Runta CLI that can reach the API, which RUNTA_TOKEN is only one way
# to supply: `runta login` leaves a credential in ~/.config/runta/config.toml, and the
# --token flag falls back to it. Probing the API accepts either and rejects a token that
# is set but stale, which the old RUNTA_TOKEN-is-non-empty check let through.
require_runta_auth() {
  command -v runta >/dev/null || { echo "runta CLI not found" >&2; return 1; }
  command -v jq >/dev/null || { echo "jq not found" >&2; return 1; }
  if ! runta checkpoint ls >/dev/null 2>&1; then
    echo "runta CLI cannot reach the API: set RUNTA_TOKEN or run 'runta login'" >&2
    return 1
  fi
}

# True when the tenant already holds a secret by this name. The API returns only
# cache_ttl_secs, display_name, and id, never a stored value, so an existing secret can
# be reused but not read back.
runta_secret_exists() {
  runta secret list --json 2>/dev/null \
    | jq -e --arg name "$1" '[.secrets[].display_name] | index($name)' >/dev/null
}

# The model must still be Kimi K3 whatever the provider. Case-insensitive because
# providers disagree on capitalisation, e.g. Together serves it as Kimi-K3.
warn_unless_kimi_k3() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    *kimi-k3*|*kimi_k3*|*"kimi k3"*|*kimik3*) return 0 ;;
  esac
  echo "warning: --model $1 is not Kimi K3. Every published FrontierHarness result uses Kimi K3, so this score will not be comparable to them." >&2
}

# Exact hosts are required at every redirect in the verifier's uv download chain.
# Never fall back to provider-only egress: that turns setup failures into reward 0.
apply_provider_egress() {
  local runtime=$1 host=$2
  [ -n "$runtime" ] && [ -n "$host" ] || return 0
  runta egress set "$runtime" --mode allowlist --allow "$host" \
    --allow astral.sh --allow releases.astral.sh --allow github.com \
    --allow release-assets.githubusercontent.com
}
