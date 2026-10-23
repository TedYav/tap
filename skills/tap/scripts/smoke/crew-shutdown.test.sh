#!/usr/bin/env bash
# Refuse source before changing the caller's shell options or environment.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# tap-yih6n.1: `tap crew shutdown` stops exactly the recorded crew pane of one crew
# seat or of one owner's crew — never a sibling pane, another server's pane, or a
# session's last pane; up/down refuse.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMUX_TMPDIR:?run through smoke-all --only}/crew-shutdown.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
REAL_TMUX="$(command -v tmux)"
SOCKET="$WORK/tmux.sock"
cleanup() {
  "$REAL_TMUX" -S "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
fail() { echo "crew-shutdown: $*" >&2; exit 1; }
mkdir -p "$WORK/bin" "$WORK/Demo/.tap/bus" "$WORK/Other/.tap/bus" "$WORK/index"
unset TAP_HOME
export TAP_INDEX_HOME="$WORK/index" REAL_TMUX SOCKET
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
if [ "${1:-}" = -S ]; then [ "$2" = "$SOCKET" ] || exit 99; shift 2; fi
exec "$REAL_TMUX" -S "$SOCKET" "$@"
TMUX
# The runner is outside tmux; bind only the caller-terminal probe to CALLER_TTY.
cat > "$WORK/bin/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *'ppid='*'tty='*) printf '1 %s\n' "${CALLER_TTY#/dev/}" ;;
  *) exec /bin/ps "$@" ;;
esac
PS
chmod +x "$WORK/bin/tmux" "$WORK/bin/ps"
export PATH="$WORK/bin:$PATH"
T() { "$REAL_TMUX" -S "$SOCKET" "$@"; }
git -C "$WORK/Demo" init -q
git -C "$WORK/Other" init -q

# Sessions: lead owns crew-a/crew-b (own windows) and crew-e (split into lead's
# window); solo owns crew-c; shared holds two owners and crew-d; lone holds only crew-f.
T new-session -d -s Demo/lead -c "$WORK/Demo"
T new-window -d -t Demo/lead -n crew-a
T new-window -d -t Demo/lead -n crew-b
T split-window -d -t Demo/lead:0
# An unregistered spare window keeps the owner window from also being the last one.
T new-window -d -t Demo/lead -n spare
T new-session -d -s Demo/solo -c "$WORK/Demo"
T new-window -d -t Demo/solo -n crew-c
T new-session -d -s Demo/foreign -c "$WORK/Demo"
T new-window -d -t Demo/foreign -n spare
T new-session -d -s Demo/shared -c "$WORK/Demo"
T new-window -d -t Demo/shared -n owner2
T new-window -d -t Demo/shared -n crew-d
T new-session -d -s Demo/lone -c "$WORK/Demo"
pane() { T display-message -p -t "$1" '#{pane_id}'; }
export TMUX="$SOCKET,0,0"
LEAD="$(pane Demo/lead:0.0)"; export TMUX_PANE="$LEAD"
# Rows carry this private server's generation, as register writes them (tap-zk1w).
export EPOCH="srv:$(T display-message -p '#{pid}:#{start_time}')"
python3 - "$WORK" \
  "lead=$LEAD=Demo/lead" "crew-a=$(pane Demo/lead:1.0)=Demo/lead=crew" "crew-b=$(pane Demo/lead:2.0)=Demo/lead=crew" \
  "crew-e=$(pane Demo/lead:0.1)=Demo/lead=crew" "solo=$(pane Demo/solo:0.0)=Demo/solo" "crew-c=$(pane Demo/solo:1.0)=Demo/solo=crew" "crew-s=$(pane Demo/foreign:0.0)=Demo/foreign=crew=/nonexistent/other.sock" \
  "owner1=$(pane Demo/shared:0.0)=Demo/shared" "owner2=$(pane Demo/shared:1.0)=Demo/shared" "crew-d=$(pane Demo/shared:2.0)=Demo/shared=crew" \
  "crew-f=$(pane Demo/lone:0.0)=Demo/lone=crew" <<'PY'
import json, os, pathlib, sys
w = pathlib.Path(sys.argv[1]); seats = {}
for spec in sys.argv[2:]:
    handle, pane_id, session, *crew = spec.split("=")
    seats[handle] = {"status": "active", "delivery": "pane", "harness": "codex", "pane_id": pane_id,
                     "pane": f"{session}:0.0", "session": session, "registered_at": "t", "server_epoch": os.environ["EPOCH"],
                     **({"crew": True} if crew else {}),
                     **({"server_socket": crew[1]} if len(crew) > 1 else {})}
# Named removal must remain a repair even when a durable owner link is wrong.
seats['crew-a'].update(crew_owner='does-not-exist', crew_owner_instance='stale-instance')
def team(name, rows):
    reg = w / name / ".tap/team-registry.json"
    reg.write_text(json.dumps({"schema": "0.20", "team": {"name": name}, "seats": rows}))
    return {"root": str(w / name), "registry_location": str(reg), "state": "registered", "enrolled_at": "t"}
(w / "index/global-registry.json").write_text(json.dumps({"schema": "0.20", "teams": {
    "Demo": team("Demo", seats), "Other": team("Other", {})}}))
PY
REG="$WORK/Demo/.tap/team-registry.json"
has() { python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1]))["seats"] else 1)' "$REG" "$1"; }
alive() { [ "$(T display-message -p -t "$1" '#{pane_id}' 2>/dev/null)" = "$1" ]; }
tty_of() { T display-message -p -t "$1" '#{pane_tty}'; }
tap() { bash "$ROOT/scripts/tap.sh" "$@"; }
run() { rc=0; out="$( "$@" 2>&1 )" || rc=$?; }
row_pane() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["seats"][sys.argv[2]]["pane_id"])' "$REG" "$1"; }
CA="$(row_pane crew-a)"; CB="$(row_pane crew-b)"; CC="$(row_pane crew-c)"; CD="$(row_pane crew-d)"; CE="$(row_pane crew-e)"; CF="$(row_pane crew-f)"; CS="$(row_pane crew-s)"
cd "$WORK/Demo"

# up/down do not exist: crew rows exist only while live.
for sub in up down; do
  cp "$REG" "$WORK/before"
  run tap crew "$sub"
  [ "$rc" != 0 ] && grep -q "tap crew $sub does not exist" <<<"$out" || fail "crew $sub did not refuse: $out"
  cmp -s "$WORK/before" "$REG" || fail "crew $sub mutated the registry"
done
echo "crew-shutdown: up/down refuse without effect: ok"

# Owner inference needs a uniquely attributable caller pane.
export CALLER_TTY=/dev/ttys-none
run tap crew shutdown
[ "$rc" != 0 ] && grep -q "cannot identify crew owner; pass the crew owner explicitly" <<<"$out" || fail "unattributable caller not refused: $out"
has crew-a && has crew-b || fail "unattributable refusal removed crew"
echo "crew-shutdown: unattributable owner inference refuses: ok"

# A crew seat cannot shut itself down, nor stand in as an inferred owner.
CALLER_TTY="$(tty_of "$CD")"
run tap crew shutdown
[ "$rc" != 0 ] && grep -q "is a crew seat" <<<"$out" && has crew-d || fail "crew caller inferred as owner: $out"
run tap crew shutdown crew-d
[ "$rc" != 0 ] && grep -q "calling pane" <<<"$out" && has crew-d && alive "$CD" || fail "self-target not refused: $out"
echo "crew-shutdown: self-target refuses: ok"

# One crew seat: exactly its pane goes; siblings and the owner stay.
CALLER_TTY="$(tty_of "$LEAD")"
run tap crew shutdown crew-a
[ "$rc" = 0 ] || fail "one-crew shutdown failed: $out"
! has crew-a && ! alive "$CA" || fail "crew-a row or window survived: $out"
has crew-b && alive "$CB" && alive "$LEAD" && has lead || fail "one-crew shutdown touched another seat"
echo "crew-shutdown: one crew seat, exact pane: ok"

# `remove` is the one-crew alias: it refuses a durable owner.
run tap crew remove lead
[ "$rc" != 0 ] && grep -q "not a crew member" <<<"$out" && alive "$CB" || fail "remove accepted an owner: $out"
echo "crew-shutdown: remove alias stays crew-only: ok"

# Two owners in one session: never guess whose crew it is.
run tap crew shutdown --owner owner1
[ "$rc" != 0 ] && grep -q "crew_owner_ambiguous\|ownership is ambiguous" <<<"$out" && has crew-d && alive "$CD" || fail "ambiguous owner not refused: $out"
echo "crew-shutdown: two-owner session refuses: ok"

# A bare owner resolves in the current-folder team only; the qualified form
# reaches another team from here.
cd "$WORK/Other"
run tap crew shutdown --owner solo
[ "$rc" != 0 ] && has crew-c && alive "$CC" || fail "bare owner scanned another team: $out"
run tap crew shutdown --owner Demo/solo
[ "$rc" = 0 ] && ! has crew-c && ! alive "$CC" && alive "$(row_pane solo)" || fail "team-qualified owner failed: $out"
echo "crew-shutdown: bare owner stays in the cwd team; team/handle wins: ok"
cd "$WORK/Demo"

# tap-zk1w: an unstamped owner row names no pane on this server, so owner
# inference refuses rather than trusting pane-id agreement.
cp "$REG" "$WORK/stamped"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["seats"]["lead"].pop("server_epoch"); json.dump(d, open(sys.argv[1], "w"))' "$REG"
run tap crew shutdown
[ "$rc" != 0 ] && grep -q "cannot identify crew owner" <<<"$out" && has crew-b && alive "$CB" || fail "unstamped owner inferred: $out"
cp "$WORK/stamped" "$REG"
echo "crew-shutdown: unstamped owner is not inferred: ok"

# Inferred owner: lead's whole crew. crew-e is split into lead's window: only
# its own pane stops, the owner's pane survives.
run tap crew shutdown
[ "$rc" = 0 ] || fail "inferred owner shutdown failed: $out"
! has crew-b && ! alive "$CB" && ! has crew-e || fail "inferred owner left crew: $out"
! alive "$CE" || fail "split crew pane survived: $out"
alive "$LEAD" && has lead || fail "owner pane was killed: $out"
has crew-d && has crew-f || fail "inferred owner reached another session's crew"
echo "crew-shutdown: inferred owner's crew, owner pane kept: ok"

# A row recorded on another tmux server names another server's pane: never stop it.
run tap crew shutdown crew-s
[ "$rc" = 0 ] && ! has crew-s && alive "$CS" && grep -q "row is on tmux server /nonexistent/other.sock" <<<"$out" || fail "foreign-server pane touched: $out"
echo "crew-shutdown: another server's pane id is never stopped: ok"

# A crew window that is its session's last window is never killed.
run tap crew shutdown crew-f
[ "$rc" = 0 ] && ! has crew-f && alive "$CF" && grep -q "last in session" <<<"$out" || fail "last-window guard failed: $out"
T has-session -t Demo/lone || fail "crew shutdown ended a session"
echo "crew-shutdown: last-window guard keeps the session: ok"
