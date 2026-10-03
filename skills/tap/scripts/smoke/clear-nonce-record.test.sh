#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# clear-nonce-record.test.sh (tap-eb9h, tap-36kb) — the register half of
# `tap clear`'s rebind witness.
#
# Record-only-on-match. Arms and which assertion a mutation must redden:
# 1. awaited+matching RECORDS — reds here if recording is neutered.
# 2. awaited+NON-matching writes nothing on the SAME fixture as (1). A
#    non-matching TAP_CLEAR_ID is not an answer to this clear's pending
#    question. Reds here if mismatch plants a foreign nonce.
# 3. TAP_CLEAR_ID absent pops the WITNESS, leaves the PENDING QUESTION.
# 4. TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE blanks then pops the witness.
# 5. stale descendant (no expected, TAP_CLEAR_ID present) writes nothing.
set -euo pipefail

export TAP_TUI_SETTLE_SCALE=0.1

# THIS FILE DOES NOT SOURCE sandbox-pins.sh, so it must drop the inherited nonce
# itself. Every descendant of a clear-launched harness carries TAP_CLEAR_ID for
# that process's whole life, which means running this suite from a cleared seat
# feeds the operator's own clear nonce to arm 2's registration — the arm whose
# entire claim is that a nonce-less registration leaves NO nonce behind. It fails
# loudly and confusingly (it reports the OPERATOR's nonce), and it fails only for
# people whose seat was cleared, which is the least reproducible kind of red.
unset TAP_CLEAR_ID

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export TAP_BOOT_ID="boot:424242"
# Own machine index, for two reasons. Isolation: registration ENROLLS the team it
# registers into, and once an enrolled team's team-registry.json exists the CLI
# resolves the ACTING registry through the index instead of the ambient bus path
# — so a test reading $TAP_HOME/registry.json would assert against a file the CLI
# stopped writing, and would pass or fail depending on leftovers from earlier
# runs. Hygiene: without this the run enrolls a throwaway team into the
# operator's real ~/.tap index and leaves it there.
export TAP_INDEX_HOME="$TAP_HOME/index"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_INDEX_HOME"

cat > "$FAKE_BIN/ps" <<'ENDPS'
#!/usr/bin/env bash
printf '1 faketty\n'
ENDPS
chmod +x "$FAKE_BIN/ps"

# Minimal fake tmux: one live pane in session "alpha", answering the record
# shapes registration probes for. Mirrors register-collision.test.sh's rules.
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
caller_pane_id="%alpha:0.0"
if [ "${1:-}" = "list-sessions" ]; then
  printf 'alpha\t4242:100\t0\n'
  exit 0
fi
if [ "${1:-}" = "list-panes" ]; then
  panes_fmt=""
  args=("$@"); i=0
  while [ "$i" -lt "${#args[@]}" ]; do
    if [ "${args[$i]}" = "-F" ]; then panes_fmt="${args[$((i+1))]}"; fi
    i=$((i+1))
  done
  case "$panes_fmt" in
    *pane_current_command*)
      printf 'alpha\talpha:0.0\t%s\tclaude\t1\t4242:100\t0\n' "$caller_pane_id"
      ;;
    *)
      printf '%s\t/dev/faketty\n' "$caller_pane_id"
      ;;
  esac
  exit 0
fi
[ "${1:-}" = "display-message" ] || exit 0
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) target="$2"; shift 2 ;;
    *)  fmt="$1"; shift ;;
  esac
done
tpid() { case "$target" in %*) printf '%s' "$target" ;; *) printf '%%%s' "$(printf '%s' "$target" | cksum | cut -d' ' -f1)" ;; esac; }
tsess() { local s="${target#%}"; printf '%s' "${s%%:*}"; }
case "$fmt" in
  # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
  *pane_id*pane_tty*session_name*) if [ -n "$target" ]; then printf '%s\t/dev/faketty\t%s\t4242:100\n' "$(tpid)" "$(tsess)"; else printf '%%900\t/dev/faketty\talpha\t4242:100\n'; fi ;;
  *pane_id*session_name*pane_pid*pane_current_command*) if [ -n "$target" ]; then printf '%s\t%s\t1\tclaude\t0\n' "$(tpid)" "$(tsess)"; else printf '%%900\talpha\t1\tclaude\t0\n'; fi ;;
  *pane_id*session_name*start_time*)
    if [ -n "$target" ]; then printf '%s\t%s\t4242:100\n' "$(tpid)" "$(tsess)"; else printf '%%900\talpha\t4242:100\n'; fi ;;
  *pane_id*session_name*)
    if [ -n "$target" ]; then printf '%s\t%s\n' "$(tpid)" "$(tsess)"; else printf '%%900\talpha\n'; fi ;;
  *pane_id*pane_tty*)
    if [ -n "$target" ]; then printf '%s\t/dev/faketty\n' "$(tpid)"; else echo ""; fi ;;
  *window_index*)         echo "alpha:0.0" ;;
  *session_name*)         if [ -n "$target" ]; then tsess; echo; else echo "alpha"; fi ;;
  *pane_id*)              if [ -n "$target" ]; then tpid; echo; else echo "%900"; fi ;;
  *pane_current_command*) echo "claude" ;;
  *pane_current_path*)    echo "${PWD}" ;;
  *pid*start_time*)       echo "4242:100" ;;
  *) echo "" ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

# Seeded directly, not bootstrapped: $TAP_HOME is a bare scratch dir (not a
# canonical <worktree>/.tap/bus path), so the born-live authority gate refuses
# to bootstrap it from nothing — an unclassified custom bus with nothing
# established to preserve. A readable, seat-less schema+seats doc gives line
# 135's seed registration an established pre-flip world to write into.
cat > "$TAP_HOME/registry.json" <<JSON
{"schema":"0.20","team":{"name":"clear-nonce-record"},"seats":{}}
JSON

REG="$TAP_HOME/registry.json"
nonce_of() {
  python3 - "$REG" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
agents = payload.get("agents") or payload.get("seats") or {}
entry = agents.get("scout") or {}
print(entry.get("clear_nonce", "<absent>"))
PY
}
expected_of() {
  python3 - "$REG" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
agents = payload.get("agents") or payload.get("seats") or {}
entry = agents.get("scout") or {}
print(entry.get("expected_clear_nonce", "<absent>"))
PY
}
stamp_expected() {
  python3 - "$REG" "$1" <<'PY'
import json, sys
reg, nonce = sys.argv[1], sys.argv[2]
payload = json.load(open(reg))
agents = payload.get("agents") or payload.get("seats")
agents["scout"]["expected_clear_nonce"] = nonce
json.dump(payload, open(reg, "w"))
PY
}
drop_expected() {
  python3 - "$REG" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
agents = payload.get("agents") or payload.get("seats")
agents["scout"].pop("expected_clear_nonce", None)
json.dump(payload, open(sys.argv[1], "w"))
PY
}

# Seed the row.
bash "$TAP" register scout --pane "alpha:0.0" >/dev/null 2>&1

# --- bidirectional fixture: matching RECORDS, then non-matching writes nothing
# Arm 3's "wrote nothing" is only meaningful next to a matching write on the
# same row. A mutation that neuters recording leaves arm 3 green and this
# matching assert red — that red must land HERE, not on a later arm.
stamp_expected "nonce-wait"
TAP_CLEAR_ID="nonce-wait" bash "$TAP" register scout --pane "alpha:0.0" --force >/dev/null 2>&1
got="$(nonce_of)"
[ "$got" = "nonce-wait" ] || {
  echo "clear-nonce-record: MATCHING arm: expected nonce-wait recorded, got '$got'" >&2; exit 1; }
[ "$(expected_of)" = "nonce-wait" ] || {
  echo "clear-nonce-record: MATCHING arm must not pop expected_clear_nonce, got '$(expected_of)'" >&2; exit 1; }

mismatch_err="$(mktemp)"
TAP_CLEAR_ID="nonce-other" bash "$TAP" register scout --pane "alpha:0.0" --force >/dev/null 2>"$mismatch_err"
got="$(nonce_of)"
[ "$got" = "nonce-wait" ] || {
  echo "clear-nonce-record: ARM 3 (non-matching): a non-matching TAP_CLEAR_ID is not an answer to this clear's pending question — must leave clear_nonce=nonce-wait, got '$got'" >&2; exit 1; }
[ "$(expected_of)" = "nonce-wait" ] || {
  echo "clear-nonce-record: ARM 3 must not pop expected_clear_nonce, got '$(expected_of)'" >&2; exit 1; }
grep -q "not an answer to this clear's pending question" "$mismatch_err" || {
  echo "clear-nonce-record: ARM 3 must breadcrumb both nonces, stderr was:" >&2; cat "$mismatch_err" >&2; exit 1; }
grep -q "clear_nonce_mismatch" "$TAP_HOME/registry-events.log" || {
  echo "clear-nonce-record: ARM 3 must append registry-events clear_nonce_mismatch" >&2
  cat "$TAP_HOME/registry-events.log" >&2; exit 1; }
rm -f "$mismatch_err"

# --- TAP_CLEAR_ID absent pops the WITNESS, leaves the QUESTION ---------------
bash "$TAP" register scout --pane "alpha:0.0" --force >/dev/null 2>&1
got="$(nonce_of)"
[ "$got" = "<absent>" ] || {
  echo "clear-nonce-record: nonce-less registration must REMOVE clear_nonce, found '$got'" >&2; exit 1; }
[ "$(expected_of)" = "nonce-wait" ] || {
  echo "clear-nonce-record: nonce-less registration must LEAVE expected_clear_nonce standing (the identity_capture analogue pin), got '$(expected_of)'" >&2; exit 1; }

# --- suppress blanks CLEAR_ID then pops the witness, question stays ----------
stamp_expected "nonce-wait"
TAP_CLEAR_ID="nonce-from-the-driver" TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE=1 \
  bash "$TAP" register scout --pane "alpha:0.0" --force >/dev/null 2>&1
got="$(nonce_of)"
[ "$got" = "<absent>" ] || {
  echo "clear-nonce-record: suppressed capture must not stamp the driver's nonce, found '$got'" >&2; exit 1; }
[ "$(expected_of)" = "nonce-wait" ] || {
  echo "clear-nonce-record: suppress must not pop expected_clear_nonce, got '$(expected_of)'" >&2; exit 1; }

# --- stale descendant: no pending question, TAP_CLEAR_ID present writes nothing
drop_expected
TAP_CLEAR_ID="nonce-leaked" bash "$TAP" register scout --pane "alpha:0.0" --force >/dev/null 2>&1
got="$(nonce_of)"
[ "$got" = "<absent>" ] || {
  echo "clear-nonce-record: stale-descendant must not plant a nonce that answers no question, found '$got'" >&2; exit 1; }

echo "clear-nonce-record: ok"
