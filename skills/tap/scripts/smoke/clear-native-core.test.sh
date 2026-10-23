#!/usr/bin/env bash
# Refuse source before changing the caller's shell options or environment.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# `tap clear` through the public router, which runs the native core
# (runtime/bun/src/launcher/replace.ts) in-process since R7b, on a real
# private-socket tmux server.
#   1. dry-run routes native, renders a fresh command for the row's model,
#      shows the TAP_CLEAR_ID the respawn will carry (odt1d #2), writes nothing;
#      a crew seat sharing its driver's session uses its own row's recipe
#   2. refusals: pane gone, recycled session, self-clear, unprovable caller,
#      unknown harness —
#      and `tap refresh`'s in-process clear refuses the unprovable caller too (N3)
#   3. a real respawn in place: new process, nonce witnessed, expectation
#      consumed, fence released, latency recorded
#   4. opencode -m: the instruction rides the bus after the rebind
# The fake harness writes the rebind witness itself; registration's own nonce
# handling is pinned by clear-nonce-record.test.sh.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
unset TAP_CLEAR_ID
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
WORK="$(mktemp -d "${TMUX_TMPDIR:?run through smoke-all --only}/clear-native-core.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
REAL_TMUX="$(command -v tmux)"
# bin/tap puts its python3 guard shim on PATH, and the respawned harness
# inherits it; the fake harness is not TAP and uses the real interpreter.
REAL_PYTHON3="$(command -v python3)"
SOCKET="$WORK/tmux.sock"
cleanup() {
  "$REAL_TMUX" -S "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
fail() { echo "clear-native-core: $*" >&2; exit 1; }
mkdir -p "$WORK/bin" "$WORK/Demo/.tap/bus" "$WORK/index" "$WORK/launches" "$WORK/config/tap" "$WORK/idle"
unset TAP_HOME
export TAP_INDEX_HOME="$WORK/index" REAL_TMUX REAL_PYTHON3 SOCKET LAUNCHES="$WORK/launches" XDG_CONFIG_HOME="$WORK/config"
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
if [ "${1:-}" = -S ]; then [ "$2" = "$SOCKET" ] || exit 99; shift 2; fi
exec "$REAL_TMUX" -S "$SOCKET" "$@"
TMUX
cat > "$WORK/bin/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *'ppid='*'tty='*) printf '1 %s\n' "${CALLER_TTY#/dev/}" ;;
  *) exec /bin/ps "$@" ;;
esac
PS
cat > "$WORK/bin/sh" <<'LOGIN_SHELL'
#!/bin/sh
PATH="${0%/*}:$PATH"; export PATH
if [ "${1:-}" = -lic ]; then shift; exec /bin/sh -c "$@"; fi
exec /bin/sh "$@"
LOGIN_SHELL
# The fake harness records argv and the clear id, answers the pending question
# the way a matching registration would, then idles under the harness's name.
cat > "$WORK/bin/claude" <<'HARNESS'
#!/bin/sh
if [ "${0##*/}" = opencode ]; then
  case "$1" in --version|api) exec "${TAP_SMOKE_BUN:?}" "$OPENCODE_FIXTURE" "$@" ;; esac
fi
{ printf 'TAP_CLEAR_ID=%s\n' "${TAP_CLEAR_ID:-}"; printf '%s\n' "$@"; } > "$LAUNCHES/$$"
if [ -n "${TAP_CLEAR_ID:-}" ]; then
  "$REAL_PYTHON3" - "$REG" "$TAP_CLEAR_ID" <<'PY'
import json, sys
reg, nonce = sys.argv[1], sys.argv[2]
doc = json.load(open(reg))
row = doc["seats"]["sol"]
if row.get("expected_clear_nonce") == nonce:
    row["clear_nonce"] = nonce
    json.dump(doc, open(reg, "w"))
PY
fi
exec "$IDLE/${0##*/}" 600
HARNESS
cp "$WORK/bin/claude" "$WORK/bin/opencode"
export OPENCODE_FIXTURE="$ROOT/runtime/bun/test/support/opencode-cli.ts" TAP_TEST_OPENCODE_LOG="$WORK/opencode-sessions"
ln -s /bin/sleep "$WORK/idle/claude"; ln -s /bin/sleep "$WORK/idle/opencode"; export IDLE="$WORK/idle"
chmod +x "$WORK/bin/tmux" "$WORK/bin/ps" "$WORK/bin/sh" "$WORK/bin/claude" "$WORK/bin/opencode"
export PATH="$WORK/bin:$PATH" TAP_LAUNCH_SHELL="$WORK/bin/sh"
printf 'version = 2\n' > "$WORK/config/tap/config.toml"; chmod 600 "$WORK/config/tap/config.toml"
T() { "$REAL_TMUX" -S "$SOCKET" "$@"; }
git -C "$WORK/Demo" init -q

export REG="$WORK/Demo/.tap/team-registry.json"
T new-session -d -s Demo/lead -c "$WORK/Demo"
T new-session -d -s Demo/sol -c "$WORK/Demo" "exec $IDLE/claude 600"
T new-session -d -s Demo/other -c "$WORK/Demo" "exec sleep 600"
pane() { T display-message -p -t "$1" '#{pane_id}'; }
pid() { T display-message -p -t "$1" '#{pane_pid}'; }
export TMUX="$SOCKET,0,0"
LEAD="$(pane Demo/lead:0.0)"; SOL="$(pane Demo/sol:0.0)"; OTHER="$(pane Demo/other:0.0)"
export TMUX_PANE="$LEAD" CALLER_TTY="$(T display-message -p -t "$LEAD" '#{pane_tty}')"
# Pane rows carry the live server generation: an unstamped row confers no identity.
EPOCH="srv:$(T display-message -p '#{pid}:#{start_time}')"
[ -n "$EPOCH" ] || fail "private tmux server reported no generation"
seed() { # seed <sol pane_id> <sol session> [harness]
  python3 - "$WORK" "$LEAD" "$1" "$2" "${3:-claude}" "$EPOCH" <<'PY'
import json, pathlib, sys
w = pathlib.Path(sys.argv[1]); lead, pane, session, harness, epoch = sys.argv[2:]
seat = lambda p, s, h: {"status": "active", "delivery": "pane", "harness": h, "pane_id": p, "pane": f"{s}:0.0",
                        "session": s, "registered_at": "t", "model": "fixture/opus-test" if h == "opencode" else "opus-test", "permissions": "bypass",
                        "harness_session_id": "old-conversation", "clear_nonce": "stale-witness", **({"server_epoch": epoch} if epoch else {})}
reg = w / "Demo/.tap/team-registry.json"
reg.write_text(json.dumps({"schema": "0.20", "team": {"name": "Demo"},
    "seats": {"lead": seat(lead, "Demo/lead", "claude"), "sol": seat(pane, session, harness)}}))
(w / "index/global-registry.json").write_text(json.dumps({"schema": "0.20", "teams": {"Demo": {
    "root": str(w / "Demo"), "registry_location": str(reg), "state": "registered", "enrolled_at": "t"}}}))
PY
}
field() { python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["seats"][sys.argv[2]]; print(json.dumps(r.get(sys.argv[3])))' "$REG" "$1" "$2"; }
tap_clear() { "$TAP" clear "$@"; }
run() { rc=0; out="$( "$@" 2>&1 )" || rc=$?; }
cd "$WORK/Demo"

# 1. Dry run: native route, a fresh command, the clear id, no writes.
seed "$SOL" Demo/sol
before_reg="$(cat "$REG")"
TRACE="$WORK/route.trace"
run env TAP_BUN_ROUTE_TRACE="$TRACE" "$TAP" clear sol --dry-run; [ "$rc" = 0 ] || fail "dry run failed: $out"
[ "$(cat "$TRACE")" = "native clear" ] || fail "clear did not route native: $(cat "$TRACE")"
grep -Eq 'TAP_CLEAR_ID=[0-9a-f-]{36}' <<<"$out" || fail "dry run hides TAP_CLEAR_ID (odt1d #2): $out"
grep -q -- 'claude' <<<"$out" && grep -q -- 'opus-test' <<<"$out" || fail "dry run lost the harness or the row model: $out"
grep -q -- 'old-conversation' <<<"$out" && fail "dry run reuses the old conversation: $out"
[ "$(cat "$REG")" = "$before_reg" ] || fail "dry run wrote the registry"
seed "$SOL" Demo/sol opencode
run tap_clear sol --dry-run -m "hello"; [ "$rc" = 0 ] || fail "opencode dry run failed: $out"
grep -q -- 'instruction rides tap send after rebind' <<<"$out" || fail "opencode dry run hides the bus channel: $out"
grep -q -- 'hello' <<<"$out" && fail "opencode dry run puts the instruction on argv: $out"
echo "clear-native-core: dry run routes native, fresh, shows the clear id: ok"

# A crew seat sharing its driver's session is cleared with its OWN row's
# recipe, never the session's (tap-uf67h).
CREW="$(T new-window -P -F '#{pane_id}' -t Demo/lead "exec $IDLE/opencode 600")"
seed "$CREW" Demo/lead opencode
run tap_clear sol --dry-run; [ "$rc" = 0 ] || fail "crew dry run failed: $out"
grep -q -- 'opencode --standalone' <<<"$out" && ! grep -q -- 'claude' <<<"$out" || fail "crew clear used another harness: $out"
T kill-window -t "$CREW"
echo "clear-native-core: a crew seat clears with its own recipe: ok"

# 2. Refusals: each exits 2 naming its cause, with nothing changed.
refuses() { # refuses <label> <verb> <phrase> [env...]
  local label="$1" verb="$2" phrase="$3"; shift 3
  local before; before="$(pid "$SOL")"
  run env "$@" "$TAP" "$verb" sol
  [ "$rc" = 2 ] || fail "$label: expected rc 2, got $rc: $out"
  grep -q -- "$phrase" <<<"$out" || fail "$label: phrase '$phrase' missing: $out"
  [ "$(field sol expected_clear_nonce)" = null ] || fail "$label: a refusal stamped the row"
  [ "$(pid "$SOL")" = "$before" ] || fail "$label: a refusal replaced the pane process"
}
seed "%999" Demo/sol; refuses "pane gone" clear "that pane is gone"
# Only a LEGACY unstamped row still reaches the session-name recycle check: a row stamped with the live
# generation proves its pane id current, so its session is read from the pane itself.
EPOCH= seed "$OTHER" Demo/sol; refuses "recycled session" clear "the id has been recycled"
seed "$SOL" Demo/sol; refuses "self clear" clear "from inside its own pane" CALLER_TTY="$(T display-message -p -t "$SOL" '#{pane_tty}')"
refuses "unprovable caller" clear "cannot identify its own pane" CALLER_TTY="??"
seed "$SOL" Demo/sol bogus; refuses "unknown harness" clear "launch recipe"
seed "$SOL" Demo/sol
# N3: refresh's in-process clear gets no caller from its own caller; the core
# observes the calling pane itself and fails closed when it cannot.
refuses "refresh, unprovable caller" refresh "cannot identify its own pane" CALLER_TTY="??"
echo "clear-native-core: refusals (gone, recycled, self, unprovable, unknown harness, refresh unprovable): ok"

# 3. A real respawn in place.
seed "$SOL" Demo/sol
before="$(pid "$SOL")"
run tap_clear sol
[ "$rc" = 0 ] && grep -q "cleared sol (claude) in place at $SOL" <<<"$out" || fail "clear failed (rc $rc): $out"
now="$(pid "$SOL")"; [ "$now" != "$before" ] || fail "the pane process was not replaced"
[ "$(pane Demo/sol:0.0)" = "$SOL" ] || fail "pane id changed"
rec="$LAUNCHES/$now"; [ -s "$rec" ] || fail "no launch record for the fresh process"
nonce="$(sed -n 's/^TAP_CLEAR_ID=//p' "$rec")"; [ -n "$nonce" ] || fail "fresh process carried no TAP_CLEAR_ID"
grep -q -- 'old-conversation' "$rec" && fail "clear resumed the old conversation: $(cat "$rec")"
grep -qx -- 'opus-test' "$rec" || fail "row model missing from argv: $(cat "$rec")"
[ "$(field sol clear_nonce)" = "\"$nonce\"" ] || fail "witness not recorded: $(field sol clear_nonce)"
[ "$(field sol expected_clear_nonce)" = null ] || fail "expectation not consumed"
[ ! -s "$WORK/Demo/.tap/bus/clear-fence/sol.json" ] || fail "fence not released: $(cat "$WORK/Demo/.tap/bus/clear-fence/sol.json")"
[ -e "$WORK/Demo/.tap/bus/clear-fence/sol.json" ] || fail "fence marker unlinked; release must truncate in place"
grep -q '"handle":"sol".*"verified":true' "$WORK/Demo/.tap/clear-latency.jsonl" || fail "no latency line"
[ "$(T show-options -p -t "$SOL" -v remain-on-exit 2>/dev/null)" = off ] || fail "remain-on-exit left armed"
echo "clear-native-core: real respawn in place, witnessed, consumed, fence released: ok"

# 4. opencode -m: no argv channel, so the instruction rides an in-process send
# after the rebind, while this process still holds the fence.
seed "$SOL" Demo/sol opencode
run tap_clear sol -m "hello from the clear"
[ "$rc" = 0 ] && grep -q "cleared sol (opencode) in place at $SOL" <<<"$out" || fail "opencode clear failed (rc $rc): $out"
grep -q -- 'hello from the clear' "$LAUNCHES/$(pid "$SOL")" && fail "opencode instruction rode argv"
grep -rlq -- 'hello from the clear' "$WORK/Demo/.tap/bus" || fail "opencode instruction never reached the bus: $out"
[ -z "$(find "$WORK/Demo/.tap/bus/tmp" -name '.tap-clear-instruction.*' 2>/dev/null)" ] || fail "instruction body file left behind"
python3 - "$LAUNCHES/$(pid "$SOL")" "$TAP_TEST_OPENCODE_LOG" <<'PY_MODEL'
import json, pathlib, sys
argv = pathlib.Path(sys.argv[1]).read_text().splitlines()
prepared = json.loads(pathlib.Path(sys.argv[2]).read_text().splitlines()[-1])
assert prepared["model"] == {"providerID": "fixture", "id": "opus-test"}, prepared
assert argv[argv.index("--session") + 1] == prepared["id"], (argv, prepared)
assert "--model" not in argv, argv
PY_MODEL
echo "clear-native-core: opencode -m rides the bus after rebind: ok"
echo "clear-native-core: ok"
