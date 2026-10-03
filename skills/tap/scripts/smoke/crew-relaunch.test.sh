#!/usr/bin/env bash
# D5: public — every remaining arm drives the public `tap crew relaunch` / `tap
# session relaunch` doors against a live fixture pane (:120 fresh replacement,
# :193 session door, :225 readiness timeout, :236 pre-effect PID timeout); the
# two direct-import heredoc arms (cancellation reporting, late-signal respawn
# fence) moved to the Bun owner runtime/bun/test/crew-relaunch.test.ts.
# Refuse source before changing the caller's shell options or environment.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# tap-odt1d.1 / tap-yih6n.1: a live crew seat relaunches fresh in its own pane
# from its persisted recipe — same pane id, new process, no resume, no catalog.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMUX_TMPDIR:?run through smoke-all --only}/crew-relaunch.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
REAL_TMUX="$(command -v tmux)"
SOCKET="$WORK/tmux.sock"
cleanup() {
  "$REAL_TMUX" -S "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
fail() { echo "crew-relaunch: $*" >&2; exit 1; }
mkdir -p "$WORK/bin" "$WORK/Demo/.tap/bus" "$WORK/Other/.tap/bus" "$WORK/index" "$WORK/launches" "$WORK/config/tap"
unset TAP_HOME
export TAP_INDEX_HOME="$WORK/index" REAL_TMUX SOCKET LAUNCHES="$WORK/launches" XDG_CONFIG_HOME="$WORK/config"
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
if [ "${1:-}" = -S ]; then [ "$2" = "$SOCKET" ] || exit 99; shift 2; fi
if [ "${CREW_PID_TIMEOUT:-}" = 1 ] && [ "${*: -1}" = '#{pane_pid}' ]; then exit 124; fi
if [ "${CREW_TIMEOUT:-}" = 1 ] && [ "${*: -1}" = '#{pane_id} #{pane_dead} #{pane_pid}' ]; then
  printf 'timeout\n' >> "$CREW_TIMEOUT_LOG"
  exit 124
fi
exec "$REAL_TMUX" -S "$SOCKET" "$@"
TMUX
cat > "$WORK/bin/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *'ppid='*'tty='*) printf '1 %s\n' "${CALLER_TTY#/dev/}" ;;
  *) exec /bin/ps "$@" ;;
esac
PS
# A login-shell fixture that keeps the isolated PATH, and a harness that records
# its argv and working directory, then idles like a live seat.
cat > "$WORK/bin/sh" <<'LOGIN_SHELL'
#!/bin/sh
PATH="${0%/*}:$PATH"; export PATH
if [ "${1:-}" = -lic ]; then shift; exec /bin/sh -c "$@"; fi
exec /bin/sh "$@"
LOGIN_SHELL
cat > "$WORK/bin/codex" <<'HARNESS'
#!/bin/sh
printf '%s\n' "$PWD" "$@" > "$LAUNCHES/$$"
exec "$IDLE/codex" 600
HARNESS
# The idle process keeps the harness's name, so the roster classifier sees codex.
mkdir -p "$WORK/idle"; ln -s /bin/sleep "$WORK/idle/codex"; export IDLE="$WORK/idle"
chmod +x "$WORK/bin/tmux" "$WORK/bin/ps" "$WORK/bin/sh" "$WORK/bin/codex"
export PATH="$WORK/bin:$PATH" TAP_LAUNCH_SHELL="$WORK/bin/sh"
# The catalog knows no preset named `gone`: relaunch must not consult it.
printf 'version = 2\n' > "$WORK/config/tap/config.toml"; chmod 600 "$WORK/config/tap/config.toml"
T() { "$REAL_TMUX" -S "$SOCKET" "$@"; }
git -C "$WORK/Demo" init -q
git -C "$WORK/Other" init -q

T new-session -d -s Demo/lead -c "$WORK/Demo"
for w in crew-a crew-b crew-c; do T new-window -d -t Demo/lead -n "$w" -c "$WORK/Demo" "exec sleep 600"; done
# crew-x already runs a codex-named process, so the roster classifier calls it active.
T new-window -d -t Demo/lead -n crew-x -c "$WORK/Demo" "exec $IDLE/codex 600"
pane() { T display-message -p -t "$1" '#{pane_id}'; }
pid() { T display-message -p -t "$1" '#{pane_pid}'; }
export TMUX="$SOCKET,0,0"
LEAD="$(pane Demo/lead:0.0)"; CA="$(pane Demo/lead:1.0)"; CB="$(pane Demo/lead:2.0)"; CC="$(pane Demo/lead:3.0)"; CX="$(pane Demo/lead:4.0)"
export TMUX_PANE="$LEAD" CALLER_TTY="$(T display-message -p -t "$LEAD" '#{pane_tty}')"
python3 - "$WORK" "$LEAD" "$CA" "$CB" "$CC" "$CX" <<'PY'
import json, pathlib, sys
w = pathlib.Path(sys.argv[1]); lead, ca, cb, cc, cx = sys.argv[2:]
demo = w / "Demo"
def crew(pane, **extra):
    row = {"status": "active", "delivery": "pane", "harness": "codex", "pane_id": pane, "pane": "Demo/lead:1.0",
           "session": "Demo/lead", "registered_at": "t", "crew": True, "model": "gpt-test", "permissions": "bypass",
           "harness_env": {}, "passthrough": [], "passthrough_from_config": False, "preset": None, "cwd": str(demo)}
    row.update(extra)
    return {k: v for k, v in row.items() if v != "__drop__"}
seats = {
    "lead": {"status": "active", "delivery": "pane", "harness": "claude", "pane_id": lead, "pane": "Demo/lead:0.0", "session": "Demo/lead", "registered_at": "t"},
    "crew-a": crew(ca, harness_session_id="old-conversation", transcript_path="/old/transcript.jsonl"),
    "crew-b": crew(cb, cwd="__drop__"),
    "crew-c": crew(cc, preset={"name": "gone", "source_path": "/nowhere", "config_digest": "x"}, passthrough_from_config=True),
}
def team(name, rows):
    reg = w / name / ".tap/team-registry.json"
    reg.write_text(json.dumps({"schema": "0.20", "team": {"name": name}, "seats": rows}))
    return {"root": str(w / name), "registry_location": str(reg), "state": "registered", "enrolled_at": "t"}
(w / "index/global-registry.json").write_text(json.dumps({"schema": "0.20", "teams": {"Demo": team("Demo", seats), "Other": team("Other", {})}}))
PY
REG="$WORK/Demo/.tap/team-registry.json"
field() { python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["seats"][sys.argv[2]]; print(json.dumps(r.get(sys.argv[3])))' "$REG" "$1" "$2"; }
tap() { bash "$ROOT/scripts/tap.sh" "$@"; }
run() { rc=0; out="$( "$@" 2>&1 )" || rc=$?; }
wait_launch() { # pane-pid-before pane -> the launch record of the new process
  local before="$1" i now
  for i in $(seq 1 100); do
    now="$(pid "$2")"
    # The harness execs through the login shell, so its $$ is the pane pid.
    if [ "$now" != "$before" ] && [ -s "$LAUNCHES/$now" ]; then echo "$LAUNCHES/$now"; return 0; fi
    sleep 0.1
  done
  return 1
}
cd "$WORK/Demo"

# Fresh relaunch in place: same pane id and row, new process, no resume token,
# stale conversation identity scrubbed, crew flag kept.
before="$(pid "$CA")"
run tap crew relaunch crew-a
[ "$rc" = 0 ] && grep -q "replaced Demo/crew-a with a fresh process in $CA" <<<"$out" || fail "crew relaunch failed: $out"
rec="$(wait_launch "$before" "$CA")" || fail "no fresh process started in $CA"
[ "$(pane Demo/lead:1.0)" = "$CA" ] || fail "pane id changed"
[ "$(sed -n 1p "$rec")" = "$WORK/Demo" ] || fail "fresh process not in the recorded cwd: $(sed -n 1p "$rec")"
grep -qx -- "gpt-test" "$rec" || fail "recipe model missing from argv: $(cat "$rec")"
if grep -Eq -- 'resume|old-conversation|--continue' "$rec"; then fail "relaunch resumed a crew conversation: $(cat "$rec")"; fi
[ "$(field crew-a harness_session_id)" = null ] && [ "$(field crew-a transcript_path)" = null ] || fail "stale identity kept on the row"
[ "$(field crew-a crew)" = true ] && [ "$(field crew-a pane_id)" = "\"$CA\"" ] || fail "row lost crew binding"
echo "crew-relaunch: fresh replacement in the same pane, no resume, identity scrubbed: ok"

# The fresh harness's SessionStart re-register from the same pane keeps the row
# crew and binds only the new conversation (register's same-pane rule).
rc=0; out="$(TMUX_PANE="$CA" CALLER_TTY="$(T display-message -p -t "$CA" '#{pane_tty}')" TAP_HARNESS_SESSION_ID=fresh-conversation \
  bash "$ROOT/scripts/tap.sh" register crew-a 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "post-relaunch rebind failed: $out"
[ "$(field crew-a crew)" = true ] && [ "$(field crew-a harness_session_id)" = '"fresh-conversation"' ] && [ "$(field crew-a pane_id)" = "\"$CA\"" ] \
  || fail "rebind did not keep the crew row with the fresh id: crew=$(field crew-a crew) id=$(field crew-a harness_session_id)"
echo "crew-relaunch: SessionStart rebind keeps crew and binds the fresh conversation: ok"

# A missing recipe refuses before any effect.
before="$(pid "$CB")"
run tap crew relaunch crew-b
[ "$rc" != 0 ] && grep -q "no usable launch recipe (cwd)" <<<"$out" && [ "$(pid "$CB")" = "$before" ] || fail "missing recipe not refused: $out"
echo "crew-relaunch: missing recipe refuses without effect: ok"

# A pane id recorded on another tmux server names another pane here: refuse.
# (Added only for this arm: a foreign-socket row makes register refuse team-wide.)
seat_x() { python3 - "$REG" "$CX" "$1" "$WORK/Other" <<'PY'
import json, sys
path, pane, mode, other = sys.argv[1:]
doc = json.load(open(path)); seats = doc["seats"]
if mode.startswith("add"):
    extra = {"cwd": other} if mode == "add-cwd" else {"server_socket": "/nonexistent/other.sock"}
    seats["crew-x"] = dict(seats["crew-a"], pane_id=pane, pane="Demo/lead:4.0", **extra)
    for key in ("harness_session_id", "transcript_path"): seats["crew-x"].pop(key, None)
else:
    seats.pop("crew-x")
json.dump(doc, open(path, "w"))
PY
}
seat_x add
before="$(pid "$CX")"
run tap crew relaunch crew-x
[ "$rc" != 0 ] && grep -q "row is on tmux server /nonexistent/other.sock" <<<"$out" && [ "$(pid "$CX")" = "$before" ] || fail "foreign-server pane replaced: $out"
seat_x drop
echo "crew-relaunch: another server's pane id is never replaced: ok"

# The recipe is replayed as recorded; a preset the catalog no longer has is irrelevant.
before="$(pid "$CC")"
run tap crew relaunch crew-c
[ "$rc" = 0 ] || fail "recorded-preset relaunch consulted the catalog: $out"
wait_launch "$before" "$CC" >/dev/null || fail "no fresh process in $CC"
echo "crew-relaunch: no preset/catalog resolution: ok"

# A crew seat cannot relaunch itself.
before="$(pid "$CA")"
CALLER_TTY="$(T display-message -p -t "$CA" '#{pane_tty}')" run tap crew relaunch crew-a
[ "$rc" != 0 ] && grep -q "cannot relaunch itself" <<<"$out" && [ "$(pid "$CA")" = "$before" ] || fail "self relaunch not refused: $out"
echo "crew-relaunch: self-target refuses: ok"

# Team-qualified from another team's checkout; a bare name there does not scan.
cd "$WORK/Other"
run tap crew relaunch crew-a
[ "$rc" != 0 ] && [ "$(pid "$CA")" = "$before" ] || fail "bare crew handle scanned another team: $out"
run tap crew relaunch Demo/crew-a
[ "$rc" = 0 ] || fail "team-qualified relaunch failed: $out"
wait_launch "$before" "$CA" >/dev/null || fail "no fresh process after team-qualified relaunch"
cd "$WORK/Demo"
echo "crew-relaunch: bare stays in cwd team; team/handle wins: ok"

# The public session door routes the live crew row to the same fresh replacement.
before="$(pid "$CA")"
run tap session relaunch Demo/crew-a --json
[ "$rc" = 0 ] || fail "session relaunch of a crew row failed: $out"
python3 -c 'import json,sys; d=json.loads(sys.argv[1].strip().splitlines()[-1]); r=d["results"]; assert [(x["handle"],x["status"]) for x in r]==[("crew-a","replaced")], d' "$out" \
  || fail "session relaunch receipt: $out"
wait_launch "$before" "$CA" >/dev/null || fail "session relaunch started no fresh process"
[ "$(pane Demo/lead:1.0)" = "$CA" ] && T has-session -t Demo/lead || fail "session relaunch moved the pane or ended the session"
echo "crew-relaunch: tap session relaunch replaces a live crew row in place: ok"

# Instructions and harness overrides have no meaning for a fresh crew process:
# the crew candidate refuses (code 2) rather than silently dropping them.
before="$(pid "$CA")"
run tap session relaunch Demo/crew-a -m hello --json
python3 -c 'import json,sys; d=json.loads(sys.argv[1].strip().splitlines()[-1]); r=d["results"][0]; assert (r["status"],r["code"])==("failed",2) and "do not apply" in r["reason"], d' "$out" \
  && [ "$(pid "$CA")" = "$before" ] || fail "crew relaunch accepted -m: $out"
echo "crew-relaunch: overrides refuse for crew candidates: ok"

# Dry run runs every check the real relaunch runs: a recorded cwd that selects
# another team's registry is refused, not previewed as would-replace.
seat_x add-cwd
run tap session relaunch Demo/crew-x --dry-run --json
python3 -c 'import json,sys; d=json.loads(sys.argv[1].strip().splitlines()[-1]); r=d["results"][0]; assert (r["status"],r["code"])==("failed",2) and "selects" in r["reason"], d' "$out" \
  || fail "dry run approved a refused crew row: $out"
seat_x drop
echo "crew-relaunch: dry run applies the same refusals: ok"

# The ordering arm — a real crew replacement must yield its readiness wait to
# finished durable siblings — lives in runtime/bun/test/crew-relaunch.test.ts,
# which drives the real relaunchCrew against a live fixture pane in-process.
# The cancellation and late-signal arms moved there too (same owner).

# A timed-out readiness read ends observation; it must not be retried 30 times.
export CREW_TIMEOUT=1 CREW_TIMEOUT_LOG="$WORK/timeouts"
run tap session relaunch Demo/crew-a
[ "$rc" != 0 ] && grep -q 'no stable new process' <<<"$out" || fail "timeout was not reported: $out"
[ "$(wc -l < "$CREW_TIMEOUT_LOG" | tr -d ' ')" = 1 ] || fail 'timed-out read was retried'
grep -q 'observing crew startup' <<<"$out" || fail "crew progress absent: $out"
unset CREW_TIMEOUT CREW_TIMEOUT_LOG
echo 'crew-relaunch: timeout ends observation and human progress is streamed: ok'

# Missing pre-effect identity refuses before respawn and restores the row.
before="$(pid "$CA")"
cp "$REG" "$WORK/registry-before-pid-timeout.json"
export CREW_PID_TIMEOUT=1
run tap crew relaunch crew-a
unset CREW_PID_TIMEOUT
[ "$rc" != 0 ] && grep -q 'cannot observe the crew process before respawn' <<<"$out" || fail "PID timeout did not refuse: $out"
[ "$(pid "$CA")" = "$before" ] || fail 'PID timeout replaced the process'
cmp "$REG" "$WORK/registry-before-pid-timeout.json" || fail 'PID timeout changed the registry'
echo 'crew-relaunch: pre-effect PID timeout refuses without replacement: ok'
