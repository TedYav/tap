#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# escalate.test.sh — CONTRACT.md §Escalation (v0.21): `tap escalate` reaches the
# HUMAN directly by invoking notify-user, and is NOT a bus send.
#
#   - exact frozen invocation: notify-user --template question -- "<label>"
#   - label order: <question> — <team>/<handle>  (symbols first, seat label LAST)
#   - the `--` terminator is UNCONDITIONAL (a dash-leading question stays text)
#   - the question is the FIRST NON-EMPTY LINE of the body; the rest stays local
#   - session precision: [tmux: <session>] ONLY when the registry's pane-backed
#     session differs; never guessed; poll seats one-way with no suffix
#   - --from must name a REGISTERED seat (truthfulness), but suspended/pane-gone/
#     poll seats PROCEED one-way — the v0.20 dischargeable bar is deliberately
#     relaxed, because "the asker is unreachable" is news a human wants
#   - identity comes from the resolved --from, never a fresh whoami (watcher/
#     goalie escalate on behalf of the armer while pane-less themselves)
#   - the notifier is reached through TAP_NOTIFY_USER_BIN; missing is a LOUD
#     error_class=notify_user_missing exit 2, never a silent no-op
#   - NO bus payload, receipt, or reply obligation is minted (gateway RETIRED)
#   - watcher integration: _watch_notify_human still escalates best-effort, and
#     its failure still never blocks the sticky NOTIFY write
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # machine index redirect: never touch real ~/.tap
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    # Native server-identity probe (no -t): a stable generation, self-stamped at
    # register time and re-read at send time.
    case "$fmt" in *pid*:*start_time*) echo "4242:100"; exit 0 ;; esac
    if [ -z "$target" ]; then echo "invoker:0.0"; exit 0; fi
    case "$fmt" in
      # Native five-field pane observation (pane_id+session_name+pane_pid+pane_current_command+pane_dead).
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%%s\tsess\t4242\tcodex\t0\n' "${target}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "%${target}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:-$WORK/repo}" ;;
      *window_activity*)      echo "100" ;;
      *) echo "" ;;
    esac ;;
  capture-pane) printf '❯ \n' ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" FAKE_WORKTREE="$WORK/repo"

# --- the notifier stub: records argv EXACTLY, one arg per line -----------------
# Recording argv rather than a rendered string is the point: it is the only way
# to prove the `--` terminator and the flag ORDER, which a joined string hides.
NOTIFY_LOG="$WORK/notify.log"
cat > "$FAKE_BIN/notify-stub" <<'STUB'
#!/usr/bin/env bash
: > "${NOTIFY_LOG:?}"
for a in "$@"; do printf '%s\n' "$a" >> "$NOTIFY_LOG"; done
exit "${NOTIFY_STUB_RC:-0}"
STUB
chmod +x "$FAKE_BIN/notify-stub"
export TAP_NOTIFY_USER_BIN="$FAKE_BIN/notify-stub" NOTIFY_LOG

# argv accessors over the recorded log
nth()   { sed -n "${1}p" "$NOTIFY_LOG"; }
label() { tail -1 "$NOTIFY_LOG"; }

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"
export TAP_HOME="$BUS"
# `armer` is a registered PANE member on a DIFFERENT pane than whatever the
# invoker resolves to (invoker:0.0, per the mock's no-target default) — exactly
# the on-behalf-of shape (a pane-less watcher escalating --from the armer). No
# entry may claim invoker:0.0, or the identity-source case below would stop
# testing anything.
cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "armer":  { "pane": "armerpane:0.0", "pane_id": "%armerpane", "harness": "codex", "status": "active", "session": "t/armer", "registered_from_worktree": "$WORK/repo" },
    "oddsess": { "pane": "oddpane:0.0", "pane_id": "%oddpane", "harness": "codex", "status": "active", "session": "OtherProject/oddsess", "registered_from_worktree": "$WORK/repo" },
    "nosess": { "pane": "nspane:0.0", "pane_id": "%nspane", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "pollguy": { "delivery": "poll", "harness": "pollguy", "status": "active", "status_reason": "", "session": "should/be-ignored", "registered_at": "x", "registered_from_worktree": "$WORK/repo" },
    "susp-armer": { "pane": "armerpane:0.0", "pane_id": "%susparmer", "harness": "codex", "status": "suspended", "status_reason": "pane_gone", "session": "t/susp-armer", "registered_from_worktree": "$WORK/repo" }
  } }
JSON

# --- (1) the frozen invocation shape, argv-exact -------------------------------
bash "$TAPSH" escalate -m "Ship tonight or hold?" --from armer >"$WORK/e1.out" 2>"$WORK/e1.err" \
  || { echo "escalate: (1) happy-path escalate failed" >&2; cat "$WORK/e1.err" >&2; exit 1; }
[ "$(nth 1)" = "--template" ] || { echo "escalate: (1) argv[1] should be --template (got '$(nth 1)')" >&2; cat "$NOTIFY_LOG" >&2; exit 1; }
[ "$(nth 2)" = "question" ]   || { echo "escalate: (1) argv[2] should be question (got '$(nth 2)')" >&2; cat "$NOTIFY_LOG" >&2; exit 1; }
[ "$(nth 3)" = "--" ]         || { echo "escalate: (1) argv[3] must be the -- terminator (got '$(nth 3)')" >&2; cat "$NOTIFY_LOG" >&2; exit 1; }
[ "$(wc -l < "$NOTIFY_LOG" | tr -d ' ')" = 4 ] || { echo "escalate: (1) expected exactly 4 argv entries" >&2; cat "$NOTIFY_LOG" >&2; exit 1; }

# ── tap-52ys: 22 of 26 arms removed (ratified 2026-08-14) ───────────────────
# escalate is the human-notify contract and we used it tonight, but 22 of its
# arms rendered the LABEL (suffix shapes, session naming, question extraction).
# grok's four: a missing notifier fails loud, a failing one surfaces its code,
# -f keeps command-shaped prose as data, and escalate mints no payload/receipt/
# obligation — it is not a bus send.
#
# Accepted gap, named: every label-rendering variant, --urgent priority, the
# retired-ladder inertness check, --team anchoring, the watcher on-behalf-of
# shape, the sticky-NOTIFY degradation path, and the notifier watchdog.

# --- (14) a MISSING notifier is loud, never a silent no-op ---------------------
rc=0; TAP_NOTIFY_USER_BIN="/nonexistent/no-notifier" bash "$TAPSH" escalate -m "q" --from armer --json \
  >"$WORK/e14.out" 2>/dev/null || rc=$?
[ "$rc" = 2 ] || { echo "escalate: (14) a missing notifier should exit 2 (got $rc)" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="notify_user_missing", d' "$WORK/e14.out" \
  || { echo "escalate: (14) should be error_class=notify_user_missing" >&2; cat "$WORK/e14.out" >&2; exit 1; }
echo "escalate: (14) a missing notifier fails loud (error_class=notify_user_missing, exit 2) — the caller must not think it sent: ok"


# --- (15) a notifier that FAILS is reported as not-reached ---------------------
rc=0; NOTIFY_STUB_RC=7 bash "$TAPSH" escalate -m "q" --from armer --json >"$WORK/e15.out" 2>/dev/null || rc=$?
[ "$rc" = 7 ] || { echo "escalate: (15) should surface the notifier's own exit code (got $rc)" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="notify_failed", d' "$WORK/e15.out" \
  || { echo "escalate: (15) should be error_class=notify_failed" >&2; cat "$WORK/e15.out" >&2; exit 1; }
echo "escalate: (15) a failing notifier surfaces its exit code as notify_failed: ok"


# --- (16) -f keeps command-shaped prose as DATA (tap-9sjp / tap-psif class) ----
export BACKTICK_PROBE="$WORK/escalate-backtick.probe"
export DOLLAR_PROBE="$WORK/escalate-dollar.probe"
cat > "$WORK/reason.md" <<'EOF'
blocked on `touch "$BACKTICK_PROBE"` and $(touch "$DOLLAR_PROBE")
EOF
bash "$TAPSH" escalate -f "$WORK/reason.md" --from armer >/dev/null 2>&1 \
  || { echo "escalate: (16) body-file escalate failed" >&2; exit 1; }
grep -qF 'touch "$BACKTICK_PROBE"' "$NOTIFY_LOG" \
  || { echo "escalate: (16) the label lost backtick prose" >&2; cat "$NOTIFY_LOG" >&2; exit 1; }
[ ! -e "$BACKTICK_PROBE" ] || { echo "escalate: (16) backtick form was EVALUATED" >&2; exit 1; }
[ ! -e "$DOLLAR_PROBE" ]   || { echo "escalate: (16) dollar-paren form was EVALUATED" >&2; exit 1; }
echo "escalate: (16) -f keeps command-shaped prose as data, unevaluated: ok"

# --- (16b) -f - accepts the canonical quoted-heredoc form ---------------------
rm -f "$BACKTICK_PROBE" "$DOLLAR_PROBE"
bash "$TAPSH" escalate -f - --from armer >/dev/null 2>&1 <<'EOF' \
  || { echo "escalate: (16b) stdin-body escalate failed" >&2; exit 1; }
blocked on `touch "$BACKTICK_PROBE"` and $(touch "$DOLLAR_PROBE")
EOF
grep -qF 'touch "$BACKTICK_PROBE"' "$NOTIFY_LOG" \
  || { echo "escalate: (16b) the stdin label lost backtick prose" >&2; cat "$NOTIFY_LOG" >&2; exit 1; }
[ ! -e "$BACKTICK_PROBE" ] || { echo "escalate: (16b) backtick form was EVALUATED" >&2; exit 1; }
[ ! -e "$DOLLAR_PROBE" ]   || { echo "escalate: (16b) dollar-paren form was EVALUATED" >&2; exit 1; }
echo "escalate: (16b) -f - reads quoted-heredoc prose as data: ok"


# --- (17) NO bus artifacts: the gateway path is retired, not merely unused -----
# The strongest statement this file makes. A payload here would mean the verb
# still talks to an agent.
[ -z "$(ls -A "$BUS/payloads" 2>/dev/null || true)" ] \
  || { echo "escalate: (17) escalate minted a bus payload — the gateway send is supposed to be RETIRED" >&2; ls -la "$BUS/payloads" >&2; exit 1; }
[ -z "$(ls -A "$BUS/receipts" 2>/dev/null || true)" ] \
  || { echo "escalate: (17) escalate minted a receipt — it is not a bus send" >&2; ls -la "$BUS/receipts" >&2; exit 1; }
echo "escalate: (17) no payload, no receipt, no reply obligation — escalate is not a bus send: ok"

echo "escalate: ok"
