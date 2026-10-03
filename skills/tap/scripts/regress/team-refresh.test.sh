#!/usr/bin/env bash
# team-refresh.test.sh — `tap team refresh` trims dead pane-backed seats.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH"
# Isolate the launcher manifest: team refresh now composes a `tap session prune`
# (tap-h3y DP3), so point it at a sandbox file — never the developer's real manifest.
export TAP_SESSION_MANIFEST="$TAP_HOME/sessions.json"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
# FAKE_TMUX_DOWN: the whole server is unreachable — nonzero WITH stderr, so
# lib.sh's reachability probe reads it as genuinely down, not a mock gap.
if [ -n "${FAKE_TMUX_DOWN:-}" ]; then
  echo "no server running on /fake/socket" >&2
  exit 1
fi
if [ -n "${FAKE_TMUX_OPAQUE:-}" ]; then
  echo "permission denied opening the tmux socket" >&2
  exit 1
fi
case "${1:-}" in
  list-sessions)
    names='demo/livepending demo/live demo/shared demo/legacy demo/revenant'
    [ -z "${TAP_HARD_FIXTURE:-}" ] || names="$names demo/zombie demo/working demo/crew-hosted"
    for name in $names; do
      if [[ "$*" == *'start_time'* ]]; then printf '%s\t900:100\n' "$name"
      else printf '%s\n' "$name"
      fi
    done
    exit 0
    ;;
  list-panes)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2#=}"; shift 2 ;;
        -F) fmt="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$fmt" == *'start_time'* ]]; then
      case "$target" in
        demo/live)     printf 'demo/live\tdemo/live:0.0\t%%11\tcodex\t111\t900:100\t0\n' ;;
        demo/shared)   printf 'demo/shared\tdemo/shared:0.0\t%%23\tcodex\t123\t900:100\t0\n' ;;
        demo/legacy)   printf 'demo/legacy\tdemo/legacy:0.0\t%%24\tcodex\t124\t900:100\t0\n' ;;
        demo/revenant) printf 'demo/revenant\tdemo/revenant:0.0\t%%22\tcodex\t122\t900:100\t0\n' ;;
        *) exit 1 ;;
      esac
    fi
    exit 0
    ;;
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s\n' "$target" >> "${TAP_HOME}/tmux-kills.log"
    exit 0
    ;;
esac
[ "${1:-}" = "display-message" ] || exit 0
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) target="$2"; shift 2 ;;
    *) fmt="$1"; shift ;;
  esac
done
case "$target" in *dead*) case "$fmt" in *pane_id*) echo ""; exit 0 ;; esac ;; esac
case "$target" in "%21"|"%22") case "$fmt" in *pane_id*) echo ""; exit 0 ;; esac ;; esac
case "$target" in "sameid-pane") case "$fmt" in *pane_id*) echo "%22"; exit 0 ;; esac ;; esac
case "$fmt" in
  # Real tmux pane ids are %<digits>; unknown targets derive stable digits via
  # cksum so the strict pane-id grammar holds for every resolution.
  *pane_id*) [ "$target" = "shared-pane" ] && { echo "%23"; exit 0; }; echo "%$(printf '%s' "$target" | cksum | cut -d' ' -f1)" ;;
  *) echo "" ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

write_fixture() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "live": {"status": "active", "delivery": "pane", "session": "demo/live", "pane": "demo/live:0.0", "pane_id": "%11", "harness": "codex"},
    "dead": {"status": "active", "delivery": "pane", "session": "demo/dead", "pane": "demo/dead:0.0", "pane_id": "%12", "harness": "codex"},
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon"}
  }
}
JSON
}
write_hard_fixture() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "active-live": {"status": "active", "delivery": "pane", "session": "demo/live", "pane": "demo/live:0.0", "pane_id": "%11", "harness": "codex"},
    "suspended-dead": {"status": "suspended", "status_reason": "server_restarted", "delivery": "pane", "session": "demo/suspended-dead", "harness": "claude"},
    "suspended-live": {"status": "suspended", "status_reason": "server_restarted", "delivery": "pane", "session": "demo/zombie", "harness": "codex"},
    "offline-dead": {"status": "offline", "status_reason": "harness_exited", "delivery": "pane", "session": "demo/offline-dead", "harness": "cursor"},
    "poll-suspended-dead": {"status": "suspended", "status_reason": "server_restarted", "delivery": "poll", "harness": "daemon"},
    "poll-active": {"status": "active", "delivery": "poll", "session": "demo/poll-active", "harness": "daemon"}
  }
}
JSON
}
has_agent() {
  python3 -B - "$TAP_HOME/registry.json" "$1" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
sys.exit(0 if sys.argv[2] in agents else 1)
PY
}

# (1) Real refresh trims dead, keeps live, skips poll, appends event.
write_fixture
out="$("$TAP" team refresh)"
[[ "$out" == *"removed 'dead' because its exact session is absent"* ]] || { echo "team-refresh: dead seat not reported as removed prose" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kept 'live'; pane is active"* ]] || { echo "team-refresh: live seat not reported as kept prose" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"skipped 'pollbot'; it uses poll delivery"* ]] || { echo "team-refresh: poll seat not reported as skipped prose" >&2; echo "$out" >&2; exit 1; }
has_agent dead && { echo "team-refresh: dead agent survived refresh" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent live || { echo "team-refresh: live agent missing after refresh" >&2; exit 1; }
has_agent pollbot || { echo "team-refresh: poll agent missing after refresh" >&2; exit 1; }
grep -q 'team-refresh' "$TAP_HOME/registry-events.log" || { echo "team-refresh: missing registry event" >&2; cat "$TAP_HOME/registry-events.log" >&2; exit 1; }
echo "team-refresh: (1) trims dead, keeps live, skips poll, appends event: ok"

# (1b) A recycled address must not keep a dead pane_id-backed row alive.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "live": {"status": "active", "delivery": "pane", "session": "demo/shared", "pane": "demo/shared:0.0", "pane_id": "%23", "harness": "codex"},
    "recycled": {"status": "active", "delivery": "pane", "session": "demo/shared", "pane": "demo/shared:0.0", "pane_id": "%21", "harness": "codex"},
    "legacy": {"status": "active", "delivery": "pane", "session": "demo/legacy", "pane": "demo/legacy:0.0", "harness": "codex"}
  }
}
JSON
out="$("$TAP" team refresh)"
[[ "$out" == *"kept 'recycled'; unknown:address_rebound"* ]] || { echo "team-refresh: recycled address is identity conflict, not deletion authority" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kept 'live'; pane is active"* ]] || { echo "team-refresh: live row sharing address should be kept" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kept 'legacy'; pane is active"* ]] || { echo "team-refresh: legacy row without pane_id should still refresh by address" >&2; echo "$out" >&2; exit 1; }
has_agent recycled || { echo "team-refresh: recycled agent was trimmed without exact-name absence proof" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent live || { echo "team-refresh: live shared-address agent missing after refresh" >&2; exit 1; }
has_agent legacy || { echo "team-refresh: legacy address-only agent missing after refresh" >&2; exit 1; }
echo "team-refresh: (1b) keeps recycled-address conflict unknown, plus live and legacy rows: ok"

# (1c) Expired pending launch reservations trim only after grace and only when
# their reserved tmux session is gone.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "expired": {"status": "pending", "session": "demo/expired", "harness": "codex", "registered_at": "2026-07-09T00:01:00Z"},
    "bound-expired": {"status": "active", "status_reason": "launching", "launch_id": "dead-token", "session": "demo/bound-expired", "harness": "codex", "pane": "demo/bound-expired:0.0", "pane_id": "%24", "registered_at": "2026-07-09T00:01:00Z"},
    "young": {"status": "pending", "session": "demo/young", "harness": "codex", "registered_at": "2026-07-09T00:01:30Z"},
    "livepending": {"status": "pending", "session": "demo/livepending", "harness": "codex", "registered_at": "2026-07-09T00:00:00Z"}
  }
}
JSON
out="$(TAP_WATCH_NOW=1783555320 "$TAP" team refresh)"
[[ "$out" == *"removed 'expired' because its pending launch expired"* ]] || { echo "team-refresh: expired pending should explain its removal" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"removed 'bound-expired' because its launch expired"* ]] || { echo "team-refresh: expired bound launch should explain its removal" >&2; echo "$out" >&2; exit 1; }
# "young"'s reserved session ("demo/young") is already gone (only "demo/livepending"
# is a live tmux session in this fixture) but its 60s probe grace has not elapsed —
# the narration must say so (tap-vom), not read as a plain, indistinguishable-from-
# genuinely-launching "kept ... (pending)" (which an operator read as "refresh doesn't clear
# pending").
[[ "$out" == *"kept 'young'; it is pending and expires in ~30s"* ]] || { echo "team-refresh: young pending (session gone, within grace) should narrate the grace window" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kept 'livepending'; it is pending"* ]] || { echo "team-refresh: live reserved session should stay protected, plain 'pending' (genuinely alive, no grace caveat)" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kept 'livepending'; it is pending and expires"* ]] && { echo "team-refresh: a genuinely alive reserved session should never show an expiry countdown" >&2; echo "$out" >&2; exit 1; }
has_agent expired && { echo "team-refresh: expired pending survived refresh" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent bound-expired && { echo "team-refresh: expired bound launch survived refresh" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent young || { echo "team-refresh: young pending was trimmed" >&2; exit 1; }
has_agent livepending || { echo "team-refresh: live pending was trimmed" >&2; exit 1; }
echo "team-refresh: (1c) trims abandoned pending only after grace and dead session probe; narrates the grace window distinctly from a genuinely alive reservation: ok"

# (1d) Caller case for the refresh trim — the tap-67n1 deletion, fixed: a seat
# whose stored pane_id probe MISSES but whose recorded address resolves to that
# SAME id is ALIVE (it IS the identity on record) and must be kept, never
# trimmed. At 4aabafa-era semantics this row classified pane_gone and refresh
# deleted a LIVE seat on main.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "revenant": {"status": "active", "delivery": "pane", "session": "demo/revenant", "pane": "demo/revenant:0.0", "pane_id": "%22", "harness": "codex"},
    "dead": {"status": "active", "delivery": "pane", "session": "demo/dead", "pane": "demo/dead:0.0", "pane_id": "%12", "harness": "codex"}
  }
}
JSON
out="$("$TAP" team refresh)"
[[ "$out" == *"kept 'revenant'; pane is active"* ]] || { echo "team-refresh: (1d) same-id-at-address seat should be kept as active" >&2; echo "$out" >&2; exit 1; }
has_agent revenant || { echo "team-refresh: (1d) same-id-at-address seat was trimmed (tap-67n1 regression)" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent dead && { echo "team-refresh: (1d) genuinely dead seat should still be trimmed" >&2; exit 1; }
echo "team-refresh: (1d) same-id-at-address seat kept, dead sibling still trimmed (tap-67n1): ok"

# (1e) Caller case for the refresh trim — unreachable tmux frees NOTHING: a
# probe that cannot see the server is not evidence any seat is dead, so every
# pane-backed row is kept and narrated as unobservable (never as gone).
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "one": {"status": "active", "delivery": "pane", "session": "demo/one", "pane": "demo/one:0.0", "pane_id": "%25", "harness": "codex"},
    "two": {"status": "active", "delivery": "pane", "session": "demo/two", "pane": "demo/two:0.0", "harness": "codex"}
  }
}
JSON
before_down="$(cat "$TAP_HOME/registry.json")"
out="$(FAKE_TMUX_DOWN=1 "$TAP" team refresh)"
[[ "$out" == *"kept 'one'; unknown:session_unobservable"* ]] || { echo "team-refresh: (1e) unobservable seat should be kept and narrated" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kept 'two'; unknown:session_unobservable"* ]] || { echo "team-refresh: (1e) legacy unobservable seat should be kept and narrated" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"removed"* ]] && { echo "team-refresh: (1e) unreachable tmux must trim nothing" >&2; echo "$out" >&2; exit 1; }
[ "$before_down" = "$(cat "$TAP_HOME/registry.json")" ] || { echo "team-refresh: (1e) unreachable tmux mutated the registry" >&2; exit 1; }
FAKE_TMUX_DOWN=1 "$TAP" team refresh --json | python3 -c '
import json, sys
d=json.load(sys.stdin)
assert d["trimmed"] == [], d
assert {x["handle"]: x["reason"] for x in d["kept"]} == {"one": "unknown:session_unobservable", "two": "unknown:session_unobservable"}, d
' || { echo "team-refresh: (1e) --json unobservable shape wrong" >&2; exit 1; }
echo "team-refresh: (1e) unreachable tmux keeps every seat as unobservable, trims nothing: ok"

# (1f) Default refresh never expands into the hard-refresh lifecycle scope.
write_hard_fixture
before_default="$(cat "$TAP_HOME/registry.json")"
TAP_HARD_FIXTURE=1 "$TAP" team refresh >/dev/null
for handle in suspended-dead suspended-live offline-dead poll-suspended-dead; do
  has_agent "$handle" || { echo "team-refresh: (1f) default refresh cut hard-only row '$handle'" >&2; exit 1; }
done
[ "$before_default" = "$(cat "$TAP_HOME/registry.json")" ] || { echo "team-refresh: (1f) default refresh changed hard-only fixture" >&2; exit 1; }
echo "team-refresh: (1f) default scope leaves suspended/offline rows untouched: ok"

help_out="$("$TAP" help team refresh)"
[[ "$help_out" == *"tap team refresh [--hard]"* ]] || { echo "team-refresh: (1f) help omits --hard grammar" >&2; exit 1; }
[[ "$help_out" == *"team up"*"only before --hard removes"* ]] || { echo "team-refresh: (1f) help omits team-up/hard-cut consequence" >&2; exit 1; }

# (1g) --hard cuts only suspended/offline rows whose exact session is absent.
# Poll delivery gets the same lifecycle rule; an exact live name still spares the row.
write_hard_fixture
hard_json="$(TAP_HARD_FIXTURE=1 "$TAP" team refresh --hard --json)"
python3 -c '
import json, sys
d=json.loads(sys.argv[1])
trimmed={x["handle"]: x for x in d["trimmed"]}
assert set(trimmed) == {"offline-dead", "poll-suspended-dead", "suspended-dead"}, d
assert {x["handle"] for x in d["kept"]} >= {"active-live", "suspended-live"}, d
assert {x["handle"] for x in d["skipped"]} == {"poll-active"}, d
assert trimmed["suspended-dead"]["harness"] == "claude", d
assert trimmed["suspended-dead"]["last_status"] == "suspended", d
assert trimmed["suspended-dead"]["reason"] == "hard_session_absent", d
assert trimmed["poll-suspended-dead"]["reason"] == "hard_session_missing", d
' "$hard_json" || { echo "team-refresh: (1g) --hard cut set or receipt fields wrong" >&2; echo "$hard_json" >&2; exit 1; }
write_hard_fixture
hard_human="$(TAP_HARD_FIXTURE=1 "$TAP" team refresh --hard --dry-run)"
[[ "$hard_human" == *"removed 'suspended-dead' (harness=claude, last_status=suspended) because"* ]] || { echo "team-refresh: (1g) human removal receipt omits required fields" >&2; echo "$hard_human" >&2; exit 1; }
TAP_HARD_FIXTURE=1 "$TAP" team refresh --hard >/dev/null
for handle in suspended-dead offline-dead poll-suspended-dead; do
  has_agent "$handle" && { echo "team-refresh: (1g) hard-refresh candidate '$handle' survived" >&2; exit 1; }
done
for handle in active-live suspended-live poll-active; do
  has_agent "$handle" || { echo "team-refresh: (1g) hard refresh removed protected row '$handle'" >&2; exit 1; }
done
echo "team-refresh: (1g) hard scope cuts dead suspended/offline rows, spares live/active, and emits receipts: ok"

# (1h) For namespace-scoped hard refresh, recognized no-server is positive
# empty-namespace evidence. An opaque failure remains fail-closed.
write_hard_fixture
FAKE_TMUX_DOWN=1 "$TAP" team refresh --hard >/dev/null
for handle in suspended-dead suspended-live offline-dead poll-suspended-dead; do
  has_agent "$handle" && { echo "team-refresh: (1h) no-server should cut '$handle'" >&2; exit 1; }
done
write_hard_fixture
before_opaque="$(cat "$TAP_HOME/registry.json")"
opaque_json="$(FAKE_TMUX_OPAQUE=1 "$TAP" team refresh --hard --json)"
[ "$before_opaque" = "$(cat "$TAP_HOME/registry.json")" ] || { echo "team-refresh: (1h) opaque snapshot mutated registry" >&2; exit 1; }
python3 -c '
import json, sys
d=json.loads(sys.argv[1])
assert d["trimmed"] == [], d
kept={x["handle"]: x["reason"] for x in d["kept"]}
for handle in ("suspended-dead", "suspended-live", "offline-dead", "poll-suspended-dead"):
    assert kept[handle] == "hard_session_unobservable", d
' "$opaque_json" || { echo "team-refresh: (1h) opaque snapshot was not kept fail-closed" >&2; echo "$opaque_json" >&2; exit 1; }
echo "team-refresh: (1h) no-server proves empty for hard scope; opaque failure cuts nothing: ok"

# (1i) Hard dry-run reports exactly the real candidate set and mutates nothing.
write_hard_fixture
hard_before="$(cat "$TAP_HOME/registry.json")"
hard_dry="$(TAP_HARD_FIXTURE=1 "$TAP" team refresh --hard --dry-run --json)"
[ "$hard_before" = "$(cat "$TAP_HOME/registry.json")" ] || { echo "team-refresh: (1i) hard dry-run mutated registry" >&2; exit 1; }
hard_real="$(TAP_HARD_FIXTURE=1 "$TAP" team refresh --hard --json)"
[ "$hard_dry" = "$hard_real" ] || { echo "team-refresh: (1i) hard dry-run candidate set differs from real" >&2; diff -u <(printf '%s\n' "$hard_dry") <(printf '%s\n' "$hard_real") >&2 || true; exit 1; }
echo "team-refresh: (1i) hard dry-run is byte-identical to real output and leaves bytes unchanged: ok"

# (2) --dry-run prints the same lines but leaves registry byte-identical.
write_fixture
before="$(cat "$TAP_HOME/registry.json")"
dry="$("$TAP" team refresh --dry-run)"
real="$("$TAP" team refresh)"
[ "$dry" = "$real" ] || { echo "team-refresh: dry-run output should match real output" >&2; diff -u <(printf '%s\n' "$dry") <(printf '%s\n' "$real") >&2 || true; exit 1; }
write_fixture
"$TAP" team refresh --dry-run >/dev/null
after="$(cat "$TAP_HOME/registry.json")"
[ "$before" = "$after" ] || { echo "team-refresh: dry-run mutated registry" >&2; exit 1; }
echo "team-refresh: (2) dry-run output identical and registry unchanged: ok"

# (3) --json parses with trimmed/skipped/kept arrays.
write_fixture
"$TAP" team refresh --json | python3 -c '
import json, sys
d=json.load(sys.stdin)
assert [x["handle"] for x in d["trimmed"]] == ["dead"], d
assert [x["handle"] for x in d["kept"]] == ["live"], d
assert [x["handle"] for x in d["skipped"]] == ["pollbot"], d
assert d["trimmed"][0]["reason"] == "session_absent", d
assert d["kept"][0]["reason"] == "active", d
assert d["skipped"][0]["reason"] == "poll-mode", d
' || { echo "team-refresh: --json shape wrong" >&2; "$TAP" team refresh --json >&2; exit 1; }
echo "team-refresh: (3) --json shape parses: ok"

# (4) Empty registry is friendly.
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{}}
JSON
out="$("$TAP" team refresh)"
[[ "$out" == *"nothing to refresh"* ]] || { echo "team-refresh: empty refresh should be friendly" >&2; echo "$out" >&2; exit 1; }
echo "team-refresh: (4) empty registry: ok"


# (6) tap-q2v4: a trim that would strand unsettled team-local inbound REPORTS it on
# stderr (ids + handle + next-action) — never silently deletes the obligation, never
# adopts (refresh has no successor). --dry-run previews the strand (the most useful
# moment, before the trim commits); the real run reports it too. The report is READ-ONLY:
# the payload's `to` is untouched and it is never settled.
write_fixture
cat > "$TAP_HOME/payloads/strandq2v4-1.md" <<'MD'
---
id: strandq2v4-1
from: sol
to: dead
kind: discuss
reply: expected
to_team: demo
path: /x/strandq2v4-1.md
---

waiting on dead
MD
dry_err="$("$TAP" team refresh --dry-run 2>&1 >/dev/null)"
[[ "$dry_err" == *"WARNING: trimming 'dead' strands 1 unsettled payload(s) addressed to it: strandq2v4-1"* ]] || { echo "team-refresh: (6) dry-run should preview the strand" >&2; echo "$dry_err" >&2; exit 1; }
has_agent dead || { echo "team-refresh: (6) dry-run must not trim while previewing a strand" >&2; exit 1; }
err="$("$TAP" team refresh 2>&1 >/dev/null)"
[[ "$err" == *"WARNING: trimming 'dead' strands 1 unsettled payload(s) addressed to it: strandq2v4-1"* ]] || { echo "team-refresh: (6) real run should report the strand with ids+handle" >&2; echo "$err" >&2; exit 1; }
[[ "$err" == *"re-register a seat as 'dead'"* ]] || { echo "team-refresh: (6) no-successor next-action missing" >&2; echo "$err" >&2; exit 1; }
grep -q '^to: dead$' "$TAP_HOME/payloads/strandq2v4-1.md" || { echo "team-refresh: (6) strand report rewrote the payload (must be read-only)" >&2; cat "$TAP_HOME/payloads/strandq2v4-1.md" >&2; exit 1; }
[ ! -e "$TAP_HOME/receipts/strandq2v4-1.done" ] || { echo "team-refresh: (6) strand report settled the obligation (must not)" >&2; exit 1; }
echo "team-refresh: (6) strand reported on stderr (dry-run + real), payload untouched and unsettled: ok"

# (7) settled inbound is NOT stranded — the report never nags about mail already put to bed.
rm -f "$TAP_HOME/payloads/"strandq2v4-*.md
write_fixture
cat > "$TAP_HOME/payloads/strandq2v4-2.md" <<'MD'
---
id: strandq2v4-2
from: sol
to: dead
kind: discuss
reply: expected
to_team: demo
path: /x/strandq2v4-2.md
---

already handled
MD
: > "$TAP_HOME/receipts/strandq2v4-2.done"
err="$("$TAP" team refresh 2>&1 >/dev/null)"
[[ "$err" == *"strandq2v4-2"* ]] && { echo "team-refresh: (7) settled inbound must not be reported stranded" >&2; echo "$err" >&2; exit 1; }
echo "team-refresh: (7) settled inbound is not stranded: ok"

# (8) when a live seat already holds the reclaim grant for the trimmed handle (a prior
# register-release adoption), the report names THAT successor instead of claiming no path
# exists — honoring the grant p6el created.
rm -f "$TAP_HOME/payloads/"strandq2v4-*.md
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "live": {"status": "active", "delivery": "pane", "session": "demo/live", "pane": "demo/live:0.0", "pane_id": "%11", "harness": "codex", "adopted_handles": ["dead"]},
    "dead": {"status": "active", "delivery": "pane", "session": "demo/dead", "pane": "demo/dead:0.0", "pane_id": "%12", "harness": "codex"}
  }
}
JSON
cat > "$TAP_HOME/payloads/strandq2v4-3.md" <<'MD'
---
id: strandq2v4-3
from: sol
to: dead
kind: discuss
reply: expected
to_team: demo
path: /x/strandq2v4-3.md
---

arrived after the reseat
MD
err="$("$TAP" team refresh 2>&1 >/dev/null)"
[[ "$err" == *"successor 'live' holds the reclaim grant"* ]] || { echo "team-refresh: (8) grant-holder next-action missing" >&2; echo "$err" >&2; exit 1; }
# Ruling 33 + architect addendum: the strand report advertises only what RUNS in
# the failure state — the sender's cancel per stranded id, plus the bead that
# owns the adoption-aware settle surface. `tap read/reply/done --by live` all
# refuse locally adopted instance-bound mail (tap-7r3fn.27 is the fix).
[[ "$err" == *"tap cancel strandq2v4-3 --by sol"* ]] || { echo "team-refresh: (8) per-id sender-cancel remedy missing" >&2; echo "$err" >&2; exit 1; }
[[ "$err" == *"tap-7r3fn.27"* ]] || { echo "team-refresh: (8) bead reference missing" >&2; echo "$err" >&2; exit 1; }
[[ "$err" != *"tap done"* ]] || { echo "team-refresh: (8) strand report still teaches tap done" >&2; echo "$err" >&2; exit 1; }
# T7 fixture half: the advertised command actually RUNS in this state — the named
# sender cancels the stranded id and it leaves the sender's outstanding.
rc=0
cout="$("$TAP" cancel strandq2v4-3 --by sol 2>&1)" || rc=$?
[ "$rc" -eq 0 ] || { echo "team-refresh: (8) the advertised cancel did not run: $cout" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/strandq2v4-3.cancelled" ] || { echo "team-refresh: (8) the advertised cancel left no .cancelled receipt" >&2; exit 1; }
oout="$("$TAP" outstanding sol 2>&1)" || true
[[ "$oout" != *"strandq2v4-3"* ]] || { echo "team-refresh: (8) the cancelled strand id still shows in the sender's outstanding" >&2; echo "$oout" >&2; exit 1; }
echo "team-refresh: (8) grant-holder strand report names runnable remedies, and the cancel runs: ok"

echo "team-refresh: ok"
