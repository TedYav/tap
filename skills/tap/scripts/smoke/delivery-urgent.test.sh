#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.

# tap-7r3fn.20: this file is about URGENT delivery and pane readiness, and it
# sends seven times to a small set of seats — so under the delivery window every
# send after the first to a given seat parks instead of reaching the behaviour
# under test. The earlier arm (1b) is the one that shows it: it asserts an ordinary
# send to a generating agy pane INJECTS, and a parked send injects nothing, so
# the window reads as exactly the tap-92v3r defect that arm exists to catch.
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window) without this file learning where the clock lives.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# delivery-urgent.test.sh — tap-gzn PR-B: --urgent send-path (interrupt-then-
# inject), the per-harness interrupt matrix, hermes's bare-inject-IS-the-
# interrupt inversion, the never-bypassed safety gate, the urgency envelope/
# sentinel marker, and explicit interrupt authority.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  # CONTRACT §Session-name authority: exact session, numeric id, generation,
  # and harness evidence are one current snapshot; display remains the urgent
  # behavior seam below.
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%1001\t%s\t4242\t4242:100\t0\nsess\tsess:0.1\t%%1002\tcodex\t4242\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      # Native server-identity probe (tmux.ts serverIdentity): the generation the
      # registry pins (srv:4242:100). Without it the observe collapses to
      # "unreachable" and every native send refuses at the dead-pane guard.
      *start_time*) echo "4242:100" ;;
      # Native five-field pane observation (pane_id+session_name+pane_pid+pane_current_command+pane_dead).
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-1001}" "${FAKE_TMUX_CMD:-codex}" ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%%%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-1001}" ;;
      *pane_id*session_name*) printf '%%%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-1001}" ;;
      *session_name*) echo "sess" ;;
      *pane_id*) echo "%${FAKE_PANE_ID:-1001}" ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*) echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*) echo "${FAKE_WINDOW_ACTIVITY:-100}" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ "${FAKE_TMUX_CMD:-codex}" = "agy" ] && [ -f "$state/agy_modal" ]; then
      # A permission modal with the band STILL RENDERED — the case geometry alone
      # cannot refuse, which is why tap_agy_permission_overlay exists. Escape clears
      # it here, modelling the plausible native effect: that is what makes the arm
      # below discriminating rather than decorative. If the guard runs after the
      # keystroke, the modal is gone by the time the classifier looks and the payload
      # injects into a pane that was asking a human for a decision.
      _r="$(printf '─%.0s' $(seq 1 100))"
      printf '  Standing by.\n%s\n' "$_r"
      if [ -f "$state/input" ]; then printf '> %s\n' "$(cat "$state/input")"; else printf '> \n'; fi
      printf '%s\n' "$_r"
      printf 'Requesting permission for: run_shell_command\n'
      printf 'Do you want to proceed?\n'
      printf 'Yes · No · Tab amend\n'
      exit 0
    fi
    if [ "${FAKE_TMUX_CMD:-codex}" = "agy" ]; then
      # agy's real band geometry: a '>' row between two full-width rules, footer
      # below. Its band STAYS on screen while generating — that is the whole point of
      # tap-92v3r — so busy changes only the FOOTER here, never the band's presence.
      # A fake that hid the band while busy would make an urgent send defer for the
      # pre-fix reason and quietly turn the arm below into a no-op.
      _r="$(printf '─%.0s' $(seq 1 100))"
      printf '  Standing by.\n%s\n' "$_r"
      if [ -f "$state/input" ]; then printf '> %s\n' "$(cat "$state/input")"; else printf '> \n'; fi
      printf '%s\n' "$_r"
      if [ -f "$state/busy" ]; then
        printf 'esc to cancel                              Gemini 3.8 Flash · high\n'
      else
        printf '? for shortcuts                            Gemini 3.8 Flash · high\n'
      fi
      exit 0
    fi
    if [ "${FAKE_TMUX_CMD:-codex}" = "opencode" ]; then
      # OpenCode's real box shape (same fixture as submit-verify.test.sh): a
      # generic glyph-line probe never matches it, so it needs its own branch
      # regardless of $state/busy -- opencode's busy signal lives in the box,
      # not a missing prompt line (a known, documented gap; not modeled here).
      printf '     ▣ Build · Fusion\n\n'
      printf '  ┃\n'
      if [ -f "$state/input" ]; then
        printf '  ┃  %s\n' "$(cat "$state/input")"
      else
        printf '  ┃\n'
      fi
      printf '  ┃\n'
      printf '  ┃  Build · Fusion OpenRouter\n'
      printf '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n'
    elif [ -f "$state/busy" ]; then
      # Live hermes still echoes typed/queued text on a prompt line while
      # reasoning (submit-verify.test.sh's FAKE_TMUX_HERMES_WORKING fixture),
      # so a bare urgent inject that lands during a busy tick is still visible
      # to the id-landed verify loop -- it just never shows an IDLE glyph.
      # Codex mid-turn: the status row the classifier reads as working (tap-rlebf.1:
      # a frame no rule classifies holds urgent delivery before its Escape).
      printf '• Working (3s • esc to interrupt)\n› \033[2mAsk Codex to do anything\033[0m\ngpt-6-astra high · Context 80%% left · /tmp\n'
      # A rendered busy pane is a successful capture even without input.
      if [ -f "$state/input" ]; then printf '❯ %s\n' "$(cat "$state/input")"; fi
    elif [ -f "$state/input" ]; then
      printf '❯ %s\n' "$(cat "$state/input")"
    else
      printf '❯ \n'
    fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    [ "${1:-}" = "-t" ] && shift 2
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then
      [ -f "$state/copy_mode_stuck" ] && exit 1
      rm -f "$state/copy_mode"
      exit 0
    fi
    case "${1:-}" in
      # Simulate the real-world effect of an interrupt: it stops generation,
      # so the pane goes from busy (no prompt) back to idle-at-prompt.
      # Escape stops generation AND dismisses a permission modal — the second half
      # models what the PR itself disclosed as plausible, and is what turns the
      # ordering question into an observable one.
      Escape) rm -f "$state/busy" "$state/agy_modal"; exit 0 ;;
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input"; exit 0 ;;
      C-u|Enter) rm -f "$state/input"; exit 0 ;;
    esac ;;
  select-pane)
    echo "$*" >> "$state/send-keys.log"
    printf '%s' "${@: -1}" > "$state/window-style"
    printf '%s' "${@: -1}" > "$state/window-active-style" ;;
  set-option)
    echo "$*" >> "$state/send-keys.log"
    # tap-vpk6: the production clear is one tmux command list that unsets and
    # reads back both pane options. Model its observable terminal state; the
    # real-tmux pane-effects smoke pins tmux's command grammar itself.
    rm -f "$state/window-style" "$state/window-active-style" ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"; export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "lead":   { "pane": "sess:0.0", "pane_id": "%1001", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "sender": { "pane": "sess:0.1", "pane_id": "%1002", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" }
  } }
JSON

payload_field() { python3 -c 'import sys
for line in open(sys.argv[1]):
    line = line.rstrip("\n")
    if line == "---" or ":" not in line: continue
    k, _, v = line.partition(":")
    if k.strip() == sys.argv[2]: print(v.strip()); break' "$BUS/payloads/$1.md" "$2"; }
events_log() { cat "$BUS/registry-events.log" 2>/dev/null || true; }
reset_state() {
  # A fixture that asserts a bus directory is EMPTY must clean every artifact
  # class the bus writes there — the cleanup predicate has to be a superset of
  # the assertion predicate, not just `*.md`. `payloads/<id>.attempts` (the
  # delivery-driver attempt log, tap-49kp6) is the first non-`.md` artifact ever
  # written into payloads/, so it is the first to expose a gap that was always
  # there: arm (4) asserts the directory is empty while this line cleaned only
  # markdown, and an earlier arm's attempt log survived into it. Durable fix — a
  # shared reset helper so no fixture re-derives this predicate by hand — is
  # tap-q1rkg.
  rm -rf "$BUS/payloads"/*.md "$BUS/payloads"/*.attempts "$BUS/receipts"/*.done "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* 2>/dev/null || true
  : > "$WORK/tmux/send-keys.log"
  rm -f "$WORK/tmux/busy" "$WORK/tmux/input" "$WORK/tmux/copy_mode" "$WORK/tmux/copy_mode_stuck"
}
escape_line_no() { grep -n -- "-t %1001 Escape" "$WORK/tmux/send-keys.log" | head -1 | cut -d: -f1; }
paste_line_no()  { grep -n -- "-t %1001 -l --" "$WORK/tmux/send-keys.log" | head -1 | cut -d: -f1; }

mkdir -p "$WORK/tmux"

# ---- (1) --urgent sends Escape x1 BEFORE injecting, for claude/codex ----
reset_state
: > "$WORK/tmux/busy"
export FAKE_TMUX_CMD="codex"
bash "$TAPSH" send lead -m "stop the line" --id urgent-1 --from sender --urgent >/dev/null 2>&1
# sol P1: `grep -q` accepts ONE OR MORE — two Escapes (a double interrupt into
# a live agent) passed as "a single Escape". Count it.
escapes="$(grep -c -- "-t %1001 Escape$" "$WORK/tmux/send-keys.log" || true)"
[ "$escapes" = "1" ] || { echo "delivery-urgent: (1) codex urgent send must issue EXACTLY one Escape, got $escapes" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
[ "$(escape_line_no)" -lt "$(paste_line_no)" ] || { echo "delivery-urgent: (1) Escape did not precede the payload injection" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
payload_field urgent-1 to >/dev/null   # sanity: canonical landed
[ "$(payload_field urgent-1 urgency)" = "urgent" ] || { echo "delivery-urgent: (1) envelope missing urgency: urgent" >&2; exit 1; }
# v0.23: `urgency=` left the wire; urgency is a bare tag from a closed set, and
# it sits after the id slot. Anchored on the sentinel so a stray 'urgent' in
# unrelated log prose cannot satisfy it.
grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* urgent' "$WORK/tmux/send-keys.log" || { echo "delivery-urgent: (1) sentinel missing the bare 'urgent' tag" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
[ "$(grep -c 'bg=red' "$WORK/tmux/send-keys.log" || true)" = 0 ] || { echo "delivery-urgent: (1) bare urgent composer must not flash" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
[ ! -e "$WORK/tmux/window-style" ] && [ ! -e "$WORK/tmux/window-active-style" ] \
  || { echo "delivery-urgent: (1) pane effect left a pane-level style" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }

# ── tap-52ys: 8 of 11 arms removed (ratified 2026-08-14) ────────────────────
# grok's rule: keep the queue-jump SHAPE, not the speed. Three arms.
#
# CORRECTED after the reviewer's P2 review: the first cut's banner named the
# --polite + --urgent usage error as kept when it had in fact been deleted, and
# the second executable arm was the denylisted-pane refusal. Nothing in either
# bucket covered the mutual-exclusion guard. It is restored below and this list
# now describes what the file runs.
#
# Kept (3): the urgent family sends its interrupt BEFORE injecting and stamps
# urgency; urgent still terminal-refuses a denylisted pane without attempting
# an interrupt (the safety direction); and --polite + --urgent is a usage error
# rather than a silent precedence.
#
# Accepted gap, named: per-harness Escape counts (opencode x2, hermes none),
# the orphan-pane style unset, copy-mode interaction with urgency, urgent
# logging. Escalation authority is covered in send-delivery-interrupt.test.ts.

echo "delivery-urgent: (1) codex/claude family sends a single Escape before injecting, interrupts a busy pane, stamps urgency: ok"

# ---- (1b) agy: urgent Escapes first; ORDINARY delivery does not (tap-92v3r) ----
# agy had NO arm in tap_interrupt_seq before tap-92v3r, and that was survivable only
# by accident: the footer gate refused a generating agy pane outright, so an urgent
# send to a working seat deferred and nothing ever asked what its interrupt keystroke
# was. Making the band injectable removes the accident. Without an arm, urgent would
# type into the queue while `tap send` printed "urgent — interrupting" — a claim the
# code no longer performed. Caught by the partner reviewer in review, not by a test,
# which is why this arm exists.
reset_state
: > "$WORK/tmux/busy"
export FAKE_TMUX_CMD="agy"
# Native delivery checks the registered family against the live command.
python3 - "$BUS/registry.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f: registry = json.load(f)
registry["seats"]["lead"]["harness"] = "agy"
with open(sys.argv[1], "w") as f: json.dump(registry, f)
PY
if AGY_OUT="$(bash "$TAPSH" send lead -m "stop the line" --id urgent-agy --from sender --urgent 2>&1)"; then
  :
else
  AGY_RC=$?
  printf 'delivery-urgent: (1b) urgent-agy failed (rc=%s):\n%s\n' "$AGY_RC" "$AGY_OUT" >&2
  exit "$AGY_RC"
fi
escapes="$(grep -c -- "-t %1001 Escape$" "$WORK/tmux/send-keys.log" || true)"
[ "$escapes" = "1" ] || { echo "delivery-urgent: (1b) agy urgent send must issue EXACTLY one Escape, got $escapes" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
[ "$(escape_line_no)" -lt "$(paste_line_no)" ] || { echo "delivery-urgent: (1b) Escape did not precede the payload injection" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }

# THE OTHER HALF, and the one that makes this arm discriminating rather than a
# one-way ratchet: an ORDINARY send to the SAME generating pane must inject WITHOUT
# an Escape. It was verified by hand (2026-09-03) that typing into the Antigravity TUI
# mid-generation queues the message and Escape is what interrupts, so ordinary
# delivery interrupting would be a regression in the opposite direction — and an arm
# that only checked "urgent Escapes" would pass a build where everything Escapes.
reset_state
: > "$WORK/tmux/busy"
# `--wake` is load-bearing and is NOT a weakening of "ordinary". An earlier change made a plain send
# settle-only, which makes it eligible for the courier auto-settle hold, so this send
# started PARKING instead of injecting and the arm reddened on its own premise rather than
# on interrupt behaviour. `--wake` opts out of that hold explicitly WITHOUT interrupting
# (§Courier deferred auto-settlement), which is precisely the property under test here:
# delivery that reaches a generating pane and does not Escape first.
bash "$TAPSH" send lead -m "queue this" --id ordinary-agy --from sender --wake >/dev/null 2>&1
grep -q -- "-t %1001 Escape$" "$WORK/tmux/send-keys.log" \
  && { echo "delivery-urgent: (1b) an ORDINARY agy send sent an interrupt keystroke — agy queues typed input mid-turn; only --urgent interrupts" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
grep -q -- "-t %1001 -l --" "$WORK/tmux/send-keys.log" \
  || { echo "delivery-urgent: (1b) an ordinary agy send to a generating pane did not inject at all — the tap-92v3r defect" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
export FAKE_TMUX_CMD="codex"
echo "delivery-urgent: (1b) agy urgent interrupts before injecting; ordinary agy delivery queues without interrupting: ok"

# ---- (1c) URGENT MUST NOT DEFEAT THE agy MODAL REFUSAL (tap-92v3r round 3) -----
# The regression this delta introduced and disclosed in a comment before sol drove it:
# urgent's Escape is sent BEFORE the band pre-check runs the permission classifier, so
# adding agy to tap_interrupt_seq made --urgent press a key at a pane whose modal
# refusal had not been evaluated. If Escape dismisses the modal — which this fixture
# models — the classifier cannot see it and the payload injects into a pane that was
# asking a human for a decision. sol's probe at the review pin: escapes=1 pastes=1
# modal_remaining=no.
#
# ZERO PANE EFFECTS is the assertion, not "it deferred". A refusal that still pressed
# the key has already done the damage the refusal exists to prevent, so an exit-code
# check alone would pass the exact build this arm is here to catch.
reset_state
export FAKE_TMUX_CMD="agy"
: > "$WORK/tmux/agy_modal"
set +e
bash "$TAPSH" send lead -m "urgent at a modal" --id urgent-modal --from sender --urgent >/dev/null 2>&1
MODAL_RC=$?
set -e
grep -q -- "Escape" "$WORK/tmux/send-keys.log" 2>/dev/null \
  && { echo "delivery-urgent: (1c) urgent sent an interrupt keystroke at a pane showing a permission prompt — the modal refusal must be decided BEFORE any pane effect" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
grep -q -- "-t %1001 -l --" "$WORK/tmux/send-keys.log" 2>/dev/null \
  && { echo "delivery-urgent: (1c) urgent injected a payload into a pane showing a permission prompt" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
[ -f "$WORK/tmux/agy_modal" ] \
  || { echo "delivery-urgent: (1c) the permission modal was dismissed by the courier — a human was asked a question and the courier answered it" >&2; exit 1; }
# The send is not lost: rc 4 is the courier's documented defer -> spool path.
[ "$MODAL_RC" = "4" ] || [ -f "$TAP_HOME/spool/urgent-modal.md" ] \
  || { echo "delivery-urgent: (1c) the refused urgent send neither deferred (rc 4) nor spooled — it was dropped, got rc=$MODAL_RC" >&2; exit 1; }
rm -f "$WORK/tmux/agy_modal"
export FAKE_TMUX_CMD="codex"
python3 - "$BUS/registry.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f: registry = json.load(f)
registry["seats"]["lead"]["harness"] = "codex"
with open(sys.argv[1], "w") as f: json.dump(registry, f)
PY
echo "delivery-urgent: (1c) urgent refuses an agy permission prompt with ZERO pane effects, before its own interrupt: ok"




# ---- (5) urgent still refuses a denylisted pane -- safety gate never bypassed ----
reset_state
export FAKE_TMUX_CMD="bash"   # a plain shell -- denylisted, never an agent REPL
set +e
DENY_OUT="$(bash "$TAPSH" send lead -m "x" --id urgent-5 --from sender --urgent 2>&1)"
DENY_RC=$?
set -e
export FAKE_TMUX_CMD="codex"
[ "$DENY_RC" = "1" ] || { echo "delivery-urgent: (5) expected exit 1 for a denylisted pane, got $DENY_RC" >&2; echo "$DENY_OUT" >&2; exit 1; }
! grep -q "Escape" "$WORK/tmux/send-keys.log" 2>/dev/null || { echo "delivery-urgent: (5) SAFETY VIOLATION: an interrupt keystroke was sent to a denylisted pane" >&2; exit 1; }
# sol P1: exit 1 + no Escape is not "nothing happened" — the refusal must also
# leave NO bus artifacts. Without this a send that canonicalized, spooled, and
# THEN refused would pass as a clean safety gate.
grep -qi 'unsafe_target\|denylist' <<<"$DENY_OUT" || { echo "delivery-urgent: (5) refusal did not name its class: $DENY_OUT" >&2; exit 1; }
[ ! -e "$TAP_HOME/payloads/urgent-5.md" ] || { echo "delivery-urgent: (5) denylisted refusal left a canonical payload" >&2; exit 1; }
[ ! -e "$TAP_HOME/spool/urgent-5.md" ]    || { echo "delivery-urgent: (5) denylisted refusal spooled instead of refusing" >&2; exit 1; }
[ ! -s "$WORK/tmux/send-keys.log" ]       || { echo "delivery-urgent: (5) denylisted refusal touched the pane: $(cat "$WORK/tmux/send-keys.log")" >&2; exit 1; }
echo "delivery-urgent: (5) urgent terminal-refuses a denylisted pane: named class, zero pane effects, zero artifacts: ok"

# ── restored on the reviewer P2 review ───────────────────────────────────────
# The banner claimed this arm was kept; it had been deleted. Nothing in
# either bucket covered the mutual-exclusion guard.
# ---- (4) --polite and --urgent together is a usage error ----
set +e
BOTH_OUT="$(bash "$TAPSH" send lead -m "x" --from sender --polite --urgent 2>&1)"
BOTH_RC=$?
set -e
# sol P1: "nonzero" grandfathers every wrong exit — a crash, a pane_gone, or a
# delivery refusal all satisfy it. Pin the CLASS, which is what distinguishes
# "these flags conflict" from "the send failed": tap-send.sh raises
# `tap_fail 1 usage_error` for every argument conflict (--fyi/--expect-reply,
# --polite/--urgent, bad --polite-timeout), so exit 1 WITH error_class is the
# contract here, not 64.
[ "$BOTH_RC" = "1" ] || { echo "delivery-urgent: (4) --polite + --urgent must exit 1, got $BOTH_RC" >&2; echo "$BOTH_OUT" >&2; exit 1; }
# error_class is machine-readable output, so assert it through --json rather
# than the human line (which carries the same fact as prose).
set +e
BOTH_JSON="$(bash "$TAPSH" send lead -m "x" --from sender --polite --urgent --json 2>&1)"
BOTH_JSON_RC=$?
set -e
[ "$BOTH_JSON_RC" = "1" ] || { echo "delivery-urgent: (4) --json form must exit 1 too, got $BOTH_JSON_RC" >&2; exit 1; }
grep -q '"error_class":"usage_error"' <<<"$BOTH_JSON" \
  || { echo "delivery-urgent: (4) conflicting flags did not raise error_class=usage_error: $BOTH_JSON" >&2; exit 1; }
grep -qi "polite.*urgent\|urgent.*polite" <<<"$BOTH_OUT" || { echo "delivery-urgent: (4) error did not name the conflicting flags" >&2; echo "$BOTH_OUT" >&2; exit 1; }
[ ! -s "$WORK/tmux/send-keys.log" ] || { echo "delivery-urgent: (4) a rejected flag combination still touched the pane: $(cat "$WORK/tmux/send-keys.log")" >&2; exit 1; }
[ -z "$(ls -A "$TAP_HOME/payloads" 2>/dev/null || true)" ] || { echo "delivery-urgent: (4) a rejected flag combination minted a payload" >&2; exit 1; }
echo "delivery-urgent: (4) --polite + --urgent is error_class=usage_error (exit 1), no pane effect, no payload: ok"


echo "delivery-urgent: ok"
