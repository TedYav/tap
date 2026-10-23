#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# crew-add.test.sh — one-command crew spawn, filtered roster, and cwd override.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
FAKE_BIN="$WORK/bin"
OUTSIDE="$WORK/outside"
# 2c85b3971 (tap-mxf95): crew add resolves --cwd through the caller selector
# with no ambient TAP_HOME, and refuses crew_registry_mismatch unless that cwd
# selects the launcher's acting registry. An unenrolled cwd selects its git
# root's default bus, so the launcher's bus must BE that default: a temp git
# root with the bus at <root>/.tap/bus, and the fixture runs from inside it.
# The fixture directory basename IS the team name: first-entry enroll derives
# the enrolled name from basename(root), so a directory named `team` would fold
# the seeded CrewAdd bus into an acting store under a different name and redden
# the roster header itself. Keep them the same word instead.
TEAM="$WORK/CrewAdd"
SIDE="$TEAM/side"
TMUX_STATE="$WORK/tmux-state"
REAL_BASH="$(command -v bash)"
REAL_PYTHON3="$(command -v python3)"
mkdir -p "$FAKE_BIN" "$OUTSIDE" "$SIDE" "$TMUX_STATE" "$TEAM/.tap/bus/payloads" "$TEAM/.tap/bus/receipts"
# Crew add arms a supervised lifetime binding (crew-lifetime.ts) that reads REAL
# process generations: the parent pane's pid must classify as a harness and have
# a readable start time, and the child pane's pid must be a live process too. A
# fixed fake pid is not a process. The fixture therefore runs two real idle
# processes and reports their pids from the tmux mock. Both are a bash running a
# script NAMED codex (the crew pane runs a codex too, so registration may certify
# either pane's process as that harness) -- the process-table classifier keys on any command
# word whose basename is a harness family. (A copy of /bin/sleep named codex does
# not work: a copied platform binary is killed by code signing.) Cleanup stops
# only pids this fixture recorded: the two idle processes and the helper pid a
# binding stored.
mkdir -p "$WORK/procs"
printf '%s\n' 'exec 3<>"$1"; read -r -t 3600 -u 3 || true' > "$WORK/procs/codex"
mkfifo "$WORK/procs/parent.fifo" "$WORK/procs/child.fifo"
"$REAL_BASH" "$WORK/procs/codex" "$WORK/procs/parent.fifo" </dev/null >/dev/null 2>&1 & printf '%s\n' "$!" > "$TMUX_STATE/parent.pid"
"$REAL_BASH" "$WORK/procs/codex" "$WORK/procs/child.fifo" </dev/null >/dev/null 2>&1 & printf '%s\n' "$!" > "$TMUX_STATE/child.pid"
cleanup_fixture() {
  local pid helper
  for helper in "$TMUX_STATE"/opt.*; do
    [ -f "$helper" ] || continue
    case "$helper" in *@tap_crew_lifetime) ;; *) continue ;; esac
    pid="$(sed -n 's/.*"helper":{"pid":"\([0-9][0-9]*\)".*/\1/p' "$helper" | head -n 1)"
    [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  done
  for pid in "$(cat "$TMUX_STATE/parent.pid" 2>/dev/null)" "$(cat "$TMUX_STATE/child.pid" 2>/dev/null)"; do
    [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  done
  rm -rf "${WORK:?}"
}
trap cleanup_fixture EXIT
git -C "$TEAM" init -q
OUTSIDE_REAL="$(cd "$OUTSIDE" && pwd -P)"
SIDE_REAL="$(cd "$SIDE" && pwd -P)"
TEAM_REAL="$(cd "$TEAM" && pwd -P)"
export TAP_HOME="$TEAM/.tap/bus" TAP_INDEX_HOME="$WORK/index" TAP_SESSION_MANIFEST="$WORK/sessions.json"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" TAP_SELF="driver"
export FAKE_TMUX_STATE="$TMUX_STATE" FAKE_DRIVER_SESSION="demo/driver"
export TEAM_REAL

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
# Registration's pinned observer supplies the socket before the command.
case "${1:-}" in -S|-L) shift 2 ;; esac
cmd="${1:-}"; shift || true
PARENT_PID="$(cat "$FAKE_TMUX_STATE/parent.pid")"; CHILD_PID="$(cat "$FAKE_TMUX_STATE/child.pid")"
# One pane, one process identity: every observation form derives the pane pid from
# the resolved pane through this function (the driver pane runs the parent
# process, the crew pane the child process).
pane_pid_for() {
  case "$1" in
    %82) printf '%s' "$PARENT_PID" ;;
    %81) printf '%s' "$CHILD_PID" ;;
    %80) printf '112' ;;
    *) printf '113' ;;
  esac
}
pane_id_for() {
  case "$1" in
    %81|demo/driver:1.0) printf '%%81' ;;
    %80|other/session:0.0) printf '%%80' ;;
    %83|demo/driver:2.0) printf '%%83' ;;
    *) printf '%%82' ;;
  esac
}
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  case "$1" in
    %82) printf '/dev/faketty' ;;
    %81) printf '/dev/crewtty' ;;
    %80) printf '/dev/othertty' ;;
    %83) printf '/dev/collisiontty' ;;
    *) return 1 ;;
  esac
}
case "$cmd" in
  new-window)
    printf '%s\n' "$*" > "$FAKE_TMUX_STATE/new-window.args"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -c) printf '%s\n' "$2" > "$FAKE_TMUX_STATE/pane.path"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'zsh\n' > "$FAKE_TMUX_STATE/pane.command"
    if [ -s "$FAKE_TMUX_STATE/new-pane-id" ]; then
      cat "$FAKE_TMUX_STATE/new-pane-id"
    else
      printf '%%81\n'
    fi
    ;;
  send-keys)
    printf '%s\n' "$*" >> "$FAKE_TMUX_STATE/send-keys.args"
    case " $* " in
      *' codex '*) printf 'codex\n' > "$FAKE_TMUX_STATE/pane.command" ;;
      *' claude '*) printf 'claude\n' > "$FAKE_TMUX_STATE/pane.command" ;;
      *' opencode '*) printf 'opencode\n' > "$FAKE_TMUX_STATE/pane.command" ;;
      *' cursor-agent '*) printf 'cursor\n' > "$FAKE_TMUX_STATE/pane.command" ;;
      *' hermes '*) printf 'hermes\n' > "$FAKE_TMUX_STATE/pane.command" ;;
    esac
    ;;
  kill-window)
    printf '%s\n' "$*" > "$FAKE_TMUX_STATE/kill-window.args"
    ;;
  # Pane options (the crew lifetime binding and its token): one file per
  # pane+name, written by set-option -p and read by show-options -p -v.
  set-option)
    pane=""; _words=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) pane="$2"; shift 2 ;;
        *) _words+=("$1"); shift ;;
      esac
    done
    [ -z "$pane" ] || [ "${#_words[@]}" -lt 2 ] || printf '%s' "${_words[1]}" > "$FAKE_TMUX_STATE/opt.$(pane_id_for "$pane").${_words[0]}"
    ;;
  show-options)
    pane=""; _words=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p|-v) shift ;;
        -t) pane="$2"; shift 2 ;;
        *) _words+=("$1"); shift ;;
      esac
    done
    [ -z "$pane" ] || [ "${#_words[@]}" -lt 1 ] || cat "$FAKE_TMUX_STATE/opt.$(pane_id_for "$pane").${_words[0]}" 2>/dev/null || true
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="$2"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    case "$fmt" in
      # crew-lifetime.ts paneFacts: seven TAB fields -- pane id, session name,
      # $session id, @window id, pane pid, raw server generation, socket. The pane
      # pids match the list-panes snapshot below, so every observation of one pane
      # agrees; the ids are derived from the pane number.
      *session_id*window_id*pane_pid*)
        resolved="$(pane_id_for "$target")"
        session="$FAKE_DRIVER_SESSION"
        case "$resolved" in %80) session="other/session" ;; esac
        pane_pid="$(pane_pid_for "$resolved")"
        printf '%s\t%s\t$%s\t@%s\t%s\t900:100\t/fake/socket\n' "$resolved" "$session" "${resolved#%}" "${resolved#%}" "$pane_pid" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        session="$FAKE_DRIVER_SESSION"
        case "$target" in %80|other/session:0.0) session="other/session" ;; esac
        command="$(cat "$FAKE_TMUX_STATE/pane.command" 2>/dev/null || printf zsh)"
        printf '%s\t%s\t%s\t%s\t0\n' "$(pane_id_for "$target")" "$session" "$(pane_pid_for "$(pane_id_for "$target")")" "$command" ;;
      '#{pid}:#{start_time}') printf '900:100\n' ;;
      *pane_current_command*) cat "$FAKE_TMUX_STATE/pane.command" 2>/dev/null || printf 'zsh\n' ;;
      *pane_current_path*) cat "$FAKE_TMUX_STATE/pane.path" 2>/dev/null || printf '%s\n' "$PWD" ;;
      *session_attached*) printf '1\n' ;;
      *pane_pid*) printf '%s\n' "$(pane_pid_for "$(pane_id_for "$target")")" ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*)
        resolved="$(pane_id_for "$target")"
        case "$target" in
          %81|demo/driver:1.0) printf '%s\t%s\t%s\t900:100\n' "$resolved" "$(tty_for "$resolved")" "$FAKE_DRIVER_SESSION" ;;
          %80|other/session:0.0) printf '%s\t%s\tother/session\t900:100\n' "$resolved" "$(tty_for "$resolved")" ;;
          %83|demo/driver:2.0) printf '%s\t%s\t%s\t900:100\n' "$resolved" "$(tty_for "$resolved")" "$FAKE_DRIVER_SESSION" ;;
          *) printf '%s\t%s\t%s\t900:100\n' "$resolved" "$(tty_for "$resolved")" "$FAKE_DRIVER_SESSION" ;;
        esac
        ;;
      *pane_id*session_name*)
        case "$target" in
          %81|demo/driver:1.0) printf '%%81\t%s\n' "$FAKE_DRIVER_SESSION" ;;
          %80|other/session:0.0) printf '%%80\tother/session\n' ;;
          %83|demo/driver:2.0) printf '%%83\t%s\n' "$FAKE_DRIVER_SESSION" ;;
          *) printf '%%82\t%s\n' "$FAKE_DRIVER_SESSION" ;;
        esac
        ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id_for "$target")"
        printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")"
        ;;
      # tap-fgx9: crew add resolves #{session_name}:#{window_index}.#{pane_index}
      # after new-window so the registry stores an address, not a bare %id.
      *session_name*:*window_index*|*session_name}:#{window_index}*)
        case "$target" in
          %81|demo/driver:1.0) printf '%s:1.0\n' "$FAKE_DRIVER_SESSION" ;;
          %80|other/session:0.0) printf 'other/session:0.0\n' ;;
          %82|demo/driver:0.0) printf '%s:0.0\n' "$FAKE_DRIVER_SESSION" ;;
          %83|demo/driver:2.0) printf '%s:2.0\n' "$FAKE_DRIVER_SESSION" ;;
          *) printf '%s:9.9\n' "$FAKE_DRIVER_SESSION" ;;
        esac
        ;;
      *pane_id*) pane_id_for "$target"; printf '\n' ;;
      *session_name*)
        [ "$target" = "%82" ] && printf '%s\n' "$FAKE_DRIVER_SESSION" || printf 'wrong/client\n'
        ;;
      *socket_path*) printf '/fake/socket\n' ;;
      *) printf '\n' ;;
    esac
    ;;
  # CONTRACT §Session-name authority: roster fixtures must provide the exact
  # session, designated pane, generation, and harness evidence.
  list-sessions)
    printf '%s\t900:100\nother/session\t900:100\n' "$FAKE_DRIVER_SESSION"
    ;;
  list-panes)
    fmt="${!#:-}"
    case "$fmt" in
      *pane_tty*) printf '%%82\t%s\n%%81\t%s\n' "$(tty_for %82)" "$(tty_for %81)" ;;
      *start_time*)
        path="$(cat "$FAKE_TMUX_STATE/pane.path" 2>/dev/null || printf '%s' "$PWD")"
        printf '%s\t%s:1.0\t%%81\tcodex\t%s\t900:100\t0\n' "$FAKE_DRIVER_SESSION" "$FAKE_DRIVER_SESSION" "$CHILD_PID"
        printf 'other/session\tother/session:0.0\t%%80\tcodex\t112\t900:100\t0\n'
        printf '%s\t%s:2.0\t%%83\tcodex\t113\t900:100\t0\n' "$FAKE_DRIVER_SESSION" "$FAKE_DRIVER_SESSION"
        # The caller's own pane: a pane-backed driver row absent from the server
        # snapshot reads as gone and is released.
        printf '%s\t%s:0.0\t%%82\tcodex\t%s\t900:100\t0\n' "$FAKE_DRIVER_SESSION" "$FAKE_DRIVER_SESSION" "$PARENT_PID"
        ;;
      *pane_current_path*)
        path="$(cat "$FAKE_TMUX_STATE/pane.path" 2>/dev/null || printf '%s' "$PWD")"
        printf '%s:1.0\t%%81\tcodex\t%s\n' "$FAKE_DRIVER_SESSION" "$path"
        ;;
    esac
    ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *'ppid='*'tty='*) printf '1 faketty\n' ;;
  *) exec /bin/ps "$@" ;;
esac
PS
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/bash" <<'BASH'
#!/bin/bash
set -euo pipefail
exec "$REAL_BASH" "$@"
BASH
chmod +x "$FAKE_BIN/bash"

REAL_CREW_BUN="$(command -v bun)"
export REAL_CREW_BUN
cat > "$FAKE_BIN/bun" <<'CREW_BUN'
#!/usr/bin/env bash
# crew add's register child is `bun <checkout>/runtime/bun/main.ts register …`
# (verbArgv, B7c R2b); bin/tap's own exec carries the public verb, never
# `register`, so only the child matches.
if [ "${FAKE_REGISTER_EMPTY:-0}" = 1 ]; then
  case "${1:-}:${2:-}" in
    */runtime/bun/main.ts:register) exit 37 ;;
  esac
fi
# U2 fail-closed control: let a register child succeed, snapshot the acting
# store it just wrote, then corrupt the authority marker BEFORE the parent
# re-resolves — the parent must refuse on its own fresh sample.
if [ "${FAKE_CORRUPT_MARKER_AFTER_REGISTER:-0}" = 1 ] &&
   [ -n "${FAKE_AFTER_REGISTER_SNAPSHOT:-}" ] &&
   [ -n "${TEAM_REAL:-}" ]; then
  case "${1:-}:${2:-}" in
    */runtime/bun/main.ts:register)
      child_rc=0
      "$REAL_CREW_BUN" "$@" || child_rc=$?
      if [ "$child_rc" -eq 0 ]; then
        cp "$TEAM_REAL/.tap/team-registry.json" "$FAKE_AFTER_REGISTER_SNAPSHOT"
        printf 'corrupted by crew-add fixture\n' > "${TAP_INDEX_HOME:?}/global-registry.json"
      fi
      exit "$child_rc"
      ;;
  esac
fi
case "${1:-}" in
  */launcher/crew-invocation.ts)
    case "${FAKE_LAUNCHER_REFUSAL:-}" in
      structured)
        printf '%s\n' '{"ok":false,"error_class":"session_error","action":"tap help session","detail":"fixture refusal"}'
        exit 23
        ;;
      empty) exit 24 ;;
    esac
    ;;
esac
exec "$REAL_CREW_BUN" "$@"
CREW_BUN
chmod +x "$FAKE_BIN/bun"
export REAL_BASH REAL_PYTHON3

# Post-door seed (checkpoint B/C): the machine index is LIVE and the team is
# enrolled with its acting store pre-seeded on the seats axis, so the register
# child runs natively against the acting store. The pre-v0.20 fold-on-first-
# register this fixture used to exercise is retired — the old-store door
# refuses that shape BEFORE any write. The bus seed below is door-inert: with
# the marker live it is never probed.
cat > "$TAP_HOME/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "CrewAdd", "worktree_root": "$TEAM_REAL"},
  "seats": {
    "driver": {"delivery": "pane", "harness": "codex", "status": "active", "session": "demo/driver", "pane": "demo/driver:0.0", "pane_id": "%82", "server_epoch": "srv:900:100", "instance": "crew-add-driver-instance"},
    "occupied": {"pane": "other/session:0.0", "pane_id": "%80", "harness": "codex", "status": "active"}
  }
}
JSON
mkdir -p "$TAP_INDEX_HOME" "$TEAM_REAL/.tap"
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{
  "schema": "0.20",
  "migrated": {"at": "2026-09-20T00:00:00Z", "backups": {}},
  "teams": {
    "CrewAdd": {
      "root": "$TEAM_REAL",
      "registry_location": "$TEAM_REAL/.tap/team-registry.json",
      "state": "registered"
    }
  }
}
JSON
cat > "$TEAM_REAL/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": {"name": "CrewAdd", "worktree_root": "$TEAM_REAL"},
  "seats": {
    "driver": {"delivery": "pane", "harness": "codex", "status": "active", "session": "demo/driver", "pane": "demo/driver:0.0", "pane_id": "%82", "server_epoch": "srv:900:100", "instance": "crew-add-driver-instance"},
    "occupied": {"pane": "other/session:0.0", "pane_id": "%80", "harness": "codex", "status": "active"}
  }
}
JSON

# Post-seed authority selector. The seed above is a born-live world: rows live
# on the acting store's seats axis from the start, every registry read/write
# targets the acting store, and callers select rows seats-first,
# agents-otherwise.
acting_registry() { printf '%s\n' "$TEAM/.tap/team-registry.json"; }

# --preset is IMPLEMENTED now (tap-8nob); the preset_scope refusal is retired.
# The property these arms actually pinned — an argv-decidable refusal that fires
# BEFORE a window exists or the acting registry is touched — is exactly what a
# preset must preserve, so it is repointed rather than deleted. A catalog typo
# must not build a pane, register a seat, and then roll both back.
#
# A FIXTURE CATALOG: sandbox-pins.sh pins XDG_CONFIG_HOME at an empty sandbox
# dir, so without this every arm below would refuse preset_config_missing and
# prove only that the sandbox has no catalog. Never the live machine file.
CREW_XDG="$WORK/crewcfg"
mkdir -p "$CREW_XDG/tap"
cat > "$CREW_XDG/tap/config.toml" <<'TOML'
version = 2

[harness.codex]
permissions = "bypass"

[presets.sol-max]
description = "Fixture preset for the crew arms"
harness = "codex"
params.model = "gpt-5.6-sol"
TOML

cp "$(acting_registry)" "$WORK/registry.before-preset"
rm -f "$TMUX_STATE/new-window.args"
cd "$TEAM"

# (a) An unknown preset name refuses with the catalog's own class.
set +e
XDG_CONFIG_HOME="$CREW_XDG" TAP_JSON=1 "$TAP" crew add codex preset-unknown \
  --preset __nosuch_preset__ >"$WORK/preset-unknown.out" 2>"$WORK/preset-unknown.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || {
  echo "crew-add: an unknown preset unexpectedly succeeded" >&2
  exit 1
}
grep -q 'preset_not_found' "$WORK/preset-unknown.out" "$WORK/preset-unknown.err" || {
  echo "crew-add: unknown preset did not refuse preset_not_found" >&2
  cat "$WORK/preset-unknown.out" "$WORK/preset-unknown.err" >&2
  exit 1
}

# (b) A preset is complete: combining it with ad-hoc tuning refuses.
set +e
XDG_CONFIG_HOME="$CREW_XDG" TAP_JSON=1 "$TAP" crew add codex preset-combined \
  --preset sol-max --model gpt-5.6-sol >"$WORK/preset-combined.out" 2>"$WORK/preset-combined.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || {
  echo "crew-add: --preset with --model unexpectedly succeeded" >&2
  exit 1
}
grep -q 'preset_not_composable' "$WORK/preset-combined.out" "$WORK/preset-combined.err" || {
  echo "crew-add: --preset with --model did not refuse preset_not_composable" >&2
  cat "$WORK/preset-combined.out" "$WORK/preset-combined.err" >&2
  exit 1
}

# (c) A preset whose harness disagrees is checked, never silently overridden.
set +e
XDG_CONFIG_HOME="$CREW_XDG" TAP_JSON=1 "$TAP" crew add claude preset-mismatch \
  --preset sol-max >"$WORK/preset-mismatch.out" 2>"$WORK/preset-mismatch.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || {
  echo "crew-add: a preset/harness disagreement unexpectedly succeeded" >&2
  exit 1
}
grep -q 'preset_harness_mismatch' "$WORK/preset-mismatch.out" "$WORK/preset-mismatch.err" || {
  echo "crew-add: harness disagreement did not refuse preset_harness_mismatch" >&2
  cat "$WORK/preset-mismatch.out" "$WORK/preset-mismatch.err" >&2
  exit 1
}

# THE LOAD-BEARING ASSERTION, unchanged in spirit from the retired arms: every
# refusal above is decidable from argv, so none of them may leave a window or a
# registry mutation behind.
cmp -s "$WORK/registry.before-preset" "$(acting_registry)" || {
  echo "crew-add: a preset refusal changed the acting registry" >&2
  exit 1
}
[ ! -e "$TMUX_STATE/new-window.args" ] || {
  echo "crew-add: a preset refusal created a tmux window" >&2
  exit 1
}
echo "crew-add: preset refusals are structured and precede every effect: ok"

# A --cwd outside the launcher's team selects another registry and refuses
# BEFORE any window or registry effect (tap-mxf95). This arm replaces the
# retired unenrolled-outside-cwd success arm (tap-evrho).
cp "$(acting_registry)" "$WORK/registry.before-outside"
set +e
"$TAP" crew add codex crew-outside --model gpt-5.6-sol --cwd "$OUTSIDE" \
  > "$WORK/outside.out" 2> "$WORK/outside.err"
outside_rc=$?
set -e
[ "$outside_rc" -ne 0 ] && grep -q "use --cwd within the launcher's team" "$WORK/outside.err" || {
  echo "crew-add: outside --cwd did not refuse crew_registry_mismatch (rc=$outside_rc)" >&2
  cat "$WORK/outside.out" "$WORK/outside.err" >&2
  exit 1
}
[ ! -e "$TMUX_STATE/new-window.args" ] || {
  echo "crew-add: the outside-cwd refusal created a tmux window" >&2
  exit 1
}
cmp -s "$WORK/registry.before-outside" "$(acting_registry)" || {
  echo "crew-add: the outside-cwd refusal changed the acting registry" >&2
  exit 1
}
echo "crew-add: outside --cwd refuses crew_registry_mismatch before any effect: ok"

set +e
TAP_HARNESS_SESSION_ID=driver-generic-must-not-transfer \
CODEX_THREAD_ID=11111111-1111-4111-8111-111111111111 \
"$TAP" crew add codex crew-sol --model gpt-5.6-sol --cwd "$SIDE" \
  --env CREW_SMOKE_FLAG=on --env=CREW_SMOKE_SECOND=two --unset-env CREW_SMOKE_GONE \
  -- -c crew_tail_marker=1 \
  > "$WORK/add.out" 2> "$WORK/add.err"
add_rc=$?
set -e
[ "$add_rc" -eq 0 ] || {
  echo "crew-add: add failed (rc=$add_rc)" >&2
  cat "$WORK/add.out" >&2
  cat "$WORK/add.err" >&2
  exit 1
}

grep -q -- '-t demo/driver' "$TMUX_STATE/new-window.args" \
  || { echo "crew-add: window was not created in the caller session" >&2; cat "$TMUX_STATE/new-window.args" >&2; exit 1; }
grep -q -- "-c $SIDE_REAL" "$TMUX_STATE/new-window.args" \
  || { echo "crew-add: --cwd did not reach tmux new-window" >&2; cat "$TMUX_STATE/new-window.args" >&2; exit 1; }
python3 -B - "$TMUX_STATE/send-keys.args" "$TAP_INDEX_HOME" <<'PY' \
  || { echo "crew-add: pane command did not match the expected login-shell + env + model shape" >&2; cat "$TMUX_STATE/send-keys.args" >&2; exit 1; }
import pathlib, re, sys
sent = pathlib.Path(sys.argv[1]).read_text()
index_home = re.escape(sys.argv[2])
# Login shell is host-resolved (zsh/bash/sh); require the -lic exec wrapper shape.
# --env must survive BOTH shell hops (tap-crew.sh's case loop, then invocation_args) and land
# as a real assignment in the pane command.
# TWO --env pairs, not one: with a single pair, replacing the repeatable array append with a
# last-value assignment left this smoke green — the bug and the fix are indistinguishable at
# n=1. Assignments render sorted, so the two keys appear in that order, and requiring them
# ADJACENT to the binary is what makes their order an assertion rather than a coincidence.
# This regex used to require a third assignment, PONYTAIL_DEFAULT_MODE=off, emitted by the
# invocation builder. U4 deleted the builders' environment, so demanding it here would pin a
# value the launcher no longer originates.
# The launcher forwards its own TAP_INDEX_HOME after login startup
# so the crew pane selects the launcher's registry sandbox; sorted rendering
# places it after the CREW_* pairs and the host boot id (TAP_BOOT_ID) and
# before the binary. Pin the forwarded value to this fixture's index rather
# than tolerating any TAP_* there. This arm runs under the sandbox's empty
# config dir, so the crew seat launches with the unsaved default, auto: Codex
# gets --no-daemon, --approve-for-me and the launcher's per-launch profile
# (-c pairs) before the model; no bypass flag appears.
# The child's env is first scrubbed with `env -u VAR` for the
# identity and launch-evidence variables the parent holds, so the assignments
# follow a run of -u pairs. Pin that the launch evidence (root and id) is among
# them: a crew child must not inherit the driver's launch binding.
assert re.search(r"/usr/bin/env (?:-u \S+ )+CREW_SMOKE_FLAG", sent), sent
assert "-u TAP_LAUNCH_ROOT -u TAP_LAUNCH_ID " in sent, sent
assert re.search(
    r"exec env \S+ -lic 'exec \"\$0\" \"\$@\"' /usr/bin/env (?:-u \S+ )+"
    r"CREW_SMOKE_FLAG=on CREW_SMOKE_SECOND=two TAP_BOOT_ID=\S+ TAP_INDEX_HOME=" + index_home + r" codex "
    r"--no-daemon --approve-for-me (?:-c \S+ )+--model gpt-5\.6-sol",
    sent,
), sent
assert "--dangerously-bypass-approvals-and-sandbox" not in sent, sent
# --unset-env lands in the -u run after login startup; the -- tail appends last.
assert "-u CREW_SMOKE_GONE " in sent, sent
command = next(line for line in sent.splitlines() if " -lic " in line)
assert command.endswith(" -c crew_tail_marker=1"), command
PY
# This arm covers a SAME-TEAM cwd only: inside the bound worktree, so no
# override is passed and no override warning may appear. It does not cover the
# permitted outside-worktree cwd that CONTRACT.md still describes — that needs
# an enrolled-team shape this unenrolled fixture does not build, and its absence
# here is a coverage boundary, not evidence the path is unreachable (tap-evrho).
! grep -q 'override active' "$WORK/add.err" \
  || { echo "crew-add: same-team --cwd raised an override warning" >&2; cat "$WORK/add.err" >&2; exit 1; }

python3 -B - "$(acting_registry)" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
seats = reg["seats"]
entry = seats["crew-sol"]
assert entry["crew"] is True, entry
assert entry["harness"] == "codex", entry
assert entry["model"] == "gpt-5.6-sol", entry
assert entry["harness_env"] == {"CREW_SMOKE_FLAG": "on", "CREW_SMOKE_SECOND": "two"}, entry
assert entry["harness_env_set"] == ["CREW_SMOKE_FLAG", "CREW_SMOKE_SECOND"], entry
assert entry["harness_unset_env"] == ["CREW_SMOKE_GONE"], entry
assert entry["harness_tail"] == ["-c", "crew_tail_marker=1"], entry
assert entry["pane_current_command"] == "zsh", entry
assert "harness_session_id" not in entry, entry
# tap-fgx9: pane ADDRESS is session:window.pane; pane_id is the %N id.
# Storing the id in `pane` makes the name-first classifier refuse first send
# with pane_drift (the field specimen that broke spawn→converse).
pane = entry.get("pane") or ""
pane_id = entry.get("pane_id") or ""
assert pane_id == "%81", entry
assert ":" in pane and not pane.startswith("%"), (
    f"crew pane must be address-shaped, not id-shaped: pane={pane!r} pane_id={pane_id!r}"
)
assert pane.startswith("demo/driver:"), entry
PY

# tap-fgx9: legacy id-shaped crew pane heals on send bind (no repair).
python3 -B - "$(acting_registry)" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
seats = reg.setdefault("seats", {})
base = seats["crew-sol"]
seats["legacy-crew"] = {
    "status": "active",
    "delivery": "pane",
    "crew": True,
    "pane": "%81",
    "pane_id": "%81",
    "session": "demo/driver",
    "harness": "codex",
    "server_epoch": base.get("server_epoch") or "srv:900:100",
    "boot_id": base.get("boot_id") or "",
    "registered_from_worktree": base.get("registered_from_worktree") or "",
}
with open(path, "w") as f:
    json.dump(reg, f, indent=2)
    f.write("\n")
PY
set +e
# tap-31it: --wake keeps this send's reply=settle-only stamp while declining
# the courier's auto-settle hold, so the fixture still exercises DELIVERY. Without
# it an eligible settle-only send parks by design and no sentinel/canonical exists.
"$TAP" send legacy-crew -m "heal me" --from driver --fyi --wake \
  > "$WORK/heal-send.out" 2> "$WORK/heal-send.err"
set -e
python3 -B - "$(acting_registry)" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
seats = reg["seats"]
lc = seats.get("legacy-crew") or {}
pane = lc.get("pane")
assert pane == "demo/driver:1.0", (pane, lc)
PY
grep -Fq "healed id-shaped pane field" "$WORK/heal-send.err" \
  || { echo "crew-add: expected heal receipt on stderr" >&2; cat "$WORK/heal-send.err" >&2; exit 1; }
! grep -Eiq 'pane_drift' "$WORK/heal-send.err" \
  || { echo "crew-add: heal path still reported pane_drift" >&2; cat "$WORK/heal-send.err" >&2; exit 1; }

# GLM/#347: stale epoch must refuse heal. Invoke tap-send.sh directly so
# tap.sh's invalidate_server_restart does not clear the binding first — the
# heal guard is the subject under test.
# The pinned epoch is the one this fixture's server really reports, and the
# driver row carries it: the sender must be CURRENT for the send to reach the
# heal guard at all (a driver row on another epoch is refused as "not an active
# sender" first). The crew row stays on srv:old, so it is the stale party.
python3 -B - "$(acting_registry)" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
seats = reg.setdefault("seats", {})
seats["stale-crew"] = {
    "status": "active",
    "delivery": "pane",
    "crew": True,
    "pane": "%81",
    "pane_id": "%81",
    "session": "demo/driver",
    "harness": "codex",
    "server_epoch": "srv:old",
    "boot_id": "",
    "registered_from_worktree": "",
}
with open(path, "w") as f:
    json.dump(reg, f, indent=2)
    f.write("\n")
PY
set +e
TAP_SERVER_EPOCH=srv:900:100 bun "$ROOT/runtime/bun/main.ts" send \
  stale-crew -m "no heal" --from driver --fyi --wake \
  > "$WORK/stale-heal.out" 2> "$WORK/stale-heal.err"
set -e
python3 -B - "$(acting_registry)" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
seats = reg["seats"]
sc = seats.get("stale-crew") or {}
pane = sc.get("pane")
assert pane == "%81", f"stale heal must not rewrite pane, got {pane!r} row={sc!r}"
PY
grep -Fq "refusing id-shaped pane heal" "$WORK/stale-heal.err" \
  || { echo "crew-add: expected stale-heal refusal on stderr" >&2; cat "$WORK/stale-heal.err" >&2; exit 1; }
echo "crew-add: (fgx9) address-shaped pane + legacy heal + stale-epoch refuse: ok"

crew_out="$(COLUMNS=200 "$TAP" crew list)"
[[ "$crew_out" == *'tap crew list: CrewAdd'* ]] \
  || { echo "crew-add: filtered roster header missing" >&2; echo "$crew_out" >&2; exit 1; }
[[ "$crew_out" == *'crew-sol'* && "$crew_out" == *'CREW'* && "$crew_out" == *'codex'* ]] \
  || { echo "crew-add: crew row or live harness missing" >&2; echo "$crew_out" >&2; exit 1; }
# Operator ruling: crew list stays wide — pane + unattended + reason, pin the nine-column order, including the per-seat notes/asks windows.
[[ "$crew_out" == *'pane'* && "$crew_out" == *'unattended'* && "$crew_out" == *'reason'* ]] \
  || { echo "crew-add: crew list must stay wide (pane + unattended + reason)" >&2; echo "$crew_out" >&2; exit 1; }
printf '%s\n' "$crew_out" | grep -E '^handle[[:space:]]+kind[[:space:]]+harness[[:space:]]+pane[[:space:]]+status[[:space:]]+attached[[:space:]]+unattended[[:space:]]+reason[[:space:]]+notes/asks[[:space:]]*$' >/dev/null \
  || { echo "crew-add: crew list must use exact nine-column header order" >&2; echo "$crew_out" >&2; exit 1; }
# Pane addresses may embed the session name (e.g. demo/driver:1.0); pin the
# durable seat by handle/kind, not a bare 'driver' substring.
printf '%s\n' "$crew_out" | grep -E '^driver[[:space:]]' >/dev/null \
  && { echo "crew-add: crew list leaked a durable seat" >&2; echo "$crew_out" >&2; exit 1; }
[[ "$crew_out" != *'SEAT'* ]] \
  || { echo "crew-add: crew list leaked a durable seat kind" >&2; echo "$crew_out" >&2; exit 1; }

team_out="$("$TAP" team)"
[[ "$team_out" == *'crew-sol'* && "$team_out" == *'codex'* ]] \
  || { echo "crew-add: tap team did not refresh the crew harness" >&2; echo "$team_out" >&2; exit 1; }

# Collision new-window must not reuse %81 (crew-sol). Distinct pane, no heal
# rows on it. Later add-refusals keep that same unused pane so they do not
# hit pane_occupied on crew-sol.
python3 -B - "$(acting_registry)" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
seats = reg.setdefault("seats", {})
seats.pop("legacy-crew", None)
seats.pop("stale-crew", None)
with open(path, "w") as handle:
    json.dump(reg, handle, indent=2)
    handle.write("\n")
PY
printf '%%83\n' > "$TMUX_STATE/new-pane-id"
rm -f "$TMUX_STATE/kill-window.args"
set +e
"$TAP" crew add codex occupied --model gpt-5.6-sol > "$WORK/collision.out" 2> "$WORK/collision.err"
collision_rc=$?
set -e
[ "$collision_rc" -ne 0 ] \
  || { echo "crew-add: live handle collision silently succeeded" >&2; cat "$WORK/collision.out" >&2; cat "$WORK/collision.err" >&2; exit 1; }
grep -Fq 'requires the exact requested handle' "$WORK/collision.err" \
  || { echo "crew-add: collision failure was not explicit" >&2; cat "$WORK/collision.err" >&2; exit 1; }
grep -Fq -- '-t %83' "$TMUX_STATE/kill-window.args" \
  || { echo "crew-add: collision did not remove the new window" >&2; cat "$TMUX_STATE/kill-window.args" >&2; exit 1; }
python3 -B - "$(acting_registry)" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
seats = reg["seats"]
assert seats["occupied"]["pane_id"] == "%80", seats
assert not any(name.startswith("occupied-") for name in seats), seats
PY

# A refusal produced by the inner `tap register --json` must reach the caller.
# `tap crew add` needs the JSON receipt on success, but capturing stdout for that
# receipt must not turn a structured registration error into a silent exit.
python3 -B - "$(acting_registry)" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
seats = reg.setdefault("seats", {})
seats["pending"] = {
    "status": "pending",
    "session": "other/pending",
    "harness": "codex",
    "registered_at": "2026-07-09T00:01:00Z",
}
with open(path, "w") as handle:
    json.dump(reg, handle, indent=2)
    handle.write("\n")
PY
rm -f "$TMUX_STATE/kill-window.args"
set +e
TAP_WATCH_NOW=1783555270 "$TAP" crew add codex pending --model gpt-5.6-sol > "$WORK/pending.out" 2> "$WORK/pending.err"
pending_rc=$?
set -e
[ "$pending_rc" -ne 0 ] \
  || { echo "crew-add: pending registration unexpectedly succeeded" >&2; exit 1; }
grep -Fq 'seat_pending' "$WORK/pending.err" \
  || { echo "crew-add: registration refusal was swallowed" >&2; cat "$WORK/pending.out" "$WORK/pending.err" >&2; exit 1; }
grep -Fq -- '-t %83' "$TMUX_STATE/kill-window.args" \
  || { echo "crew-add: registration refusal did not remove the new window" >&2; cat "$TMUX_STATE/kill-window.args" >&2; exit 1; }

# Even an abrupt register failure with no body must produce the add-owned
# fallback diagnostic; the new window must still be removed.
rm -f "$TMUX_STATE/kill-window.args"
set +e
FAKE_REGISTER_EMPTY=1 "$TAP" crew add codex register-empty --model gpt-5.6-sol > "$WORK/register-empty.out" 2> "$WORK/register-empty.err"
register_empty_rc=$?
set -e
[ "$register_empty_rc" -eq 37 ] \
  || { echo "crew-add: empty registration refusal exit status drifted" >&2; cat "$WORK/register-empty.out" "$WORK/register-empty.err" >&2; exit 1; }
grep -Fq 'registration failed (exit 37)' "$WORK/register-empty.err" \
  || { echo "crew-add: empty registration refusal had no fallback diagnostic" >&2; cat "$WORK/register-empty.err" >&2; exit 1; }
grep -Fq -- '-t %83' "$TMUX_STATE/kill-window.args" \
  || { echo "crew-add: empty registration refusal did not remove the new window" >&2; cat "$TMUX_STATE/kill-window.args" >&2; exit 1; }

# Launcher preparation is the sibling command-substitution boundary. Preserve
# both a structured refusal and an empty-failure fallback on stderr after
# unregistering the provisional row and removing the new window.
rm -f "$TMUX_STATE/kill-window.args"
set +e
TAP_JSON=1 FAKE_LAUNCHER_REFUSAL=structured "$TAP" crew add codex launcher-refusal \
  > "$WORK/launcher-refusal.out" 2> "$WORK/launcher-refusal.err"
launcher_refusal_rc=$?
set -e
[ "$launcher_refusal_rc" -eq 23 ] \
  || { echo "crew-add: launcher refusal exit status drifted" >&2; cat "$WORK/launcher-refusal.out" "$WORK/launcher-refusal.err" >&2; exit 1; }
grep -Fq '"error_class":"session_error"' "$WORK/launcher-refusal.err" \
  || { echo "crew-add: structured launcher refusal was swallowed" >&2; cat "$WORK/launcher-refusal.out" "$WORK/launcher-refusal.err" >&2; exit 1; }
grep -Fq -- '-t %83' "$TMUX_STATE/kill-window.args" \
  || { echo "crew-add: launcher refusal did not remove the new window" >&2; cat "$TMUX_STATE/kill-window.args" >&2; exit 1; }

rm -f "$TMUX_STATE/kill-window.args"
set +e
FAKE_LAUNCHER_REFUSAL=empty "$TAP" crew add codex launcher-empty > "$WORK/launcher-empty.out" 2> "$WORK/launcher-empty.err"
launcher_empty_rc=$?
set -e
[ "$launcher_empty_rc" -eq 24 ] \
  || { echo "crew-add: empty launcher refusal exit status drifted" >&2; cat "$WORK/launcher-empty.out" "$WORK/launcher-empty.err" >&2; exit 1; }
grep -Fq 'launch preparation failed (exit 24)' "$WORK/launcher-empty.err" \
  || { echo "crew-add: empty launcher refusal had no fallback diagnostic" >&2; cat "$WORK/launcher-empty.err" >&2; exit 1; }
grep -Fq -- '-t %83' "$TMUX_STATE/kill-window.args" \
  || { echo "crew-add: empty launcher refusal did not remove the new window" >&2; cat "$TMUX_STATE/kill-window.args" >&2; exit 1; }

# U2 (tap-ygq1x) fail-closed control: crew invocation follows MOVED authority.
# The register child succeeds, the fake bash wrapper snapshots the acting store
# it just wrote and corrupts the authority marker, and the parent must refuse on
# its own fresh resolution — never fall back to the stale pre-registration path.
# The child's provisional row may survive (best-effort unregister may itself
# fail closed on the invalid marker): this is relocation, not row loss, so the
# acting store must stay byte-identical to the after-register snapshot. No
# launch keys may reach the pane, and the owned window must be cleaned up.
rm -f "$TMUX_STATE/kill-window.args"
cp "$TMUX_STATE/send-keys.args" "$WORK/reauth.send-keys.before" 2>/dev/null || : > "$WORK/reauth.send-keys.before"
cp "$TAP_INDEX_HOME/global-registry.json" "$WORK/reauth.marker.valid"
export FAKE_CORRUPT_MARKER_AFTER_REGISTER=1
export FAKE_AFTER_REGISTER_SNAPSHOT="$WORK/reauth.after-register"
set +e
TAP_JSON=1 "$TAP" crew add codex reauth-crew --model gpt-5.6-sol \
  > "$WORK/reauth.out" 2> "$WORK/reauth.err"
reauth_rc=$?
set -e
unset FAKE_CORRUPT_MARKER_AFTER_REGISTER FAKE_AFTER_REGISTER_SNAPSHOT
# The hook itself must be proven to have fired BEFORE the restored marker can
# make any downstream refusal look like a pass: the wrapper must have written
# the after-register snapshot and left invalid bytes at the marker path.
[ -f "$WORK/reauth.after-register" ] \
  || { echo "crew-add: the corrupt-after-register hook never fired (no snapshot)" >&2; cat "$WORK/reauth.err" >&2; exit 1; }
grep -q 'corrupted by crew-add fixture' "$TAP_INDEX_HOME/global-registry.json" \
  || { echo "crew-add: the corrupt-after-register hook never corrupted the marker" >&2; exit 1; }
cp "$WORK/reauth.marker.valid" "$TAP_INDEX_HOME/global-registry.json"
[ "$reauth_rc" -ne 0 ] \
  || { echo "crew-add: corrupted authority after registration unexpectedly succeeded" >&2; cat "$WORK/reauth.out" >&2; exit 1; }
grep -Fq '"error_class":"registry_unreachable"' "$WORK/reauth.out" \
  || { echo "crew-add: stale post-registration authority did not refuse registry_unreachable" >&2; cat "$WORK/reauth.out" "$WORK/reauth.err" >&2; exit 1; }
cmp -s "$WORK/reauth.after-register" "$(acting_registry)" \
  || { echo "crew-add: the re-resolution refusal mutated the acting registry" >&2; exit 1; }
cmp -s "$WORK/reauth.send-keys.before" "$TMUX_STATE/send-keys.args" \
  || { echo "crew-add: the re-resolution refusal sent launch keys to the pane" >&2; exit 1; }
grep -Fq -- '-t %83' "$TMUX_STATE/kill-window.args" \
  || { echo "crew-add: the re-resolution refusal did not remove the new window" >&2; cat "$TMUX_STATE/kill-window.args" >&2; exit 1; }
echo "crew-add: moved-authority re-resolve refuses fail-closed, leaves the row and the window cleaned: ok"

echo "crew-add: add/list/override/probe refresh/exact collision/register+launcher diagnostics: ok"

# A fenced --env key is decidable from argv alone, so it must refuse BEFORE anything is built.
# Asserting the refusal class is not enough — that would pass just as well with the refusal
# arriving after a window was created and rolled back, which is what it used to do. The
# assertion that carries the ordering is the ABSENCE of a new window for this attempt.
rm -f "$TMUX_STATE/new-window.args" "$TMUX_STATE/kill-window.args"
set +e
# TAP_JSON=1 because this arm asserts an ERROR CLASS, which is the structured
# surface. Crew re-renders launcher refusals through tap_fail now, so the class
# token appears when the caller asks for JSON and prose appears when they do not
# — it used to leak the machine envelope at every human, which is what this arm
# was silently depending on.
TAP_JSON=1 "$TAP" crew add codex fenced-env --env TAP_HOME=/x \
  > "$WORK/fenced.out" 2> "$WORK/fenced.err"
fenced_rc=$?
set -e
[ "$fenced_rc" -ne 0 ] \
  || { echo "crew-add: a fenced --env key was accepted" >&2; cat "$WORK/fenced.out" >&2; exit 1; }
# On STDOUT: a TAP_JSON refusal is structured output, which is the stream TAP
# publishes objects on. The old forced-JSON preflight relayed it to stderr, so
# this assertion moved with the stream when the refusal started rendering through
# tap_fail like every other refusal in the repo.
grep -Fq 'launch_env_forbidden' "$WORK/fenced.out" \
  || { echo "crew-add: fenced --env did not report launch_env_forbidden" >&2; cat "$WORK/fenced.err" >&2; exit 1; }
[ ! -s "$TMUX_STATE/new-window.args" ] \
  || { echo "crew-add: fenced --env created a window before refusing" >&2; cat "$TMUX_STATE/new-window.args" >&2; exit 1; }
echo "crew-add: fenced --env refuses before any window is created: ok"

# A supplied-but-empty --model must refuse, not launch a default-model seat. Both crew launcher
# calls used to test the VALUE (`${MODEL:+...}` and `[ -z "$MODEL" ]`), which reads `--model ""`
# as absent — the silent swallow this lane exists to remove, reintroduced one layer down in
# shell. The window-absence check is what distinguishes "refused" from "refused after building".
rm -f "$TMUX_STATE/new-window.args" "$TMUX_STATE/kill-window.args"
set +e
TAP_JSON=1 "$TAP" crew add codex empty-model --model "" \
  > "$WORK/empty-model.out" 2> "$WORK/empty-model.err"
empty_model_rc=$?
set -e
[ "$empty_model_rc" -ne 0 ] \
  || { echo "crew-add: an empty --model was accepted and launched" >&2; cat "$WORK/empty-model.out" >&2; exit 1; }
grep -Fq 'launch_arg_invalid' "$WORK/empty-model.out" \
  || { echo "crew-add: empty --model did not report launch_arg_invalid" >&2; cat "$WORK/empty-model.err" >&2; exit 1; }
[ ! -s "$TMUX_STATE/new-window.args" ] \
  || { echo "crew-add: empty --model created a window before refusing" >&2; cat "$TMUX_STATE/new-window.args" >&2; exit 1; }
echo "crew-add: supplied-empty --model refuses before any window is created: ok"
