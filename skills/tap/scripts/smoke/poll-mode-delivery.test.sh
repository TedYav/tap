#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# poll-mode-delivery.test.sh — CONTRACT.md §Poll-mode delivery class (v0.4): a
# registered delivery:poll member (a pane-less daemon, e.g. the hermes gateway)
# participates in every bus mechanism except pane injection.
#
#   - register --delivery poll: explicit handle required, no --pane, poll-entry
#     shape omits pane/pane_id/pane_current_command/cost_mode/include_policy.
#   - send/reply to a poll target: durable write only — exit 0, no injection, no
#     sentinel; classify/denylist bypassed; a suspended poll target refuses (not
#     via the pane-gone exit code, which is structurally unreachable for it).
#   - the --expect-reply carve-out: a REGISTERED poll-mode --from can mint
#     reply=expected; an unregistered pane-less --from is refused.
#   - poll --quiet always exits 0.
#   - health reports 'poll-mode (liveness unknown)'; nudge refuses structurally
#     (error_class=poll_mode_member); the watch escalation chain excludes it.
#   - --team anchors the bus for a pane-less caller (poll/send/reply/done/
#     outstanding), resolved via the machine index, never cwd.
#   - a team-qualified send to a REMOTE poll target is refused
#     (error_class=poll_member_remote) — poll members are team-local only.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # machine index redirect: never touch real ~/.tap
export FAKE_TMUX_STATE="$WORK/fake-tmux"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
pane_id() {
  case "${1#=}" in
    dead-pane)                   printf '' ;;
    recip:0.0|%951|recip)        printf %%951 ;;
    self:0.0|%952|self)          printf %%952 ;;
    crew-convert:0.0|%953|crew-convert) printf %%953 ;;
    *)                           printf %%999 ;;
  esac
}
session_for() {
  case "${1#=}" in
    recip:0.0|%951|recip)        printf recip ;;
    self:0.0|%952|self)          printf self ;;
    crew-convert:0.0|%953|crew-convert) printf crew-convert ;;
    *)                           printf self ;;
  esac
}
case "$cmd" in
  # CONTRACT §Session-name authority: pane-mode registrations get an exact
  # session, numeric pane ID, single generation, and observed codex harness.
  list-sessions)
    printf 'recip\t4242:100\nself\t4242:100\ncrew-convert\t4242:100\n' ;;
  list-panes)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    session="$(session_for "$target")"
    case "$session" in
      recip)        printf 'recip\trecip:0.0\t%%951\tcodex\t4242\t4242:100\t0\n' ;;
      self)          printf 'self\tself:0.0\t%%952\tcodex\t4242\t4242:100\t0\n' ;;
      crew-convert)  printf 'crew-convert\tcrew-convert:0.0\t%%953\tcodex\t4242\t4242:100\t0\n' ;;
    esac ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ] && [[ "$fmt" == *session_name* ]]; then echo self; exit 0; fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\t%s\t4242\tcodex\t0\n' "$(pane_id "$target")" "$(session_for "$target")" ;;
      *socket_path*) printf '/fake/socket\n' ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t4242:100\n' "$(pane_id "$target")" "$(session_for "$target")" ;;
      *pane_id*session_name*) printf '%s\t%s\t4242:100\n' "$(pane_id "$target")" "$(session_for "$target")" ;;
      *pane_id*)              pane_id "$target" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *session_name*)         session_for "$target" ;;
      *pid*start_time*)       echo "4242:100" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; printf '%s' "${1:-}" > "$state/last-sentinel"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"

new_repo() { git init -q "$1"; git -C "$1" config user.email t@example.invalid; git -C "$1" config user.name t; touch "$1/r"; git -C "$1" add r; git -C "$1" commit -q -m i; }

# No global TAP_HOME export: every TeamA call below derives its bus from cwd (via
# `cd "$WORK/TeamA"`, unset TAP_HOME), matching how `tap_index_enroll_team` derives
# its canonical root — pre-exporting a raw mktemp path here would desync the two
# (mktemp's /var/folders vs git's realpath'd /private/var/folders on macOS) and
# silently skip machine-index enrollment, breaking the --team lookups in (10).
new_repo "$WORK/TeamA"
TAP_HOME="$(cd "$WORK/TeamA" && git rev-parse --show-toplevel)/.tap/bus"

# The ACTING registry, resolved at call time rather than assumed to be the bus
# file. This fixture used to read "$TAP_HOME/registry.json" directly, which was
# only ever correct because the suite shared one marker-absent index and nothing
# published a marker. Now that each file gets its own index, the first register
# here is born live and creates the canonical team-registry.json instead — the
# retired bus file is never written, so the old read raised FileNotFoundError.
# Reading the selected store keeps the subject (the registered seat row) and
# stops asserting WHICH store born-live chose.
acting_registry() {
  local canon; canon="$(cd "$WORK/TeamA" && git rev-parse --show-toplevel)"
  if [ -f "$canon/.tap/team-registry.json" ]; then
    printf '%s\n' "$canon/.tap/team-registry.json"
  else
    printf '%s\n' "$TAP_HOME/registry.json"
  fi
}
# Rows live under "seats" post-flip and "agents" pre-flip; the subject is the row,
# so every reader below takes whichever key the selected store uses.

# --- (1) register --delivery poll: explicit shape, no pane fields ----------------------
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in hermes-gw --delivery poll --wake-url http://127.0.0.1:9/wake >/dev/null )
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in cron-watch --delivery poll >/dev/null )
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in recipient --pane recip:0.0 >/dev/null )
python3 - "$(acting_registry)" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
ent = (doc.get("seats") or doc.get("agents"))["hermes-gw"]
required = {"delivery": "poll", "status": "active", "status_reason": "", "harness": "hermes-gw"}
for k, v in required.items():
    assert ent.get(k) == v, f"poll-mode: (1) entry.{k} = {ent.get(k)!r}, want {v!r}"
for k in ("registered_at", "registered_from_worktree"):
    assert ent.get(k), f"poll-mode: (1) entry.{k} missing"
for k in ("pane", "pane_id", "pane_current_command", "cost_mode", "include_policy"):
    assert k not in ent, f"poll-mode: (1) entry carries '{k}' — poll entries must omit it"
assert ent.get("wake_url") == "http://127.0.0.1:9/wake"
PY

# ── tap-52ys: 9 of 19 arms removed (ratified 2026-08-14) ────────────────────
# Poll delivery is a real delivery class (pane-less seats, cron, daemons).
#
# CORRECTED after sol-ponytail's P1 review: the first cut's banner listed three
# arms as kept that it had actually DELETED — including (3), the defining poll
# behavior, that a send to a poll target writes durably and never injects into
# a pane. Nothing else in either bucket proved that. They are restored below,
# and this list now describes what the file runs rather than what the cut
# intended. The lesson belongs to the banner, not the shrink: a comment
# describing a deletion is a claim to check against the file, not a record of it.
#
# Kept (10): the poll-entry registration shape, the
# flag rejections, a durable send with NO pane injection, a suspended target
# refusing, health's structured delivery readout, remote-poll refusal, a reply
# from a poll member settling, nudge refusing a poll member, and --team
# anchoring pane-less poll/send/done/outstanding callers.
#
# Accepted gap, named: watch-chain exclusion of poll seats, the TAP_HOME/--team
# conflict, the \x1f seat_state delimiter, and the two re-registration
# conversions.

echo "poll-mode: (1) register --delivery poll writes the explicit poll-entry shape: ok"


# --- (2) explicit handle required; --pane incompatible ---------------------------------
rc=0; ( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in --delivery poll >"$WORK/r2.out" 2>&1 ) || rc=$?
[ "$rc" != 0 ] || { echo "poll-mode: (2) --delivery poll with no handle should fail" >&2; exit 1; }
grep -q 'pass one explicitly' "$WORK/r2.out" || { echo "poll-mode: (2) should name the missing-handle fix" >&2; cat "$WORK/r2.out" >&2; exit 1; }
rc=0; ( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in x --delivery poll --pane p >"$WORK/r3.out" 2>&1 ) || rc=$?
[ "$rc" != 0 ] || { echo "poll-mode: (2) --delivery poll + --pane should fail" >&2; exit 1; }
rc=0; ( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in x --delivery poll --include on_request >"$WORK/r4.out" 2>&1 ) || rc=$?
[ "$rc" != 0 ] || { echo "poll-mode: (2) --delivery poll + --include should fail" >&2; exit 1; }
grep -q 'poll entries omit include_policy' "$WORK/r4.out" || { echo "poll-mode: (2) --include refusal should name the omitted poll field" >&2; cat "$WORK/r4.out" >&2; exit 1; }
rc=0; ( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in x --delivery poll --mode api >"$WORK/r5.out" 2>&1 ) || rc=$?
[ "$rc" != 0 ] || { echo "poll-mode: (2) --delivery poll + --mode should fail" >&2; exit 1; }
grep -q 'poll entries omit cost_mode' "$WORK/r5.out" || { echo "poll-mode: (2) --mode refusal should name the omitted poll field" >&2; cat "$WORK/r5.out" >&2; exit 1; }
echo "poll-mode: (2) explicit handle required, --pane/--include/--mode rejected for poll registration: ok"


# --- (6) a suspended poll target refuses (not via the unreachable pane-gone code) ------
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in hermes-gw --offline >/dev/null )
rc=0; ( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "x" --from cron-watch --id pm-6 --json >"$WORK/s6.out" 2>/dev/null ) || rc=$?
[ "$rc" = 1 ] || { echo "poll-mode: (6) suspended poll target should exit 1 (got $rc) — 3/4/5 are structurally unreachable" >&2; cat "$WORK/s6.out" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="suspended", d' "$WORK/s6.out" \
  || { echo "poll-mode: (6) should be error_class=suspended" >&2; cat "$WORK/s6.out" >&2; exit 1; }
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in hermes-gw --delivery poll >/dev/null )   # reactivate
echo "poll-mode: (6) a suspended poll target refuses with error_class=suspended (exit 1, not 3): ok"


# --- (7) health reports poll-mode liveness-unknown -------------------------------------
# Health answers natively since tap-diagnostics-u1 (the bash tap-health.sh body
# was deleted); the door is `bun runtime/bun/main.ts health`.
( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" health --json >"$WORK/h1.json" 2>/dev/null ) || true
python3 - "$WORK/h1.json" <<'PY'
import json, sys
roster = {item["handle"]: item for item in json.load(open(sys.argv[1]))["roster"]}
assert roster["hermes-gw"].get("delivery") == "poll", roster["hermes-gw"]
assert roster["hermes-gw"].get("state") == "poll-mode (liveness unknown)", roster["hermes-gw"]
PY
echo "poll-mode: (7) tap health reports poll-mode state and structured delivery: ok"


# --- (11) a team-qualified send to a REMOTE poll target is refused ---------------------
new_repo "$WORK/SenderTeam"
( cd "$WORK/SenderTeam" && bash "$ROOT/bin/tap" in sender-agent --pane self:0.0 >/dev/null )
rc=0; ( cd "$WORK/SenderTeam" && bun "$ROOT/runtime/bun/main.ts" send TeamA/hermes-gw -m "hi" --from sender-agent --json >"$WORK/s11.out" 2>/dev/null ) || rc=$?
[ "$rc" != 0 ] || { echo "poll-mode: (11) team-qualified send to a remote poll target should be refused" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="poll_member_remote", d' "$WORK/s11.out" \
  || { echo "poll-mode: (11) should be error_class=poll_member_remote" >&2; cat "$WORK/s11.out" >&2; exit 1; }
echo "poll-mode: (11) a team-qualified send to a remote poll target is refused (error_class=poll_member_remote): ok"


# --- (12) tap reply FROM a poll member: answers the sender AND settles the inbound ------
# Setup for (12), with its status ASSERTED. It used to run unguarded into
# /dev/null, so a failure here killed the file under set -e with no message at
# all — the arm that follows never ran and nothing said why. An expected-success
# command in a fixture owes a checked status and a readable log.
#
# Both commands also carried `--pane self:0.0`. On send, `--pane` overrides the
# RECIPIENT's pane, and both recipients here (hermes-gw, then cron-watch on the
# reply) are pane-less poll members — so the override never named anything real.
# It was inert pre-flip because a pre-flip send pins no forwarding route. A
# v20-bound send does: placement re-checks the pinned recipient identity and
# compares the explicit pane against the registry row, and a poll row omits
# `pane` entirely, so the override read as an identity change
# (error_class=forwarding_changed, "retry"). The arm's subject is a reply FROM a
# poll member, not a pane override, so the flag is gone rather than accommodated.
( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "question" --from cron-watch --id pm-12 >"$WORK/send12.out" 2>&1 ) \
  || { echo "poll-mode: (12) setup send failed" >&2; cat "$WORK/send12.out" >&2; exit 1; }
( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" reply pm-12 -m "answer" --by hermes-gw >"$WORK/rep12.out" 2>&1 ) \
  || { echo "poll-mode: (12) reply from a poll member should succeed" >&2; cat "$WORK/rep12.out" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/pm-12.done" ] || { echo "poll-mode: (12) reply did not settle the inbound" >&2; exit 1; }
echo "poll-mode: (12) tap reply from a poll member answers the sender and settles the inbound: ok"


# --- (12b) an explicit --pane naming a poll recipient is refused for its own reason ------
# The flag arm (12) used to carry. `--pane` overrides the RECIPIENT's pane and a
# poll row omits `pane` by construction, so the override can never name anything.
# Asserting the CLASS is what makes this arm discriminating: without the refusal
# the send still exits nonzero, but as `forwarding_changed` from the locked
# placement recheck — with the next step "retry the send" for a condition every
# retry reproduces (tap-k5mjz). A test that only asserted failure would pass on
# the defect it exists to catch.
# Both streams into one file: a refusal that never reaches tap_fail prints on
# stderr, and discarding it would leave an empty capture that looks identical to
# the wrong-class failure this arm is about.
rc=0; ( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "x" --from cron-watch --pane self:0.0 --id pm-12b --json >"$WORK/s12b.out" 2>&1 ) || rc=$?
[ "$rc" = 1 ] || { echo "poll-mode: (12b) --pane to a poll target should exit 1 (got $rc)" >&2; cat "$WORK/s12b.out" >&2; exit 1; }
grep -q '"error_class":"poll_mode_member"' "$WORK/s12b.out" \
  || { echo "poll-mode: (12b) should be error_class=poll_mode_member, not a retryable forwarding_changed" >&2; cat "$WORK/s12b.out" >&2; exit 1; }
[ ! -f "$TAP_HOME/payloads/pm-12b.md" ] || { echo "poll-mode: (12b) refused send must leave no payload" >&2; exit 1; }
# Same refusal through tap reply, which forwards --pane to send: cron-watch, the
# sender of pm-12 and so the recipient of its reply, is itself a poll member.
( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "question" --from cron-watch --id pm-12c >"$WORK/send12c.out" 2>&1 ) \
  || { echo "poll-mode: (12b) setup send failed" >&2; cat "$WORK/send12c.out" >&2; exit 1; }
rc=0; ( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" reply pm-12c -m "answer" --by hermes-gw --pane self:0.0 >"$WORK/rep12c.out" 2>&1 ) || rc=$?
[ "$rc" = 1 ] || { echo "poll-mode: (12b) reply --pane to a poll recipient should exit 1 (got $rc)" >&2; cat "$WORK/rep12c.out" >&2; exit 1; }
grep -q 'cannot target it' "$WORK/rep12c.out" || { echo "poll-mode: (12b) reply refusal should name the pane-less recipient, not a route change" >&2; cat "$WORK/rep12c.out" >&2; exit 1; }
echo "poll-mode: (12b) an explicit --pane to a poll member is refused as poll_mode_member, not as a retryable route change: ok"

# --- (12d) the ORDER of that refusal, which (12b) cannot see -------------------------
# (12b)'s target is active, so a guard moved BELOW the status checks passes it. Both
# reviewers found the same gap independently: CONTRACT and the code comment both claim
# the refusal precedes the row's status, and nothing proved it. The claim matters —
# status-first would make the same argv refuse differently as the row flaps, and would
# teach a caller that `--pane` starts working once the seat is active.
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in hermes-gw --offline >/dev/null )
rc=0; ( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "x" --from cron-watch --pane self:0.0 --id pm-12d --json >"$WORK/s12d.out" 2>&1 ) || rc=$?
[ "$rc" = 1 ] || { echo "poll-mode: (12d) --pane at a suspended poll row should exit 1 (got $rc)" >&2; cat "$WORK/s12d.out" >&2; exit 1; }
grep -q '"error_class":"poll_mode_member"' "$WORK/s12d.out" \
  || { echo "poll-mode: (12d) a suspended poll row must still refuse --pane as poll_mode_member, not as suspended — the flag is invalid for the delivery class, not for a transient state" >&2; cat "$WORK/s12d.out" >&2; exit 1; }
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in hermes-gw --delivery poll >/dev/null )   # reactivate
echo "poll-mode: (12d) the --pane refusal precedes the row status, so the same argv refuses the same way as the row flaps: ok"

# --- (12e) the same refusal for a TEAM-QUALIFIED recipient ---------------------------
# (12b)/(12d) name the recipient by bare handle only. `TeamA/hermes-gw` reaches the
# same row through the qualified-recipient parse, so the refusal must not depend on
# which spelling located the poll member.
rc=0; ( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send TeamA/hermes-gw -m "x" --from cron-watch --pane self:0.0 --id pm-12e --json >"$WORK/s12e.out" 2>&1 ) || rc=$?
[ "$rc" = 1 ] || { echo "poll-mode: (12e) --pane to a team-qualified poll target should exit 1 (got $rc)" >&2; cat "$WORK/s12e.out" >&2; exit 1; }
grep -q '"error_class":"poll_mode_member"' "$WORK/s12e.out" \
  || { echo "poll-mode: (12e) a team-qualified poll target must refuse --pane as poll_mode_member" >&2; cat "$WORK/s12e.out" >&2; exit 1; }
[ ! -f "$TAP_HOME/payloads/pm-12e.md" ] || { echo "poll-mode: (12e) refused send must leave no payload" >&2; exit 1; }
echo "poll-mode: (12e) --pane to a team-qualified poll member is refused as poll_mode_member with no payload: ok"

# ── restored on sol-ponytail P1 review ──────────────────────────────────────
# The first cut deleted these three while the banner claimed they were kept.
# (3) is the DEFINING poll behavior: a durable write with NO pane injection.
# Nothing else in either bucket proved a poll send never touches tmux.

# --- (3) send to a poll target: durable write only, no injection -----------------------
rm -f "$FAKE_TMUX_STATE/last-sentinel"
( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "status?" --from cron-watch --id pm-1 >"$WORK/s1.out" 2>&1 )
grep -q 'tap send: queued pm-1' "$WORK/s1.out" || { echo "poll-mode: (3) send output should use accepted queued prose" >&2; cat "$WORK/s1.out" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/pm-1.md" ] || { echo "poll-mode: (3) payload not written" >&2; exit 1; }
[ ! -e "$FAKE_TMUX_STATE/last-sentinel" ] || { echo "poll-mode: (3) send injected a sentinel into a pane for a poll target (should never inject)" >&2; exit 1; }
( cd "$WORK/TeamA" && bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "json status?" --from cron-watch --id pm-1-json --json >"$WORK/s1.json" )
python3 -B - "$WORK/s1.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "queued" and d["delivery"] == "poll", d
assert d["path"].endswith("/payloads/pm-1-json.md"), d
PY
echo "poll-mode: (3) send to a poll target durably writes with no pane injection: ok"


# --- (8) nudge on a poll member is a structured refusal --------------------------------
rc=0; ( cd "$WORK/TeamA" && TAP_JSON=1 bash "$ROOT/bin/tap" nudge hermes-gw >"$WORK/n1.out" 2>/dev/null ) || rc=$?
[ "$rc" != 0 ] || { echo "poll-mode: (8) nudge on a poll member should fail" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="poll_mode_member", d' "$WORK/n1.out" \
  || { echo "poll-mode: (8) should be error_class=poll_mode_member" >&2; cat "$WORK/n1.out" >&2; exit 1; }
echo "poll-mode: (8) tap nudge on a poll member is a structured refusal (error_class=poll_mode_member): ok"


# --- (10) --team anchors the bus for a pane-less caller (poll/send/reply/done/outstanding)
new_repo "$WORK/Unrelated"
( cd "$WORK/Unrelated" && env -u TAP_HOME bash "$ROOT/bin/tap" poll hermes-gw --team TeamA --quiet ) \
  || { echo "poll-mode: (10) poll --team should anchor to TeamA's bus from an unrelated cwd" >&2; exit 1; }
( cd "$WORK/Unrelated" && env -u TAP_HOME bun "$ROOT/runtime/bun/main.ts" send hermes-gw -m "via team" --from cron-watch --id pm-10 --team TeamA >"$WORK/s10.out" 2>&1 ) \
  || { echo "poll-mode: (10) send --team should anchor to TeamA's bus" >&2; cat "$WORK/s10.out" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/pm-10.md" ] || { echo "poll-mode: (10) --team-anchored send did not land on TeamA's bus" >&2; exit 1; }
( cd "$WORK/Unrelated" && env -u TAP_HOME bash "$ROOT/bin/tap" outstanding cron-watch --team TeamA --json >"$WORK/o10.out" 2>/dev/null ) || true
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any(i["id"]=="pm-10" for i in d["outstanding"]), d' "$WORK/o10.out" \
  || { echo "poll-mode: (10) outstanding --team should list pm-10 from TeamA's bus before settlement" >&2; cat "$WORK/o10.out" >&2; exit 1; }
( cd "$WORK/Unrelated" && env -u TAP_HOME bash "$ROOT/bin/tap" read pm-10 --by hermes-gw --team TeamA ) \
  || { echo "poll-mode: (10) read --team should settle on TeamA's bus" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/pm-10.done" ] || { echo "poll-mode: (10) --team-anchored read did not write the receipt on TeamA's bus" >&2; exit 1; }
echo "poll-mode: (10) --team anchors the bus for pane-less poll/send/done/outstanding callers: ok"


echo "poll-mode-delivery: ok"
