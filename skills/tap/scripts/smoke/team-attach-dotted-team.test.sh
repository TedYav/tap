#!/usr/bin/env bash
# team-attach-dotted-team.test.sh — `tap team attach` must plan the seats of a
# team whose NAME is not a legal tmux session component (tap-rxmgp).
#
# The specimen: team `demo.alpha.107-Renewal`, nine
# live seats on the roster, and `tap team attach` answering "no live seats" —
# while `tap attach <handle>` reached `demo-alpha-107-Renewal/<handle>` fine.
# The launcher names every session `sanitize_component(<team>)/<handle>` (tmux
# refuses `.` in a session name, it is the target separator), and the planner
# filtered the catalog on `<team>/` spelled RAW, so on a dotted team every row
# failed the prefix test and the live set came out empty.
#
# Real tmux, on the runner's own server: the row's `live` flag comes from
# `tmux list-sessions`, and a fake tmux would let the fixture answer "live" for a
# name it never had to create. Arm (0) proves the catalog carries both rows,
# live, under the SANITIZED name before attach is invoked — an empty upstream
# snapshot must not masquerade as the intended red (partner review).
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

fail() { echo "team-attach-dotted-team: $*" >&2; exit 1; }

# Dot, digits, upper case, an underscore: everything sanitize_component either
# rewrites (the dot) or must leave alone (the rest). The base is what the
# launcher's own naming produces for it — computed, not typed, so this fixture
# cannot drift from the mapping it exercises.
TEAM="demo.alpha.107-Renewal"
SESSION_BASE="$("${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/launcher-fixture.ts" sanitize "$TEAM")"
[ "$SESSION_BASE" = "demo-alpha-107-Renewal" ] \
  || fail "sanitize_component changed shape; expected demo-alpha-107-Renewal, got '$SESSION_BASE'"
# The launcher's own mapping is what is pinned above — the reason it sanitizes
# (tmux reads `.` as the session:window.pane separator) is stated, not asserted:
# no arm here attempts a raw-name session and observes a refusal, and claiming
# otherwise would advertise coverage this file does not carry.
SESSIONS=()
cleanup() {
  local s
  for s in "${SESSIONS[@]:-}"; do
    [ -n "$s" ] || continue
    timeout 5 tmux kill-session -t "=$s" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
WORK="$(mktemp -d)"
trap cleanup EXIT
TEAM_ROOT="$WORK/$TEAM"
mkdir -p "$TEAM_ROOT"
export TAP_HOME="$TEAM_ROOT/.tap/bus"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# Two live seats, one seat whose session is gone (the unavailable disclosure
# must still name it, so the fix cannot pass by planning everything it sees).
for handle in fable sol; do
  name="$SESSION_BASE/$handle"
  timeout 5 tmux new-session -d -s "$name" -c "$TEAM_ROOT" /bin/sleep 300 \
    || fail "could not start tmux session '$name' on the suite server"
  SESSIONS+=("$name")
done

# Build the registry through the launcher's OWN writer and its OWN session
# naming, so the fixture cannot encode a row shape production never produces.
"${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/launcher-fixture.ts" dotted-registry "$TEAM_ROOT" "$TEAM" || fail "could not build the fixture registry"
# Born live: the launcher lists only an enrolled worktree.
printf '{"schema":"0.20","teams":{"%s":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' "$TEAM" "$(cd "$TEAM_ROOT" && pwd -P)" "$(cd "$TAP_HOME" && pwd -P)" > "${TAP_INDEX_HOME:?}/global-registry.json"

# --- (0) the catalog carries both rows LIVE under the sanitized name ----------
_snap_err="$(mktemp)"; _snap_rc=0
snapshot="$("$ROOT/bin/tap" session list --json --cwd "$TEAM_ROOT" 2>"$_snap_err")" || _snap_rc=$?
[ "$_snap_rc" = 0 ] \
  || fail "launcher list FAILED (rc=$_snap_rc) — an empty snapshot here is a crash, not the defect: $(tr '\n' ' ' <"$_snap_err")"
rm -f "$_snap_err"
# The check reads the snapshot from a FILE: a heredoc script and a here-string
# payload both claim stdin, and the last redirection wins — a form that silently
# runs the wrong bytes.
printf '%s' "$snapshot" >"$WORK/snapshot.json"
cat >"$WORK/catalog-check.py" <<'PY'
import json, sys
base, path = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    rows = {r["name"]: r for r in json.load(fh)["sessions"]}
for h in ("fable", "sol"):
    row = rows.get(f"{base}/{h}")
    assert row is not None, f"no catalog row named {base}/{h}: {sorted(rows)}"
    assert row.get("live") is True, f"{base}/{h} is not live in the catalog: {row}"
    assert row.get("handle") == h, f"{base}/{h} handle is {row.get('handle')!r}"
ghost = rows.get(f"{base}/ghost")
assert ghost is not None and ghost.get("live") is False, f"ghost row: {ghost}"
PY
python3 -B "$WORK/catalog-check.py" "$SESSION_BASE" "$WORK/snapshot.json" \
  || fail "catalog precondition failed; snapshot was: $snapshot"
echo "team-attach-dotted-team: (0) catalog carries fable+sol live under '$SESSION_BASE/' and ghost not live: ok"
# Belt and braces on the premise: the verb must see the DOTTED team name, or a
# fixture that sanitized the team itself would pass without touching the bug.
rc=0
out="$(cd "$TEAM_ROOT" && "$TAP" team attach --dry-run </dev/null 2>&1)" || rc=$?
case "$out" in
  *"team '$TEAM'"*) ;;
  *) fail "(0) attach did not report the dotted team name '$TEAM'; output: $out" ;;
esac

# --- (1) plain attach plans both live seats -----------------------------------
[ "$rc" = 0 ] || fail "(1) plain --dry-run expected exit 0 (a plan), got $rc; output: $out"
case "$out" in
  *"plan for team '$TEAM' (2 new viewer(s))"*) ;;
  *) fail "(1) expected a 2-viewer plan for the dotted team; output: $out" ;;
esac
case "$out" in
  *"tmux attach -t '=$SESSION_BASE/fable'"*) ;;
  *) fail "(1) plan must target the sanitized session for fable; output: $out" ;;
esac
case "$out" in
  *"tmux attach -t '=$SESSION_BASE/sol'"*) ;;
  *) fail "(1) plan must target the sanitized session for sol; output: $out" ;;
esac
case "$out" in
  *"skipped because already attached: none"*) ;;
  *) fail "(1) disclosure 'skipped because already attached: none' missing; output: $out" ;;
esac
case "$out" in
  *"unavailable: ghost (resume tier"*) ;;
  *) fail "(1) the seat with no live session must be disclosed as unavailable; output: $out" ;;
esac
echo "team-attach-dotted-team: (1) plain attach plans both live seats of the dotted team: ok"

# --- (2) --only spares the unselected live seat -------------------------------
# The specimen's second symptom: `--only <four names>` answered "matched every
# seat — none spared" because the live set it selected over was empty.
rc=0
out="$(cd "$TEAM_ROOT" && "$TAP" team attach --dry-run --only fable </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(2) --only fable expected exit 0 (a plan), got $rc; output: $out"
case "$out" in
  *"plan for team '$TEAM' (1 new viewer(s))"*) ;;
  *) fail "(2) expected a 1-viewer plan under --only fable; output: $out" ;;
esac
case "$out" in
  *"tmux attach -t '=$SESSION_BASE/sol'"*) fail "(2) --only fable must not plan sol; output: $out" ;;
esac
case "$out" in
  *"tmux attach -t '=$SESSION_BASE/fable'"*) ;;
  *) fail "(2) --only fable must plan fable; output: $out" ;;
esac
case "$out" in
  *"spared by --only fable — every other seat"*) ;;
  *) fail "(2) --only fable must report the spared seats; output: $out" ;;
esac
case "$out" in
  *"matched every seat — none spared"*) fail "(2) the specimen's false 'none spared' line must not appear; output: $out" ;;
esac
echo "team-attach-dotted-team: (2) --only spares the unselected live seat on the dotted team: ok"

# --- (3) whole-roster --only still names its selector (undotted behavior kept) -
rc=0
out="$(cd "$TEAM_ROOT" && "$TAP" team attach --dry-run --only fable,sol,ghost </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(3) whole-roster --only expected exit 0, got $rc; output: $out"
case "$out" in
  *"--only fable, sol, ghost matched every seat — none spared"*) ;;
  *) fail "(3) whole-roster --only must still name its selector; output: $out" ;;
esac
case "$out" in
  *"plan for team '$TEAM' (2 new viewer(s))"*) ;;
  *) fail "(3) whole-roster --only must plan both live seats; output: $out" ;;
esac
echo "team-attach-dotted-team: (3) whole-roster --only names its selector and plans both live seats: ok"

# --- (4) an all-spared dotted team explains the empty plan, and does not blame it -
# Design call 4 in runtime/bun/src/team/attach.ts: when the operator's OWN selection is what
# emptied the live set, that is a legal no-op (exit 0) naming the selection —
# not the "no live seats" failure, which blames the team for the operator's
# instruction. On a dotted team that branch was UNREACHABLE before the fix: the
# gate is a spared LIVE seat, spared rows came from the same filter, and the
# filter matched nothing, so an all-spared dotted team took the failure arm and
# reported the one thing that was not true of it. Raised in lane S review
# from its census of this planner, as the symptom class adjacent to this fix.
rc=0
out="$(cd "$TEAM_ROOT" && "$TAP" team attach --dry-run --except fable,sol,ghost </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(4) an all-spared team is a legal no-op and must exit 0, got $rc; output: $out"
case "$out" in
  *"no seats matched after exclusions (excluded: fable, sol, ghost)"*) ;;
  *) fail "(4) an all-spared dotted team must name the exclusions that emptied the plan; output: $out" ;;
esac
case "$out" in
  *"no live seats for team"*) fail "(4) an all-spared dotted team must NOT report 'no live seats' — that blames the team for the operator's own selection; output: $out" ;;
esac
# attach passes its OWN computed spared list (tap_select_operand's argument), so
# each seat carries the live/unavailable state the empty-plan gate counts — the
# two `(live)` entries here ARE what makes this a legal no-op rather than the
# failure arm, so asserting the states is asserting the reason.
case "$out" in
  *"spared by --except: fable (live), ghost (unavailable), sol (live)"*) ;;
  *) fail "(4) the spared disclosure must name every spared seat with its state; output: $out" ;;
esac
echo "team-attach-dotted-team: (4) an all-spared dotted team is a legal no-op that names the selection: ok"

echo "team-attach-dotted-team: ok"
