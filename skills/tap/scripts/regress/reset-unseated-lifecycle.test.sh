#!/usr/bin/env bash
# D5: fixture-door — :188 copies the src tree and :191 mutates the stop-plan.ts copy to force the unseated path; the subject is the public `tap team reset --yes` retention/hard-gate behavior, owned natively by team-stop-plan.test.ts + team-reset.test.ts.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reset-unseated-lifecycle.test.sh — freeze-5 item 2 / fable 084245.
# Proven-inactive stripped rows (suspended/exited, no pane) are retained on
# reset-stop; active/pending unbound reservations must hard-gate before cut.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

fail() { echo "reset-unseated-lifecycle: $*" >&2; exit 1; }

BUSROOT="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$BUSROOT" "$FAKE_BIN" "${MUT:-}"' EXIT
export TAP_HOME="$BUSROOT/.tap/bus"
export TAP_SCRATCH_ONLY="$BUSROOT"
export TAP_SESSION_MANIFEST="$BUSROOT/sessions.json"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/socket"
export FAKE_CALLER_TTY="?"
export FAKE_EPOCH_RAW="900:100"

printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"

setup_case() {
  local id="$1"
  export TAP_HOME="$BUSROOT/case-$id/tap"
  mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp"
  seed_marker
}

# Fake tmux: unobservable caller ok for reset keep_self default; no pane targets.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  has-session|kill-session) exit 0 ;;
  list-sessions|list-panes) exit 0 ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;; *) echo "" ;; esac
    exit 0
    ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *ppid*|*tty=*)
    printf '1 %s\n' "${FAKE_CALLER_TTY:-?}"
    exit 0
    ;;
esac
exec /bin/ps "$@"
PS
chmod +x "$FAKE_BIN/ps"

seed_marker() {
  printf 'keep-me\n' > "$TAP_HOME/payloads/marker.md"
}

assert_bus_unchanged() {
  local label="$1" before_reg="$2" before_payload="$3"
  [ -f "$TAP_HOME/payloads/marker.md" ] || fail "$label: payloads cut despite refusal"
  [ "$(cat "$TAP_HOME/payloads/marker.md")" = "$before_payload" ] || fail "$label: payload mutated"
  [ "$(cat "$TAP_HOME/registry.json")" = "$before_reg" ] || fail "$label: registry mutated"
  n_complete="$(find "$TAP_HOME/archive" -name COMPLETE 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n_complete" = 0 ] || fail "$label: COMPLETE written despite refusal (n=$n_complete)"
  [ ! -f "$TAP_HOME/reset.fence.json" ] || fail "$label: fence left after refused reset"
}

assert_refusal() {
  local label="$1" rc="$2" out="$3"
  [ "$rc" != 0 ] || { echo "$out" >&2; fail "$label: reset should refuse active unbound seat"; }
  grep -Eq 'session_stop_refused|refused|unverified' <<<"$out" \
    || { echo "$out" >&2; fail "$label: refusal must name unverified/session_stop_refused"; }
}

# --- (a) Proven-inactive: stripped restore shape must succeed ---
setup_case a
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon"},
    "restored": {
      "status": "suspended",
      "status_reason": "restored_from_archive",
      "harness": "claude"
    }
  }
}
JSON

set +e
out_a="$("$TAP" team reset --yes --allow-nonstandard-bus-path 2>&1)"
rc_a=$?
set -e
[ "$rc_a" = 0 ] || { echo "$out_a" >&2; fail "(a) proven-inactive reset should succeed rc=$rc_a"; }
grep -Eq 'session_stop_refused|unverified_unbound|refused unverified' <<<"$out_a" \
  && { echo "$out_a" >&2; fail "(a) reset must not refuse proven-inactive unseated row"; }
BUNDLE_A="$(ls "$TAP_HOME/archive/team-reset" 2>/dev/null | head -1 || true)"
[ -n "$BUNDLE_A" ] || fail "(a) reset should write archive checkpoint"
[ -f "$TAP_HOME/archive/team-reset/$BUNDLE_A/COMPLETE" ] \
  || fail "(a) reset should stamp COMPLETE"
[ -z "$(ls -A "$TAP_HOME/payloads" 2>/dev/null)" ] || fail "(a) reset should cut payloads"
[ ! -f "$TAP_HOME/registry.json" ] || fail "(a) reset should cut registry"
echo "reset-unseated-lifecycle: (a) proven-inactive unseated succeeds: ok"

# --- (b) Active unbound: crashed reservation must refuse ---
setup_case b
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon"},
    "crasher": {
      "status": "active",
      "status_reason": "launching",
      "harness": "claude",
      "session": "demo/crasher"
    }
  }
}
JSON
before_reg_b="$(cat "$TAP_HOME/registry.json")"
before_payload_b="$(cat "$TAP_HOME/payloads/marker.md")"

set +e
out_b="$("$TAP" team reset --yes --allow-nonstandard-bus-path 2>&1)"
rc_b=$?
set -e
assert_refusal "(b) active unbound" "$rc_b" "$out_b"
assert_bus_unchanged "(b) active unbound" "$before_reg_b" "$before_payload_b"
echo "reset-unseated-lifecycle: (b) active unbound refuses: ok"

# --- (b2) pending reservation shape (same gate) ---
setup_case b2
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon"},
    "pending": {
      "status": "pending",
      "status_reason": "launching",
      "harness": "codex",
      "launch_id": "dead-token"
    }
  }
}
JSON
before_reg_b2="$(cat "$TAP_HOME/registry.json")"
before_payload_b2="$(cat "$TAP_HOME/payloads/marker.md")"

set +e
out_b2="$("$TAP" team reset --yes --allow-nonstandard-bus-path 2>&1)"
rc_b2=$?
set -e
assert_refusal "(b2) pending unbound" "$rc_b2" "$out_b2"
assert_bus_unchanged "(b2) pending unbound" "$before_reg_b2" "$before_payload_b2"
echo "reset-unseated-lifecycle: (b2) pending unbound refuses: ok"

# --- Mutation polarity: treat all empty-pane rows as unseated → active case greens wrongly ---
MUT="$(mktemp -d)"
mkdir -p "$MUT/scripts" "$MUT/skills/tap/scripts"
cp -a "$ROOT/scripts/tap.sh" "$MUT/scripts/tap.sh"
# scripts/tap.sh now execs bin/tap — copy it the same way scripts/runtime are copied.
cp -a "$ROOT/bin" "$MUT/bin"
cp -a "$ROOT/skills/tap/scripts/." "$MUT/skills/tap/scripts/"
# The dispatcher now loads Bun onboarding before its leaf command.
mkdir -p "$MUT/runtime/bun"
cp -a "$ROOT/runtime/bun/src" "$MUT/runtime/bun/src"
# bin/tap dispatches to runtime/bun/main.ts — copy it too.
cp -a "$ROOT/runtime/bun/main.ts" "$MUT/runtime/bun/main.ts"
# fzf-tool.ts statically imports vendor/fzf/manifest.json relative to the repo root.
mkdir -p "$MUT/vendor/fzf"
cp -a "$ROOT/vendor/fzf/manifest.json" "$MUT/vendor/fzf/manifest.json"
python3 -B - "$MUT/runtime/bun/src/team/stop-plan.ts" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old = """    if (!row.paneId && !row.pane) {
      if (row.status === "suspended" || row.status === "exited") {
        result.nokill.push({ handle: row.handle, reason: "unseated" });
      } else {
        result.nokill.push({ handle: row.handle, reason: "unverified_unbound" });
      }
      continue;
    }"""
new = """    if (!row.paneId && !row.pane) {
      result.nokill.push({ handle: row.handle, reason: "unseated" });
      continue;
    }"""
if old not in text:
    raise SystemExit("mutation target missing — unseated lifecycle gate shape changed")
p.write_text(text.replace(old, new, 1))
PY

setup_case mut
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon"},
    "crasher": {
      "status": "active",
      "status_reason": "launching",
      "harness": "claude",
      "session": "demo/crasher"
    }
  }
}
JSON
set +e
mout="$(cd "$MUT" && TAP_HOME="$TAP_HOME" TAP_SCRATCH_ONLY="$TAP_SCRATCH_ONLY" \
  TAP_SESSION_MANIFEST="$TAP_SESSION_MANIFEST" TMUX="$TMUX" FAKE_CALLER_TTY="?" \
  FAKE_EPOCH_RAW="$FAKE_EPOCH_RAW" PATH="$PATH" \
  bash scripts/tap.sh team reset --yes --allow-nonstandard-bus-path 2>&1)"
mrc=$?
set -e
[ "$mrc" = 0 ] || { echo "$mout" >&2; fail "MUTATION DID NOT GREEN — empty-pane status gate strip should let active unbound reset proceed"; }
echo "reset-unseated-lifecycle: mutation (all empty-pane unseated) greens active wrongly: ok"

echo "reset-unseated-lifecycle: ok"
