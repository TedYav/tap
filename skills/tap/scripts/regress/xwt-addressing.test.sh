#!/usr/bin/env bash
# xwt-addressing.test.sh — U3: team-qualified cross-worktree addressing.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK_ROOT="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK_ROOT" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK_ROOT/index"   # never touch real ~/.tap (team-qualified sends read the index)

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
target=""
fmt=""
case "$cmd" in
  # CONTRACT §Session-name authority: cross-worktree pane delivery requires a
  # current exact session, designated numeric pane id, generation, and harness.
  list-sessions)
    printf 'SenderTeam/claude\t123:456\nSenderTeam/local\t123:456\nRemoteTeam/codex\t123:456\nDotbusTeam/codex\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      SenderTeam/claude) printf 'SenderTeam/claude\tsender-pane\t%%701\tcodex\t4242\t123:456\t0\n' ;;
      SenderTeam/local) printf 'SenderTeam/local\tlocal-pane\t%%702\tcodex\t4242\t123:456\t0\n' ;;
      RemoteTeam/codex) printf 'RemoteTeam/codex\tremote-pane\t%%703\tcodex\t4242\t123:456\t0\n' ;;
      DotbusTeam/codex) printf 'DotbusTeam/codex\tdotbus-pane\t%%704\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    case "$fmt" in
      '#{pid}:#{start_time}') echo "123:456" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          SenderTeam/claude|sender-pane|%701) printf '%%701\tSenderTeam/claude\t4242\tcodex\t0\n' ;;
          SenderTeam/local|local-pane|%702)   printf '%%702\tSenderTeam/local\t4242\tcodex\t0\n' ;;
          RemoteTeam/codex|remote-pane|%703)  printf '%%703\tRemoteTeam/codex\t4242\tcodex\t0\n' ;;
          DotbusTeam/codex|dotbus-pane|%704)  printf '%%704\tDotbusTeam/codex\t4242\tcodex\t0\n' ;;
          dead-pane|%705)                     printf '\t\t\t\t\n' ;;
          *)                                  printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*)              case "$target" in sender-pane) echo '%701' ;; local-pane) echo '%702' ;; remote-pane) echo '%703' ;; dotbus-pane) echo '%704' ;; dead-pane) echo '' ;; *) echo '%799' ;; esac ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/last-sentinel"
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"

SENDER="$WORK_ROOT/SenderTeam"
REMOTE="$WORK_ROOT/RemoteTeam"
NO_REGISTRY="$WORK_ROOT/NoRegistry"
OTHER_REPO="$WORK_ROOT/OtherRepo"
git init -q "$SENDER"
git -C "$SENDER" config user.email tap@example.invalid
git -C "$SENDER" config user.name "TAP Smoke"
touch "$SENDER/README.md"
git -C "$SENDER" add README.md
git -C "$SENDER" commit -q -m init
git -C "$SENDER" worktree add -q "$REMOTE" -b remote-team
git -C "$SENDER" worktree add -q "$NO_REGISTRY" -b no-registry
DOTBUS="$WORK_ROOT/DotbusTeam"
git -C "$SENDER" worktree add -q "$DOTBUS" -b dotbus-team
git init -q "$OTHER_REPO"

mkdir -p "$SENDER/.tap/bus" "$REMOTE/.tap/bus"
cat > "$SENDER/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "SenderTeam" },
  "seats": {
    "claude": { "session": "SenderTeam/claude", "pane": "sender-pane", "pane_id": "%701", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" },
    "local": { "session": "SenderTeam/local", "pane": "local-pane", "pane_id": "%702", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" }
  }
}
JSON
cat > "$REMOTE/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "RemoteTeam" },
  "seats": {
    "codex": { "session": "RemoteTeam/codex", "pane": "remote-pane", "pane_id": "%703", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" },
    "dead": { "session": "RemoteTeam/dead", "pane": "dead-pane", "pane_id": "%705", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" }
  }
}
JSON
# U2: a remote on the v0.3 .tap/bus layout resolves via the canonical root-derived bus.
mkdir -p "$DOTBUS/.tap/bus"
cat > "$DOTBUS/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "DotbusTeam" },
  "seats": {
    "codex": { "session": "DotbusTeam/codex", "pane": "dotbus-pane", "pane_id": "%704", "server_epoch": "srv:123:456", "harness": "codex", "status": "active" }
  }
}
JSON

. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
tap_smoke_enroll_current "$SENDER" "$SENDER/.tap/bus" SenderTeam
tap_smoke_enroll_current "$REMOTE" "$REMOTE/.tap/bus" RemoteTeam
tap_smoke_enroll_current "$DOTBUS" "$DOTBUS/.tap/bus" DotbusTeam
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$NO_REGISTRY" <<'PYINDEX'
import json, sys
path, root = sys.argv[1:]
doc = json.load(open(path))
doc["teams"]["NoRegistry"] = {"root": root, "registry_location": root + "/.tap/team-registry.json", "state": "registered"}
with open(path, "w") as fh: json.dump(doc, fh)
PYINDEX

export FAKE_TMUX_STATE="$SENDER/tmp/fake-tmux"

# These routing controls request direct attempts; default notes intentionally
# queue on the sender bus and cannot supply an immediate delivered canonical.
if ! (
  cd "$SENDER"
  "$TAP" send RemoteTeam/codex -m "hello remote" --from claude --kind discuss --id xwt-addressed --no-spool \
    >"$SENDER/send.out" 2>&1
); then
  echo "xwt-addressing: team-qualified remote send failed" >&2
  cat "$SENDER/send.out" >&2
  exit 1
fi

CANON="$SENDER/.tap/bus/payloads/xwt-addressed.md"
[ -f "$CANON" ] || { echo "xwt-addressing: canonical payload missing on sender bus" >&2; cat "$SENDER/send.out" >&2; exit 1; }
grep -q '^to: codex$' "$CANON" || { echo "xwt-addressing: canonical to field should stay handle-local" >&2; cat "$CANON" >&2; exit 1; }
grep -q '^from_team: SenderTeam$' "$CANON" || { echo "xwt-addressing: from_team not stamped" >&2; cat "$CANON" >&2; exit 1; }
grep -q '^to_team: RemoteTeam$' "$CANON" || { echo "xwt-addressing: to_team not stamped (tap-yv3)" >&2; cat "$CANON" >&2; exit 1; }
grep -q '^cross_worktree: true$' "$CANON" || { echo "xwt-addressing: cross_worktree not stamped" >&2; cat "$CANON" >&2; exit 1; }
[ ! -d "$REMOTE/.tap/bus/payloads" ] || [ -z "$(ls -A "$REMOTE/.tap/bus/payloads" 2>/dev/null)" ] || {
  echo "xwt-addressing: remote bus should not receive sender payloads" >&2; exit 1
}
# v0.23 (tap-7r3fn.8) INVERTED THIS ARM, and the inversion is the point rather than
# a substitution. NamingWave put the team on the sentinel's `from=`/`to=` keys and
# said "id stays unqualified"; §13 deletes both keys and moves the team ONTO the id
# slot as a `<team>/` prefix. So the assertion that used to read "id is bare" now
# reads "id carries the SENDER's team" -- and only the sender's, because the prefix
# is a BUS LOCATOR (the canonical lives on the sender's bus, asserted above) rather
# than a label naming the recipient.
#
# The envelope is untouched and is still asserted above: `to: codex` handle-local,
# with from_team/to_team as the structured equivalent. That split is the whole
# design -- the wire got shorter, the record did not.
grep -qE '^\[\[TAP v[0-9.]+ (ask|note) SenderTeam/xwt-addressed( |\]\])' "$FAKE_TMUX_STATE/last-sentinel" || { echo "xwt-addressing: cross-team sentinel id slot should carry the SENDER team prefix" >&2; cat "$FAKE_TMUX_STATE/last-sentinel" >&2; exit 1; }
grep -q 'RemoteTeam/' "$FAKE_TMUX_STATE/last-sentinel" && { echo "xwt-addressing: the recipient team must NOT appear on the wire — the prefix is a sender-bus locator" >&2; cat "$FAKE_TMUX_STATE/last-sentinel" >&2; exit 1; }
CANON_PHYSICAL="$(cd "$(dirname "$CANON")" && pwd -P)/$(basename "$CANON")"
grep -Fxq "path: $CANON_PHYSICAL" "$CANON" || {
  echo "xwt-addressing: canonical path should point at sender bus" >&2; cat "$FAKE_TMUX_STATE/last-sentinel" >&2; exit 1
}
echo "xwt-addressing: team-qualified remote send: ok"

if ! (
  cd "$OTHER_REPO"
  TAP_HOME="$SENDER/.tap/bus" "$TAP" send RemoteTeam/codex -m "hello remote from elsewhere" --from claude --kind discuss --id xwt-addressed-other-cwd --no-spool \
    >"$SENDER/send-other-cwd.out" 2>&1
); then
  echo "xwt-addressing: team-qualified send should resolve worktrees from TAP_HOME repo, not cwd" >&2
  cat "$SENDER/send-other-cwd.out" >&2
  exit 1
fi
echo "xwt-addressing: team-qualified remote send ignores unrelated cwd repo: ok"

# A remote whose bus is the v0.3 .tap/bus layout resolves via the canonical root-derived bus
# (U2). If the probe only checked .tap/bus this send would fail "no TAP registry".
if ! (
  cd "$SENDER"
  "$TAP" send DotbusTeam/codex -m "hello dotbus" --from claude --kind discuss --id xwt-dotbus --no-spool \
    >"$SENDER/dotbus.out" 2>&1
); then
  echo "xwt-addressing: team-qualified send to a .tap/bus remote failed" >&2
  cat "$SENDER/dotbus.out" >&2
  exit 1
fi
[ -f "$SENDER/.tap/bus/payloads/xwt-dotbus.md" ] || { echo "xwt-addressing: .tap/bus remote send left no canonical on sender bus" >&2; exit 1; }
# Same inversion: the wire names the SENDER's bus, not the recipient's team. That
# the send resolved DotbusTeam at all is an envelope fact now.
grep -qE '^\[\[TAP v[0-9.]+ (ask|note) SenderTeam/xwt-dotbus( |\]\])' "$FAKE_TMUX_STATE/last-sentinel" || { echo "xwt-addressing: .tap/bus remote sentinel id slot should carry the SenderTeam prefix" >&2; cat "$FAKE_TMUX_STATE/last-sentinel" >&2; exit 1; }
grep -q '^to_team: DotbusTeam$' "$SENDER/.tap/bus/payloads/xwt-dotbus.md" || { echo "xwt-addressing: .tap/bus remote send did not resolve DotbusTeam into the envelope" >&2; cat "$SENDER/.tap/bus/payloads/xwt-dotbus.md" >&2; exit 1; }
echo "xwt-addressing: team-qualified send resolves a .tap/bus remote: ok"

(
  cd "$SENDER"
  "$TAP" send SenderTeam/local -m "hello local" --from claude --kind discuss --id xwt-local --no-spool \
    >"$SENDER/local.out" 2>&1
)
LOCAL_CANON="$SENDER/.tap/bus/payloads/xwt-local.md"
[ -f "$LOCAL_CANON" ] || { echo "xwt-addressing: local team-qualified send failed" >&2; cat "$SENDER/local.out" >&2; exit 1; }
! grep -q '^cross_worktree:' "$LOCAL_CANON" || { echo "xwt-addressing: local team send should not stamp cross_worktree" >&2; cat "$LOCAL_CANON" >&2; exit 1; }
! grep -q '^from_team:' "$LOCAL_CANON" || { echo "xwt-addressing: local team send should not stamp from_team" >&2; cat "$LOCAL_CANON" >&2; exit 1; }
! grep -q '^to_team:' "$LOCAL_CANON" || { echo "xwt-addressing: local team send should not stamp to_team (tap-yv3)" >&2; cat "$LOCAL_CANON" >&2; exit 1; }
# tap-yv3's property SURVIVES v0.23, restated in the new grammar: a same-team send
# takes no team qualification anywhere on the wire. What changed is where the
# absence is visible -- there are no `from=`/`to=` keys to be bare, so the observable
# is a BARE ID SLOT with no `<team>/` prefix. The old wording ("byte-identical to
# pre-v0.4 output") is retired with the keys it described; the invariant it was
# protecting is not.
grep -qE '^\[\[TAP v[0-9.]+ (ask|note) xwt-local( |\]\])' "$FAKE_TMUX_STATE/last-sentinel" || { echo "xwt-addressing: same-team sentinel id slot should be bare — no team prefix (tap-yv3)" >&2; cat "$FAKE_TMUX_STATE/last-sentinel" >&2; exit 1; }
echo "xwt-addressing: local team-qualified send stays local: ok"

# codex P1 (tap-yv3 review): from_team/to_team are courier-owned, same as the five
# routing fields — a writer-supplied copy in the SOURCE payload must never survive
# into the canonical. Plant a malicious source file and prove the courier always
# overwrites with its own resolution (never merges/trusts the writer's copy).
SPOOF_SRC="$SENDER/spoof-source.md"
cat > "$SPOOF_SRC" <<'EOF'
---
from_team: EvilFrom
to_team: EvilTo
---

spoofed provenance test
EOF

# (a) same-team send: courier's own resolution is "neither field" — the spoofed
# values must be dropped, not merely left unoverwritten.
(
  cd "$SENDER"
  "$TAP" send local "$SPOOF_SRC" --from claude --kind discuss --id xwt-spoof-same --no-spool \
    >"$SENDER/spoof-same.out" 2>&1
)
SPOOF_SAME_CANON="$SENDER/.tap/bus/payloads/xwt-spoof-same.md"
[ -f "$SPOOF_SAME_CANON" ] || { echo "xwt-addressing: spoof same-team send failed" >&2; cat "$SENDER/spoof-same.out" >&2; exit 1; }
! grep -q 'EvilFrom\|EvilTo' "$SPOOF_SAME_CANON" || { echo "xwt-addressing: same-team send let a writer-supplied from_team/to_team survive (spoofable)" >&2; cat "$SPOOF_SAME_CANON" >&2; exit 1; }
! grep -q '^from_team:\|^to_team:' "$SPOOF_SAME_CANON" || { echo "xwt-addressing: same-team send should stamp neither from_team nor to_team" >&2; cat "$SPOOF_SAME_CANON" >&2; exit 1; }
echo "xwt-addressing: same-team send drops a writer-supplied from_team/to_team (not spoofable): ok"

# (b) team-qualified remote send: the courier's REAL resolution (SenderTeam/
# RemoteTeam) must replace the spoofed values, never merge with or defer to them.
(
  cd "$SENDER"
  "$TAP" send RemoteTeam/codex "$SPOOF_SRC" --from claude --kind discuss --id xwt-spoof-remote --no-spool \
    >"$SENDER/spoof-remote.out" 2>&1
)
SPOOF_REMOTE_CANON="$SENDER/.tap/bus/payloads/xwt-spoof-remote.md"
[ -f "$SPOOF_REMOTE_CANON" ] || { echo "xwt-addressing: spoof remote send failed" >&2; cat "$SENDER/spoof-remote.out" >&2; exit 1; }
! grep -q 'EvilFrom\|EvilTo' "$SPOOF_REMOTE_CANON" || { echo "xwt-addressing: remote send let a writer-supplied from_team/to_team survive (spoofable)" >&2; cat "$SPOOF_REMOTE_CANON" >&2; exit 1; }
grep -q '^from_team: SenderTeam$' "$SPOOF_REMOTE_CANON" || { echo "xwt-addressing: remote send should stamp the REAL from_team (SenderTeam), got:" >&2; cat "$SPOOF_REMOTE_CANON" >&2; exit 1; }
grep -q '^to_team: RemoteTeam$' "$SPOOF_REMOTE_CANON" || { echo "xwt-addressing: remote send should stamp the REAL to_team (RemoteTeam), got:" >&2; cat "$SPOOF_REMOTE_CANON" >&2; exit 1; }
echo "xwt-addressing: team-qualified remote send overwrites spoofed from_team/to_team with the real resolution: ok"

python3 -B - "$SENDER/.tap/bus/registry.json" "$TAP_INDEX_HOME/global-registry.json" <<'PY'
import json
import sys
path = sys.argv[1]
reg = json.load(open(path))
reg["team"]["name"] = "Sender Team"
index = json.load(open(sys.argv[2]))
index["teams"]["Sender Team"] = index["teams"].pop("SenderTeam")
with open(sys.argv[2], "w") as fh: json.dump(index, fh)
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
# Registry protocol part-03 requires a valid local team even for a bare handle,
# before staging. Invalid identity must create neither a canonical nor input.
cp "$FAKE_TMUX_STATE/last-sentinel" "$SENDER/before-invalid-team"
if (
  cd "$SENDER"
  "$TAP" send local -m "plain local" --from claude --kind discuss --id xwt-plain-invalid-team --no-spool \
    >"$SENDER/plain-invalid-team.out" 2>&1
); then
  echo "xwt-addressing: plain local send should refuse an invalid local team token" >&2
  cat "$SENDER/plain-invalid-team.out" >&2
  exit 1
fi
grep -q "local team 'Sender Team' is not a valid token" "$SENDER/plain-invalid-team.out"
[ ! -f "$SENDER/.tap/bus/payloads/xwt-plain-invalid-team.md" ]
[ ! -f "$SENDER/.tap/bus/spool/xwt-plain-invalid-team.md" ]
cmp "$SENDER/before-invalid-team" "$FAKE_TMUX_STATE/last-sentinel"
python3 -B - "$SENDER/.tap/bus/registry.json" "$TAP_INDEX_HOME/global-registry.json" <<'PY'
import json
import sys
path = sys.argv[1]
reg = json.load(open(path))
reg["team"]["name"] = "SenderTeam"
index = json.load(open(sys.argv[2]))
index["teams"]["SenderTeam"] = index["teams"].pop("Sender Team")
with open(sys.argv[2], "w") as fh: json.dump(index, fh)
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
echo "xwt-addressing: plain local send refuses invalid local team token before effects: ok"

expect_fail() {
  local label="$1"; shift
  local output="$SENDER/${label}.out"
  if (cd "$SENDER" && "$TAP" "$@" >"$output" 2>&1); then
    echo "xwt-addressing: $label should have failed" >&2
    exit 1
  fi
  grep -q -- '--cross-worktree --pane' "$output" || {
    echo "xwt-addressing: $label did not name manual fallback" >&2
    cat "$output" >&2
    exit 1
  }
}

expect_fail missing-team send MissingTeam/codex -m body --from claude --id xwt-missing-team --no-spool
grep -q "unknown team 'MissingTeam'" "$SENDER/missing-team.out" || { cat "$SENDER/missing-team.out" >&2; exit 1; }
grep -q "not in the machine index" "$SENDER/missing-team.out" || { cat "$SENDER/missing-team.out" >&2; exit 1; }
echo "xwt-addressing: unknown team failure: ok"

if (cd "$SENDER" && "$TAP" send NoRegistry/codex -m body --from claude --id xwt-no-registry --no-spool >"$SENDER/no-registry.out" 2>&1); then
  echo "xwt-addressing: no-registry should have failed" >&2; exit 1
fi
grep -q "acting registry file is gone" "$SENDER/no-registry.out" || { cat "$SENDER/no-registry.out" >&2; exit 1; }
grep -q "tap admin refresh" "$SENDER/no-registry.out" || { cat "$SENDER/no-registry.out" >&2; exit 1; }
echo "xwt-addressing: missing registry failure: ok"

expect_fail unknown-handle send RemoteTeam/ghost -m body --from claude --id xwt-unknown-handle --no-spool
grep -q "unknown handle 'ghost' in team 'RemoteTeam'" "$SENDER/unknown-handle.out" || { cat "$SENDER/unknown-handle.out" >&2; exit 1; }
grep -q "codex, dead" "$SENDER/unknown-handle.out" || { cat "$SENDER/unknown-handle.out" >&2; exit 1; }
echo "xwt-addressing: unknown handle failure: ok"

expect_fail dead-pane send RemoteTeam/dead -m body --from claude --id xwt-dead-pane --no-spool
grep -q "pane 'dead-pane' for RemoteTeam/dead is not alive" "$SENDER/dead-pane.out" || { cat "$SENDER/dead-pane.out" >&2; exit 1; }
echo "xwt-addressing: dead pane failure: ok"

echo "xwt-addressing: ok"
