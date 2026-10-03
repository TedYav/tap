#!/usr/bin/env bash
# delivery-enum.test.sh — tap-7r3fn.20 U1+2. `--delivery interrupt|now|polite`,
# its aliases, and the conflict matrix.
#
# The alias rows are the ones worth reading twice. --urgent and --polite map onto
# interrupt and polite exactly. --wake maps onto `now` ON THE DELIVERY AXIS ONLY
# (ruling 51): `now` is already the default, so --wake no longer changes when a
# note arrives — but it keeps a second, separate effect of declining courier
# pre-settlement. Calling it a no-op alias would be false in exactly the way that
# matters, and arm 5 pins the half that survives.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus" TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
mkdir -p "$TAP_HOME"

fail() { echo "delivery-enum: FAIL — $*" >&2; exit 1; }
ok()   { echo "  ok   $*"; }

# The bus is deliberately empty: every arm below is decided during OPTION
# PARSING, which runs before any bus resolution. A parse that is accepted falls
# through to the unregistered-recipient refusal, and that refusal is the signal
# the flag was understood. Asserting on the message rather than the exit code
# matters because both outcomes exit 1.
send_out() { bash "$TAPSH" send peer -m x --from a "$@" 2>&1 || true; }
accepted() { # <description> <flags...>
  local d="$1"; shift
  local out; out="$(send_out "$@")"
  case "$out" in
    *"unknown option"*)  fail "$d — the parser rejected it as an unknown option: $out" ;;
    # MATCH THE REFUSAL, NOT THE FLAG NAME. This arm used to match any output
    # containing `--delivery`, and an unrelated sender-registration error whose
    # hint reads `tap register a --delivery poll` satisfied that glob — so a
    # fixture-setup problem was reported as a parser refusal. Both real refusals
    # name "delivery class"; the flag name alone appears in prose that has
    # nothing to do with parsing.
    *"delivery class"*)  fail "$d — the parser refused it: $out" ;;
    *"pass either"*)     fail "$d — the parser refused it: $out" ;;
  esac
}
refused() { # <description> <expected-substring> <flags...>
  local d="$1" want="$2"; shift 2
  local out; out="$(send_out "$@")"
  case "$out" in
    *"$want"*) ;;
    *) fail "$d — expected a refusal naming '$want', got: $out" ;;
  esac
}

# --- 1. the three values parse ------------------------------------------------
for v in interrupt now polite; do
  accepted "--delivery $v" --delivery "$v"
done
ok "--delivery interrupt|now|polite all parse"

# --- 2. an unknown value is refused and names the legal set ------------------
refused "--delivery bogus" "takes interrupt, now, or polite" --delivery bogus
refused "--delivery bogus" "got 'bogus'" --delivery bogus
ok "an unknown value is refused, naming the three legal values and the one given"

# --- 3. a legacy spelling naming the SAME class is accepted -----------------
accepted "interrupt + --urgent" --delivery interrupt --urgent
accepted "polite + --polite"    --delivery polite --polite
accepted "now + --wake"         --delivery now --wake
ok "a legacy spelling that agrees with --delivery is accepted"

# --- 4. a legacy spelling naming a DIFFERENT class is refused ---------------
# Refused rather than resolved: a sender who wrote two delivery intents has one
# of them wrong, and picking a winner is how the other is silently dropped.
refused "interrupt vs --polite" "--delivery interrupt contradicts --polite" --delivery interrupt --polite
refused "interrupt vs --wake"   "--delivery interrupt contradicts --wake"   --delivery interrupt --wake
refused "polite vs --urgent"    "--delivery polite contradicts --urgent"    --delivery polite --urgent
refused "polite vs --wake"      "--delivery polite contradicts --wake"      --delivery polite --wake
refused "now vs --urgent"       "--delivery now contradicts --urgent"       --delivery now --urgent
refused "now vs --polite"       "--delivery now contradicts --polite"       --delivery now --polite
ok "every contradictory pair is refused, and the message names both spellings"

# --- 5. --fyi is NOT a delivery class ---------------------------------------
# It is reply expectation plus the supervisor probe/notice marker. Keeping it off
# this axis is why --fyi and --delivery coexist without a conflict rule.
accepted "--fyi with --delivery now"    --fyi --delivery now
accepted "--fyi with --delivery polite" --fyi --delivery polite
refused "--fyi with --ask still refuses" "either --fyi or --ask" --fyi --ask
ok "--fyi is orthogonal to --delivery and keeps its own --ask exclusion"

# --- 6. the pre-existing exclusion survives ----------------------------------
refused "--polite with --urgent" "pass either --polite or --urgent" --polite --urgent
ok "--polite with --urgent is still refused on its own terms"

# --- 7. the flag needs a value ----------------------------------------------
out="$(bash "$TAPSH" send peer -m x --from a --delivery 2>&1 || true)"
case "$out" in
  *"--delivery needs a value"*) ;;
  *) fail "a bare --delivery should say it needs a value, got: $out" ;;
esac
ok "a bare --delivery reports that it needs a value"

# --- 8. the help surface carries the enum -----------------------------------
# A flag the CLI accepts and the help does not name is a flag nobody finds.
help="$(bash "$TAPSH" help send 2>&1)"
case "$help" in
  *"--delivery interrupt|now|polite"*) ;;
  *) fail "tap help send does not carry the --delivery usage" ;;
esac
case "$help" in
  *"defaults to now"*) ;;
  *) fail "tap help send does not say which class is the default" ;;
esac
case "$help" in
  *"LAST VERIFIED DELIVERY"*) ;;
  *) fail "tap help send does not say what the window is measured from" ;;
esac
ok "tap help send names the enum, its default, and what the window measures from"

# =============================================================================
# THE ENUM REACHES THE MACHINERY. Every arm above decides during option PARSING,
# so all of them pass while `--delivery` is accepted and then does nothing:
# deleting the line that maps `interrupt` onto URGENT survived the entire file.
# These arms observe the EFFECT instead — which policy the entry parks under, and
# which path the send takes — against a real courier over a mock tmux.
# =============================================================================
(
  E2E="$WORK/e2e"; FAKE_BIN="$E2E/bin"
  mkdir -p "$FAKE_BIN" "$E2E/tmux" "$E2E/repo"
  cat > "$FAKE_BIN/tmux" <<'TMUXMOCK'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      # Native server-identity probe: the generation the registry pins (srv:4242:100).
      *start_time*) echo "4242:100" ;;
      # Native five-field pane observation (pane_id+session_name+pane_pid+pane_current_command+pane_dead).
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-%401}" "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "${FAKE_PANE_ID:-%401}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    if [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input.$key"; exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input.$key"; exit 0; fi
    ;;
esac
TMUXMOCK
  chmod +x "$FAKE_BIN/tmux"
  export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$E2E/tmux" \
         FAKE_WORKTREE="$E2E/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
  export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
  export TAP_SPOOL_DISABLE_DELIVERER=1
  BUS="$E2E/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"
  export TAP_HOME="$BUS"
  cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$E2E/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$E2E/repo" },
    "alice": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$E2E/repo" }
  } }
JSON
  policy_of() { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("policy") or "")
except Exception: print("")' "$BUS/spool/$1.meta.json"; }

  # polite: the enum must park the entry under the SAME policy the legacy flag
  # does, because the whole downstream window and deadline machinery keys on it.
  bash "$TAPSH" send peer -m "legacy" --id lp --from alice --polite >/dev/null 2>&1 || true
  bash "$TAPSH" send peer -m "enum"   --id ep --from alice --delivery polite >/dev/null 2>&1 || true
  legacy="$(policy_of lp)"; enum="$(policy_of ep)"
  [ "$legacy" = polite ] \
    || { echo "delivery-enum: FAIL — --polite parked as '$legacy', expected polite (the fixture, not the enum, is wrong)" >&2; exit 1; }
  [ "$enum" = "$legacy" ] \
    || { echo "delivery-enum: FAIL — --delivery polite parked as '$enum' while --polite parked as '$legacy'; the enum is accepted but does not reach the machinery" >&2; exit 1; }

  # interrupt: the urgent path announces itself before injecting, unconditionally
  # and regardless of harness, so its warning is the observable that the enum
  # resolved onto URGENT rather than merely being spelled.
  legacy_err="$(bash "$TAPSH" send peer -m "legacy u" --id lu --from alice --urgent 2>&1 >/dev/null || true)"
  enum_err="$(bash "$TAPSH" send peer -m "enum u" --id eu --from alice --delivery interrupt 2>&1 >/dev/null || true)"
  case "$legacy_err" in
    *"interrupt attempt for"*) ;;
    *) echo "delivery-enum: FAIL — --urgent printed no interrupt warning; the fixture cannot see this path: $legacy_err" >&2; exit 1 ;;
  esac
  case "$enum_err" in
    *"interrupt attempt for"*) ;;
    *) echo "delivery-enum: FAIL — --delivery interrupt printed no interrupt warning while --urgent did; the enum is accepted but does not reach URGENT" >&2; exit 1 ;;
  esac
) || exit 1
ok "--delivery polite and interrupt reach the same machinery their legacy spellings do"

# =============================================================================
# RULING 51: WHO OWES THE SETTLE. Delivery timing and settlement obligation are
# two axes, and --wake now moves only the first. These arms observe the second.
# =============================================================================
(
  E2E="$WORK/settle"; FAKE_BIN="$E2E/bin"
  mkdir -p "$FAKE_BIN" "$E2E/tmux" "$E2E/repo"
  cp "$WORK/e2e/bin/tmux" "$FAKE_BIN/tmux" 2>/dev/null || cat > "$FAKE_BIN/tmux" <<'TMUXMOCK'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      # Native server-identity probe: the generation the registry pins (srv:4242:100).
      *start_time*) echo "4242:100" ;;
      # Native five-field pane observation (pane_id+session_name+pane_pid+pane_current_command+pane_dead).
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-%401}" "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "${FAKE_PANE_ID:-%401}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    if [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input.$key"; exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input.$key"; exit 0; fi
    ;;
esac
TMUXMOCK
  chmod +x "$FAKE_BIN/tmux"
  export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$E2E/tmux" \
         FAKE_WORKTREE="$E2E/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
  export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
  export TAP_SPOOL_DISABLE_DELIVERER=1
  BUS="$E2E/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"
  export TAP_HOME="$BUS"
  cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$E2E/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$E2E/repo" },
    "alice": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$E2E/repo" }
  } }
JSON
  policy_of() { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("policy") or "")
except Exception: print("")' "$BUS/spool/$1.meta.json"; }
  sendp() { TAP_AUTOSETTLE_HOLD_SECONDS=99999 bash "$TAPSH" send "$@"; }

  # All three spellings remain recipient-settled. None creates courier .done.
  sendp peer -m "note" --id s1 --from alice >/dev/null 2>&1 || fail "plain send failed"
  sendp peer -m "answer" --id s2 --from alice --in-reply-to s1 >/dev/null 2>&1 || fail "correlated send failed"
  sendp peer -m "woken" --id s3 --from alice --wake >/dev/null 2>&1 || fail "wake send failed"
  for id in s1 s2 s3; do
    [ -f "$BUS/receipts/$id.sent" ] || fail "$id did not deliver to a bare composer"
    [ ! -f "$BUS/receipts/$id.done" ] || fail "$id falsely settled before recipient read"
    [ ! -f "$BUS/spool/$id.md" ] || fail "$id parked without draft or siblings"
  done
) || exit 1
ok "plain, correlated and wake notes all wait for recipient settlement"

echo "delivery-enum: ok"
