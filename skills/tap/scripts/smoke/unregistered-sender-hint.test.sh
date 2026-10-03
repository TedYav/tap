#!/usr/bin/env bash
# unregistered-sender-hint.test.sh — tap-hgzj stage 2: the `next:` command a send
# refusal hands an unregistered sender must fit the sender it is talking to.
#
# THE DEFECT. tap-send.sh's unregistered_sender refusal hardcoded
# `tap register <handle> --delivery poll`. The prose named the audience
# (pane-less daemons and scripts); the COMMAND named nobody, and the command is
# what an agent copies. On 2026-08-19 a launcher-managed seat sitting in a live
# pane followed that hint, became a poll seat holding a pane, and for 95 minutes
# eight sends from two senders wrote success receipts into a mailbox nobody
# read. Every actor followed the path the tool laid out.
#
# WHY A HINT DESERVES A TEST AT ALL. This one is executable prose: it is copied
# and run verbatim by the reader. A wrong hint is not a documentation nit, it is
# a remote-code suggestion with a 95-minute failure attached — so it is asserted
# as behavior, per pane state, not eyeballed.
#
# The discriminator resolves the CALLER's pane without trusting TMUX_PANE and
# fails closed: `outside` and `unobservable` both keep the poll hint, which is
# correct for the daemons the prose describes. `tap send` is native now
# (runtime/bun/src/verbs/send.ts, unregisteredSenderRefusal); the lib.sh
# tap_unregistered_sender_next adapter this test used to call directly was
# deleted as a callerless Bash function once native send stopped shelling out
# to it — every arm below now drives the real `tap send` binary end to end
# (context.ts's own observeCallingPane replaces tap_calling_pane_id there;
# unit3-tmux.test.ts covers that resolver directly). Arms (4)/(5)/(9) already
# did this; arms (1)/(2)/(3)/(6)/(7)/(8) are converted the same way here.
set -uo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "${WORK:?}"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

export TAP_HOME="$WORK/.tap/bus"
# Born live: every team bus below is enrolled in this test's own index.
export TAP_INDEX_HOME="$WORK/index"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# --- fakes: the caller's tty, and tmux's view of which pane owns it -----------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/ps" <<'FAKEPS'
#!/usr/bin/env bash
printf '%s %s\n' "1" "${FAKE_CALLER_TTY:-ttys001}"
FAKEPS
cat > "$WORK/bin/tmux" <<'FAKETMUX'
#!/usr/bin/env bash
case "${1:-}" in
  list-panes)   printf '%s' "${SCAN_MAP:-}" ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    row=""
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      [ "${line%%	*}" = "$target" ] || continue
      row="$line"; break
    done <<< "${LIVE_MAP:-}"
    [ -n "$row" ] || exit 0
    out="$fmt"; out="${out//'#{pane_id}'/${row%%	*}}"; out="${out//'#{pane_tty}'/${row#*	}}"
    out="${out//'#{session_name}'/sess}"; out="${out//'#{pid}:#{start_time}'/900:100}"
    printf '%s' "$out" ;;
  *) exit 0 ;;
esac
FAKETMUX
chmod +x "$WORK/bin/ps" "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH"

# A bus with at least one seat on it. Seeded directly BEFORE the first arm
# (not via a live `tap register` bootstrap: $WORK is a bare scratch dir with no
# git worktree behind it, so the born-live authority gate refuses to bootstrap
# it from nothing — same as any other unclassified custom bus). An EMPTY acting
# bus is now its own answer (arm 6) and would otherwise leak into every other
# arm's expectation.
# held-by-daemon carries status_reason=launching: native send.ts's dischargeable
# check (senderDischargeable = senderActivePane || (senderActive && delivery ===
# "poll")) makes every ACTIVE poll seat unconditionally dischargeable — the
# incumbent had the identical rule (lib.sh:9608-9688's sender facts), so a
# fully-active poll seat's unregistered_sender hint was NEVER reachable through
# a live send even before this port; only the launching phase (senderActive
# false) reaches the refusal this arm is actually about.
cat > "$TAP_HOME/registry.json" <<JSON
{"schema":"0.20","team":{"name":"unregistered-sender-hint","worktree_root":"$WORK"},"seats":{"held-by-daemon":{"status":"active","status_reason":"launching","delivery":"poll","harness":"daemon"}}}
JSON
tap_smoke_enroll_current "$WORK" "$TAP_HOME" unregistered-sender-hint

INSIDE_SCAN=$'%5\t/dev/ttys001'
OUTSIDE_SCAN=$'%5\t/dev/ttys777'

# <TAP_HOME> <scan-map> <handle> <id> -> the full refusal text on stderr.
send_full() {
  SCAN_MAP="$2" LIVE_MAP="$2" TAP_HOME="$1" \
    bash "$ROOT/scripts/tap.sh" send someone -m x --from "$3" --id "$4" 2>&1
}
# <TAP_HOME> <scan-map> <handle> <id> -> the printed `next:` command.
send_next() {
  local out; out="$(send_full "$1" "$2" "$3" "$4")"
  printf '%s' "${out##*next: }"
}

# --- (1) a caller INSIDE an observable pane is never told to become a mailbox --
h="$(send_next "$TAP_HOME" "$INSIDE_SCAN" nobody-here hgzj-1)"
case "$h" in
  *"--delivery poll"*) bad "(1) a pane-backed caller is still told to register --delivery poll: $h" ;;
  "") bad "(1) no hint produced for a pane-backed caller" ;;
  *) ok "(1) a pane-backed caller gets a pane-derived hint: $h" ;;
esac

# --- (2) ... and when the handle is already held, the hint says how to reclaim -
# The 2026-08-19 seat ran plain `tap in`, which DERIVES the handle — the one form
# the collision ladder refuses against an active poll incumbent (it mints -2 and
# leaves the poll row holding the address everyone writes to). The two authorized
# cures are naming the handle explicitly and --force; the refusal named neither.
out="$(send_full "$TAP_HOME" "$INSIDE_SCAN" held-by-daemon hgzj-2)"
h="${out##*next: }"
det="$out"
# The COMMAND must name the handle (the documented authorization) and must NOT
# carry --force: forcing over an active PANE incumbent takes a live teammate's
# address, and a remedy line is copied without being read. --force belongs in the
# prose, where a reader who has just seen `-2` minted can reach for it knowingly.
case "$h" in
  *--force*)               bad "(2) the copied command force-claims a handle that may belong to a live seat: $h" ;;
  "tap in held-by-daemon") ok  "(2) a held handle is reclaimed by naming it, not by forcing: $h" ;;
  *)                       bad "(2) hint does not name the handle explicitly, so the ladder will mint -2: $h" ;;
esac
case "$det" in
  *--force*) ok "(2b) the prose still names --force as the escape hatch when -2 is minted" ;;
  *) bad "(2b) nothing tells a reader who just got '-2' how to reclaim the address: $det" ;;
esac

# --- (3) the pane-less case KEEPS the poll hint -------------------------------
# Fail-closed direction: outside and unobservable callers are the daemons and
# scripts the original prose was written for, and poll is right for them.
h="$(send_next "$TAP_HOME" "$OUTSIDE_SCAN" nobody-here hgzj-3)"
case "$h" in
  *"--delivery poll"*) ok "(3) a caller with no observable pane still gets the poll hint: $h" ;;
  *) bad "(3) the pane-less daemon case lost its poll hint: $h" ;;
esac

# --- (4) end to end: the refusal tap send actually PRINTS ---------------------
# The helper being right is not the property that matters; what reaches the
# reader is. A refactor that computed the hint and printed the constant would
# pass (1)-(3).
#
# ASSERT ON THE `next:` HALF, NOT THE WHOLE LINE. The first version of this arm
# grepped the entire refusal for "--delivery poll" and failed on a CORRECT
# message — because the prose now explains what poll mode is FOR. That is this
# board's recurring defect wearing a test costume: an instrument that cannot
# express the question it was asked. The property is "the command handed to a
# pane-backed sender does not prescribe poll", and the command is the `next:`
# suffix.
out="$(SCAN_MAP="$INSIDE_SCAN" LIVE_MAP="$INSIDE_SCAN" \
  bash "$ROOT/scripts/tap.sh" send someone -m x --from nobody-here --id hgzj-e2e 2>&1)"
next_cmd="${out##*next: }"
case "$next_cmd" in
  *"--delivery poll"*) bad "(4) the printed next: command still tells a pane-backed sender to become a mailbox: $next_cmd" ;;
  "tap in "*)          ok "(4) the printed next: command is pane-derived: $next_cmd" ;;
  *)                   bad "(4) unexpected next: command: $next_cmd" ;;
esac

# --- (5) the refusal must still TEACH the poll case ---------------------------
# Making the command conditional must not delete the knowledge. A pane-backed
# sender is told why poll is wrong FOR THEM, which is what stops the next reader
# from reaching for it anyway.
case "$out" in
  *"pane-less daemons"*) ok "(5) the refusal still explains who poll mode is for" ;;
  *) bad "(5) the poll audience is no longer explained anywhere in the refusal: $out" ;;
esac

# --- (6) AN EMPTY ACTING BUS IS A WRONG-CWD DIAGNOSIS, NOT AN IDENTITY ONE -----
# Found by reproducing tap-hgzj on the lane fixing it. Originally attributed to
# `.tap/.gitignore` being a TRACKED file (every git worktree carries a bare
# `.tap/` at checkout); tap-mcg0 disproved that — a bare `.tap/` with no bus/
# content changes no verb's resolution. The empty bus a lane worktree actually
# accumulates comes from `tap_ensure_dirs` running (send and siblings, before
# tap-mcg0's guard) with cwd inside it, not from anything git checked out. A
# registered, pane-backed seat that runs a tap verb from its own lane worktree
# — the normal thing to do while driving — resolves to that empty bus and is
# told it is not registered, regardless of how the bus got there.
#
# For that caller BOTH other answers are wrong, and the pane-derived one is the
# more damaging: registering here binds the pane into the LANE's bus, splitting
# the seat's identity across two buses while every teammate keeps writing to the
# real one. A silent mailbox becomes a split identity.
#
# The discriminator is local and needs no machine index (whose output is evidence
# only, never action): a fresh worktree bus has NO seats, a real team bus always
# has some. So an empty acting bus means the cwd is not this seat's bus.
EMPTY_HOME="$WORK/empty/.tap/bus"; mkdir -p "$EMPTY_HOME/payloads" "$EMPTY_HOME/receipts"
h="$(send_next "$EMPTY_HOME" "$INSIDE_SCAN" someone-registered-elsewhere hgzj-6)"
case "$h" in
  "tap in "*)          bad "(6) an empty acting bus steers a pane-backed seat to register into the WRONG bus: $h" ;;
  *"--delivery poll"*) bad "(6) an empty acting bus steers a pane-backed seat into poll mode: $h" ;;
  *--team*)            ok  "(6) an empty acting bus is diagnosed as an unanchored cwd: $h" ;;
  *)                   bad "(6) unexpected hint for an empty acting bus: $h" ;;
esac

# --- (7) UNOBSERVABLE IS THE DIRECTION THE FAIL-CLOSED CLAIM IS ABOUT ----------
# Arm (3) pins `outside` — a tty that belongs to no pane. The claim this unit
# actually defends is broader: `unobservable` (tmux inventory unavailable, or an
# ancestry that ended with no tty) must ALSO keep the poll hint, because a daemon
# is the unobservable caller. Without this arm, a later split that pane-hints
# `unobservable` stays green while teaching the original prose's audience the
# wrong command. Partner review, unit-1 review minor 1.
cat > "$WORK/bin/tmux-blind" <<'BLIND'
#!/usr/bin/env bash
case "${1:-}" in
  list-panes) exit 1 ;;   # inventory unavailable -> unobservable, not outside
  *) exit 0 ;;
esac
BLIND
chmod +x "$WORK/bin/tmux-blind"
# A PATH where tmux itself is the blind one — the fake must SHADOW the fake, not
# sit beside it.
mkdir -p "$WORK/blind"; cp "$WORK/bin/tmux-blind" "$WORK/blind/tmux"; cp "$WORK/bin/ps" "$WORK/blind/ps"
out="$(PATH="$WORK/blind:$PATH" TAP_HOME="$TAP_HOME" \
  bash "$ROOT/scripts/tap.sh" send someone -m x --from nobody-here --id hgzj-7 2>&1)"
h="${out##*next: }"
case "$h" in
  *"--delivery poll"*) ok "(7) an UNOBSERVABLE caller keeps the poll hint: $h" ;;
  *) bad "(7) an unobservable caller was treated as pane-backed: $h" ;;
esac

# --- (8) A READABLE-BUT-EMPTY BUS IS A REAL TEAM, AND WANTS THE IDENTITY ANSWER
# The first version of arm (6)'s predicate collapsed two very different causes of
# "no seats" into one answer. A bus that is READABLE and empty is a real team
# root immediately after `tap team reset` or `tap init` — whose own next-line is
# `tap in`. Telling that caller to pass --team cannot progress on the same empty
# bus and contradicts the instruction reset just printed. Only an ABSENT or
# unreadable registry is the decoy-worktree case. Partner review, unit-2 review.
RESET_HOME="$WORK/reset/.tap/bus"; mkdir -p "$RESET_HOME/payloads" "$RESET_HOME/receipts"
# Seeded directly (not bootstrapped via a live register/unregister round trip):
# $RESET_HOME is a bare scratch dir with no git worktree behind it, so the
# born-live authority gate refuses to bootstrap it from nothing — same reason
# as the held-by-daemon bus above. A readable, seat-less schema+seats doc is
# exactly what `tap team reset` / `tap init` leaves behind.
cat > "$RESET_HOME/registry.json" <<JSON
{"schema":"0.20","team":{"name":"unregistered-sender-hint-reset","worktree_root":"$WORK/reset"},"seats":{}}
JSON
tap_smoke_enroll_current "$WORK/reset" "$RESET_HOME" unregistered-sender-hint-reset
h="$(send_next "$RESET_HOME" "$INSIDE_SCAN" fresh-seat hgzj-8)"
case "$h" in
  "tap in fresh-seat") ok "(8) a readable, seat-less team bus gets the identity answer: $h" ;;
  *--team*)            bad "(8) a freshly reset team bus was diagnosed as an unanchored cwd, which cannot progress: $h" ;;
  *)                   bad "(8) unexpected hint on a readable empty bus: $h" ;;
esac

# --- (9) THE LIVE PATH, ON A DECOY BUS AND ON A RESET BUS ---------------------
# Arms (6) and (8) call the helper from a script that is `set -uo pipefail`.
# `tap send` is `set -euo pipefail`, and the helper signals its three states
# through the EXIT STATUS — so a bare call was a failing simple command that
# aborted the send before the remedy printed. Every helper arm stayed green
# while the real caller died with no unregistered_sender line at all: worse than
# the wrong hint, because there is nothing to read. a reviewer found it by
# running `tap send`, which is what the reader runs.
#
# So these arms drive the BINARY, once per state (using the same send_next
# helper arms (1)/(3)/(6)/(8) now use). A test that exercises a helper that
# merely computes the hint is testing the half that was never broken.
DECOY="$WORK/decoy/.tap/bus"; mkdir -p "$DECOY/payloads" "$DECOY/receipts"
n="$(send_next "$DECOY" "$INSIDE_SCAN" nobody-here hgzj-9a)"
# Match the SEND form, not merely the substring `--team`: the old poll remedy is
# `tap register <h> --delivery poll [--team <team>]`, which also contains it, so
# a `*--team*` glob would accept the exact command this arm exists to forbid.
# A reviewer spotted it as a nit; it is the same defect class as everything
# else in this lane, so it gets fixed rather than noted.
case "$n" in
  *"--delivery poll"*) bad "(9a) the live send still hands a decoy-bus caller the poll command: $n" ;;
  "tap send "*--team*) ok "(9a) tap send on a DECOY bus prints the unanchored-cwd remedy: $n" ;;
  *) bad "(9a) the live send did not print the decoy-bus remedy (empty means it aborted before printing): $n" ;;
esac
n="$(send_next "$RESET_HOME" "$INSIDE_SCAN" fresh-seat hgzj-9b)"
case "$n" in
  "tap in fresh-seat") ok "(9b) tap send on a RESET bus prints the identity remedy: $n" ;;
  *) bad "(9b) the live send did not print the identity remedy for a readable empty bus: $n" ;;
esac

printf 'unregistered-sender-hint: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ] || exit 1
