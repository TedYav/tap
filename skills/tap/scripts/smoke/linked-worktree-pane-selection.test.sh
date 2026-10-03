#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# linked-worktree-pane-selection.test.sh — a pane registered on team `tap`
# running TAP bus verbs from an UNENROLLED LINKED WORKTREE of the same Git
# repo resolves native context through that pane's existing team (tap-7s1r):
# whoami/team/outstanding/reply anchor without --team, TAP_HOME or --by, the
# settlement lands on the pane team's bus (never a wrong team's), and
# `session launch --dry-run` keeps refusing launcher_unenrolled through BOTH
# the native and the Python/default public routing doors.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT

fail() { echo "linked-worktree-pane-selection: $*" >&2; exit 1; }

export TAP_INDEX_HOME="$WORK/index"
REPO="$WORK/repo"
WT="$WORK/wt"
BUS="$REPO/.tap/bus"
REGISTRY="$REPO/.tap/team-registry.json"
ELSEWHERE_BUS="$WORK/elsewhere/.tap/bus"
TRACE="$WORK/observe.trace"
mkdir -p "$TAP_INDEX_HOME" "$WORK/bin" "$BUS/payloads" "$BUS/receipts" "$ELSEWHERE_BUS/payloads" "$ELSEWHERE_BUS/receipts"

git -C "$REPO" init -q
git -C "$REPO" -c user.email=p@x -c user.name=p commit -q --allow-empty -m init
git -C "$REPO" worktree add -q "$WT" -b lane-smoke

# Model the pane-backed caller without trusting the runner's real process
# ancestry. The targeted four-field identity record answers arity-exact
# readers with all four fields (pane_id, pane_tty, session_name,
# pid:start_time); the trace proves the fake observation actually ran.
cat >"$WORK/bin/ps" <<'SH'
#!/usr/bin/env bash
printf '1 ttys001\n'
SH
cat >"$WORK/bin/tmux" <<SH
#!/usr/bin/env bash
echo "tmux \${1:-}" >> "$TRACE"
case "\${1:-}" in
  list-panes) printf '%%5\t/dev/ttys001\n' ;;
  display-message)
    for a in "\$@"; do
      case "\$a" in
        *'#{pane_tty}'*) printf '%%5\t/dev/ttys001\ttap/glm\t4242:100'; exit 0 ;;
        *'#{pane_id}	#{session_name}	#{pid}:#{start_time}'*) printf '%%5	tap/glm	4242:100'; exit 0 ;;
        *'#{session_name}'*) printf 'tap/glm\t4242:100'; exit 0 ;;
        *'#{pid}:#{start_time}'*) printf '4242:100'; exit 0 ;;
      esac
    done
    printf '%%5\t/dev/ttys001' ;;
esac
SH
chmod +x "$WORK/bin/ps" "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH"
# The reply door's actor resolution refuses without an ambient tmux record;
# the fake pane stands in for it exactly as the native test fixture does.
export TMUX="/fake,1,0"

cat >"$REGISTRY" <<'JSON'
{
  "schema": "0.20",
  "team": {"name": "tap"},
  "seats": {
    "glm": {
      "status": "active",
      "delivery": "pane",
      "harness": "claude",
      "pane": "tap-glm:0.0",
      "pane_id": "%5",
      "session": "tap/glm",
      "registered_at": "2026-09-19T00:00:00Z",
      "server_epoch": "srv:4242:100",
      "instance": "glm|tap"
    },
    "snd": {
      "status": "active",
      "delivery": "poll",
      "harness": "codex",
      "instance": "snd|tap"
    }
  }
}
JSON
cat >"$TAP_INDEX_HOME/global-registry.json" <<JSON
{
  "schema": "0.20",
  "teams": {
    "tap": {
      "root": "$REPO",
      "registry_location": "$REGISTRY",
      "state": "registered"
    },
    "elsewhere": {
      "root": "$WORK/elsewhere",
      "registry_location": "$WORK/elsewhere/.tap/team-registry.json",
      "state": "registered"
    }
  }
}
JSON
cat >"$WORK/elsewhere/.tap/team-registry.json" <<'JSON'
{
  "schema": "0.20",
  "team": {"name": "elsewhere"},
  "seats": {}
}
JSON

INBOUND="fable-20260919T000000Z-abcdef123456"
OUTBOUND="glm-20260919T000001Z-abcdef123456"
cat >"$BUS/payloads/$INBOUND.md" <<EOF
---
id: $INBOUND
from: snd
to: glm
kind: discuss
path: $BUS/payloads/$INBOUND.md
reply: expected
---
pending inbound
EOF
printf '{}\n' >"$BUS/receipts/$INBOUND.placed"
cat >"$BUS/payloads/$OUTBOUND.md" <<EOF
---
id: $OUTBOUND
from: glm
to: snd
kind: discuss
path: $BUS/payloads/$OUTBOUND.md
reply: expected
---
pending outbound
EOF
printf '{}\n' >"$BUS/receipts/$OUTBOUND.placed"

wt() { (cd "$WT" && env -u TAP_HOME -u TAP_SELF "$TAP" "$@"); }

# ── whoami resolves the registered handle from the linked worktree ──────────
rc=0
wt whoami --json >"$WORK/whoami.out" 2>&1 || rc=$?
[ "$rc" -eq 0 ] || fail "whoami returned rc=$rc (want 0): $(cat "$WORK/whoami.out")"
grep -Eq '"handle"[[:space:]]*:[[:space:]]*"glm"' "$WORK/whoami.out" \
  || fail "whoami did not resolve handle glm: $(cat "$WORK/whoami.out")"
grep -Eq '"team"[[:space:]]*:[[:space:]]*"tap"' "$WORK/whoami.out" \
  || fail "whoami did not name team tap: $(cat "$WORK/whoami.out")"
grep -q 'display-message' "$TRACE" || fail "the fake pane observation never ran"

# ── team --context names the pane's existing team and bus ───────────────────
rc=0
wt team --context --json >"$WORK/team.out" 2>&1 || rc=$?
[ "$rc" -eq 0 ] || fail "team --context returned rc=$rc (want 0): $(cat "$WORK/team.out")"
grep -Eq '"team"[[:space:]]*:[[:space:]]*"tap"' "$WORK/team.out" \
  || fail "team --context did not name team tap: $(cat "$WORK/team.out")"

# ── outstanding is not unanchored from the linked worktree ──────────────────
rc=0
wt outstanding glm --json >"$WORK/outstanding.out" 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "outstanding returned rc=$rc (want 2): $(cat "$WORK/outstanding.out")"
grep -Fq "$OUTBOUND" "$WORK/outstanding.out" \
  || fail "outstanding did not reach the pane team's bus: $(cat "$WORK/outstanding.out")"
grep -Fq "unanchored" "$WORK/outstanding.out" \
  && fail "outstanding still reported an unanchored bus: $(cat "$WORK/outstanding.out")" || true

# ── the shipped public reply door settles WITHOUT repair flags ──────────────
# bin/tap is the installed entry whose pre-dispatcher routes reply through the
# native engine, where the pane-anchored context applies. No --by, no --team,
# no TAP_HOME: the actor and the bus both come from the pane's registration.
# (skills/tap/scripts/tap.sh routes reply to the Bash engine, which by design
# has no pane-anchored selection; `tap done` is Bash-owned, NOT a substitute.)
rc=0
(cd "$WT" && env -u TAP_HOME -u TAP_SELF "$ROOT/bin/tap" reply "$INBOUND" -m ack) >"$WORK/reply.out" 2>&1 || rc=$?
[ "$rc" -eq 0 ] || fail "reply returned rc=$rc (want 0): $(cat "$WORK/reply.out")"
[ -e "$BUS/receipts/$INBOUND.done" ] || fail "reply left no settlement receipt on the pane team's bus"
grep -Fq '"via"' "$BUS/receipts/$INBOUND.done" || fail "the receipt carries no via field"
grep -Fq 'reply' "$BUS/receipts/$INBOUND.done" || fail "the receipt was not settled via reply"
grep -Fq 'glm' "$BUS/receipts/$INBOUND.done" || fail "the receipt was not settled by the pane's handle"
grep -Fq 'queued' "$WORK/reply.out" || fail "reply did not report the queued outcome: $(cat "$WORK/reply.out")"
[ ! -e "$ELSEWHERE_BUS/receipts/$INBOUND.done" ] \
  || fail "the settlement leaked onto the wrong team's bus"

# ── the launcher keeps refusing a pane-anchored context ─────────────────────
# Pane selection is NOT enrollment: launch refuses implicit enrollment.
rc=0
(cd "$WT" && env -u TAP_HOME "$TAP" session launch claude --dry-run) >"$WORK/launch.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "dry-run launch succeeded from an unenrolled linked worktree"
grep -Fq "refusing implicit enrollment" "$WORK/launch.out" \
  || fail "dry-run launch lost the implicit-enrollment refusal: $(cat "$WORK/launch.out")"

echo "linked-worktree-pane-selection: pane-anchored selection resolves through the enrolled team; the launcher still refuses: ok"
