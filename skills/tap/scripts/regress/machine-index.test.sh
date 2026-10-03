#!/usr/bin/env bash
# machine-index.test.sh — U8 (R13/R14, AE5): an indexed team is addressable from any
# cwd; the machine's global registry stores the repo root and its registry_location,
# and the remote bus is derived from it (.tap/bus else legacy tmp/tap). A deleted
# root keeps its registered entry — de-enrollment is explicit, never a read
# side-effect — and the send refuses loud naming the unreachable registry_location
# and the tap admin refresh recovery door. Tests redirect TAP_INDEX_HOME — never the real
# ~/.tap.
#
# Contract restated 2026-09-17 (tap-2jab5): since the born-live change the
# machine-level store is global-registry.json and `tap init` enrolls the team there;
# the retired teams.json is never created on a fresh machine. The per-repo store the
# index points at is <root>/.tap/team-registry.json (seats axis), not the retired
# <root>/.tap/bus/registry.json.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # machine index redirect: never touch real ~/.tap
export FAKE_TMUX_STATE="$WORK/fake-tmux"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  # CONTRACT §Session-name authority: indexed remote delivery is still gated by
  # the current exact-session/pane/generation/harness observation.
  list-sessions)
    printf 'RemoteTeam/codex\t123:456\nLegacyRemote/codex\t123:456\nUnrelated/claude\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      RemoteTeam/codex) printf 'RemoteTeam/codex\tcodex-pane\t%%601\tcodex\t4242\t123:456\t0\n' ;;
      LegacyRemote/codex) printf 'LegacyRemote/codex\tlegacy-pane\t%%602\tcodex\t4242\t123:456\t0\n' ;;
      Unrelated/claude) printf 'Unrelated/claude\tsender-pane\t%%603\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      '#{pid}:#{start_time}') echo "123:456" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          RemoteTeam/codex|codex-pane|%601) printf '%%601\tRemoteTeam/codex\t4242\tcodex\t0\n' ;;
          LegacyRemote/codex|legacy-pane|%602) printf '%%602\tLegacyRemote/codex\t4242\tcodex\t0\n' ;;
          Unrelated/claude|sender-pane|%603) printf '%%603\tUnrelated/claude\t4242\tcodex\t0\n' ;;
          *) printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*)              case "$target" in codex-pane) echo '%601' ;; legacy-pane) echo '%602' ;; sender-pane) echo '%603' ;; dead-pane) echo '' ;; *) echo '%699' ;; esac ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; printf '%s' "${1:-}" > "$state/last-sentinel"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"

new_repo() { git init -q "$1"; git -C "$1" config user.email t@example.invalid; git -C "$1" config user.name t; touch "$1/r"; git -C "$1" add r; git -C "$1" commit -q -m i; }

# RemoteTeam on the post-flip layout, enrolled via `tap init` (born-live: the
# enrollment lands in global-registry.json and the retired teams.json is never
# created). The team's seat lives in the post-flip store the index's
# registry_location points at.
new_repo "$WORK/RemoteTeam"
( cd "$WORK/RemoteTeam" && env -u TAP_HOME "$TAP" init >/dev/null )
cat > "$WORK/RemoteTeam/.tap/team-registry.json" <<'JSON'
{ "schema": "0.20",
  "team": { "name": "RemoteTeam" },
  "seats": { "codex": { "session": "RemoteTeam/codex", "pane": "codex-pane", "pane_id": "%601", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" } } }
JSON
grep -q '"RemoteTeam"' "$TAP_INDEX_HOME/global-registry.json" || { echo "machine-index: init did not enroll RemoteTeam in the global registry" >&2; cat "$TAP_INDEX_HOME/global-registry.json" >&2; exit 1; }
[ ! -f "$TAP_INDEX_HOME/teams.json" ] || { echo "machine-index: born-live init created the retired teams.json" >&2; exit 1; }
echo "machine-index: tap init enrolls the team in the machine's global registry (born-live; retired teams.json not created): ok"

# LegacyRemote on the legacy tmp/tap layout, enrolled by hand into the global
# registry (root + registry_location pointing at the legacy team registry file).
new_repo "$WORK/LegacyRemote"
mkdir -p "$WORK/LegacyRemote/tmp/tap"
cat > "$WORK/LegacyRemote/tmp/tap/registry.json" <<'JSON'
{"schema": "0.20",  "team": { "name": "LegacyRemote" },
  "seats": { "codex": { "session": "LegacyRemote/codex", "pane": "legacy-pane", "pane_id": "%602", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" } } }
JSON
python3 - "$TAP_INDEX_HOME/global-registry.json" "$WORK/LegacyRemote" <<'PY'
import json, sys, datetime
idx, root = sys.argv[1:3]
d = json.load(open(idx)); d.setdefault("teams", {})["LegacyRemote"] = {"root": root, "state": "registered", "registry_location": root + "/tmp/tap/registry.json", "enrolled_at": "x"}
json.dump(d, open(idx, "w"), indent=2, sort_keys=True)
PY

# AE5: from an UNRELATED cwd, a team-qualified send resolves via the index.
# Request a direct attempt: default settle-only notes correctly park on this
# sender bus under spool/, while this arm inspects the delivered canonical.
new_repo "$WORK/Unrelated"
( cd "$WORK/Unrelated" && env -u TAP_HOME "$TAP" init >/dev/null )
cat > "$WORK/Unrelated/.tap/team-registry.json" <<'JSON'
{ "schema": "0.20",
  "team": { "name": "Unrelated" },
  "seats": { "claude": { "session": "Unrelated/claude", "pane": "sender-pane", "pane_id": "%603", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" } } }
JSON
( cd "$WORK/Unrelated" && env -u TAP_HOME "$TAP" send RemoteTeam/codex --no-spool -m "ping" --from claude --id mi-1 >"$WORK/s1.out" 2>&1 ) \
  || { echo "machine-index: index-resolved send failed" >&2; cat "$WORK/s1.out" >&2; exit 1; }
[ -f "$WORK/Unrelated/.tap/bus/payloads/mi-1.md" ] || { echo "machine-index: canonical not on sender bus" >&2; exit 1; }
# v0.23 (tap-7r3fn.8): `to=` left the wire. Cross-team addressing now rides the ID
# SLOT as a `<team>/` prefix -- and the prefix is the SENDER's team, a bus locator,
# not the recipient's. So what this arm can still observe is that the send resolved
# the remote team at all, which is what it was really about: the ENVELOPE's
# `to_team` is where the resolved recipient team lives now.
grep -q '^to_team: RemoteTeam$' "$WORK/Unrelated/.tap/bus/payloads/mi-1.md" || { echo "machine-index: send did not resolve the recipient team RemoteTeam into the envelope" >&2; cat "$WORK/Unrelated/.tap/bus/payloads/mi-1.md" >&2; exit 1; }
echo "machine-index: (AE5) team-qualified send resolves an indexed team from any cwd: ok"

# An indexed legacy-only bus refuses without placement or a fresh bus.
if ( cd "$WORK/Unrelated" && env -u TAP_HOME "$TAP" send LegacyRemote/codex --no-spool -m "ping" --from claude --id mi-2 >"$WORK/s2.out" 2>&1 ); then
  echo "machine-index: legacy-layout indexed send must refuse" >&2; exit 1
fi
grep -q 'old TAP bus location' "$WORK/s2.out" || { cat "$WORK/s2.out" >&2; exit 1; }
[ ! -e "$WORK/Unrelated/.tap/bus/payloads/mi-2.md" ] || exit 1
[ ! -d "$WORK/LegacyRemote/.tap/bus" ] || exit 1
echo "machine-index: (R14) legacy-only remote refuses before effects: ok"

# AE5 (deleted-root half, post-flip contract): the entry is NOT pruned on read —
# de-enrollment is explicit — and the send refuses loud, naming the unreachable
# registry_location and the tap admin refresh recovery door.
rm -rf "$WORK/RemoteTeam"
rc=0; ( cd "$WORK/Unrelated" && env -u TAP_HOME "$TAP" send RemoteTeam/codex --no-spool -m "ping" --from claude --id mi-3 >"$WORK/s3.out" 2>&1 ) || rc=$?
[ "$rc" != 0 ] || { echo "machine-index: send to a deleted-root team should fail" >&2; exit 1; }
grep -q 'acting registry file is gone' "$WORK/s3.out" || { echo "machine-index: failure should name the unreachable registry_location" >&2; cat "$WORK/s3.out" >&2; exit 1; }
grep -q 'tap admin refresh' "$WORK/s3.out" || { echo "machine-index: failure should name the tap admin refresh recovery door" >&2; cat "$WORK/s3.out" >&2; exit 1; }
# The stale entry persists as REGISTERED with its registry_location intact —
# a historical or vanished row would not be the persistence this arm pins.
python3 - "$TAP_INDEX_HOME/global-registry.json" "$WORK/RemoteTeam/.tap/team-registry.json" <<'PY'
import json, os, sys
idx, loc = sys.argv[1:3]
d = json.load(open(idx))
entry = d.get("teams", {}).get("RemoteTeam")
assert isinstance(entry, dict), entry
assert entry.get("state") == "registered", entry
assert entry.get("registry_location") == os.path.realpath(loc), (entry.get("registry_location"), os.path.realpath(loc))
PY
echo "machine-index: (AE5) deleted root: send refuses loud naming the unreachable registry_location and the tap doctor door; entry persists registered pending explicit de-enrollment: ok"

echo "machine-index: ok"
