#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# health-differential.test.sh — `tap health` pinned byte-for-byte, so a runtime
# port is judged against what the verb says today rather than what a port
# author remembers it saying (tap-ip5ko, verifier built ahead of the port).
#
# Three instruments in one file, each proven able to fail before it is trusted:
#
#   DIFFERENTIAL  every named case runs `tap health` through the installed entry
#                 (bin/tap) in text and --json form; normalized stdout and the raw
#                 exit are diffed against fixtures/health-differential/<case>.*.
#                 Text usage and registry-invalid also pin normalized stderr
#                 (<case>.text.err). deleted-cwd stderr is asserted non-empty
#                 only — Bun vs Bash wording is not pinned.
#   ZERO-WRITE    a snapshot hash of the whole sandbox (path, mode, size,
#                 mtime_ns, ctime_ns, content) is taken around every call;
#                 health is read-only (T3) and must not materialize a bus, a
#                 registry, a seat-state cache, or anything else to answer.
#   JSON-CLEAN    on the --json route, stdout is exactly one line and that line
#                 parses, on every exit code — a classifier or parser failure may
#                 write to stderr but never dirties the machine-readable stream.
#
# The cases are the acceptance list: a live private-tmux census (generating
# pane, idle pane, pane gone, suspended seat, poll seat), wrong and ambient
# registry/bus selection, invalid and unreadable flip marker, invalid registry,
# deleted cwd, watcher armed-alive / armed-dead / paused / unreadable, sticky
# notify, an unreachable tmux server, a failing tmux on PATH, and usage errors.
#
# RECORDING. Fixtures are captured, never typed: `TAP_HEALTH_DIFF_RECORD=1 bash
# scripts/smoke-all.sh --only skills/tap/scripts/smoke/health-differential.test.sh`
# rewrites every fixture from the current runtime (runner-private tmux). A bare
# `TAP_HEALTH_DIFF_RECORD=1 bash <this file>` is the standalone recorder: this
# file then allocates a private TMUX_TMPDIR so new-session cannot reach the
# operator default server. The gate never sets RECORD. Re-record only under a
# named ruling that the user-visible text or JSON changed on purpose; a port
# that needs a re-record has changed behavior.
#
# tmux: the live census uses the DEFAULT server under TMUX_TMPDIR — that is the
# socket every bare `tmux` call inside lib.sh's classifier reaches. Under
# smoke-all, TAP_SUITE_SANDBOX is set and the runner already admitted a private
# TMUX_TMPDIR; keep it so the census shares that ephemeral server. Standalone
# (TAP_SUITE_SANDBOX unset) allocates its own TMUX_TMPDIR before new-session.
# Session names carry this pid; teardown kills only those sessions, and the
# standalone socket dir.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
FIX="$ROOT/skills/tap/scripts/smoke/fixtures/health-differential"
CENSUS="$ROOT/skills/tap/scripts/smoke/fixtures/census-false-idle-20260819"
PANES="$ROOT/skills/tap/scripts/smoke/fixtures/pane-state/claude"
RECORD="${TAP_HEALTH_DIFF_RECORD:-0}"
PY="${TAP_PYTHON:-python3}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-health-diff.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"   # health prints realpaths; normalize from one form
OUT="$(mktemp -d "${TMPDIR:-/tmp}/tap-health-diff-out.XXXXXX")"   # captures live OUTSIDE the hashed sandbox
# Every state root a verb could write through lives UNDER the hashed sandbox, so the
# zero-write instrument sees a write to HOME, the machine index, the session manifest,
# the opencode db, the version-seen stamp, or XDG config — not only the team dirs.
# sandbox-pins.sh already pinned these to private paths; overriding after sourcing is
# its documented opt-in. They are this test's OWN roots (under smoke-all the runner's
# HOME/index are shared by every worker in the run, so hashing those would flake).
# TMUX_TMPDIR is not relocated under WORK: under smoke-all the census needs the
# runner's server. Standalone (no TAP_SUITE_SANDBOX) allocates a private one
# below, after fail() exists, so a missing pin cannot reach the operator default.
export HOME="$WORK/home" TAP_INDEX_HOME="$WORK/index" TAP_SESSION_MANIFEST="$WORK/state/sessions.json" \
       OPENCODE_DB_PATH="$WORK/state/opencode.db" TAP_VERSION_SEEN_PATH="$WORK/state/version-seen.json" \
       XDG_CONFIG_HOME="$WORK/xdg"
mkdir -p "$HOME" "$TAP_INDEX_HOME" "$WORK/state" "$XDG_CONFIG_HOME"
# Bun's runtime transpiler cache is the one write inside the hashed sandbox that is
# not the verb's. bin/tap enters through the Bun router (health answers there natively
# since tap-diagnostics-u1), and on a cold cache that FIRST call
# materializes ~30 .pile files at $HOME/Library/Caches/bun — which is under WORK
# because HOME is relocated there, so the zero-write instrument saw the interpreter
# and reported the verb (ZERO-WRITE census/text, on every macOS gate run). Redirect
# it beside the other captures, OUTSIDE the hashed sandbox, exactly as OUT already
# holds this file's own output. Nothing is excluded from the snapshot: every TAP
# state root above, HOME included, stays hashed byte-for-byte and metadata-for-
# metadata. The redirect is asserted after the first case, not assumed.
BUN_CACHE="$OUT/bun-cache"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="$BUN_CACHE"
mkdir -p "$BUN_CACHE"
S="hd$$"                          # session-name prefix; unique on a shared server
WATCH_PID=""
_hd_tmux=""
_hd_socket=""
_no_server=""
cleanup() {
  if [ -n "$_hd_socket" ]; then
    tmux -S "$_hd_socket" kill-session -t "${S}gen" 2>/dev/null || true
    tmux -S "$_hd_socket" kill-session -t "${S}idle" 2>/dev/null || true
  fi
  [ -z "$WATCH_PID" ] || kill "$WATCH_PID" 2>/dev/null || true
  if [ -n "${_hd_tmux:-}" ]; then
    # Only the standalone private server. Never kill-server under smoke-all.
    tmux -S "$_hd_socket" kill-server 2>/dev/null || true
    rm -rf "$_hd_tmux"
  fi
  [ -z "$_no_server" ] || rm -rf "$_no_server"
  rm -rf "$WORK" "$OUT"
}
trap cleanup EXIT
fail() { echo "health-differential: $*" >&2; exit 1; }

# Standalone recorder (TAP_SUITE_SANDBOX unset): sandbox-pins.sh unsets TMUX
# but does not create a private default socket. Allocate one so new-session
# and the EXIT kill-server cannot reach the operator default server. Under
# smoke-all, keep the runner's admitted TMUX_TMPDIR.
if [ -z "${TAP_SUITE_SANDBOX:-}" ]; then
  _hd_tmux="$(mktemp -d "${TMPDIR:-/tmp}/hd-tmux.XXXXXX")"
  export TMUX_TMPDIR="$_hd_tmux"
fi
[ -n "${TMUX_TMPDIR:-}" ] || fail "TMUX_TMPDIR unset — census new-session would use the operator default server"
_hd_socket="$TMUX_TMPDIR/tmux-$(id -u)/default"

# bin/tap prefers Bun when one is on PATH; the runner strips ~/.bun/bin from
# PATH and hands the binary over as TAP_SMOKE_BUN instead. Append its directory
# so the gate drives that entry while retaining the runner's tmux guard first.
. "$ROOT/skills/tap/scripts/smoke/health-fixture-env.sh"
health_fixture_path

# Deterministic rendering: fixed clock, fixed width, no styling, UTC mtimes.
export TAP_WATCH_NOW=1788220890      # 2026-09-01T00:01:30Z (date -u -j -f %Y-%m-%dT%H:%M:%SZ); payload mtimes sit 90s earlier
# COLUMNS is wide on purpose: at 80 the unsettled-payloads table truncates the path
# column to a prefix of the temp root ("/priva..." on macOS, "/tmp/t..." on Linux)
# BEFORE normalization can see the full path, which would make the fixtures
# host-dependent. At 400 the path renders whole and normalizes to <WORK>.
export COLUMNS=400 TERM=dumb NO_COLOR=1
export TAP_BUN_ROUTE_TRACE="$OUT/route.trace"

# --- sandbox --------------------------------------------------------------------------
# Identity is set per call: under the runner HOME is empty, so nothing is inherited.
mk_repo() { git init -q "$1"; git -C "$1" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m i; }
mk_team() { mk_repo "$1"; mkdir -p "$1/.tap/bus/payloads" "$1/.tap/bus/receipts" "$1/.tap/bus/watch"; }
write_registry() {  # <team-dir> <team-name> <seats-json>
  "$PY" -B - "$1" "$2" "$3" <<'PY'
import json, pathlib, sys
team, name, seats = pathlib.Path(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3])
reg = team / ".tap" / "team-registry.json"
reg.write_text(json.dumps({
    "schema": "0.20",
    "team": {"name": name, "worktree_root": str(team)},
    "seats": seats,
}, sort_keys=True) + "\n")
PY
}
write_index() {  # <name=root>...
  "$PY" -B - "$TAP_INDEX_HOME" "$@" <<'PY'
import json, pathlib, sys
idx = pathlib.Path(sys.argv[1]); idx.mkdir(parents=True, exist_ok=True)
teams = {}
for spec in sys.argv[2:]:
    name, root = spec.split("=", 1)
    teams[name] = {"root": root, "registry_location": root + "/.tap/team-registry.json"}
(idx / "global-registry.json").write_text(json.dumps({"schema": "0.20", "teams": teams}) + "\n")
PY
}
payload() {  # <bus> <id> <from> <to> <kind> [extra-frontmatter-line]...
  local bus="$1" id="$2" from="$3" to="$4" kind="$5"; shift 5
  { printf -- '---\nid: %s\nfrom: %s\nto: %s\nkind: %s\n' "$id" "$from" "$to" "$kind"
    for line in "$@"; do printf '%s\n' "$line"; done
    printf -- '---\nbody\n'; } > "$bus/payloads/$id.md"
}

A="$WORK/A"; B="$WORK/B"; C="$WORK/C"; N="$WORK/N"
mk_team "$A"; mk_team "$B"; mk_team "$C"; mk_repo "$N"
BUS_A="$A/.tap/bus"; BUS_B="$B/.tap/bus"; BUS_C="$C/.tap/bus"

# Two live panes on the default server. Contents are the repo's pinned pane
# corpora: a real generating claude footer (`esc to interrupt` on the last
# rendered line) and a real idle claude prompt. `cat` then `sleep` keeps each
# pane showing exactly the fixture; nothing else is ever typed into them.
tmux new-session -d -s "${S}gen"  -x 120 -y 40 "cat '$CENSUS/pine-gate.pane.txt'; exec sleep 600"
tmux new-session -d -s "${S}idle" -x 120 -y 40 "cat '$PANES/idle-current.txt'; exec sleep 600"
# Captures are read into variables and matched with here-strings: an early-exiting
# `grep -q` on the read end of a pipe can SIGPIPE the writer under pipefail.
gen_cap=""; idle_cap=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  gen_cap="$(tmux capture-pane -p -t "${S}gen:0.0" 2>/dev/null || true)"
  idle_cap="$(tmux capture-pane -p -t "${S}idle:0.0" 2>/dev/null || true)"
  grep -q 'esc to interrupt' <<<"$gen_cap" && grep -q '❯' <<<"$idle_cap" && break
  sleep 0.2
done
grep -q 'esc to interrupt' <<<"$gen_cap" || fail "setup: generating pane never rendered its footer"
grep -q '❯' <<<"$idle_cap" || fail "setup: idle pane never rendered its prompt"
_sock="$(tmux display-message -p -t "${S}gen:0.0" '#{socket_path}' 2>/dev/null || true)"
[ -n "$_sock" ] || fail "setup: no tmux socket after census new-session"
_sock_root="$(cd "$(dirname "$_sock")/.." && pwd -P)"
_tmux_root="$(cd "$TMUX_TMPDIR" && pwd -P)"
[ "$_sock_root" = "$_tmux_root" ] \
  || fail "setup: tmux socket $_sock is not under TMUX_TMPDIR=$TMUX_TMPDIR"

write_registry "$A" A "$(cat <<JSON
{"gen":     {"status":"active","pane":"${S}gen:0.0","harness":"claude","instance":"gen|a","registered_at":"t"},
 "idle":    {"status":"active","pane":"${S}idle:0.0","harness":"claude","instance":"idle|b","registered_at":"t"},
 "gone":    {"status":"active","pane":"nosuch:0.0","harness":"claude","instance":"gone|c","registered_at":"t"},
 "parked":  {"status":"suspended","pane":"${S}idle:0.0","harness":"claude","instance":"parked|e","registered_at":"t"},
 "pollseat":{"status":"active","delivery":"poll","harness":"claude","instance":"pollseat|d","registered_at":"t"}}
JSON
)"
write_registry "$B" B '{"b-only":{"status":"active","pane":"nosuch:0.0","harness":"codex","instance":"b-only|z","registered_at":"t"}}'
# Team C is the operator-real shape: a migrated team keeps its PRE-FLIP bus registry
# (.tap/bus/registry.json) beside the post-flip acting file. Both are real files copied
# from a live bus, with seat handles replaced by one synthetic mapping
# (fixtures/health-differential/source-shapes/, provenance in its README);
# the only field the test rewrites is team.worktree_root, so nothing on this machine is read.
# Their seat names differ, so any rendering says which file it was read from.
install_shape() {  # <source-shape> <destination> <sandbox-team-root>
  "$PY" -B - "$1" "$2" "$3" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["team"]["worktree_root"] = sys.argv[3]
open(sys.argv[2], "w").write(json.dumps(d, indent=2, sort_keys=True) + "\n")
PY
}
install_shape "$FIX/source-shapes/team-registry.json" "$C/.tap/team-registry.json" "$C"
install_shape "$FIX/source-shapes/bus-registry.json"  "$BUS_C/registry.json"       "$C"
write_index "A=$A" "B=$B" "C=$C"
# The real shape's seats carry server_epoch and boot_id. Health IS on the dispatcher's
# skip list since tap-diagnostics-u1 (its restart attention judges the registry AS THE
# CALLER FOUND IT — tap-uxac's pre-dispatch reconciliation would have erased that
# evidence by suspending rows and clearing panes first). The sandbox server is a
# different server by construction, so WITHOUT the pin the classifier reports
# server_epoch_stale for the shape's seats and health raises the server-restart
# attention — exactly the reboot shape U1 exists for (see (12)). Pin
# TAP_SERVER_EPOCH to the shape's own recorded value so the differential cases
# observe a team whose server never restarted.
# TAP_BOOT_ID is pinned to the shape's own boot_id as REBOOT-PROOFING: today row_boot
# equals the live boot only because the shape was copied on this machine; after a
# reboot the boot conjunct would fire instead. Setting TAP_BOOT_ID without
# TAP_BOOT_ID_LEGACY makes the comparison strict equality, so the pin MUST be the
# shape's value, never an arbitrary one. The one case that wants the restart shape
# removes both pins (see (12)).
SHAPE_EPOCH="$("$PY" -B -c 'import json,sys; m=json.load(open(sys.argv[1]))["seats"]; print(sorted({e.get("server_epoch","") for e in m.values()})[-1])' "$FIX/source-shapes/team-registry.json")"
SHAPE_BOOT="$("$PY" -B -c 'import json,sys; m=json.load(open(sys.argv[1]))["seats"]; print(sorted({e.get("boot_id","") for e in m.values()})[-1])' "$FIX/source-shapes/team-registry.json")"
[ -n "$SHAPE_EPOCH" ] && [ -n "$SHAPE_BOOT" ] || fail "setup: source shape carries no server_epoch/boot_id to pin"
export TAP_SERVER_EPOCH="$SHAPE_EPOCH" TAP_BOOT_ID="$SHAPE_BOOT"
cp "$TAP_INDEX_HOME/global-registry.json" "$WORK/index.good"

# Bus A: one unsettled cross-team task, one settled notice, one older probe,
# a dead-watcher arm record, an unacked sticky notify, and an events tail.
payload "$BUS_A" alice-20260901T000000Z-aaaaaaaaaaaa alice bob task "from_team: other"
payload "$BUS_A" bob-20260901T000001Z-bbbbbbbbbbbb   bob   alice notice
payload "$BUS_A" watcher-20260831T235900Z-cccccccccccc watcher gen probe "to_team: A"
: > "$BUS_A/receipts/bob-20260901T000001Z-bbbbbbbbbbbb.done"
: > "$BUS_A/receipts/watcher-20260831T235900Z-cccccccccccc.done"
printf '%s\n' '{"armed_by":"lead","done_when":"PR merged","threshold_seconds":600,"current_rung":1,"heartbeat_at":"2026-09-01T00:00:00Z","watcher_pid":2147483000,"watcher_command":"tap-watch"}' > "$BUS_A/watch/arm.json"
printf '%s\n' '{"acked":"0","at":"2026-08-31T23:59:00Z","reason":"seat parked"}' > "$BUS_A/watch/notify.json"
printf '%s\n' 'e01' 'e02' 'e03' 'e04' 'e05' 'e06' 'e07' 'e08' 'e09' 'e10' 'e11' 'e12' > "$BUS_A/registry-events.log"
TZ=UTC touch -t 202608312359.00 "$BUS_A/payloads/watcher-20260831T235900Z-cccccccccccc.md" "$BUS_A/receipts/watcher-20260831T235900Z-cccccccccccc.done"
TZ=UTC touch -t 202609010000.00 "$BUS_A/payloads/alice-20260901T000000Z-aaaaaaaaaaaa.md"
TZ=UTC touch -t 202609010000.01 "$BUS_A/payloads/bob-20260901T000001Z-bbbbbbbbbbbb.md" "$BUS_A/receipts/bob-20260901T000001Z-bbbbbbbbbbbb.done"
cp "$BUS_A/watch/arm.json" "$WORK/arm.dead"; cp "$BUS_A/watch/notify.json" "$WORK/notify.good"

# --- instruments ----------------------------------------------------------------------
# Snapshot of everything under WORK: for every file and directory, its path, mode,
# size, mtime and ctime (nanoseconds), plus a sha256 of file content. WORK holds the
# team dirs AND the relocated HOME / machine index / state roots above, so a verb
# writing through any of them moves this hash. Metadata is in the snapshot on purpose:
# a rewrite with identical bytes, a bare touch, or a chmod is still a write under T3
# and content alone cannot see it; ctime catches a rename-into-place and a chmod,
# mtime a touch. Directories are in it (path + mode) so a bootstrapped EMPTY bus tree
# is visible; directory TIMES are deliberately left out, because a directory's mtime
# moves whenever an entry is created or removed, which the path list already
# catches, and keeping them would make the probe controls unable to return to
# baseline. atime is excluded (reading is allowed to read). Excluded only: the tmux
# socket dir (sockets are not files, and the server's own bookkeeping is not health's).
tree_hash() {
  "$PY" -B - "$WORK" <<'PY'
import hashlib, os, sys
root = sys.argv[1]; h = hashlib.sha256()
for dirpath, dirnames, filenames in os.walk(root):
    rel = os.path.relpath(dirpath, root)
    if rel == "tmux" or rel.startswith("tmux" + os.sep):
        dirnames[:] = []; continue
    dirnames.sort(); filenames.sort()
    st = os.lstat(dirpath)
    h.update(f"D {rel} {st.st_mode:o}\n".encode())
    for name in filenames:
        path = os.path.join(dirpath, name); st = os.lstat(path)
        line = f"F {os.path.relpath(path, root)} {st.st_mode:o} {st.st_size} {st.st_mtime_ns} {st.st_ctime_ns} "
        if os.path.isfile(path) and not os.path.islink(path):
            with open(path, "rb") as fh: line += hashlib.sha256(fh.read()).hexdigest()
        h.update((line + "\n").encode())
print(h.hexdigest())
PY
}
# Order matters: JSON-CLEAN is asserted on the RAW stream before this runs. The
# normalized form is deliberately not JSON (a bare <PID> token replaces a number),
# so a fixture's .json file parses as text for the diff, never as JSON.
normalize() {  # WORK path, session prefix, and the live watcher pid (both renderings)
  sed -e "s#$WORK#<WORK>#g" -e "s#${S}#<S>#g" \
      ${WATCH_PID:+-e "s#\"watcher_pid\":${WATCH_PID},#\"watcher_pid\":<PID>,#g" -e "s#watcher pid: ${WATCH_PID}\$#watcher pid: <PID>#"}
}
json_clean() {  # <stdout-file> ; exactly one line, parses
  [ "$(wc -l < "$1")" -eq 1 ] || return 1
  "$PY" -B -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
}
# Text usage and registry-invalid dump the diagnostic on stderr; the committed
# .text fixtures are empty stdout on purpose. Pin the normalized stderr so a
# wording change (or an extra diagnostic) cannot pass unseen. JSON routes already
# pin structured errors on stdout. deleted-cwd is not in this list.
pin_text_stderr() {  # <name> <err-file>
  local name="$1" err="$2"
  case "$name" in
    registry-invalid|usage-bogus|usage-extra) ;;
    *) return 0 ;;
  esac
  normalize < "$err" > "$err.norm"
  [ -s "$err.norm" ] || { echo "health-differential: $name/text: pinned stderr is empty" >&2; FAILED=$((FAILED+1)); return 0; }
  if [ "$RECORD" = 1 ]; then
    mkdir -p "$FIX"; cp "$err.norm" "$FIX/$name.text.err"
  else
    [ -f "$FIX/$name.text.err" ] || fail "no stderr fixture for $name.text (record with TAP_HEALTH_DIFF_RECORD=1)"
    if ! diff -u "$FIX/$name.text.err" "$err.norm" >&2; then
      echo "health-differential: DIFFERENTIAL $name/text: stderr diverged from fixture (above)" >&2
      FAILED=$((FAILED+1))
    fi
  fi
}

CASES=0; FAILED=0
# run_case <name> <cwd> [env assignments...] -- runs text and --json; compares or records
run_case() {
  local name="$1" dir="$2"; shift 2
  local route out rc h0 h1
  for route in text json; do
    out="$OUT/out.$name.$route"
    h0="$(tree_hash)"
    set +e
    if [ "$route" = json ]; then
      (cd "$dir" && env "$@" "$TAP" health --json > "$out" 2> "$out.err"); rc=$?
    else
      (cd "$dir" && env "$@" "$TAP" health > "$out" 2> "$out.err"); rc=$?
    fi
    set -e
    h1="$(tree_hash)"
    [ "$h0" = "$h1" ] || { echo "health-differential: ZERO-WRITE $name/$route: sandbox hash moved ($h0 -> $h1)" >&2; FAILED=$((FAILED+1)); }
    if [ "$route" = json ]; then
      # Asserted on every exit code, and an EMPTY stdout is a failure here too: a
      # skip on empty would record green for a route that printed nothing.
      json_clean "$out" || { echo "health-differential: JSON-CLEAN $name: stdout is not exactly one JSON line (rc=$rc):" >&2; cat "$out" >&2; FAILED=$((FAILED+1)); }
    fi
    normalize < "$out" > "$out.norm"
    if [ "$RECORD" = 1 ]; then
      mkdir -p "$FIX"; cp "$out.norm" "$FIX/$name.$route"; printf '%s\n' "$rc" > "$FIX/$name.$route.rc"
    else
      [ -f "$FIX/$name.$route" ] || fail "no fixture for $name.$route (record with TAP_HEALTH_DIFF_RECORD=1)"
      if ! diff -u "$FIX/$name.$route" "$out.norm" >&2; then
        echo "health-differential: DIFFERENTIAL $name/$route: stdout diverged from fixture (above)" >&2; FAILED=$((FAILED+1))
      fi
      [ "$(cat "$FIX/$name.$route.rc")" = "$rc" ] \
        || { echo "health-differential: DIFFERENTIAL $name/$route: exit $rc, fixture says $(cat "$FIX/$name.$route.rc")" >&2; FAILED=$((FAILED+1)); }
    fi
    if [ "$route" = text ]; then
      pin_text_stderr "$name" "$out.err"
    fi
  done
  CASES=$((CASES+1))
}

# --- positive controls: each instrument must be able to say no --------------------------
h0="$(tree_hash)"; : > "$WORK/A/.tap/bus/seat-state.probe"; h1="$(tree_hash)"; rm -f "$WORK/A/.tap/bus/seat-state.probe"
[ "$h0" != "$h1" ] || fail "control: tree_hash did not move on a new empty file — the zero-write check is blind"
[ "$h0" = "$(tree_hash)" ] || fail "control: tree_hash did not return to baseline after the probe was removed"
mkdir "$WORK/N/.tap"; h2="$(tree_hash)"; rmdir "$WORK/N/.tap"
[ "$h0" != "$h2" ] || fail "control: tree_hash did not move on a new EMPTY directory — a bootstrapped bus would pass unseen"
# Metadata controls: each is a write under T3 that leaves content identical.
ctl="$A/.tap/team-registry.json"; hc0="$(tree_hash)"
sleep 0.01; touch "$ctl"; hc1="$(tree_hash)"
[ "$hc0" != "$hc1" ] || fail "control: tree_hash did not move on a bare touch (mtime) — a same-bytes rewrite would pass unseen"
chmod 600 "$ctl"; hc2="$(tree_hash)"; chmod 644 "$ctl"
[ "$hc1" != "$hc2" ] || fail "control: tree_hash did not move on chmod (mode/ctime)"
hc3="$(tree_hash)"; [ "$hc2" != "$hc3" ] || fail "control: chmod back did not move the hash (ctime) — ctime is not being read"
# Identical-bytes rewrite: content unchanged; mtime/ctime must still move the hash.
sleep 0.01
"$PY" -B -c 'import sys; p=sys.argv[1]; d=open(p,"rb").read(); open(p,"wb").write(d)' "$ctl"
hc4="$(tree_hash)"; [ "$hc3" != "$hc4" ] || fail "control: tree_hash did not move on an identical-bytes rewrite (mtime/ctime) — a same-content rewrite would pass unseen"
printf '{"a":1}\njunk\n' > "$OUT/ctl.two"; printf '{"a":1' > "$OUT/ctl.bad"; printf '{"a":1}\n' > "$OUT/ctl.ok"
json_clean "$OUT/ctl.two" && fail "control: json_clean accepted two lines"
json_clean "$OUT/ctl.bad" && fail "control: json_clean accepted a truncated object"
json_clean "$OUT/ctl.ok" || fail "control: json_clean rejected a valid one-line object"
rm -f "$OUT"/ctl.*
echo "health-differential: (0) controls: tree_hash sees a new file, a new empty dir, a bare touch, a chmod, and an identical-bytes rewrite; json_clean rejects two lines and a torn object: ok"

# --- cases ------------------------------------------------------------------------------
# (1) the live census: every seat class at once, plus every bus signal.
run_case census "$A"

# FALSIFIER for that redirect, run against the case that exposed the write. The
# invariant changed with tap-diagnostics-u1 review fix r4046473763: health pins
# BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 at BOTH entry doors (bin/tap and the direct
# tap.sh health exec), so the census no longer writes a cache anywhere — the
# redirect target is expected to stay EMPTY, and that emptiness is now the
# direct zero-write proof rather than a vacuous absence. The hashed-sandbox
# absence half is unchanged: a cache under $HOME/Library would still mean some
# unpinned Bun call wrote state.
[ ! -e "$HOME/Library" ] \
  || fail "(0b) Bun's transpiler cache materialized inside the hashed sandbox ($HOME/Library) — a Bun call ran unpinned, and ZERO-WRITE will report the interpreter as the verb"
[ -z "$(ls -A "$BUN_CACHE" 2>/dev/null)" ] \
  || fail "(0b) the redirect target $BUN_CACHE is non-empty after the census case — health ran with a live transpiler cache, breaking the entry doors' pin"
echo "health-differential: (0b) the Bun transpiler cache is pinned off for health: nothing landed in the sandbox or the redirect: ok"

# (2) bus-less repo: no .tap, no registry, nothing armed. Must stay bus-less afterwards.
run_case busless "$N"

# (3) selection. The native selector's precedence governs unchanged: cwd
#     enrollment walks first, TAP_HOME is the env fallback when the walk finds
#     nothing (ambient-home), and a valid enrollment beats TAP_HOME (wrong-home
#     — the incumbent's env-first rule is NOT ported; the recorded render is
#     team A). TAP_REGISTRY is NOT a selector — inside a team the acting-
#     registry rebind replaces it (tap-n85k's passing arm), outside a team it
#     is ignored and the cwd's empty bus renders.
run_case ambient-home    "$N" TAP_HOME="$BUS_B"
run_case wrong-home      "$A" TAP_HOME="$BUS_B"
run_case ambient-registry-outside "$N" TAP_REGISTRY="$B/.tap/team-registry.json"
run_case ambient-registry-inside  "$A" TAP_REGISTRY="$B/.tap/team-registry.json"

# (4) flip marker invalid / unreadable. CURRENT TRUTH, pinned as-is: the native
#     selector fails CLOSED — a marker that cannot be validated is a structured
#     refusal (error_class invalid_flip, exit 1) on both output routes, never a
#     rendered report. One exception is carved for health's read-only,
#     registry-optional report: an UNENROLLED cwd (unanchored_bus) renders the
#     cwd-derived/default bus with registry_present:false (the busless shape).
#     Team C carries the pre-flip bus registry too — under the refusal ruling
#     the decoy is never read; the arm keeps the file so a future fail-soft
#     change cannot pass silently without re-recording this block.
run_case marker-good-both-files "$C"
printf '%s\n' '{"schema":"9.99"}' > "$TAP_INDEX_HOME/global-registry.json"
run_case marker-invalid "$A"
run_case marker-invalid-both-files "$C"
printf 'not json' > "$TAP_INDEX_HOME/global-registry.json"
run_case marker-unreadable "$A"
run_case marker-unreadable-both-files "$C"
cp "$WORK/index.good" "$TAP_INDEX_HOME/global-registry.json"

# (5) the acting registry is not JSON: exit 1, registry_invalid; the parser's own
#     message goes to stderr, never into the JSON line.
cp "$A/.tap/team-registry.json" "$WORK/reg.good"; printf '{oops' > "$A/.tap/team-registry.json"
run_case registry-invalid "$A"
cp "$WORK/reg.good" "$A/.tap/team-registry.json"

# (6) watcher armed and ALIVE (a real pid whose command matches), and paused.
sleep 600 & WATCH_PID=$!
printf '%s\n' "{\"armed_by\":\"lead\",\"done_when\":\"PR merged\",\"threshold_seconds\":600,\"current_rung\":2,\"heartbeat_at\":\"2026-09-01T00:01:00Z\",\"watcher_pid\":$WATCH_PID,\"watcher_command\":\"sleep\",\"pause_reason\":\"gate window\",\"paused_by\":\"lead\",\"paused_at\":\"2026-09-01T00:01:10Z\",\"paused_until\":\"2026-09-01T01:00:00Z\"}" > "$BUS_A/watch/arm.json"
run_case watch-alive-paused "$A"
# (6b) same live pid, watcher_command that does NOT match its command line: `command in
#      out` is what makes this read dead. A port that keeps only the pid check reds here.
printf '%s\n' "{\"armed_by\":\"lead\",\"done_when\":\"PR merged\",\"threshold_seconds\":600,\"current_rung\":2,\"heartbeat_at\":\"2026-09-01T00:01:00Z\",\"watcher_pid\":$WATCH_PID,\"watcher_command\":\"tap-watch\"}" > "$BUS_A/watch/arm.json"
run_case watch-alive-wrong-command "$A"
# (6c) same live pid, EMPTY watcher_command: pid existence alone reads alive. Current
#      truth, pinned; it is the reused-pid exposure, and a port that tightens it re-records.
printf '%s\n' "{\"armed_by\":\"lead\",\"done_when\":\"PR merged\",\"threshold_seconds\":600,\"current_rung\":2,\"heartbeat_at\":\"2026-09-01T00:01:00Z\",\"watcher_pid\":$WATCH_PID,\"watcher_command\":\"\"}" > "$BUS_A/watch/arm.json"
run_case watch-alive-empty-command "$A"
# (6e) the Bun loop's signature recorded against a live pid that is not that loop: dead.
#      A recorded command matches itself only; the pre-W3 Bash loop's signature is retired.
printf '%s\n' "{\"armed_by\":\"lead\",\"done_when\":\"PR merged\",\"threshold_seconds\":600,\"current_rung\":2,\"heartbeat_at\":\"2026-09-01T00:01:00Z\",\"watcher_pid\":$WATCH_PID,\"watcher_command\":\"watch-run.ts run\"}" > "$BUS_A/watch/arm.json"
run_case watch-dead-known-signature-other-process "$A"
kill "$WATCH_PID" 2>/dev/null || true; wait "$WATCH_PID" 2>/dev/null || true; WATCH_PID=""
# (7) arm record present but unreadable: a distinct condition from a dead watcher.
printf '{bad' > "$BUS_A/watch/arm.json"
run_case watch-unreadable "$A"
# (8) notify state unreadable: surfaces as a sticky-notify with the parse error.
printf '{bad' > "$BUS_A/watch/notify.json"
run_case notify-unreadable "$A"
cp "$WORK/arm.dead" "$BUS_A/watch/arm.json"; cp "$WORK/notify.good" "$BUS_A/watch/notify.json"

# (9) pane classifier failures. A tmux that fails every call (with stderr noise) and
#     a TMUX_TMPDIR with no server both degrade every pane seat to `unknown`, and
#     the JSON line stays clean. Since tap-diagnostics-u1 the exit ALSO carries the
#     reboot finding: pane-backed seats exist, none observed active, and the shared
#     classifier reported restart evidence (session_unobservable) — so every case
#     here exits 2 with a server-restart attention item first (plan decision 2).
FB="$WORK/fakebin"; mkdir -p "$FB"; printf '#!/bin/sh\necho "tmux: server exited unexpectedly" >&2\nexit 1\n' > "$FB/tmux"; chmod +x "$FB/tmux"
run_case tmux-failing "$A" PATH="$FB:$PATH"
#     The empty socket root lives outside the hashed sandbox: the tmux CLIENT creates
#     its socket directory on any invocation, which is tmux's materialization, not
#     health's. A server, if one had been started, would be a socket inside it.
#     A tmux that SUCCEEDS but prints junk to stdout: the classifier reads tmux
#     through captures, so the junk lands in classifier variables (seats degrade
#     to unknown) and never in the JSON stream. This case is a regression pin only;
#     the causal proof that JSON-CLEAN can red at the classifier site is the
#     stdout-leak mutant in the driver's report, not this shim.
NB="$WORK/noisybin"; mkdir -p "$NB"; printf '#!/bin/sh\necho "tmux: unexpected stdout chatter"\nexit 0\n' > "$NB/tmux"; chmod +x "$NB/tmux"
run_case tmux-noisy-stdout "$A" PATH="$NB:$PATH"
# The absent server stays outside the hashed TAP state but inside the runner's
# admitted socket root, so this probes tmux's refusal rather than the guard's.
_no_server="$(health_no_server_root)"
run_case tmux-unreachable "$A" TMUX_TMPDIR="$_no_server"
[ ! -S "$_no_server/tmux-$(id -u)/default" ] || fail "(9) observing an unreachable server started one"

# (10) deleted cwd: the process cannot resolve where it is; stdout stays empty on
#      both routes and the exit is 1. stderr is the runtime's own message and is
#      not pinned (it differs between the Bun and Bash entries).
#      run_case enters the directory before running tap, so the removal has to
#      happen inside the case: this one is driven by hand.
for route in text json; do
  out="$OUT/out.deleted-cwd.$route"; h0="$(tree_hash)"
  set +e
  if [ "$route" = json ]; then (mkdir -p "$A/sub" && cd "$A/sub" && rmdir "$A/sub" && "$TAP" health --json > "$out" 2> "$out.err"); rc=$?
  else (mkdir -p "$A/sub" && cd "$A/sub" && rmdir "$A/sub" && "$TAP" health > "$out" 2> "$out.err"); rc=$?; fi
  set -e
  [ "$h0" = "$(tree_hash)" ] || { echo "health-differential: ZERO-WRITE deleted-cwd/$route: sandbox hash moved" >&2; FAILED=$((FAILED+1)); }
  [ -s "$out.err" ] || { echo "health-differential: deleted-cwd/$route: no stderr at all — the refusal must be visible" >&2; FAILED=$((FAILED+1)); }
  normalize < "$out" > "$out.norm"
  if [ "$RECORD" = 1 ]; then cp "$out.norm" "$FIX/deleted-cwd.$route"; printf '%s\n' "$rc" > "$FIX/deleted-cwd.$route.rc"
  else
    diff -u "$FIX/deleted-cwd.$route" "$out.norm" >&2 || { echo "health-differential: DIFFERENTIAL deleted-cwd/$route diverged" >&2; FAILED=$((FAILED+1)); }
    [ "$(cat "$FIX/deleted-cwd.$route.rc")" = "$rc" ] || { echo "health-differential: DIFFERENTIAL deleted-cwd/$route: exit $rc, fixture says $(cat "$FIX/deleted-cwd.$route.rc")" >&2; FAILED=$((FAILED+1)); }
  fi
done
rm -rf "$A/sub"; CASES=$((CASES+1))

# (11) usage: an unknown option and a stray positional both exit 1 with the verb's
#      own refusal, structured on the --json route.
for route in text json; do
  for bad in "--bogus" "extra"; do
    tag="usage-${bad#--}"; out="$OUT/out.$tag.$route"; h0="$(tree_hash)"
    set +e
    if [ "$route" = json ]; then (cd "$A" && "$TAP" health --json "$bad" > "$out" 2> "$out.err"); rc=$?
    else (cd "$A" && "$TAP" health "$bad" > "$out" 2> "$out.err"); rc=$?; fi
    set -e
    [ "$h0" = "$(tree_hash)" ] || { echo "health-differential: ZERO-WRITE $tag/$route moved the sandbox" >&2; FAILED=$((FAILED+1)); }
    if [ "$route" = json ]; then json_clean "$out" || { echo "health-differential: JSON-CLEAN $tag: stdout not one JSON line" >&2; FAILED=$((FAILED+1)); }; fi
    normalize < "$out" > "$out.norm"
    if [ "$RECORD" = 1 ]; then cp "$out.norm" "$FIX/$tag.$route"; printf '%s\n' "$rc" > "$FIX/$tag.$route.rc"
    else
      diff -u "$FIX/$tag.$route" "$out.norm" >&2 || { echo "health-differential: DIFFERENTIAL $tag/$route diverged" >&2; FAILED=$((FAILED+1)); }
      [ "$(cat "$FIX/$tag.$route.rc")" = "$rc" ] || { echo "health-differential: DIFFERENTIAL $tag/$route: exit $rc, fixture says $(cat "$FIX/$tag.$route.rc")" >&2; FAILED=$((FAILED+1)); }
    fi
    if [ "$route" = text ]; then
      pin_text_stderr "$tag" "$out.err"
    fi
  done
done
CASES=$((CASES+2))

# (12) REAL-SHAPE SERVER RESTART — the reboot shape U1 exists for. With the epoch/boot
#      pins removed, the sandbox server differs from the shape's recorded server: the
#      shared classifier reports server_epoch_stale, every pane-backed seat is
#      unobserved-active, and health must NOT read that as healthy. It exits 2 with
#      the server-restart attention item FIRST, and (T3, tap-uxac retired) writes
#      nothing anywhere — the registry the caller found is the evidence, and this arm
#      asserts its bytes survived the call. It records no fixture because the shapes
#      carry host-specific sockets; the census case already pins the schema.
#      PRECONDITION first: the trigger needs a LIVE server whose epoch differs from the
#      shape's. Without a server the classifier cannot report restart evidence and the
#      arm would red for the wrong reason.
live_epoch_raw="$(env -u TAP_SERVER_EPOCH tmux display-message -p '#{pid}:#{start_time}' 2>/dev/null || true)"
case "$live_epoch_raw" in
  *[!0-9:]*|"") fail "(12) precondition: no live tmux server to differ from the shape's epoch (raw='$live_epoch_raw'); this arm needs the runner's server" ;;
esac
[ "srv:$live_epoch_raw" != "$SHAPE_EPOCH" ] || fail "(12) precondition: live server epoch equals the shape's ($SHAPE_EPOCH); nothing to trigger"
# This restart control represents rows stamped on the current socket namespace.
"$PY" -B - "$C/.tap/team-registry.json" "$(tmux display-message -p '#{socket_path}')" <<'PY_SOCKET'
import json, sys
path, socket = sys.argv[1:]
doc = json.load(open(path))
for row in (doc.get('seats') or doc.get('agents') or {}).values():
    if isinstance(row, dict) and row.get('delivery') != 'poll': row['server_socket'] = socket
with open(path, 'w') as out: json.dump(doc, out)
PY_SOCKET
h0="$(tree_hash)"; reg_before="$(shasum -a 256 < "$C/.tap/team-registry.json")"
set +e
(cd "$C" && env -u TAP_SERVER_EPOCH -u TAP_BOOT_ID "$TAP" health --json > "$OUT/out.real-shape-server-restart.json" 2> "$OUT/out.real-shape-server-restart.json.err"); rc=$?
set -e
h1="$(tree_hash)"; reg_after="$(shasum -a 256 < "$C/.tap/team-registry.json")"
[ "$rc" -eq 2 ] || { echo "health-differential: (12) restart-shape health exited $rc, expected 2 (server-restart attention)" >&2; FAILED=$((FAILED+1)); }
json_clean "$OUT/out.real-shape-server-restart.json" || { echo "health-differential: JSON-CLEAN real-shape-server-restart" >&2; FAILED=$((FAILED+1)); }
[ "$h0" = "$h1" ] || { echo "health-differential: ZERO-WRITE real-shape-server-restart: sandbox hash moved ($h0 -> $h1)" >&2; FAILED=$((FAILED+1)); }
[ "$reg_before" = "$reg_after" ] || { echo "health-differential: (12) the acting registry was rewritten — health judged a registry it mutated, not the one the caller found" >&2; FAILED=$((FAILED+1)); }
"$PY" -B - "$OUT/out.real-shape-server-restart.json" <<'PY' || { echo "health-differential: (12) restart shape did not lead attention with server-restart over a found registry" >&2; FAILED=$((FAILED+1)); }
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "attention", d["status"]
assert d["attention"] and d["attention"][0]["type"] == "server-restart", d["attention"]
assert d["roster"] and all(r["status"] == "active" for r in d["roster"]), d["roster"]
assert not any("server_restarted" in e for e in d["events"]), d["events"]
PY
echo "health-differential: (12) restart shape: exit 2, server-restart first, roster still as found, whole call wrote nothing (tap-uxac retired)"
CASES=$((CASES+1))

# --- the census must actually have observed what it claims -----------------------------
# The differential would pass on a fixture recorded from a broken sandbox. Assert the
# load-bearing states directly, so a green here means the live pane census ran.
# tap-diagnostics-u1: native harness attestation is authoritative, and the census
# panes run `cat fixture; exec sleep 600` — sleep is not a live Claude harness, so
# every pane-backed row degrades to state "unknown" (named ruling, plan step for
# re-records). agent-state.test.ts keeps the real footer/prompt corpora coverage.
"$PY" -B - "$OUT/out.census.json" <<'PY' || fail "census JSON does not carry the expected seat states"
import json, sys
d = json.load(open(sys.argv[1]))
roster = {r["handle"]: r for r in d["roster"]}
assert roster["gen"]["state"] == "unknown", roster["gen"]
assert roster["idle"]["state"] == "unknown", roster["idle"]
assert roster["gone"]["state"] == "unknown", roster["gone"]
assert roster["parked"]["state"] == "unknown" and roster["parked"]["status"] == "suspended", roster["parked"]
assert roster["pollseat"]["state"] == "poll-mode (liveness unknown)" and roster["pollseat"]["delivery"] == "poll", roster["pollseat"]
assert d["status"] == "attention" and d["watch"]["condition"] == "armed-but-watcher-dead", d["watch"]
assert [a["type"] for a in d["attention"]] == ["sticky-notify", "unsettled-payload", "armed-but-watcher-dead"], d["attention"]
assert d["unsettled"][0]["from_team"] == "other" and len(d["unsettled"]) == 1, d["unsettled"]
assert [s["kind"] for s in d["supervision"]] == ["notice", "probe"], d["supervision"]
assert d["events"] == ["e%02d" % i for i in range(3, 13)], d["events"]
PY
"$PY" -B - "$OUT/out.watch-alive-wrong-command.json" "$OUT/out.watch-alive-empty-command.json" <<'PY' || fail "watcher_alive branches did not classify as expected"
import json, sys
wrong, empty = (json.load(open(a)) for a in sys.argv[1:3])
assert wrong["watch"]["watcher_alive"] is False and wrong["watch"].get("condition") == "armed-but-watcher-dead", wrong["watch"]
assert empty["watch"]["watcher_alive"] is True and "condition" not in empty["watch"], empty["watch"]
PY
grep -q 'state: unknown' "$OUT/out.census.text" \
  || fail "census text does not show the attested-unknown pane states"

# route note (not an assertion): which runtime answered. The port PR flips this.
if [ -s "$OUT/route.trace" ]; then
  echo "health-differential: route: $(sort "$OUT/route.trace" | uniq -c | tr -s ' ' | tr '\n' ';')"
else
  echo "health-differential: route: bin/tap did not go through the Bun router (no bun on PATH)"
fi

if [ "$RECORD" = 1 ]; then
  echo "health-differential: RECORDED $CASES cases into $FIX (review the diff; this run is not a pass)"
  exit 0
fi
[ "$FAILED" -eq 0 ] || fail "$FAILED instrument failure(s) across $CASES cases"
echo "health-differential: $CASES cases x {text,json}: differential, zero-write, json-clean: ok"
