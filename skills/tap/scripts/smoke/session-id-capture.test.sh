#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# session-id-capture.test.sh — tap-4hn direct harness identity + SessionStart restamp.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z: TAP_HOME alone does not move the machine index — a directly invoked
# body without these pins can write the operator's machine-wide state.
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
CLAUDE_HOOK="$ROOT/hooks/tap-advisory.sh"
CODEX_HOOK="$ROOT/hooks/tap-codex-session-start.sh"
CURSOR_HOOK="$ROOT/hooks/tap-cursor-session-start.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MOCKBIN="$WORK/bin"
mkdir -p "$MOCKBIN"
# SessionStart binds only a hook that descends from the pane's own harness, so
# this ps shows a real-shaped chain: the hook (this script's parent, the calling bun
# process) -> a wrapper (4243) -> the seat's harness, which is the pane pid 4242.
cat > "$MOCKBIN/ps" <<'PS'
#!/usr/bin/env bash
harness="${FAKE_HARNESS:-codex}"
case "$*" in
  *pid=,pgid=,tpgid=,comm=,command=*)
    printf '%s 4243 4243 bun bun /repo/session-start.ts\n4243 4242 4242 sh sh -c hook\n4242 4242 4242 %s %s\n' "$PPID" "$harness" "$harness" ;;
  *tty=*) printf '1 faketty\n' ;;
  *ppid=*)
    case "${*: -1}" in
      4243) printf '4242\n' ;;
      4242) printf '1\n' ;;
      *) printf '4243\n' ;;
    esac ;;
  *) printf '1 faketty\n' ;;
esac
PS
chmod +x "$MOCKBIN/ps"
cat > "$MOCKBIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
pane_id_for() {
  local known="${FAKE_PANE_ID:-%99999}" query="${1:-}"
  if [ -z "$query" ]; then
    printf '%s' "$known"
    return 0
  fi
  case "$query" in
    "$known"|"${FAKE_SESSION:-capture-sol-0}:0.0") printf '%s' "$known" ;;
    *) return 1 ;;
  esac
}
tty_for() {
  pane_id_for "$1" >/dev/null || return 1
  printf '/dev/faketty'
}
[ "${1:-}" = list-panes ] && {
  if [[ "$*" == *pane_tty* ]]; then
    printf '%s\t/dev/faketty\n' "$(pane_id_for)"
  else
    printf '%s\t%s:0.0\t%s\t%s\t4242\t4242:100\t0\n' "${FAKE_SESSION:-capture-sol-0}" "${FAKE_SESSION:-capture-sol-0}" "$(pane_id_for)" "${FAKE_HARNESS:-codex}"
  fi
  exit 0
}
[ "${1:-}" = list-sessions ] && { printf '%s\t4242:100\t1\n' "${FAKE_SESSION:-capture-sol-0}"; exit 0; }
[ "${1:-}" = display-message ] || exit 0
shift
target=""; fmt=""
    while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) target="$2"; shift 2 ;;
    *) fmt="$1"; shift ;;
  esac
    done
    if [ "$target" = "%99998" ]; then echo "can't find pane: $target" >&2; exit 1; fi
pane_id="${FAKE_PANE_ID:-%99999}"
session="${FAKE_SESSION:-capture-sol-0}"
case "$fmt" in
  # Bun's combined nine-field caller record — precedes the pane globs.
  *pane_id*pane_tty*session_name*socket_path*pane_current_path*)
    resolved="$(pane_id_for "${target:-$pane_id}" || true)"
    [ -n "$resolved" ] || exit 0
    printf '%s\t%s\t%s\t4242:100\t%s:0.0\t4242\t%s\t%s\t%s\n' "$resolved" "$(tty_for "$resolved")" "$session" "$session" "${FAKE_HARNESS:-codex}" "$(python3 -B -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}")" "${FAKE_TMUX_PATH:-$PWD}" ;;
  # Bun's combined eight-field pane record.
  *pane_id*session_name*pane_pid*pane_current_command*socket_path*)
    resolved="$(pane_id_for "${target:-$pane_id}" || true)"
    [ -n "$resolved" ] || exit 0
    printf '%s\t%s\t4242\t%s\t0\t%s:0.0\t%s\t%s\n' "$resolved" "$session" "${FAKE_HARNESS:-codex}" "$session" "$(python3 -B -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}")" "${FAKE_TMUX_PATH:-$PWD}" ;;
  # Native calling observe (pane_id+session_name+pane_pid+current_command).
  *pane_id*session_name*pane_pid*pane_current_command*)
    resolved="$(pane_id_for "${target:-$pane_id}" || true)"
    [ -n "$resolved" ] || exit 0
    printf '%s\t%s\t4242\t%s\t0\n' "$resolved" "$session" "${FAKE_HARNESS:-codex}" ;;
  # Four-field calling observe. *pane_id*session_name* also matches that
  # string and would put the session name in the pane_tty slot (tap-316wj).
  *pane_id*pane_tty*session_name*)
    resolved="$(pane_id_for "${target:-$pane_id}" || true)"
    [ -n "$resolved" ] || exit 0
    printf '%s\t%s\t%s\t4242:100\n' "$resolved" "$(tty_for "$resolved")" "$session" ;;
  *pane_id*session_name*) printf '%s\t%s\t4242:100\n' "$pane_id" "$session" ;;
  *pane_id*pane_tty*)
    resolved="$(pane_id_for "${target:-$pane_id}" || true)"
    [ -n "$resolved" ] || exit 0
    printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")" ;;
  *window_index*) printf '%s:0.0\n' "$session" ;;
  *pid*start_time*) printf '4242:100\n' ;;
  *socket_path*) python3 -B -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}" ;;
  *session_name*) printf '%s\n' "$session" ;;
  *pane_id*) printf '%s\n' "$pane_id" ;;
  *pane_pid*) printf '4242\n' ;;
  *pane_current_command*) printf '%s\n' "${FAKE_HARNESS:-codex}" ;;
  *pane_current_path*) printf '%s\n' "${FAKE_TMUX_PATH:-$PWD}" ;;
  *) printf '\n' ;;
esac
TMUX
chmod +x "$MOCKBIN/tmux"
# Quoted heredoc (tap-psif class): PATH-shadowed tap stubs must not use unquoted
# heredocs — one prose backtick in a comment becomes a live fork bomb.
export _TAP_SHIM_TAP="$TAP"
cat > "$MOCKBIN/tap" <<'TAP'
#!/usr/bin/env bash
exec bash "${_TAP_SHIM_TAP:?}" "$@"
TAP
chmod +x "$MOCKBIN/tap"

TEAM="$(basename "$ROOT")"
export PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake,1,0" FAKE_TMUX_PATH="$ROOT"

seed_current_bus() {
  local bus="$1" root="${2:-$1/$TEAM}"
  mkdir -p "$root"
  git -C "$root" init -q
  tap_smoke_enroll_current "$root" "$bus"
  export FAKE_TMUX_PATH="$root"
  cd "$root"
}

# A target outside the fixture's pane map must not produce a composite binding.
unknown_binding="$(tmux display-message -p -t %tap-bzyz-unknown $'#{pane_id}\t#{pane_tty}' 2>/dev/null || true)"
[ -z "$unknown_binding" ] || {
  echo "session-id-capture: unknown-pane recheck returned '$unknown_binding'" >&2
  exit 1
}
echo "session-id-capture: unknown-pane recheck returns no binding: ok"

# ── tap-52ys: 4 of 6 arms removed (ratified 2026-08-14) ─────────────────────
# Two arms carry it: `tap register` captures the direct harness env ids, and a
# matched-pane duplicate owner REFUSES adoption (the destructive direction —
# adopting a live seat's identity is how two agents end up answering as one).
#
# Accepted gap, named: the unknown-pane recheck, dead-pane duplicate refusal,
# the acting-registry quarantine scope, and the adapter forward/degrade matrix.


write_legacy_journal() { # <path> <handle> <harness> [id]
  python3 -B - "$1" "$ROOT" "$TEAM" "$2" "$3" "${4:-}" <<'PY'
import json, os, sys
path, root, team, handle, harness, sid = sys.argv[1:7]
os.makedirs(os.path.dirname(path), exist_ok=True)
row = {
    "name": f"{team}/{handle}", "harness": harness, "cwd": root,
    "base": team, "tag": handle, "index": 1, "model": None,
    "teams": False, "harness_session_id": sid or None,
}
with open(path, "w") as fh:
    json.dump({"dir_aliases": {}, "sessions": [row]}, fh)
    fh.write("\n")
PY
}

json_field() { # <file> <path component>...
  python3 -B - "$@" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
value = data
for component in sys.argv[2:]:
    value = value[int(component)] if isinstance(value, list) else value[component]
print(value)
PY
}

run_direct_capture() { # <handle> <harness command> <env name> <id>
  local handle="$1" harness="$2" env_name="$3" sid="$4"
  local bus="$WORK/$handle-bus" manifest="$WORK/$handle-sessions.json"
  mkdir -p "$bus/payloads" "$bus/receipts"
  seed_current_bus "$bus"
  write_legacy_journal "$manifest" "$handle" "${harness/cursor-agent/cursor}"
  tap_smoke_quiet env TAP_HOME="$bus" TAP_SESSION_MANIFEST="$manifest" FAKE_SESSION="${TEAM}-${handle}-0" \
    FAKE_HARNESS="$harness" "$env_name=$sid" \
    "$TAP" register "$handle"
  [ "$(json_field "$bus/registry.json" seats "$handle" harness_session_id)" = "$sid" ] \
    || { echo "session-id-capture: $env_name did not stamp registry" >&2; exit 1; }
  [ "$(json_field "$manifest" sessions 0 harness_session_id)" = None ] \
    || { echo "session-id-capture: core registration crossed into launcher manifest state" >&2; exit 1; }
}

run_direct_capture sol codex CODEX_THREAD_ID codex-direct-id
run_direct_capture grok cursor-agent CURSOR_CONVERSATION_ID cursor-direct-id
run_direct_capture glm opencode OPENCODE_SESSION_ID opencode-direct-id

# A bare direct capture ignores the launcher's default journal even when no
# TAP_SESSION_MANIFEST override is present. Historical provenance cannot own
# the native id of a current registry row.
DEFAULT_HOME="$WORK/default-home"
DEFAULT_BUS="$WORK/default-manifest-bus"
DEFAULT_MANIFEST="$DEFAULT_HOME/.tap/launcher/sessions.json"
mkdir -p "$DEFAULT_BUS/payloads" "$DEFAULT_BUS/receipts"
seed_current_bus "$DEFAULT_BUS"
write_legacy_journal "$DEFAULT_MANIFEST" fable codex default-manifest-owned-id
cp "$DEFAULT_MANIFEST" "$WORK/default-manifest.before"
DEFAULT_WARNING="$WORK/default-manifest-warning.err"
env -u TAP_SESSION_MANIFEST HOME="$DEFAULT_HOME" TAP_HOME="$DEFAULT_BUS" \
  CODEX_THREAD_ID=default-manifest-owned-id \
  FAKE_SESSION="${TEAM}-opus-0" FAKE_PANE_ID=%54 FAKE_HARNESS=codex \
  "$TAP" register opus >/dev/null 2>"$DEFAULT_WARNING"
python3 -B - "$DEFAULT_BUS/registry.json" <<'PY'
import json, sys
opus = json.load(open(sys.argv[1]))["seats"]["opus"]
assert opus["harness_session_id"] == "default-manifest-owned-id", opus
assert "quarantined_harness_session_id" not in opus, opus
PY
cmp -s "$WORK/default-manifest.before" "$DEFAULT_MANIFEST" \
  || { echo "session-id-capture: default journal changed during registry capture" >&2; exit 1; }
if grep -q 'quarantined captured harness identity' "$DEFAULT_WARNING"; then
  echo "session-id-capture: historical journal incorrectly influenced registry capture" >&2
  cat "$DEFAULT_WARNING" >&2
  exit 1
fi

# A native id already held by another row on this machine is never copied into
# a second seat, even when both captures are otherwise direct and well-formed.
DUP_BUS="$WORK/duplicate-bus"
mkdir -p "$DUP_BUS/payloads" "$DUP_BUS/receipts"
seed_current_bus "$DUP_BUS"
tap_smoke_quiet env TAP_HOME="$DUP_BUS" TAP_HARNESS_SESSION_ID=shared-native-id \
  FAKE_SESSION="${TEAM}-fable-0" FAKE_PANE_ID=%51 FAKE_HARNESS=claude \
  "$TAP" register fable
FAIL_REPLACE_SITE="$WORK/fail-replace-site"
mkdir -p "$FAIL_REPLACE_SITE"
cat > "$FAIL_REPLACE_SITE/sitecustomize.py" <<'PY'
import json, os

_real_replace = os.replace
def fail_quarantine_replace(source, destination, *args, **kwargs):
    if os.path.realpath(destination) == os.path.realpath(os.environ["TAP_TEST_FAIL_REGISTRY"]):
        with open(source) as fh:
            candidate = json.load(fh)
        row = candidate.get("seats", {}).get("opus", {})
        # This is the intended final write, not initialization or a sidecar.
        if row.get("identity_capture_result", {}).get("decision") == "quarantined":
            assert "harness_session_id" not in row, row
            assert row.get("quarantined_harness_session_id") == "shared-native-id", row
            with open(os.environ["TAP_TEST_REPLACE_HIT"], "w") as fh:
                fh.write("quarantine candidate reached registry replace\n")
            raise PermissionError("injected registry replace failure")
    return _real_replace(source, destination, *args, **kwargs)
os.replace = fail_quarantine_replace
PY
cp "$DUP_BUS/registry.json" "$WORK/pre-failed-replace.json"
# Current-contract twin of the incumbent's injected os.replace failure: the
# native writer commits by atomic rename inside the bus directory, so a
# read-only bus directory is the same "commit fails after the decision" seam.
# The pins are unchanged: a failed transaction mutates nothing and announces
# no committed registration outcome.
FAIL_REPLACE_OUT="$WORK/failed-replace.out"
chmod 555 "$DUP_BUS"
if env TAP_HOME="$DUP_BUS" TAP_HARNESS_SESSION_ID=shared-native-id \
  FAKE_SESSION="${TEAM}-opus-0" FAKE_PANE_ID=%52 FAKE_HARNESS=claude \
  "$TAP" register opus >"$FAIL_REPLACE_OUT" 2>&1; then
  chmod 755 "$DUP_BUS"
  echo "session-id-capture: injected failed replace reported success" >&2
  exit 1
fi
chmod 755 "$DUP_BUS"
cmp "$WORK/pre-failed-replace.json" "$DUP_BUS/registry.json" \
  || { echo "session-id-capture: failed replace mutated the saved registry" >&2; exit 1; }
# The warning guard kills the old implementation: its warning was printed
# before os.replace, then relayed in the failed transaction's stderr detail.
if grep -Ei 'quarantined captured harness identity|tap register: (registered|reactivated|updated)|registration saved|saved registration|TAP address:' "$FAIL_REPLACE_OUT"; then
  echo "session-id-capture: failed transaction announced a committed registration outcome" >&2
  exit 1
fi
echo "session-id-capture: failed replace retains registry and emits no committed outcome: ok"


DUP_WARNING="$WORK/duplicate-warning.err"
env TAP_HOME="$DUP_BUS" TAP_HARNESS_SESSION_ID=shared-native-id \
  FAKE_SESSION="${TEAM}-opus-0" FAKE_PANE_ID=%52 FAKE_HARNESS=claude \
  "$TAP" register opus >/dev/null 2>"$DUP_WARNING"
python3 -B - "$DUP_BUS/registry.json" <<'PY'
import json, sys
seats = json.load(open(sys.argv[1]))["seats"]
assert seats["fable"]["harness_session_id"] == "shared-native-id", seats
assert "harness_session_id" not in seats["opus"], seats
assert seats["opus"]["quarantined_harness_session_id"] == "shared-native-id", seats
assert "expected seat" in seats["opus"]["identity_quarantine_reason"], seats
PY
grep -q 'WARNING: quarantined captured harness identity for opus' "$DUP_WARNING" \
  || { echo "session-id-capture: duplicate machine-row quarantine was silent" >&2; cat "$DUP_WARNING" >&2; exit 1; }
grep -Fq "seat registration saved for $TEAM/opus" "$DUP_WARNING"
grep -q 'identity was not accepted' "$DUP_WARNING"
actual_address="$(env TAP_HOME="$DUP_BUS" FAKE_SESSION="${TEAM}-opus-0" \
  FAKE_PANE_ID=%52 FAKE_HARNESS=claude "$TAP" whoami --pane %52)"
[ "$actual_address" = opus ] || { echo "session-id-capture: saved quarantine lost its TAP address" >&2; exit 1; }

# Matched-pane duplicate-owner is still a refusal (the ordering pin: duplicate
# ownership wins over any later drift classification).
python3 -B - "$DUP_BUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; data = json.load(open(p)); row = dict(data["seats"]["fable"])
row.update(name="opus", pane_id="%51", pane="%51", harness_session_id="old-opus-id", identity_capture={"mode":"unattested"})
data["seats"]["opus"] = row
with open(p, "w") as fh: json.dump(data, fh); fh.write("\n")
PY
SAME_WARNING="$WORK/duplicate-same-pane.err"
env TAP_HOME="$DUP_BUS" TAP_HARNESS_SESSION_ID=shared-native-id FAKE_SESSION="${TEAM}-opus-0" FAKE_PANE_ID=%51 FAKE_HARNESS=claude \
  "$TAP" register opus --pane %51 >/dev/null 2>"$SAME_WARNING" || true
[ "$(json_field "$DUP_BUS/registry.json" seats opus harness_session_id)" = old-opus-id ] || { echo "session-id-capture: same-pane duplicate was adopted" >&2; exit 1; }
grep -q 'already belongs to expected seat' "$SAME_WARNING" || { echo "session-id-capture: same-pane duplicate lacked quarantine" >&2; exit 1; }
echo "session-id-capture: matched-pane duplicate owner refuses adoption: ok"



# The shared SessionStart hook must relay the registry-side quarantine warning
# even when no launcher manifest exists to restamp.
NO_MANIFEST_REPO="$WORK/no-manifest-repo"
NO_MANIFEST_BUS="$NO_MANIFEST_REPO/.tap/bus"
NO_MANIFEST_TEAM="$(basename "$NO_MANIFEST_REPO")"
mkdir -p "$NO_MANIFEST_BUS/payloads" "$NO_MANIFEST_BUS/receipts"
seed_current_bus "$NO_MANIFEST_BUS" "$NO_MANIFEST_REPO"
(
  cd "$NO_MANIFEST_REPO"
  tap_smoke_quiet env TAP_HOME="$NO_MANIFEST_BUS" TAP_HARNESS_SESSION_ID=shared-hook-id \
    FAKE_SESSION="${NO_MANIFEST_TEAM}/fable" FAKE_PANE_ID=%53 \
    FAKE_HARNESS=claude FAKE_TMUX_PATH="$NO_MANIFEST_REPO" \
    "$TAP" register fable
)
NO_MANIFEST_WARNING="$WORK/no-manifest-warning.err"
(
  cd "$NO_MANIFEST_REPO"
  printf '{"hook_event_name":"SessionStart","source":"resume","session_id":"shared-hook-id"}\n' \
  | env PATH="$PATH" HOME="$WORK" TMUX="$TMUX" TAP_HOME="$NO_MANIFEST_BUS" \
      CLAUDE_PROJECT_DIR="$NO_MANIFEST_REPO" FAKE_TMUX_PATH="$NO_MANIFEST_REPO" \
      FAKE_SESSION="${NO_MANIFEST_TEAM}/sol" FAKE_PANE_ID=%57 FAKE_HARNESS=claude \
      bash "$CLAUDE_HOOK" >/dev/null 2>"$NO_MANIFEST_WARNING"
)
python3 -B - "$NO_MANIFEST_BUS/registry.json" <<'PY'
import json, sys
seats = json.load(open(sys.argv[1]))["seats"]
assert seats["fable"]["harness_session_id"] == "shared-hook-id", seats
assert "harness_session_id" not in seats["sol"], seats
assert seats["sol"]["quarantined_harness_session_id"] == "shared-hook-id", seats
PY
[[ "$(grep -c 'WARNING: quarantined captured harness identity for sol' "$NO_MANIFEST_WARNING")" = 1 ]] \
  || { echo "session-id-capture: hook hid registry quarantine without a manifest" >&2; cat "$NO_MANIFEST_WARNING" >&2; exit 1; }
grep -q 'seat registration saved for sol' "$NO_MANIFEST_WARNING"
grep -q 'identity was not accepted' "$NO_MANIFEST_WARNING"

# Empty values preserve identity for the same harness, but a harness takeover
# must never inherit another harness's native identity or transcript key.
DIRECT_BUS="$WORK/sol-bus"
seed_current_bus "$DIRECT_BUS"
tap_smoke_quiet env -u CODEX_THREAD_ID -u CURSOR_CONVERSATION_ID -u OPENCODE_SESSION_ID \
  -u TAP_HARNESS_SESSION_ID -u TAP_TRANSCRIPT_PATH \
  TAP_HOME="$DIRECT_BUS" FAKE_SESSION="${TEAM}-sol-0" FAKE_HARNESS=codex \
  "$TAP" register sol
[ "$(json_field "$DIRECT_BUS/registry.json" seats sol harness_session_id)" = codex-direct-id ] \
  || { echo "session-id-capture: same-harness empty register discarded identity" >&2; exit 1; }
tap_smoke_quiet env -u CODEX_THREAD_ID -u CURSOR_CONVERSATION_ID -u OPENCODE_SESSION_ID \
  -u TAP_HARNESS_SESSION_ID -u TAP_TRANSCRIPT_PATH \
  TAP_HOME="$DIRECT_BUS" FAKE_SESSION="${TEAM}-sol-0" FAKE_HARNESS=cursor-agent \
  "$TAP" register sol
python3 -B - "$DIRECT_BUS/registry.json" <<'PY'
import json, sys
entry = json.load(open(sys.argv[1]))["seats"]["sol"]
assert entry["harness"] == "cursor"
assert "harness_session_id" not in entry
assert "transcript_path" not in entry
PY
echo "session-id-capture: 1/4 - tap register captures direct harness env ids: ok"

echo "session-id-capture: ok"
