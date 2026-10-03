#!/usr/bin/env bash
# D5: fixture-door — :133 copies the src tree and :136 mutates the stop.ts copy purely as fixture prep; every assertion runs the public `tap team reset` hard gate (nonzero refusal, no COMPLETE, live bus unchanged, fence removed), owned natively by reset-fence.test.ts + team-reset.test.ts.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reset-unverified-pane-refuses.test.sh — sol 075040 / fable 075157 finding 1.
# Non-caller unverified pane row must hard-gate reset-stop: nonzero refusal,
# no COMPLETE/cut, live bus unchanged, fence removed.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

fail() { echo "reset-unverified: $*" >&2; exit 1; }

BUSROOT="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$BUSROOT" "$FAKE_BIN"' EXIT
export TAP_HOME="$BUSROOT/.tap/bus"
export TAP_SCRATCH_ONLY="$BUSROOT"
export TAP_SESSION_MANIFEST="$BUSROOT/sessions.json"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/socket"
export FAKE_CALLER_TTY="?"
export FAKE_EPOCH_RAW="900:100"
export FAKE_LIVE_SESSION="gone-sess"

printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp"

# Fake tmux: the canonical name is live, but the stored pane id resolves in a
# different session. This is the name-first destructive E2 refusal: a live
# exact name alone never authorizes a stored id that belongs elsewhere. There
# is no caller pane.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    # Only the exact canonical name is live.
    [ "${target#=}" = "${FAKE_LIVE_SESSION:-}" ] && [ -n "${FAKE_LIVE_SESSION:-}" ] && exit 0
    exit 1 ;;
  kill-session) exit 0 ;;
  list-sessions) printf '%s\t%s\n' "$FAKE_LIVE_SESSION" "$FAKE_EPOCH_RAW" ;;
  list-panes) printf '%%1000\n' ;;
  display-message)
    # Untargeted epoch is observable. The stored id is live, but its session
    # is foreign; it is deliberately not a member of gone-sess above.
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
      *session_name*) [ "$target" = "%999" ] && echo "foreign-sess" || echo "$FAKE_LIVE_SESSION" ;;
      *pane_id*) [ "$target" = "%999" ] && echo "%999" || echo "%1000" ;;
      *) echo "" ;;
    esac
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

# Marker payload + registry: one poll (ok) + one unverified pane non-caller.
printf 'keep-me\n' > "$TAP_HOME/payloads/marker.md"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon"},
    "ghost": {
      "status": "active",
      "delivery": "pane",
      "pane": "gone-sess:0.0",
      "pane_id": "%999",
      "session": "gone-sess",
      "harness": "claude",
      "server_epoch": "srv:900:100"
    }
  }
}
JSON
before_reg="$(cat "$TAP_HOME/registry.json")"
before_payload="$(cat "$TAP_HOME/payloads/marker.md")"

set +e
out="$("$TAP" team reset --yes --allow-nonstandard-bus-path 2>&1)"
rc=$?
set -e
[ "$rc" != 0 ] || { echo "$out" >&2; fail "reset should refuse with unverified pane seat"; }
grep -Eq 'session_stop_refused|refused|unverified' <<<"$out" \
  || { echo "$out" >&2; fail "refusal must name unverified/session_stop_refused"; }

# No COMPLETE checkpoint / no cut.
n_complete="$(find "$TAP_HOME/archive" -name COMPLETE 2>/dev/null | wc -l | tr -d ' ')"
[ "$n_complete" = 0 ] || fail "COMPLETE written despite refusal (n=$n_complete)"
[ -f "$TAP_HOME/payloads/marker.md" ] || fail "payloads cut despite refusal"
[ "$(cat "$TAP_HOME/payloads/marker.md")" = "$before_payload" ] || fail "payload mutated"
[ "$(cat "$TAP_HOME/registry.json")" = "$before_reg" ] || fail "registry mutated"
[ ! -f "$TAP_HOME/reset.fence.json" ] || fail "fence left after refused reset"

# Mutation polarity: if unverified refusals are ignored for policy=none, this reds.
# Prove by temporarily neutering the none-arm (scratch copy).
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
python3 -B - "$MUT/runtime/bun/src/team/stop.ts" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
# The incumbent's single gate classified unverified rows as refusals under
# suspend AND none; the port splits classification (listing, which drives the
# receipt's partial flag) from counting. Strip the none arm at the listing
# site: reset must then proceed despite unverified rows.
old = "  engine.refusedHandles = nokill.refusedHandles;"
new = '  engine.refusedHandles = policy === "suspend" ? nokill.refusedHandles : [];'
if old not in text:
    raise SystemExit(f"mutation target missing:\n{old!r}")
p.write_text(text.replace(old, new, 1))
PY
# Restore bus
printf 'keep-me\n' > "$TAP_HOME/payloads/marker.md"
printf '%s\n' "$before_reg" > "$TAP_HOME/registry.json"
set +e
mout="$(cd "$MUT" && TAP_HOME="$TAP_HOME" TAP_SCRATCH_ONLY="$TAP_SCRATCH_ONLY" \
  TAP_SESSION_MANIFEST="$TAP_SESSION_MANIFEST" TMUX="$TMUX" FAKE_CALLER_TTY="?" \
  FAKE_EPOCH_RAW="$FAKE_EPOCH_RAW" PATH="$PATH" \
  bash scripts/tap.sh team reset --yes --allow-nonstandard-bus-path 2>&1)"
mrc=$?
set -e
[ "$mrc" = 0 ] || { echo "$mout" >&2; fail "MUTATION DID NOT GREEN — none-arm strip should let reset proceed"; }
echo "reset-unverified: mutation (drop none-arm) lets reset proceed: ok"

echo "reset-unverified-pane-refuses: ok"
