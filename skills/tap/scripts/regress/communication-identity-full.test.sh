#!/usr/bin/env bash
# communication-identity.test.sh — fail-closed (team, handle, pane_id) binding.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

export TAP_TUI_SETTLE_SCALE=0.1 TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"
FAKE_BIN="$WORK/bin"
STATE="$WORK/tmux"
mkdir -p "$FAKE_BIN" "$STATE"
trap 'rm -rf "$WORK"' EXIT

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
while [[ "${1:-}" == -L || "${1:-}" == -S ]]; do shift 2; done
cmd="${1:-}"; shift || true
target=""; fmt=""
# Native effects target stable ids; fixture state and assertions use logical names.
# Resolve both spellings through the same live table, never separate pane buffers.
logical_target() {
  local name
  name="$(awk -F '\t' -v p="$1" '$1 == p || $2 == p { print $1; exit }' "$state/live.tsv" 2>/dev/null || true)"
  printf '%s' "${name:-$1}"
}
key() { local name; name="$(logical_target "$1")"; printf '%s' "${name//[^A-Za-z0-9_.-]/_}"; }
live_id() {
  local wanted="$1"
  awk -F '\t' -v p="$wanted" '$1 == p || $2 == p { print $2; exit }' "$state/live.tsv" 2>/dev/null || true
}
live_session() { awk -F '\t' -v p="$1" '$1 == p || $2 == p { print $3; exit }' "$state/live.tsv" 2>/dev/null || true; }
# FAKE_PANE_EXIT_ON=<pane> with FAKE_PANE_EXIT_N=k: from its k-th command read on,
# that pane answers zsh everywhere a live command is read, as tmux does after the
# harness exits (tap-dmf7z). FAKE_LIST_PANES_COMMAND stays list-panes-only.
live_command() {
  local armed="${FAKE_PANE_EXIT_ON:-}" count
  if [ -n "$armed" ] && { [ "$1" = "$armed" ] || [ "$1" = "$(live_id "$armed")" ]; }; then
    count="$(( $(cat "$state/exit-count" 2>/dev/null || echo 0) + 1 ))"
    printf '%s' "$count" > "$state/exit-count"
    if [ "$count" -ge "${FAKE_PANE_EXIT_N:-1}" ]; then echo zsh; return 0; fi
  fi
  awk -F '\t' -v p="$1" '$1 == p || $2 == p { print $4; exit }' "$state/live.tsv" 2>/dev/null || true
}
live_pid() { awk -F '\t' -v p="$1" '$1 == p || $2 == p { print $5; exit }' "$state/live.tsv" 2>/dev/null || true; }
mutate_registry_once() {
  [ ! -e "$state/mutated" ] || return 0
  # Record how many pane events preceded the rebind, so a case can tell an
  # effect before it from an effect after it.
  if [ -f "$state/events.log" ]; then wc -l < "$state/events.log" | tr -d ' ' > "$state/mutated"; else echo 0 > "$state/mutated"; fi
  python3 -B - "${FAKE_MUTATE_REGISTRY:?}" "${FAKE_MUTATE_HANDLE:?}" "${FAKE_MUTATE_PANE_ID:?}" <<'PY'
import json, sys
path, handle, pane_id = sys.argv[1:4]
data = json.load(open(path))
data["seats"][handle]["pane_id"] = pane_id
json.dump(data, open(path, "w"), indent=2, sort_keys=True)
PY
}
# Every command read, standalone or inside the native four-field observe, counts
# toward FAKE_MUTATE_REGISTRY_COMMAND_N. The armed pane matches by name or id.
command_read_hook() {
  local armed="${FAKE_MUTATE_REGISTRY_ON_COMMAND:-}" count_file count
  [ -n "$armed" ] || return 0
  [ "$1" = "$armed" ] || [ "$1" = "$(live_id "$armed")" ] || return 0
  count_file="$state/command-count"
  count="$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))"
  printf '%s' "$count" > "$count_file"
  [ "$count" -ne "${FAKE_MUTATE_REGISTRY_COMMAND_N:-1}" ] || mutate_registry_once
}
case "$cmd" in
  list-sessions)
    awk -F '\t' '!seen[$3]++ && $3 != "" { print $3 }' "$state/live.tsv" | while IFS= read -r session; do
      if [[ "$*" == *'start_time'* ]]; then printf '%s\t900:100\n' "$session"
      else printf '%s\n' "$session"
      fi
    done ;;
  list-panes)
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; -F) fmt="$2"; shift 2 ;; *) shift ;; esac
    done
    awk -F '\t' -v s="$target" -v override="${FAKE_LIST_PANES_COMMAND:-}" '
      $3 == s { cmd = override != "" ? override : $4; printf "%s\t%s\t%s\t%s\t%s\t900:100\t0\n", $3, $1, $2, cmd, $5 }
    ' "$state/live.tsv" ;;
  display-message)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    if [ -z "$target" ]; then target="${FAKE_CALLER_PANE:-caller-pane}"; fi
    target="$(logical_target "$target")"
    case "$fmt" in
      '#{pid}:#{start_time}') printf '900:100\n' ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t900:100\n' "$(live_id "$target")" "$(live_session "$target")" ;;
      *pane_id*session_name*start_time*) printf '%s\t%s\t900:100\n' "$(live_id "$target")" "$(live_session "$target")" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        command_read_hook "$target"
        printf '%s\t%s\t%s\t%s\t0\n' "$(live_id "$target")" "$(live_session "$target")" "$(live_pid "$target")" "$(live_command "$target")" ;;
      *pane_id*)
        if [ -n "${FAKE_MUTATE_REGISTRY_ON:-}" ] && [ "$target" = "$FAKE_MUTATE_REGISTRY_ON" ] \
           && [ ! -e "$state/mutated" ]; then
          mutate_registry_once
        fi
        live_id "$target" ;;
      *pane_pid*) live_pid "$target" ;;
      *pane_in_mode*)
        if [ -n "${FAKE_MUTATE_REGISTRY_ON_MODE:-}" ] && [ "$target" = "$FAKE_MUTATE_REGISTRY_ON_MODE" ]; then
          mutate_registry_once
        fi
        [ -f "$state/copy-mode.$(key "$target")" ] && echo 1 || echo 0 ;;
      *pane_current_command*)
        command_read_hook "$target"
        live_command "$target" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    target="$(logical_target "$target")"
    if [ -n "${FAKE_MUTATE_REGISTRY_ON_CAPTURE:-}" ] && [ "$target" = "$FAKE_MUTATE_REGISTRY_ON_CAPTURE" ]; then
      count_file="$state/capture-count"
      count="$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))"
      printf '%s' "$count" > "$count_file"
      [ "$count" -eq "${FAKE_MUTATE_REGISTRY_CAPTURE_N:-1}" ] && mutate_registry_once
    fi
    input="$state/input.$(key "$target")"
    if [ -f "$input" ]; then printf '› %s\n' "$(cat "$input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then target="${2:-}"; shift 2; fi
    target="$(logical_target "$target")"
    input="$state/input.$(key "$target")"
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = cancel ]; then
      printf 'cancel\t%s\n' "$target" >> "$state/events.log"
      rm -f "$state/copy-mode.$(key "$target")"
      exit 0
    fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$input"
      printf 'paste\t%s\t%s\n' "$target" "${1:-}" >> "$state/events.log"
      exit 0
    fi
    case "${1:-}" in
      Enter)
        printf 'enter\t%s\n' "$target" >> "$state/events.log"
        rm -f "$input" ;;
      Escape) printf 'escape\t%s\n' "$target" >> "$state/events.log" ;;
    esac ;;
  select-pane) : ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$STATE"
export TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:1"

A="$WORK/A"
B="$WORK/B"
git init -q "$A"
git -C "$A" config user.email tap@example.invalid
git -C "$A" config user.name "TAP Smoke"
touch "$A/README.md"
git -C "$A" add README.md
git -C "$A" commit -q -m init
git -C "$A" worktree add -q "$B" -b team-b

ABUS="$A/.tap/bus"
BBUS="$B/.tap/bus"
mkdir -p "$ABUS/payloads" "$ABUS/receipts" "$BBUS/payloads" "$BBUS/receipts"
cat > "$ABUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "A", "worktree_root": "$A"},
  "seats": {
    "sender": {"session": "A/sender", "pane": "sender-pane", "pane_id": "%101", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"},
    "fable": {"session": "A/fable", "pane": "a-fable-pane", "pane_id": "%102", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"},
    "principal": {"session": "A/principal", "pane": "a-principal-pane", "pane_id": "%103", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"}
  }
}
JSON
cat > "$BBUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "B", "worktree_root": "$B"},
  "seats": {
    "fable": {"session": "B/fable", "pane": "b-fable-pane", "pane_id": "%104", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"},
    "principal": {"session": "B/principal", "pane": "b-principal-pane", "pane_id": "%105", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"}
  }
}
JSON
cat > "$STATE/live.tsv" <<'EOF'
sender-pane	%101	A/sender	codex	101
a-fable-pane	%102	A/fable	codex	102
a-principal-pane	%103	A/principal	codex	103
b-fable-pane	%104	B/fable	codex	104
b-principal-pane	%105	B/principal	codex	105
caller-pane	%106	A/caller	codex	106
recycled-pane	%107	B/recycled	codex	107
foreign-pane	%999	B/foreign	codex	199
EOF
export TAP_HOME="$ABUS" TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"
tap_smoke_enroll_current "$A" "$ABUS" A
tap_smoke_enroll_current "$B" "$BBUS" B

reset_bus() {
  rm -f "${ABUS:?}/payloads"/*.md "${ABUS:?}/receipts"/*.done "${ABUS:?}/spool"/* \
        "${STATE:?}"/events.log "${STATE:?}"/mutated "${STATE:?}"/command-count "${STATE:?}"/capture-count "${STATE:?}"/exit-count "${STATE:?}"/input.* "${STATE:?}"/copy-mode.* 2>/dev/null || true
  mkdir -p "$ABUS/payloads" "$ABUS/receipts" "$ABUS/spool"
}

assert_only_entered() {
  local pane="$1"
  [ "$(awk -F '\t' '$1 == "enter" { seen[$2] = 1 } END { for (p in seen) print p }' "$STATE/events.log" 2>/dev/null)" = "$pane" ] || {
    echo "communication-identity: expected only $pane to receive Enter" >&2
    cat "$STATE/events.log" >&2 || true
    exit 1
  }
}

# ── tap-52ys: the REGRESS tier of the identity family ───────────────────────
# The 19 cases that left the merge gate, kept intact and runnable rather than
# deleted: reply_to/nudge binding, the point-of-effect drift family (6c-6i),
# the spool-binding family (7-9), and the malformed-registry no-suspend path.
# They are real coverage that is too slow and too broad for every merge.
#
# The gate tier is skills/tap/scripts/smoke/communication-identity.test.sh
# (4 cases). Case ids are unchanged across both files, so COMM_ID_CASE=<id>
# still selects the same case it always did.

# Effect controls use asks to reach the immediate-delivery safety path;
# the post-canonical refusal uses --no-spool so a defer cannot become acceptance.
# Default notes queue, and --no-spool deliberately refuses copy mode earlier.
# Explicit polite spool controls below retain their queue semantics.
case_bare_local() {
  reset_bus
  "$TAP" send --expect-reply fable -m local --from sender --id ci-local >/dev/null
  assert_only_entered a-fable-pane
  ! grep -q '^to_team:' "$ABUS/payloads/ci-local.md"
  echo "communication-identity: (2) bare handle remains on caller team A: ok"
}

case_reply_to_binding() {
  reset_bus
  "$TAP" send --expect-reply B/fable -m reply-route --from sender --reply-to principal --id ci-reply-to >/dev/null
  grep -q '^reply_to: A/principal$' "$ABUS/payloads/ci-reply-to.md" || {
    echo "communication-identity: bare reply_to was not bound to sender team A" >&2
    cat "$ABUS/payloads/ci-reply-to.md" >&2
    exit 1
  }
  assert_only_entered b-fable-pane
  echo "communication-identity: (6a) bare reply_to binds sender team at send time: ok"
}

case_nudge_sentinel_binding() {
  reset_bus
  sentinel='[[TAP v=0.6 from=A/sender to=B/fable id=ci-nudge kind=discuss reply=expected path=/tmp/ci-nudge.md]]'
  printf '%s' "$sentinel" > "$STATE/input.a-fable-pane"
  set +e
  out="$(TAP_JSON=1 "$TAP" nudge fable 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "communication-identity: nudge submitted a foreign-bound sentinel through local fable" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* ]] || { echo "$out" >&2; exit 1; }
  [ -f "$STATE/input.a-fable-pane" ]
  ! grep -q $'^enter\ta-fable-pane$' "$STATE/events.log" 2>/dev/null
  echo "communication-identity: (6b) nudge refuses argv/sentinel identity disagreement: ok"
}

case_direct_toctou() {
  reset_bus
  # First capture is the pre-canonical pending-input probe. The second is the
  # native courier's final band read, after canonical placement and the
  # beforeInject authorize (tap-wudl2).
  export FAKE_MUTATE_REGISTRY_ON_CAPTURE=b-fable-pane FAKE_MUTATE_REGISTRY_CAPTURE_N=2
  export FAKE_MUTATE_REGISTRY="$BBUS/registry.json" FAKE_MUTATE_HANDLE=fable FAKE_MUTATE_PANE_ID=%998
  set +e
  out="$("$TAP" send --no-spool B/fable -m raced --from sender --id ci-toctou --json 2>&1)"; rc=$?
  set -e
  unset FAKE_MUTATE_REGISTRY_ON_CAPTURE FAKE_MUTATE_REGISTRY_CAPTURE_N FAKE_MUTATE_REGISTRY FAKE_MUTATE_HANDLE FAKE_MUTATE_PANE_ID
  [ "$rc" -ne 0 ] || { echo "communication-identity: bind-to-inject registry drift injected" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* ]] || { echo "rc=$rc capture_count=$(cat "$STATE/capture-count" 2>/dev/null)" >&2; echo "$out" >&2; cat "$STATE/events.log" >&2 2>/dev/null; exit 1; }
  [ ! -f "$ABUS/payloads/ci-toctou.md" ]
  [ ! -s "$STATE/events.log" ]
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
  echo "communication-identity: (6c) post-canonical bind-to-inject drift removes canonical and fails closed: ok"
}

case_direct_foreign_toctou() {
  reset_bus
  # Compose 6c's preflight-to-effect race with case 3's live foreign pane. The
  # recipient is valid at the outer guard, then its registry binding moves to
  # %999 during the last observation before the first pane effect. The
  # point-of-effect authorizer must reject that live stranger before attempting
  # a copy-mode cancel or placing a canonical payload.
  touch "$STATE/copy-mode.b-fable-pane"
  export FAKE_MUTATE_REGISTRY_ON_MODE=b-fable-pane
  export FAKE_MUTATE_REGISTRY="$BBUS/registry.json" FAKE_MUTATE_HANDLE=fable FAKE_MUTATE_PANE_ID=%999
  set +e
  out="$("$TAP" send --expect-reply B/fable -m foreign-race --from sender --id ci-foreign-toctou --json 2>&1)"; rc=$?
  set -e
  unset FAKE_MUTATE_REGISTRY_ON_MODE FAKE_MUTATE_REGISTRY FAKE_MUTATE_HANDLE FAKE_MUTATE_PANE_ID
  [ "$rc" -ne 0 ] || { echo "communication-identity: live foreign pane crossed the point-of-effect barrier" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-foreign-toctou.md" ]
  [ ! -s "$STATE/events.log" ] || {
    echo "communication-identity: live foreign pane received a tmux effect" >&2
    cat "$STATE/events.log" >&2; exit 1
  }
  [ -f "$STATE/copy-mode.b-fable-pane" ] || {
    echo "communication-identity: live foreign pane received copy-mode cancel" >&2; exit 1
  }
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
  echo "communication-identity: (6c2) live foreign drift at the point-of-effect barrier has zero tmux effects: ok"
}

case_explicit_pane_mismatch() {
  reset_bus
  set +e
  out="$("$TAP" send --expect-reply fable -m wrong-pane --from sender --pane b-fable-pane --id ci-explicit-pane --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "communication-identity: explicit pane bypassed registered recipient" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-explicit-pane.md" ]
  [ ! -s "$STATE/events.log" ]
  echo "communication-identity: (6d) explicit pane must match registered recipient binding: ok"
}

case_unbound_manual_spool_refused() {
  reset_bus
  set +e
  out="$("$TAP" send fable -m manual-polite --from sender --cross-worktree --pane b-fable-pane --polite --id ci-manual-polite --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "communication-identity: unbound manual relay claimed a durable spool" >&2; exit 1; }
  [[ "$out" == *identity_unverified* ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-manual-polite.md" ]
  [ ! -f "$ABUS/spool/ci-manual-polite.md" ]
  [ ! -f "$ABUS/spool/ci-manual-polite.meta.json" ]
  [ ! -s "$STATE/events.log" ]
  echo "communication-identity: (6e) unbound manual relay cannot enter registry-bound spool: ok"
}

case_rowless_harness_drift_before_effect() {
  reset_bus
  # Preflight observes codex through display-message; the rowless point-of-effect
  # guard must then refuse the exact same pane when its session-panes observation
  # sees a shell. Without the expected harness threaded through that guard, the
  # old code cancels copy-mode and injects into the shell.
  python3 -B - "$STATE/live.tsv" <<'PY'
import sys
path = sys.argv[1]
rows = [line.rstrip("\n").split("\t") for line in open(path)]
for row in rows:
    if row[0] == "b-fable-pane":
        row[0] = "B/fable:0.0"
open(path, "w").write("".join("\t".join(row) + "\n" for row in rows))
PY
  touch "$STATE/copy-mode.B_fable_0.0"
  set +e
  out="$(FAKE_LIST_PANES_COMMAND=zsh "$TAP" send fable -m rowless-shell --from sender --cross-worktree --pane B/fable:0.0 --id ci-rowless-shell --json 2>&1)"; rc=$?
  set -e
  python3 -B - "$STATE/live.tsv" <<'PY'
import sys
path = sys.argv[1]
rows = [line.rstrip("\n").split("\t") for line in open(path)]
for row in rows:
    if row[0] == "B/fable:0.0":
        row[0] = "b-fable-pane"
open(path, "w").write("".join("\t".join(row) + "\n" for row in rows))
PY
  [ "$rc" -ne 0 ] || { echo "communication-identity: rowless shell transition crossed the effect barrier" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* && ( "$out" == *harness_exited* || "$out" == *harness_mismatch* ) ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-rowless-shell.md" ]
  [ ! -s "$STATE/events.log" ] || {
    echo "communication-identity: rowless shell transition received a pane effect" >&2
    cat "$STATE/events.log" >&2; exit 1
  }
  echo "communication-identity: (6e2) rowless harness drift blocks before copy-mode or injection effects: ok"
}

case_stuck_sentinel_recipient_guard() {
  reset_bus
  sentinel='[[TAP v=0.6 from=A/sender to=A/fable id=ci-old-stuck kind=discuss reply=expected path=/tmp/ci-old-stuck.md]]'
  printf '%s' "$sentinel" > "$STATE/input.b-fable-pane"
  set +e
  out="$("$TAP" send --expect-reply B/fable -m urgent-new --from sender --urgent --id ci-stuck-guard --json 2>&1)"; rc=$?
  set -e
  # tap-rdy9n: urgent delivery parks behind another recipient's stuck
  # sentinel, keeps it intact, and tells the sender whose sentinel it is.
  [ "$rc" -eq 0 ] || { echo "communication-identity: (6f) urgent send was not parked" >&2; echo "$out" >&2; exit 1; }
  [ "$(cat "$STATE/input.b-fable-pane")" = "$sentinel" ] || { echo "communication-identity: (6f) foreign stuck sentinel was disturbed" >&2; echo "$out" >&2; exit 1; }
  if grep -qE $'^(escape|paste|enter)\tb-fable-pane' "$STATE/events.log" 2>/dev/null; then
    echo "communication-identity: (6f) foreign stuck sentinel pane received an interrupt, paste, or Enter" >&2; cat "$STATE/events.log" >&2; exit 1
  fi
  [ -f "$ABUS/spool/ci-stuck-guard.md" ] && [ ! -f "$ABUS/payloads/ci-stuck-guard.md" ] || { echo "communication-identity: (6f) urgent send did not park in the spool" >&2; echo "$out" >&2; exit 1; }
  printf '%s\n' "$out" | grep -F '"status":"queued"' | grep -qF '"detail":"parked behind a stuck TAP sentinel addressed to A/fable (id ci-old-stuck), not B/fable' \
    || { echo "communication-identity: (6f) park receipt did not name the foreign sentinel" >&2; echo "$out" >&2; exit 1; }
  # A v0.23 sentinel carries no to=; the notice re-keys through its payload,
  # whose bare to: belongs to the team named in the id.
  reset_bus
  printf -- '---\nid: ci-old-v23\nfrom: sender\nto: fable\nkind: discuss\nreply: expected\n---\nold\n' > "$ABUS/payloads/ci-old-v23.md"
  sentinel='[[TAP v0.23 ask A/ci-old-v23]]'
  printf '%s' "$sentinel" > "$STATE/input.b-fable-pane"
  set +e
  out="$("$TAP" send --expect-reply B/fable -m urgent-new --from sender --urgent --id ci-stuck-guard-v23 --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ "$(cat "$STATE/input.b-fable-pane")" = "$sentinel" ] || { echo "communication-identity: (6f) v0.23 foreign sentinel was not parked intact" >&2; echo "$out" >&2; exit 1; }
  if grep -qE $'^(escape|paste|enter)\tb-fable-pane' "$STATE/events.log" 2>/dev/null; then
    echo "communication-identity: (6f) v0.23 foreign sentinel pane received an interrupt, paste, or Enter" >&2; cat "$STATE/events.log" >&2; exit 1
  fi
  printf '%s\n' "$out" | grep -F '"status":"queued"' | grep -qF '"detail":"parked behind a stuck TAP sentinel addressed to A/fable (id A/ci-old-v23), not B/fable' \
    || { echo "communication-identity: (6f) park receipt did not name the v0.23 foreign sentinel" >&2; echo "$out" >&2; exit 1; }
  echo "communication-identity: (6f) urgent send parks behind a foreign stuck sentinel and names it: ok"
}

case_harness_exit_before_copy_mode() {
  local n
  # Read 1 is the send-time bound observe; read 2 is the point-of-effect
  # authorize ahead of the copy-mode cancel. The harness exits at each.
  for n in 1 2; do
    reset_bus
    touch "$STATE/copy-mode.b-fable-pane"
    set +e
    out="$(FAKE_PANE_EXIT_ON=b-fable-pane FAKE_PANE_EXIT_N="$n" "$TAP" send --expect-reply B/fable -m barrier --from sender --id "ci-harness-barrier-$n" --json 2>&1)"; rc=$?
    set -e
    [ "$(cat "$STATE/exit-count" 2>/dev/null || echo 0)" -ge "$n" ] || { echo "communication-identity: (6g) harness exit at read $n never fired" >&2; echo "$out" >&2; exit 1; }
    [ "$rc" -ne 0 ] || { echo "communication-identity: shell transition at read $n crossed the effect barrier" >&2; echo "$out" >&2; cat "$STATE/events.log" >&2 2>/dev/null; exit 1; }
    # Preflight names the denylisted shell; the point-of-effect authorize
    # reports the exited harness. Either refusal leaves the pane untouched.
    if [ "$n" = 1 ]; then want='*unsafe_target*zsh*'; else want='*identity_mismatch*harness evidence exited*'; fi
    # shellcheck disable=SC2053 # $want is a deliberate glob
    [[ "$out" == $want ]] || { echo "communication-identity: (6g) read $n refusal class" >&2; echo "$out" >&2; exit 1; }
    [ ! -f "$ABUS/payloads/ci-harness-barrier-$n.md" ]
    [ -f "$STATE/copy-mode.b-fable-pane" ] || { echo "communication-identity: (6g) shell pane received copy-mode cancel at read $n" >&2; exit 1; }
    [ ! -s "$STATE/events.log" ] || {
      echo "communication-identity: shell transition at read $n received a pane effect" >&2
      cat "$STATE/events.log" >&2; exit 1
    }
  done
  echo "communication-identity: (6g) shell transition blocks before copy-mode or injection effects: ok"
}

case_boot_stale_before_copy_mode() {
  reset_bus
  touch "$STATE/copy-mode.b-fable-pane"
  # Vary the remote recipient's stored provenance, not the machine-wide
  # current boot. Changing TAP_BOOT_ID would correctly restart-invalidate the
  # local pane sender in dispatcher preflight, so the fixture would never
  # reach the recipient's point-of-effect barrier.
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["boot_id"] = "boot:0"; json.dump(d, open(p, "w"), indent=2)
PY
  set +e
  out="$("$TAP" send --expect-reply B/fable -m rebooted --from sender --id ci-boot-stale --json 2>&1)"; rc=$?
  set -e
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["boot_id"] = "boot:1"; json.dump(d, open(p, "w"), indent=2)
PY
  [ "$rc" -ne 0 ] || { echo "communication-identity: prior-boot binding crossed the effect barrier" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* && "$out" == *boot_id_stale* && "$out" == *"stored boot_id"* ]] \
    || { echo "$out" >&2; exit 1; }
  [[ "$out" != *"pane_id, stored pane_id, and live pane_id must match"* ]] \
    || { echo "communication-identity: boot refusal misdescribed the failed axis" >&2; echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-boot-stale.md" ]
  [ ! -s "$STATE/events.log" ] || { echo "communication-identity: prior-boot binding received a pane effect" >&2; cat "$STATE/events.log" >&2; exit 1; }
  echo "communication-identity: (6h) prior-boot binding blocks before copy-mode or injection effects: ok"
}

set_sender_boot() { # <boot_id, or empty to drop the stamp>
  python3 -B - "$ABUS/registry.json" "$1" <<'PY'
import json, sys
p, boot = sys.argv[1:3]; d = json.load(open(p)); row = d["seats"]["sender"]
if boot: row["boot_id"] = boot
else: row.pop("boot_id", None)
json.dump(d, open(p, "w"), indent=2)
PY
}

case_boot_unobservable_before_copy_mode() {
  reset_bus
  touch "$STATE/copy-mode.b-fable-pane"
  # An unreadable boot is machine-wide, so a boot-stamped sender refuses on its
  # own liveness first (tap-fsmgm). Both classes are contractual; pin the order.
  set +e
  out="$(TAP_BOOT_ID= "$TAP" send --expect-reply B/fable -m boot-unknown --from sender --id ci-boot-unknown-sender --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "communication-identity: boot-unobservable sender crossed the effect barrier" >&2; exit 1; }
  [[ "$out" == *sender_liveness_unobservable* ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-boot-unknown-sender.md" ]
  [ ! -s "$STATE/events.log" ] || { echo "communication-identity: boot-unobservable sender produced a pane effect" >&2; cat "$STATE/events.log" >&2; exit 1; }
  # A sender row with no boot stamp skips that axis, so the recipient's
  # boot-stamped binding is what refuses.
  set_sender_boot ""
  set +e
  out="$(TAP_BOOT_ID= "$TAP" send --expect-reply B/fable -m boot-unknown --from sender --id ci-boot-unknown --json 2>&1)"; rc=$?
  set -e
  set_sender_boot boot:1
  [ "$rc" -ne 0 ] || { echo "communication-identity: boot-unobservable binding crossed the effect barrier" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* && "$out" == *boot_id_unobservable* ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-boot-unknown.md" ]
  [ -f "$STATE/copy-mode.b-fable-pane" ] || { echo "communication-identity: boot-unobservable binding received copy-mode cancel" >&2; exit 1; }
  [ ! -s "$STATE/events.log" ] || { echo "communication-identity: boot-unobservable binding received a pane effect" >&2; cat "$STATE/events.log" >&2; exit 1; }
  echo "communication-identity: (6i) unobservable boot blocks before copy-mode or injection effects: ok"
}

seed_bound_spool() {
  local id="$1" pane="$2" pane_id="$3" target_registry="${4:-$BBUS/registry.json}"
  reset_bus
  src="$WORK/$id.md"
  cat > "$src" <<EOF
---
id: $id
from: sender
to: fable
kind: discuss
reply: expected
from_team: A
to_team: B
path: $ABUS/payloads/$id.md
---
bound spool construction
EOF
  TAP_HOME="$ABUS" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-park-fixture.sh"; tap_ensure_dirs; spool_park_fixture "$2" "$3" fable A polite busy 600 "$4" "$5" B polite 60 "$6" >/dev/null' \
    _ "$LIB" "$id" "$src" "$pane" "$pane_id" "$target_registry"
}

seed_registry_departure_spool() {
  local id="$1"
  seed_bound_spool "$id" recycled-pane %107
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane"] = "other-pane"; d["seats"]["fable"]["pane_id"] = "%998"; json.dump(d, open(p, "w"), indent=2)
PY
}

case_spool_registry_departure() {
  seed_registry_departure_spool ci-registry-departure
  TAP_HOME="$ABUS" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB"
  [ -f "$ABUS/spool/ci-registry-departure.md" ] || { echo "communication-identity: registry-departure spool was delivered" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-registry-departure.md" ]
  [ ! -s "$STATE/events.log" ]
  echo "communication-identity: (7) registry departure after bind stays spooled: ok"
}

case_spool_toctou() {
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane"] = "b-fable-pane"; d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
  seed_bound_spool ci-spool-toctou b-fable-pane %104
  export FAKE_MUTATE_REGISTRY_ON_COMMAND=b-fable-pane FAKE_MUTATE_REGISTRY_COMMAND_N=3
  export FAKE_MUTATE_REGISTRY="$BBUS/registry.json" FAKE_MUTATE_HANDLE=fable FAKE_MUTATE_PANE_ID=%998
  TAP_HOME="$ABUS" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB"
  unset FAKE_MUTATE_REGISTRY_ON_COMMAND FAKE_MUTATE_REGISTRY_COMMAND_N FAKE_MUTATE_REGISTRY FAKE_MUTATE_HANDLE FAKE_MUTATE_PANE_ID
  [ -f "$ABUS/spool/ci-spool-toctou.md" ] || { echo "communication-identity: spool registry drift during redelivery injected" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-spool-toctou.md" ]
  ! grep -q $'^enter\tb-fable-pane$' "$STATE/events.log" 2>/dev/null
  ! grep -q $'^enter\t%104$' "$STATE/events.log" 2>/dev/null
  # The race must actually have fired, or early parking would pass as coverage.
  [ -e "$STATE/mutated" ] || { echo "communication-identity: (7b) armed registry mutation never fired" >&2; exit 1; }
  echo "communication-identity: (7b) redelivery rechecks registry immediately before inject: ok"
}

# tap-wudl2: the Bash courier's last samples before the payload paste are tmux
# captures, and the registry can rebind the recipient while they run. Sweep the
# rebind across every capture of one redelivery rather than pin an index a
# refactor can shift: whatever capture it lands on, the old recipient pane gets
# no paste after it, and a rebind ahead of every pane effect leaves the entry
# spooled with no attempt evidence. Later captures fall after the paste, where
# the courier's unverified notice to the sender pane is expected.
case_spool_final_sample_rebind() {
  local n id before pre=0 swept=0
  for n in $(seq 1 16); do
    python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane"] = "b-fable-pane"; d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
    id="ci-spool-rebind-$n"
    seed_bound_spool "$id" b-fable-pane %104
    export FAKE_MUTATE_REGISTRY_ON_CAPTURE=b-fable-pane FAKE_MUTATE_REGISTRY_CAPTURE_N="$n"
    export FAKE_MUTATE_REGISTRY="$BBUS/registry.json" FAKE_MUTATE_HANDLE=fable FAKE_MUTATE_PANE_ID=%998
    TAP_HOME="$ABUS" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" || true
    unset FAKE_MUTATE_REGISTRY_ON_CAPTURE FAKE_MUTATE_REGISTRY_CAPTURE_N FAKE_MUTATE_REGISTRY FAKE_MUTATE_HANDLE FAKE_MUTATE_PANE_ID
    if [ ! -e "$STATE/mutated" ]; then swept=1; break; fi
    before="$(cat "$STATE/mutated")"
    [ -n "$before" ] || { echo "communication-identity: (7d) rebind marker unreadable at capture $n" >&2; exit 1; }
    if [ -f "$STATE/events.log" ] && awk -v k="$before" 'NR > k && $1 == "paste" && $2 == "b-fable-pane" { hit = 1 } END { exit !hit }' "$STATE/events.log"; then
      echo "communication-identity: (7d) redelivery pasted after a registry rebind at capture $n" >&2
      cat "$STATE/events.log" >&2
      exit 1
    fi
    if [ "$before" = 0 ]; then
      pre=$((pre + 1))
      [ -f "$ABUS/spool/$id.md" ] || { echo "communication-identity: (7d) pre-effect rebind at capture $n left the spool" >&2; exit 1; }
      [ ! -e "$ABUS/receipts/$id.attempted" ] || { echo "communication-identity: (7d) pre-effect rebind at capture $n minted attempt evidence" >&2; exit 1; }
      [ ! -s "$STATE/events.log" ]
    fi
  done
  [ "$swept" = 1 ] || { echo "communication-identity: (7d) redelivery made 16 or more captures; widen the sweep" >&2; exit 1; }
  [ "$pre" -ge 1 ] || { echo "communication-identity: (7d) no rebind landed before a pane effect" >&2; exit 1; }
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
  echo "communication-identity: (7d) a rebind at any redelivery capture never precedes a paste: ok"
}

case_spool_registry_team_mismatch() {
  seed_bound_spool ci-crossed-registry a-fable-pane %102 "$ABUS/registry.json"
  [ "$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reason", ""))' "$ABUS/spool/ci-crossed-registry.meta.json")" = legacy_meta_no_binding ] || {
    echo "communication-identity: crossed team/registry pair entered the spool without a recovery reason" >&2; exit 1
  }
  TAP_HOME="$ABUS" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB"
  [ -f "$ABUS/spool/ci-crossed-registry.md" ] || { echo "communication-identity: crossed team/registry spool was delivered" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-crossed-registry.md" ]
  ! grep -q $'^enter\ta-fable-pane$' "$STATE/events.log" 2>/dev/null
  echo "communication-identity: (7c) qualified spool rejects a registry owned by another team: ok"
}

# The witness that the drain RAN: the waiter spawns its drain as a child through PATH,
# and drive_waiter's bun shim records that child's start and exit. A pane probe would
# not do: the waiter's own preliminary draft probe reads panes before any drain starts.
drain_completed() { grep -q '^exit 0$' "$STATE/engine.log" 2>/dev/null; }
delivered_ci_drain_ctl() { [ -f "$ABUS/receipts/ci-drain-ctl.sent" ]; }
# Earlier cases (7d) leave B's fable rebound; start from the fixture's own binding.
bind_foreign_fable() {
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane"] = "b-fable-pane"; d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
}
# Earlier cases stamp B's delivery clock (7d delivers to B/fable); a polite entry
# then holds until the window reopens, and a deliverer still waiting proves nothing
# either way. The clock lives on the RECIPIENT's bus.
clear_delivery_clock() {
  rm -f "${BBUS:?}/delivery/fable.json"
}
dump_waiter() {
  { echo "--- waiter log"; cat "$WORK/waiter-$1.log"; echo "--- engine log"; cat "$STATE/engine.log"; echo "--- events"; cat "$STATE/events.log"; } >&2 2>&1 || true
}
# Run the detached deliverer (runtime/bun/src/spool-waiter.ts) for one spooled id from
# A's cwd until the named predicate holds (at most ~30 s), then stop it and set
# $witnessed. It stops only the pid it started. The shim dir sits first on the waiter's
# PATH, so the drain child it spawns (`bun .../spool-engine.ts ... drain`) is logged to
# $STATE/engine.log: `start`, then `exit <rc>` when that drain finishes.
drive_waiter() {
  local id="$1" predicate="$2" pid i real_bun shim="$WORK/engine-shim"
  witnessed=0
  real_bun="$(command -v bun)"
  mkdir -p "$shim"
  cat > "$shim/bun" <<SHIM
#!/usr/bin/env bash
case " \$* " in
  *"/spool-engine.ts "*" drain "*)
    printf 'start\n' >> "$STATE/engine.log"
    "$real_bun" "\$@"; rc=\$?
    printf 'exit %s\n' "\$rc" >> "$STATE/engine.log"
    exit "\$rc" ;;
esac
exec "$real_bun" "\$@"
SHIM
  chmod +x "$shim/bun"
  rm -f "${STATE:?}/engine.log"
  ( cd "$A" && PATH="$shim:$PATH" TAP_SPOOL_DELIVERER_DELAYS="0.1 0.1 0.1" exec "$real_bun" "$ROOT/runtime/bun/src/spool-waiter.ts" "$id" ) >"$WORK/waiter-$id.log" 2>&1 &
  pid=$!
  for i in $(seq 300); do
    if "$predicate"; then witnessed=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

case_opportunistic_foreign_registry() {
  reset_bus
  clear_delivery_clock
  bind_foreign_fable
  set +e
  out="$("$TAP" send B/fable -m drain-me --from sender --polite --id ci-drain --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -eq 0 ] || { echo "communication-identity: foreign polite send was not accepted into spool" >&2; echo "$out" >&2; exit 1; }
  target_registry="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("target_registry", ""))' "$ABUS/spool/ci-drain.meta.json")"
  # Enrollment makes bus/registry.json a symlink to the acting
  # team-registry.json, and send records the acting path (tap-skn6b).
  [ -n "$target_registry" ] && [ "$(python3 -B -c 'import os, sys; print(os.path.realpath(sys.argv[1]) == os.path.realpath(sys.argv[2]))' "$target_registry" "$BBUS/registry.json")" = True ] || {
    echo "communication-identity: send construction did not persist the exact foreign registry ($target_registry)" >&2; exit 1
  }
  # Rebind the foreign seat, then let a same-named LOCAL handle claim the old
  # pane identity. A buggy opportunistic drain that consults A will inject.
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane"] = "other-pane"; d["seats"]["fable"]["pane_id"] = "%998"; json.dump(d, open(p, "w"), indent=2)
PY
  python3 -B - "$ABUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane"] = "b-fable-pane"; d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
  # `tap send` no longer drains (U5a), so a send here would pass without exercising
  # anything. Drive the drain owner that remains: the detached deliverer, run from
  # A's bus and ended by the witness, not by a clock.
  drive_waiter ci-drain drain_completed
  [ "$witnessed" = 1 ] || { echo "communication-identity: (8) the deliverer's drain never ran to completion, so the absence below proves nothing" >&2; dump_waiter ci-drain; exit 1; }
  [ -f "$ABUS/spool/ci-drain.md" ] || { echo "communication-identity: opportunistic drain used caller registry for foreign target" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-drain.md" ]
  ! grep -qs $'^enter\tb-fable-pane$' "$STATE/events.log"
  echo "communication-identity: (8) opportunistic drain uses only bound foreign registry: ok"
}

# (8b) The positive control for (8): the same deliverer invocation, same parked
# foreign entry, but B's seat has NOT been rebound. It must deliver. Without this,
# (8)'s no-injection could be a waiter that never starts from this cwd or bus.
case_opportunistic_foreign_registry_control() {
  reset_bus
  clear_delivery_clock
  bind_foreign_fable
  "$TAP" send B/fable -m drain-me --from sender --polite --id ci-drain-ctl --json >/dev/null
  drive_waiter ci-drain-ctl delivered_ci_drain_ctl
  [ "$witnessed" = 1 ] || { echo "communication-identity: (8b) the deliverer did not deliver the unrebound foreign entry" >&2; dump_waiter ci-drain-ctl; exit 1; }
  grep -q $'^enter\tb-fable-pane$' "$STATE/events.log" || { echo "communication-identity: (8b) delivered without an Enter at the bound pane" >&2; exit 1; }
  [ -f "$ABUS/payloads/ci-drain-ctl.md" ] && [ ! -f "$ABUS/spool/ci-drain-ctl.md" ]
  echo "communication-identity: (8b) the deliverer delivers a foreign entry whose seat is unrebound: ok"
}

case_legacy_spool_binding() {
  reset_bus
  local id=ci-legacy-spool src="$WORK/ci-legacy-spool.md" out rc
  cat > "$src" <<EOF
---
id: $id
from: sender
to: fable
kind: discuss
reply: expected
path: $ABUS/payloads/$id.md
---
pre-upgrade spool entry
EOF
  # Pre-upgrade metadata carried pane/pane_id but no registry binding. It must
  # remain parked and tell the sender to re-send instead of guessing locally.
  TAP_HOME="$ABUS" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-park-fixture.sh"; tap_ensure_dirs; spool_park_fixture "$2" "$3" fable A polite busy 600 a-fable-pane %102 "" polite 60 >/dev/null' \
    _ "$LIB" "$id" "$src"
  TAP_HOME="$ABUS" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB"
  set +e
  out="$("$TAP" outstanding sender 2>&1)"; rc=$?
  set -e
  [ "$rc" -eq 2 ] || { echo "communication-identity: legacy spool disappeared from outstanding" >&2; echo "$out" >&2; exit 1; }
  [[ "$out" == *"reason: legacy_meta_no_binding"* ]] || { echo "communication-identity: legacy spool lacks named recovery reason" >&2; echo "$out" >&2; exit 1; }
  [ -f "$ABUS/spool/$id.md" ] || { echo "communication-identity: legacy spool was injected" >&2; exit 1; }
  [ "$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reason", ""))' "$ABUS/spool/$id.meta.json")" = legacy_meta_no_binding ]
  echo "communication-identity: (9) pre-upgrade spool parks with named re-send reason: ok"
}

case_malformed_registry_id_no_suspend() {
  reset_bus
  python3 -B - "$ABUS/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
row = data["seats"]["fable"]
row.update({"pane": "missing-pane", "pane_id": "%tap-claude", "status": "active"})
row.pop("status_reason", None)
json.dump(data, open(path, "w"), indent=2, sort_keys=True)
PY
  set +e
  out="$("$TAP" send --expect-reply fable -m corrupt-row --from sender --id ci-malformed-id --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "communication-identity: malformed registry pane_id was delivered" >&2; exit 1; }
  python3 -B - "$ABUS/registry.json" <<'PY' || {
import json, sys
row = json.load(open(sys.argv[1]))["seats"]["fable"]
assert row.get("status") == "active", row
assert not row.get("status_reason"), row
PY
    echo "communication-identity: malformed pane_id changed the live seat's status" >&2
    exit 1
  }
  [[ "$out" == *identity_unverified* && "$out" == *pane_id* ]] || {
    echo "communication-identity: malformed pane_id refusal lacked identity repair guidance" >&2
    echo "$out" >&2
    exit 1
  }
  [ ! -f "$ABUS/payloads/ci-malformed-id.md" ]
  [ ! -s "$STATE/events.log" ]
  python3 -B - "$ABUS/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["seats"]["fable"].update({
    "pane": "a-fable-pane", "pane_id": "%102", "status": "active",
})
data["seats"]["fable"].pop("status_reason", None)
json.dump(data, open(path, "w"), indent=2, sort_keys=True)
PY
  echo "communication-identity: (10) malformed registry pane_id refuses without suspension: ok"
}

run_case() {
  case "$1" in
    2) case_bare_local ;;
    6a) case_reply_to_binding ;;
    6b) case_nudge_sentinel_binding ;;
    6c) case_direct_toctou ;;
    6c2) case_direct_foreign_toctou ;;
    6d) case_explicit_pane_mismatch ;;
    6e) case_unbound_manual_spool_refused ;;
    6e2) case_rowless_harness_drift_before_effect ;;
    6f) case_stuck_sentinel_recipient_guard ;;
    6g) case_harness_exit_before_copy_mode ;;
    6h) case_boot_stale_before_copy_mode ;;
    6i) case_boot_unobservable_before_copy_mode ;;
    7) case_spool_registry_departure ;;
    7b) case_spool_toctou ;;
    7d) case_spool_final_sample_rebind ;;
    7c) case_spool_registry_team_mismatch ;;
    8) case_opportunistic_foreign_registry ;;
    8b) case_opportunistic_foreign_registry_control ;;
    9) case_legacy_spool_binding ;;
    10) case_malformed_registry_id_no_suspend ;;
    *) echo "communication-identity-full: unknown case '$1'" >&2; exit 2 ;;
  esac
}

if [ -n "${COMM_ID_CASE:-}" ]; then
  run_case "$COMM_ID_CASE"
else
  for c in 2 6a 6b 6c 6c2 6d 6e 6e2 6f 6g 6h 6i 7 7b 7d 7c 8b 8 9 10; do run_case "$c"; done
  echo "communication-identity-full: ok"
fi
