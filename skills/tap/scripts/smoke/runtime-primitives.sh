#!/usr/bin/env bash
# Add fixture functions without changing an existing runtime or environment.
# Seed an already-selected fixture bus, including the marker native drainers
# require. This is setup, not a replacement for production bus validation.
if ! declare -F tap_ensure_dirs >/dev/null; then
tap_ensure_dirs() {
  : "${TAP_HOME:?source runtime-helpers.sh after selecting a fixture bus}"
  mkdir -p "$TAP_PAYLOADS" "$TAP_RECEIPTS" || return 1
  local authority="$TAP_HOME/${TAP_SPOOL_HOME_AUTHORITY_MARKER:-.tap-bus-authority}"
  [ -f "$authority" ] || printf 'bootstrapped_at_epoch=%s\n' "$(date +%s)" > "$authority"
}
fi

# Error rendering for test-only placement and park fixtures.
if ! declare -F tap_error_line >/dev/null; then
tap_error_line() { # <error_class> <action> [detail]
  local klass="$1" action="$2" detail="${3:-}" verb="${TAP_VERB:-tap}"
  local human_detail="$detail" human_action="$action"
  human_detail="${human_detail//$'\n'/ }"
  human_detail="${human_detail//$'\r'/ }"
  human_action="${human_action//$'\n'/ }"
  human_action="${human_action//$'\r'/ }"
  [ -n "$human_detail" ] || human_detail="${klass//_/ }"
  case "$human_action" in
    *' '*|*/*) ;;
    *) human_action="${human_action//_/ }" ;;
  esac
  printf '%s: %s; next: %s\n' "$verb" "$human_detail" "$human_action" >&2
}
fi

if ! declare -F tap_error_json >/dev/null; then
tap_error_json() { # <error_class> <action> [detail]
  python3 -I -B - "$1" "$2" "${3:-}" <<'PY'
import json, sys
klass, action, detail = sys.argv[1:4]
obj = {"ok": False, "error_class": klass, "action": action}
if detail:
    obj["detail"] = detail
print(json.dumps(obj, separators=(",", ":")))
PY
}
fi

if ! declare -F tap_fail >/dev/null; then
tap_fail() { # <exit-code> <error_class> <action> [detail]
  local rc="$1" klass="$2" action="$3" detail="${4:-}"
  if [ "${TAP_JSON:-0}" = "1" ]; then
    tap_error_json "$klass" "$action" "$detail"
  else
    tap_error_line "$klass" "$action" "$detail"
  fi
  exit "$rc"
}
fi
