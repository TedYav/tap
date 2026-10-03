#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# authorizer-single-observation.test.sh — tap-6lai.
#
# Two AUTHORIZERS read the server generation and a pane identity as SEPARATE
# observations, and both inherit the same fall-through when the generation is
# unobservable: the check that is supposed to reject a prior-generation row
# simply does not run, and the row is then judged on pane agreement alone. A
# recycled pane id makes that agreement a coincidence rather than an identity.
#
# The generation is forced unobservable here with a set-but-empty
# TAP_SERVER_EPOCH, which is not a contrived lever: tap_server_epoch_from_raw
# checks that pin FIRST and returns failure on an empty value even when the
# tmux record was perfect, so "identity present, generation empty" is a state
# the design GUARANTEES for every force-unknown caller rather than an edge case.
#
# WHAT EACH CASE PROVES
#   A  tap_bound_pane_identity_state — the delivery gate every `tap send` rides
#      through tap_submit_identity_guard. Its header states "Every other result
#      is fail-closed"; this arm does not, so a prior-generation row can reach
#      'match' and authorize an injection into whatever pane now holds that id.
#   B  tap_resolve_self_handle — the ONE lookup whoami/send/reply/done/unregister
#      share, so it decides `from=` on the bus. With no row skipped, a stale row
#      whose id coincides with the caller's wins on sorted() order and is
#      returned as SELF: a forged author, invisible to every downstream reader.
#      Case B is the only artifact that will ever demonstrate this path existed.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"

# Fake tmux: the seat's pane address and its id both resolve to %9. The
# generation field is answered too, so the ONLY thing making the generation
# unknown in these cases is the explicit pin — never a gap in the fixture.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
[ "$cmd" = "display-message" ] || exit 0
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
done
if [ -z "$target" ]; then
  case "$fmt" in *pid*start_time*) printf '%s\n' "${FAKE_EPOCH_RAW-4242:99}" ;; *) printf '\n' ;; esac
  exit 0
fi
case "$target" in
  "%9"|"T/seat:0.0") ;;
  *) printf '\n'; exit 0 ;;
esac
out="$fmt"
out="${out//'#{pane_id}'/${FAKE_PANE_ID-%9}}"
out="${out//'#{session_name}'/T/seat}"
out="${out//'#{pid}:#{start_time}'/${FAKE_EPOCH_RAW-4242:99}}"
printf '%s\n' "$out"
TMUX
chmod +x "$FAKE_BIN/tmux"

STALE='srv:1:1'
# Born live: each arm's team root is enrolled and its bus is <root>/.tap/bus, so
# the acting-registry rebind inside the resolver finds it. Select an arm's team
# with use_bus before calling into lib.sh.
mk_registry() { # $1=<root>/.tap/bus/registry.json, $2=json seats body
  local bus root
  bus="$(dirname "$1")"; root="${bus%/.tap/bus}"
  mkdir -p "$bus"
  printf '{"schema": "0.20", "team":{"name":"%s","worktree_root":"%s"},"seats":%s}\n' "$(basename "$root")" "$root" "$2" > "$1"
  tap_smoke_enroll_current "$root" "$bus" "$(basename "$root")"
}
use_bus() { export TAP_HOME="$(dirname "$1")"; }

fails=0

# ── A. delivery gate: prior-generation row must not reach 'match' ────────────
REG_A="$WORK/Ta/.tap/bus/registry.json"
mk_registry "$REG_A" '{"seat":{"status":"active","delivery":"pane","pane":"T/seat:0.0","pane_id":"%9","server_epoch":"'"$STALE"'"}}'
use_bus "$REG_A"
state="$(TAP_SERVER_EPOCH="" bash -c '. "$1" >/dev/null 2>&1; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-readiness-fixture.sh" >/dev/null 2>&1; bound_pane_identity_fixture "$2" seat "T/seat:0.0" "%9"' _ "$LIB" "$REG_A")"
if [ "$state" = "match" ]; then
  echo "authorizer-single-observation: FAIL [A] delivery gate returned 'match' for a row stamped under a PRIOR generation while the current one was unobservable — the staleness check did not run and pane agreement alone authorized the injection" >&2
  fails=$((fails + 1))
else
  echo "authorizer-single-observation: ok [A] delivery gate refuses an unverifiable generation (got '$state')"
fi

# Native self-identity controls now live in compact-support.test.ts and context.test.ts.
[ "$fails" -eq 0 ] || { echo "authorizer-single-observation: FAILED ($fails)" >&2; exit 1; }
echo "authorizer-single-observation: PASS"
