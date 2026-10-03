#!/usr/bin/env bash
# D5: public — seat-refresh-positive-matrix.test.sh:66-67: exercises behavior through the public CLI surface only
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# tap-3xj1 coverage repair (Diagnostics U3a) — positive four-arm matrix for
# seat-level `tap refresh --fresh` on the incumbent Bash engine. The retired
# spike (faf87bc0) proved these seams once and was dropped; this file pins the
# four states the exit surface promises, as POSITIVE transitions:
#   (1) success      rc 0 — clear delegated, old instance tombstoned, successor
#                    registered in place.
#   (2) notice-dedup rc 0 — one notice per sender, every orphaned id named.
#   (3) notice-fail  rc 6 — retirement KEPT after a sender notice failed; the
#                    deliverable sender still got theirs and the failure is
#                    reported on stderr.
#   (4) late-spool   rc 7 — a payload spooled between preflight and retirement
#                    refuses the retirement; the clear already happened, so the
#                    seat KEEPS its old identity.
#   (5) cross-team   rc 6 — a from_team-stamped sender's notice is routed under
#                    its team prefix, carried from the FIRST canonical scan.
#   (6) engine-out   rc 0 — the delegated clear engine's stdout/stderr reach the
#                    caller; refresh claims the exit code, never the text.
#   (7) default-idx  rc 0 — the acting-registry flip works with TAP_INDEX_HOME
#                    unset, through the default index.
#
# Boundary: refresh runs through the REPO's own bin/tap door (route assertion
# demands a `native refresh` trace line), so the pane transport is the fake
# tmux/ps pair and the delegated clear engine is intercepted in-process: a
# PATH-earlier `bun` preloads a mock of launcher/replace.ts's cmdClearNative
# (the peer clear refresh awaits since R7b), keeping every other export real. The
# notice path is the REAL tap-send (arm 3 needs a genuinely undeliverable
# recipient, not a stubbed failure).
# TAP_REFRESH_MATRIX_CASE selects one arm for red-first proof; default runs all.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
FAKE_BIN="$WORK/bin"
cleanup() {
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
mkdir -p "$FAKE_BIN"

# Copy nested two dirs deep and link the repo runtime at the exact spot the
# Bun message-construction slice resolves: from the copy it walks
# scripts/../../.. = WORK, so WORK/runtime must be the repo runtime.
TRACE_FILE="$WORK/route.trace"
CLEAR_LOG="$WORK/clear-invocations"
export CLEAR_LOG

# The clear is observed at the in-process DELEGATION BOUNDARY: cmdClearNative
# is answered by the preload (record the seat, print both markers, return the
# chosen code); every other module stays real. The arm (4) race injector lives
# in the same stub, keyed on INJECT_SPOOL_ON_RETIRE: it writes a real spooled
# payload at the moment refresh delegates the clear, and if production removes
# that synchronization point the marker stays absent and the fixture fails.
REAL_BUN="$(command -v bun)"
CLEAR_STUB_RC=0
export CLEAR_STUB_RC
cat > "$WORK/clear-stub.ts" <<STUB
import { mock } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import * as real from "$ROOT/runtime/bun/src/launcher/replace.ts";
mock.module("$ROOT/runtime/bun/src/launcher/replace.ts", () => ({
  ...real,
  async cmdClearNative(argv: string[]) {
    const env = process.env;
    if (env.INJECT_SPOOL_ON_RETIRE === "1" && env.LATE_MARKER && !existsSync(env.LATE_MARKER)) {
      const path = env.LATE_SPOOL_DIR + "/" + env.LATE_ID + ".md";
      writeFileSync(path, "---\nid: " + env.LATE_ID + "\nfrom: " + env.LATE_FROM + "\nto: " + env.LATE_TO
        + "\nkind: discuss\nreply: expected\nsender_instance: " + env.LATE_SENDER_INSTANCE + "\npath: " + path + "\n---\nlate spooled send\n");
      writeFileSync(env.LATE_SPOOL_DIR + "/" + env.LATE_ID + ".meta.json", JSON.stringify({ id: env.LATE_ID, reason: "fixture-late" }) + "\n");
      writeFileSync(env.LATE_MARKER, "");
    }
    process.stdout.write("ENGINE_STDOUT_MARKER\n");
    process.stderr.write("ENGINE_STDERR_MARKER\n");
    appendFileSync("$CLEAR_LOG", argv[0] + "\n");
    return Number(env.CLEAR_STUB_RC || 0);
  },
}));
STUB
cat > "$FAKE_BIN/bun" <<SHIM
#!/bin/bash
exec "$REAL_BUN" --preload "$WORK/clear-stub.ts" "\$@"
SHIM
chmod +x "$FAKE_BIN/bun"

fail() { echo "seat-refresh-positive-matrix: $*" >&2; exit 1; }

# Real command-mode behavior, fake pane transport. Assertions are on the
# refresh result, registry, tombstone, payloads, and submitted clear.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
cmd="${1:?}"; shift
target="taptest:lead.0"
target_set=0
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [ "${args[$i]}" = "-t" ] && [ $((i+1)) -lt ${#args[@]} ]; then
    target="${args[$((i+1))]}"
    target_set=1
  fi
done
target="${target#=}"
case "$target" in
  taptest:lead.0|%101) seat=lead; pane_id=%101; pane_pid=4101; session=taptest ;;
  taptest:peggy.0|%102) seat=peggy; pane_id=%102; pane_pid=4102; session=taptest ;;
  remote/peer:0.0|%103) seat=remote_peer; pane_id=%103; pane_pid=4103; session=remote/peer ;;
  taptest) seat=""; pane_id=""; pane_pid=""; session=taptest ;;
  remote/peer) seat=""; pane_id=""; pane_pid=""; session=remote/peer ;;
  *) seat=""; pane_id=""; pane_pid=""; session="" ;;
esac
harness=claude
[ "$seat" != peggy ] || harness="${FAKE_TARGET_HARNESS:-claude}"

case "$cmd" in
  list-sessions)
    if [ "$target_set" = 1 ] && [ -n "$session" ]; then
      if [[ "$*" == *start_time* ]]; then
        printf '%s\t900:100\n' "$session"
      else
        printf '%s\n' "$session"
      fi
    elif [[ "$*" == *start_time* ]]; then
      printf 'taptest\t900:100\nremote/peer\t900:100\n'
    else
      printf 'taptest\nremote/peer\n'
    fi
    ;;
  display-message)
    [ -n "$pane_id" ] || exit 0
    fmt="${args[${#args[@]}-1]:-}"
    case "$fmt" in
      *pane_id*session_name*start_time*) printf '%s\t%s\t900:100\n' "$pane_id" "$session" ;;
      *pid*start_time*) printf '900:100\n' ;;
      *pane_id*session_name*) printf '%s\t%s\n' "$pane_id" "$session" ;;
      *pane_id*pane_tty*)
        if [ "$seat" = lead ]; then
          printf '%s\t/dev/faketty\n' "$pane_id"
        else
          printf '%s\t/dev/faketty-%s\n' "$pane_id" "$seat"
        fi
        ;;
      *pane_id*) printf '%s\n' "$pane_id" ;;
      *pane_pid*) printf '%s\n' "$pane_pid" ;;
      *pane_current_command*) printf '%s\n' "$harness" ;;
      *pane_current_path*) printf '\n' ;;
      *pane_in_mode*) printf '0\n' ;;
      *session_name*) printf '%s\n' "$session" ;;
      *window_index*) printf '0\n' ;;
      *pane_index*) printf '0\n' ;;
      *) printf '\n' ;;
    esac
    ;;
  list-panes)
    fmt="${args[${#args[@]}-1]:-}"
    case "$fmt" in
      *pane_tty*)
        if [ "$seat" = lead ]; then
          printf '%s\t/dev/faketty\n' "$pane_id"
        elif [ -n "$pane_id" ]; then
          printf '%s\t/dev/faketty-%s\n' "$pane_id" "$seat"
        fi
        ;;
      *)
        if [ "$session" = remote/peer ]; then
          printf 'remote/peer\tremote/peer:0.0\t%%103\tclaude\t4103\t900:100\t0\n'
        else
          printf 'taptest\ttaptest:lead.0\t%%101\tclaude\t4101\t900:100\t0\n'
          printf 'taptest\ttaptest:peggy.0\t%%102\t%s\t4102\t900:100\t0\n' "${FAKE_TARGET_HARNESS:-claude}"
        fi
        ;;
    esac
    ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" ppid= "* && " $* " == *" tty= "* && " $* " == *" -p "* ]]; then
  printf '1 faketty\n'
  exit 0
fi
pid=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  [ "${args[$i]}" = -p ] && pid="${args[$((i+1))]:-}"
done
case "$pid" in
  4101) harness=claude ;;
  4102) harness="${FAKE_TARGET_HARNESS:-claude}" ;;
  4103) harness=claude ;;
  *) exit 1 ;;
esac
printf ' %s 1 %s %s\n' "$pid" "$harness" "$harness"
PS
chmod +x "$FAKE_BIN/ps"


export PATH="$FAKE_BIN:$PATH" TMUX=1 TAP_SELF=lead
export TAP_TUI_SETTLE_SCALE=0.1
export TMUX_PANE=taptest:lead.0

setup() { # <peggy-instance>
  local peggy_instance="$1"
  RUN="$(mktemp -d "$WORK/run.XXXXXX")"
  BUS="$RUN/repo/.tap/bus"
  TAP_HOME="$BUS"
  TAP_INDEX_HOME="$RUN/index"
  FAKE_TMUX_STATE="$RUN/tmux"
  export TAP_HOME TAP_INDEX_HOME FAKE_TMUX_STATE
  mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool" "$RUN/repo/.tap" "$RUN/index" "$FAKE_TMUX_STATE"

  python3 -B - "$RUN/repo" "$RUN/index/global-registry.json" <<'PY'
import json, sys
root, path = sys.argv[1:]
json.dump({"schema": "0.20", "teams": {
    "repo": {"root": root, "state": "registered",
             "registry_location": root + "/.tap/team-registry.json"},
}}, open(path, "w"))
PY
  python3 -B - "$RUN/repo/.tap/team-registry.json" "$BUS/registry.json" "$RUN/repo" "$peggy_instance" <<'PY'
import json, sys
acting_path, bus_path, root, peggy_instance = sys.argv[1:]
rows = {
    "lead": {"status": "active", "instance": "lead|live", "pane": "taptest:lead.0",
             "pane_id": "%101", "session": "taptest", "server_epoch": "srv:900:100",
             "harness": "claude"},
    "peggy": {"status": "active", "instance": peggy_instance, "pane": "taptest:peggy.0",
              "pane_id": "%102", "session": "taptest", "server_epoch": "srv:900:100",
              "harness": "claude"},
    "peer": {"status": "active", "instance": "peer|live", "delivery": "poll", "harness": "claude"},
    "latepeer": {"status": "active", "instance": "latepeer|live", "delivery": "poll", "harness": "claude"},
}
json.dump({"schema": "0.20", "team": {"name": "repo", "worktree_root": root}, "seats": rows},
          open(acting_path, "w"))
json.dump({"schema": "0.20", "version": 3, "team": {"name": "repo", "worktree_root": root}, "seats": rows},
          open(bus_path, "w"))
PY
  : > "$CLEAR_LOG"
  unset FAKE_TARGET_HARNESS INJECT_SPOOL_ON_RETIRE || true
}

mkpayload() { # <id> <from> <to> <recipient-instance>
  printf -- '---\nid: %s\nfrom: %s\nto: %s\nkind: discuss\nreply: expected\nrecipient_instance: %s\n---\nbody\n' \
    "$1" "$2" "$3" "$4" > "$BUS/payloads/$1.md"
}

run_refresh() {
  REFRESH_RC=0
  : > "$TRACE_FILE"
  ( cd "$RUN/repo" && TAP_BUN_ROUTE_TRACE="$TRACE_FILE" bash "$ROOT/bin/tap" refresh peggy "$@" ) \
    > "$RUN/out" 2> "$RUN/err" || REFRESH_RC=$?
  # Route coverage lives HERE, not in a copied script: the refresh under test is
  # the repo's own door, and it must dispatch natively.
  grep -qx 'native refresh' "$TRACE_FILE" \
    || fail "refresh did not route natively (trace: $(tr '\n' ' ' < "$TRACE_FILE"); stderr: $(tr '\n' ' ' < "$RUN/err"))"
}

seat_instance() {
  python3 -B - "$RUN/repo/.tap/team-registry.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
row = (d.get("seats") or d.get("agents") or {}).get("peggy")
print(row.get("instance", "") if isinstance(row, dict) else "<missing>")
PY
}

tombstone_count() {
  local dir="$RUN/repo/.tap/team-history"
  [ -d "$dir" ] || { printf '0'; return; }
  find "$dir" -type f -name 'peggy.*.json' ! -name '*.lineage.*' | wc -l | tr -d ' '
}

tombstone_names_instance() { # <instance>
  local dir="$RUN/repo/.tap/team-history"
  [ -d "$dir" ] || return 1
  python3 -B - "$dir" "$1" <<'PY'
import glob, json, os, sys
directory, instance = sys.argv[1:]
for path in glob.glob(os.path.join(directory, "peggy.*.json")):
    if ".lineage." in os.path.basename(path):
        continue
    with open(path) as f:
        if json.load(f).get("instance") == instance:
            raise SystemExit(0)
raise SystemExit(1)
PY
}

clear_count() {
  # Counts DELEGATIONS to the clear engine for the seat under test.
  grep -Fxc 'peggy' "$CLEAR_LOG" 2>/dev/null || true
}

refresh_notice_count() { # <recipient>
  python3 -B - "$BUS/payloads" "$1" <<'PY'
import glob, os, sys
payloads, recipient = sys.argv[1:]
count = 0
for path in glob.glob(os.path.join(payloads, "*.md")):
    text = open(path).read()
    if f"\nto: {recipient}\n" in text and "Seat refreshed fresh:" in text:
        count += 1
print(count)
PY
}

refresh_notice_names() { # <recipient> <orphaned-id>...
  python3 -B - "$BUS/payloads" "$@" <<'PY'
import glob, os, sys
payloads, recipient, *idents = sys.argv[1:]
notices = []
for path in glob.glob(os.path.join(payloads, "*.md")):
    text = open(path).read()
    if f"\nto: {recipient}\n" in text and "Seat refreshed fresh:" in text:
        notices.append(text)
if len(notices) != 1:
    raise SystemExit(1)
notice = notices[0]
# The notice must name the REFRESHED seat as its sender: production passes
# --from "$HANDLE" to tap-send, so a dropped --from would misattribute the
# notice (or default the sender) and this check must fail the arm.
truthful = ("NOT be settled" in notice and "Nothing is required" in notice
            and "\nfrom: peggy\n" in notice)
raise SystemExit(0 if truthful and all(ident in notice for ident in idents) else 1)
PY
}

case_success() {
  local old='peggy|matrix-success' new rc clears tombs
  setup "$old"
  run_refresh --fresh
  rc="$REFRESH_RC"; new="$(seat_instance)"; clears="$(clear_count)"; tombs="$(tombstone_count)"
  if [ "$rc" != 0 ] || [ "$clears" != 1 ] || [ "$new" = '<missing>' ] \
      || [ -z "$new" ] || [ "$new" = "$old" ] || [ "$tombs" != 1 ] \
      || ! tombstone_names_instance "$old"; then
    fail "(1-success) clear-then-retire-then-rebind contract broken: rc=$rc clear_count=$clears old_instance=$old new_instance=$new tombstones=$tombs; stderr: $(tr '\n' ' ' < "$RUN/err")"
  fi
  echo "seat-refresh-positive-matrix: (1-success) clear completes, old instance tombstoned, successor registered: ok"
}

case_notice_dedup() {
  local old='peggy|matrix-dedup' new rc clears tombs peer_notices other_notices
  setup "$old"
  mkpayload notice-peer-001 peer peggy "$old"
  mkpayload notice-peer-002 peer peggy "$old"
  mkpayload notice-other-001 latepeer peggy "$old"
  run_refresh --fresh --force
  rc="$REFRESH_RC"; new="$(seat_instance)"; clears="$(clear_count)"; tombs="$(tombstone_count)"
  peer_notices="$(refresh_notice_count peer)"
  other_notices="$(refresh_notice_count latepeer)"
  if [ "$rc" != 0 ] || [ "$clears" != 1 ] || [ "$new" = '<missing>' ] \
      || [ -z "$new" ] || [ "$new" = "$old" ] || [ "$tombs" != 1 ] \
      || [ "$peer_notices" != 1 ] || [ "$other_notices" != 1 ] \
      || ! refresh_notice_names peer notice-peer-001 notice-peer-002 \
      || ! refresh_notice_names latepeer notice-other-001; then
    fail "(2-notice-dedup) refresh did not notify exactly once per sender with every id: rc=$rc clear_count=$clears old_instance=$old new_instance=$new tombstones=$tombs peer_notices=$peer_notices other_notices=$other_notices; stderr: $(tr '\n' ' ' < "$RUN/err")"
  fi
  echo "seat-refresh-positive-matrix: (2-notice-dedup) each sender gets one notice naming all their orphaned ids: ok"
}

case_notice_failure() {
  # missingpeer is enrolled NOWHERE, so the real tap-send from the copy refuses
  # it — a genuine delivery failure, not a stubbed one. The retirement must
  # survive it (exit 6), the deliverable sender must still be told.
  local old='peggy|matrix-notice-fail' new rc clears tombs delivered failed
  setup "$old"
  mkpayload notice-deliverable peer peggy "$old"
  mkpayload notice-undeliverable missingpeer peggy "$old"
  run_refresh --fresh --force
  rc="$REFRESH_RC"; new="$(seat_instance)"; clears="$(clear_count)"; tombs="$(tombstone_count)"
  delivered="$(refresh_notice_count peer)"
  failed="$(refresh_notice_count missingpeer)"
  if [ "$rc" != 6 ] || [ "$clears" != 1 ] || [ "$new" = '<missing>' ] \
      || [ -z "$new" ] || [ "$new" = "$old" ] || [ "$tombs" != 1 ] \
      || [ "$delivered" != 1 ] || [ "$failed" != 0 ] \
      || ! refresh_notice_names peer notice-deliverable \
      || ! grep -Fq missingpeer "$RUN/err"; then
    fail "(3-notice-failure) failed notice was not isolated as partial exit 6: rc=$rc clear_count=$clears old_instance=$old new_instance=$new tombstones=$tombs delivered_notices=$delivered failed_notices=$failed; stderr: $(tr '\n' ' ' < "$RUN/err")"
  fi
  echo "seat-refresh-positive-matrix: (3-notice-failure) one failed notice exits 6, retirement kept, deliverable sender still told: ok"
}

case_late_spool() {
  local old='peggy|matrix-late-spool' instance rc clears tombs
  setup "$old"
  export INJECT_SPOOL_ON_RETIRE=1
  export LATE_ID=spooled-late-001 LATE_FROM=peggy LATE_TO=peer LATE_SENDER_INSTANCE="$old"
  export LATE_SPOOL_DIR="$BUS/spool" LATE_MARKER="$RUN/late-spool-injected"
  run_refresh --fresh
  unset INJECT_SPOOL_ON_RETIRE LATE_ID LATE_FROM LATE_TO LATE_SENDER_INSTANCE LATE_SPOOL_DIR LATE_MARKER

  [ -e "$RUN/late-spool-injected" ] && [ -f "$BUS/spool/spooled-late-001.md" ] \
    || fail "(4-late-spool) fixture did not inject spooled-late-001 at the retirement boundary"
  rc="$REFRESH_RC"; instance="$(seat_instance)"; clears="$(clear_count)"; tombs="$(tombstone_count)"
  if [ "$rc" != 7 ] || [ "$instance" != "$old" ] || [ "$clears" != 1 ] \
      || [ "$tombs" != 0 ] || ! grep -Fq spooled-late-001 "$RUN/err"; then
    fail "(4-late-spool) late spooled send bypassed the retirement-boundary guard: rc=$rc clear_count=$clears old_instance=$old final_instance=$instance tombstones=$tombs; stderr: $(tr '\n' ' ' < "$RUN/err")"
  fi
  echo "seat-refresh-positive-matrix: (4-late-spool) late spooled send exits 7, old identity kept after clear: ok"
}

case_cross_team_notice() {
  # Owed mail from a sender stamped with from_team: the notice must be routed
  # under that team prefix (`otherco/peer`), and peerTeam must ride the FIRST
  # canonical scan — rows entered into `seen` there are never re-read by the
  # second scan, which is where the team stamp was originally dropped. otherco
  # is enrolled nowhere, so the send genuinely fails; its failure line names
  # the routing key either way, which is what this arm pins.
  local old='peggy|matrix-cross-team' rc
  setup "$old"
  printf -- '---\nid: notice-cross-001\nfrom: peer\nto: peggy\nfrom_team: otherco\nkind: discuss\nreply: expected\nrecipient_instance: %s\n---\nbody\n' "$old" \
    > "$BUS/payloads/notice-cross-001.md"
  run_refresh --fresh --force
  rc="$REFRESH_RC"
  if [ "$rc" != 6 ] || ! grep -Fq "could not notify 'otherco/peer'" "$RUN/err"; then
    fail "(5-cross-team) cross-team sender notice was not routed via its team prefix: rc=$rc; stderr: $(tr '\n' ' ' < "$RUN/err")"
  fi
  echo "seat-refresh-positive-matrix: (5-cross-team) a from_team sender's notice is addressed otherco/peer: ok"
}

case_engine_output() {
  # The delegated engine's own output must reach the caller: refresh claims the
  # EXIT CODE, never the text, and a spawn that pipes-and-discards hides the
  # diagnostics an operator needs when a clear half-behaves.
  local rc out_hits err_hits
  setup 'peggy|matrix-engine-echo'
  run_refresh
  rc="$REFRESH_RC"
  out_hits="$(grep -cxF 'ENGINE_STDOUT_MARKER' "$RUN/out" || true)"
  err_hits="$(grep -cxF 'ENGINE_STDERR_MARKER' "$RUN/err" || true)"
  if [ "$rc" != 0 ] || [ "$out_hits" -lt 1 ] || [ "$err_hits" -lt 1 ]; then
    fail "(6-engine-output) delegated engine output was discarded: rc=$rc stdout_markers=$out_hits stderr_markers=$err_hits; stderr: $(tr '\n' ' ' < "$RUN/err")"
  fi
  echo "seat-refresh-positive-matrix: (6-engine-output) delegated engine stdout and stderr reach the caller: ok"
}

case_default_index() {
  # The acting-registry flip comes from the RESOLVED CONTEXT (marker live with
  # an enrolled team directory), not from TAP_INDEX_HOME being set: a default
  # index is just as live as an explicit one. The pre-fix port read the env var
  # and minted nothing without it — refresh "succeeded" while the seat kept its
  # old identity. HOME is pointed at a fixture-local home so the default index
  # lands inside the sandbox on every runner.
  local old='peggy|matrix-default-index' new rc clears tombs saved_home
  setup "$old"
  saved_home="$HOME"
  HOME="$RUN/fakehome"
  mkdir -p "$HOME/.tap"
  cp "$RUN/index/global-registry.json" "$HOME/.tap/global-registry.json"
  unset TAP_INDEX_HOME
  run_refresh --fresh
  HOME="$saved_home"
  rc="$REFRESH_RC"; new="$(seat_instance)"; clears="$(clear_count)"; tombs="$(tombstone_count)"
  if [ "$rc" != 0 ] || [ "$clears" != 1 ] || [ "$new" = '<missing>' ] \
      || [ -z "$new" ] || [ "$new" = "$old" ] || [ "$tombs" != 1 ]; then
    fail "(7-default-index) refresh did not rebind through the default index (TAP_INDEX_HOME unset): rc=$rc clear_count=$clears old_instance=$old new_instance=$new tombstones=$tombs; stderr: $(tr '\n' ' ' < "$RUN/err")"
  fi
  echo "seat-refresh-positive-matrix: (7-default-index) TAP_INDEX_HOME unset still rebinds via the default index: ok"
}

case "${TAP_REFRESH_MATRIX_CASE:-all}" in
  success) case_success ;;
  notice-dedup) case_notice_dedup ;;
  notice-failure) case_notice_failure ;;
  late-spool) case_late_spool ;;
  cross-team) case_cross_team_notice ;;
  engine-output) case_engine_output ;;
  default-index) case_default_index ;;
  all)
    case_success
    case_notice_dedup
    case_notice_failure
    case_late_spool
    case_cross_team_notice
    case_engine_output
    case_default_index
    ;;
  *) fail "unknown TAP_REFRESH_MATRIX_CASE '${TAP_REFRESH_MATRIX_CASE:-}'" ;;
esac

echo "seat-refresh-positive-matrix: ok"
