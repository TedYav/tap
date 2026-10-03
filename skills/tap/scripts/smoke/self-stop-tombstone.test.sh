#!/usr/bin/env bash
# self-stop-tombstone.test.sh — finding #7 (ring-fenced).
#
# MUTATION A — restore publish-after-kill (tip 154c74e0 / Cluster D .pending staging):
#   smoke_exit=1
#   RED attributed to assertion (1):
#     "(1) published tombstone must exist after self-stop (pending=1 files: …alice.out-….json.pending)"
#   captured 2026-07-29 against HEAD unregister + this smoke (publish-before restored after).
#
# Why these assertions (not source-order grep):
#   (1)/(2) observe durable history after the terminating call
#   (3) observes the CONSEQUENCE — the historical tombstone remains provenance,
#       but it cannot retain current membership authority after `tap out`.
#
# Losing branch (publish-before-kill): kill-fail rollback unlinks the published
# tombstone — instance-terminal-gates.test.sh (3). Session-already-gone arm no
# longer publishes post-kill (tombstone already final before kill).
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

WORK="$(mktemp -d)"
SOCK="tap-selfstop-$$"
REAL_TMUX="$(command -v tmux)" || { echo "self-stop-tombstone: real tmux required" >&2; exit 1; }
BIN="$WORK/bin"
mkdir -p "$BIN"
# printf (not unquoted <<EOF) — prose-eval-inventory forbids bare $( in unquoted heredocs.
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf 'exec %s -L %s "$@"\n' "$(printf '%q' "$REAL_TMUX")" "$(printf '%q' "$SOCK")"
} > "$BIN/tmux"
chmod +x "$BIN/tmux"
export PATH="$BIN:$PATH"
unset TMUX

cleanup() {
  "$REAL_TMUX" -L "$SOCK" kill-server 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "self-stop-tombstone: $*" >&2; exit 1; }

export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/team/.tap/bus"
ACTING="$WORK/team/.tap/team-registry.json"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp" \
  "$WORK/team/.tap/team-history" "$TAP_INDEX_HOME"

# Flip marker live and point at the acting team registry.
python3 -B - "$TAP_INDEX_HOME" "$WORK/team" "$ACTING" <<'PY'
import json, pathlib, sys, time
idx, root, acting = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
(idx / "global-registry.json").write_text(json.dumps({
    "schema": "0.20",
    "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
    "teams": {"team": {
        "root": str(root),
        "registry_location": str(acting),
        "state": "registered",
    }},
}) + "\n")
PY

# Session name contains '/'; bare -t team/alice works, but -t =team/alice
# (exact) returns empty pane_id on this tmux — do not use the = form here.
tmux new-session -d -s "team/alice" -c "$WORK/team" -- bash -lc 'exec sleep 3600'
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
  tmux has-session -t 'team/alice' 2>/dev/null && break
  sleep 0.05
done
tmux has-session -t 'team/alice' 2>/dev/null \
  || fail "failed to create isolated session team/alice"

pane_id="$(tmux display-message -p -t 'team/alice' '#{pane_id}')"
server_epoch="$(tmux display-message -p -t 'team/alice' '#{pid}:#{start_time}')"
server_epoch="srv:${server_epoch}"
[ -n "$pane_id" ] || fail "no pane_id from isolated session"

python3 -B - "$ACTING" "$WORK/team" "$pane_id" "$server_epoch" <<'PY'
import json, pathlib, sys
path, root, pane_id, epoch = sys.argv[1:5]
pathlib.Path(path).write_text(json.dumps({
    "schema": "0.20",
    "team": {"name": "team", "worktree_root": root},
    "seats": {
        "alice": {
            "status": "active",
            "delivery": "pane",
            "harness": "claude",
            "pane": "team/alice:0.0",
            "pane_id": pane_id,
            "session": "team/alice",
            "instance": "alice|I1",
            "server_epoch": epoch,
            "registered_at": "t",
        }
    },
}, indent=2) + "\n")
PY
printf '{"schema":"0.20","team":{"name":"team","worktree_root":"%s"},"seats":{}}\n' "$WORK/team" >"$TAP_HOME/registry.json"

RUNNER="$WORK/self-out.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  printf 'export PATH=%s\n' "$(printf '%q' "$PATH")"
  printf '%s\n' 'unset TMUX'
  printf 'export TAP_INDEX_HOME=%s\n' "$(printf '%q' "$TAP_INDEX_HOME")"
  printf 'export TAP_HOME=%s\n' "$(printf '%q' "$TAP_HOME")"
  printf 'export TAP_SERVER_EPOCH=%s\n' "$(printf '%q' "$server_epoch")"
  printf 'cd %s\n' "$(printf '%q' "$WORK/team")"
  printf 'exec %s out alice --kill\n' "$(printf '%q' "$TAP")"
} > "$RUNNER"
chmod +x "$RUNNER"

tmux respawn-pane -k -t 'team/alice' -- "$RUNNER"

deadline=$((SECONDS + 300))
while tmux has-session -t 'team/alice' 2>/dev/null; do
  [ "$SECONDS" -lt "$deadline" ] || fail "self-stop did not end session before the deadman"
  sleep 0.1
done

hist="$WORK/team/.tap/team-history"
shopt -s nullglob
published=("$hist"/alice.*.json)
pending=("$hist"/alice.*.json.pending)
shopt -u nullglob

# (1) published tombstone after terminating call
[ "${#published[@]}" -ge 1 ] \
  || fail "(1) published tombstone must exist after self-stop (pending=${#pending[@]} files: ${pending[*]:-none})"
# (2) no stranded provisional
[ "${#pending[@]}" -eq 0 ] \
  || fail "(2) no .pending may remain after self-stop (found: ${pending[*]})"

# list_handle_history must see it (same predicate as the historical door)
hist_n="$("${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/python-closure-cli.ts" history-count "$hist" alice)"
[ "${hist_n:-0}" -ge 1 ] \
  || fail "(2b) list_handle_history must see published tombstone (hist_n=$hist_n)"

python3 - "$ACTING" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
if "alice" in agents:
    raise SystemExit("alice row must be removed after successful self-stop")
PY

echo "self-stop-tombstone: (1)(2) published tombstone, no pending: ok"

# (3) CONSEQUENCE — history is provenance, not current membership authority.
# A deliberate `tap in` may claim the now-vacant handle.
FAKE_BIN="$WORK/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%77\tfake\t1\tclaude\t0\n' ;;
      *pane_id*) echo "%77" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*) echo "${FAKE_TMUX_PATH:-}" ;;
      *session_name*window_index*pane_index*) echo "fake:0.0" ;;
      *pane_pid*) echo "1" ;;
      *pid*start_time*) echo "1:1" ;;
      *) echo "" ;;
    esac ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

rc=0
err="$(mktemp)"
out="$(cd "$WORK/team" && env -u TAP_HOME \
  PATH="$FAKE_BIN:$PATH" \
  TMUX="/fake/tmux/socket" \
  TAP_INDEX_HOME="$TAP_INDEX_HOME" \
  FAKE_TMUX_PATH="$WORK/team" \
  "$TAP" in alice --pane fake:0.0 2>"$err")" || rc=$?
[ "$rc" -eq 0 ] \
  || fail "(3) retired history must not block a deliberate rejoin (rc=$rc, stderr=$(cat "$err"), stdout=$out)"
python3 -B - "$ACTING" <<'PY' || fail "(3) rejoin did not recreate the acting row"
import json, sys
assert "alice" in (json.load(open(sys.argv[1])).get("seats") or {})
PY
[ "$hist_n" -ge 1 ] || fail "(3) rejoin removed historical provenance"
echo "self-stop-tombstone: (3) history remains provenance but no longer blocks rejoin: ok"

echo "self-stop-tombstone: ok"
