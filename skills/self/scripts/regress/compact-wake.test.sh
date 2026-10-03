#!/usr/bin/env bash
# compact-wake.test.sh — smokes for the post-compaction resume wake (tap-joqz).
#
# WHAT THIS FILE MAY AND MAY NOT ASSERT
#
# It tests the CODE: that `tap self compact` delegates the /compact through the
# same submit-verification everything else uses, arms the resume worker behind
# it rather than submitting the ping itself, and that the handoff file exists
# before any pane input happens.
#
# It does NOT — and cannot honestly — assert that the ping SURVIVES a
# compaction. That is harness behavior. A mock asserting survival would only be
# replaying our own assumption about what compaction does, and it would be the
# most dangerous placebo available, because it would sit under a bead titled
# "silent deadlock, fixed." Survival is established by a LIVE PROBE whose
# procedure and specimens are recorded on tap-joqz, and it is re-established by
# RE-RUNNING that probe after a harness update — never by this file going green.
#
# Coverage:
#   (w) ordering + verification on the Claude self path
#   (h) handoff artifact: written before pane input, refusals, always-arm
#   (f) failed arming refuses before input (exit 1), never a silent success
#   (c) Codex self path arms the proof-carrying Bun worker (tap-n27ug)
#   (c-oc) OpenCode arms the same worker, which owns the idle-boundary submit
#
# The instrument is the worker's request file on the bus
# (<bus>/handoff/<id>.compact.json), written before the detached spawn. The
# resume itself (chrome wait, spacing, the TAP note, unobservable and failed
# arms) lives in the Bun worker and is tested in runtime/bun/test/self-compact.test.ts.
#
# SAFETY: all pane injection goes through a MOCK tmux in a temp dir, and the
# worker spawn is shimmed. This test never targets a live agent pane.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_TUI_SETTLE_SCALE=0.1
# The fixture registry binds `srv:fixture`; pin the observed generation to match.
export TAP_SERVER_EPOCH='srv:fixture'

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
PASTE_FIXTURES="$ROOT/skills/tap/scripts/smoke/fixtures/submit-verify"
FAKE_BIN="$(mktemp -d)"
WORK="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN" "$WORK"' EXIT
# `tap self` acts only for a registered seat: one enrolled team whose seat is the mock pane.
TEAM_ROOT="$WORK/team"
export TAP_HOME="$TEAM_ROOT/.tap/bus"
export TAP_REGISTRY="$TEAM_ROOT/.tap/team-registry.json"
export FAKE_TMUX_FIXTURES="$PASTE_FIXTURES"
mkdir -p "$TAP_HOME" "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$TEAM_ROOT" "$TAP_REGISTRY" <<'JSON'
import json, sys
global_path, root, registry = sys.argv[1:]
json.dump({"schema":"0.20","teams":{"fixture":{"root":root,"registry_location":registry}}}, open(global_path,"w"))
open(root+"/claude.jsonl", "w").write(json.dumps({"type":"user","sessionId":"claude-session"})+"\n")
json.dump({"schema":"0.20","team":{"name":"fixture","worktree_root":root},"seats":{"subject":{"status":"active","instance":"subject|1","pane":"fake-pane","pane_id":"%4242","session":"fixture","server_epoch":"srv:fixture","harness":"claude","harness_session_id":"claude-session","transcript_path":root+"/claude.jsonl"}}}, open(registry,"w"))
JSON
seat() { # <json-object-of-fields>: merge into the subject row
  python3 -B - "$TAP_REGISTRY" "$1" <<'JSON'
import json, sys
path, fields = sys.argv[1:]
doc = json.load(open(path)); doc["seats"]["subject"].update(json.loads(fields)); json.dump(doc, open(path, "w"))
JSON
}
tself() { (cd "$TEAM_ROOT" && "$TAP" self "$@"); }

# --- fake tmux ---------------------------------------------------------------
# Same shape as self.test.sh's, plus one instrument this file needs:
#   handoff-witness  — how many handoff files existed at the moment of each send,
#                      which is what lets us prove the handoff preceded the input
#                      rather than merely coexisting with it at the end.
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  display-message)
    for arg in "$@"; do
      case "$arg" in
        # Composite observations first, before the bare pane_id pattern swallows them.
        *pane_id*session_name*pane_current_command*)
          printf '%%4242\tfixture\t4242\t%s\n' "${FAKE_TMUX_CMD:-claude}"; exit 0 ;;
        *pane_id*session_name*) printf '%%4242\tfixture\t4242:100\n'; exit 0 ;;
        *start_time*) echo "4242:100"; exit 0 ;;
        *pane_id*) echo "%4242"; exit 0 ;;
        *pane_pid*) echo "4242"; exit 0 ;;
        *pane_current_command*) echo "${FAKE_TMUX_CMD:-claude}"; exit 0 ;;
        *pane_current_path*) echo "${FAKE_PANE_PATH:-}"; exit 0 ;;
        *pane_in_mode*) echo "0"; exit 0 ;;
      esac
    done
    echo ""
    ;;
  capture-pane)
    prompt="${FAKE_TMUX_PROMPT:-›}"
    if [ "${FAKE_TMUX_CMD:-claude}" = "opencode" ]; then
      printf '     ▣ Build · Fusion\n\n'
      printf '  ┃\n'
      if [ -f "$state/input" ]; then
        printf '  ┃  %s\n' "$(cat "$state/input")"
      else
        printf '  ┃\n'
      fi
      printf '  ┃\n'
      printf '  ┃  Build · Fusion OpenRouter\n'
      printf '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n'
      exit 0
    fi
    if [ -f "$state/input" ]; then
      printf '%s %s\n' "$prompt" "$(sed -n '1p' "$state/input")"
      sed -n '2,$p' "$state/input"
    else
      printf '%s \n' "$prompt"
    fi
    # Claude's box is bounded by this border with the shortcuts footer beneath;
    # readers that bound the box on it return nothing when it is missing, so a
    # prompt-line-only mock quietly exercises a path no pane produces (tap-tx3s).
    printf '%s\n' '──────────────────────────────────────────'
    printf '%s\n' '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift
      [ "${1:-}" = "--" ] && shift
      body="${1:-}"
      # Witness: handoff files present AT THIS INSTANT, before the text lands.
      printf '%s\n' "$(find "${TAP_HOME:-/nonexistent}/handoff" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')" \
        >> "$state/handoff-witness"
      # Typing INSERTS at the cursor; it does not replace the composer. tap types a
      # slash command in two stages -- the `/compact ` token, then the payload
      # (one large burst collapses into a [Pasted text] chip and slash parsing is
      # disabled inside it). Overwriting here dropped the token, so the submit
      # guard read back a composer it had not typed and withheld Enter.
      printf '%s' "$body" >> "$state/input"
      printf '%s\n' "$body" >> "$state/send-log"
      exit 0
    fi
    if [ "${1:-}" = "C-u" ]; then rm -f "$state/input"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then
      printf 'Enter\n' >> "$state/enter-log"; rm -f "$state/input"; exit 0
    fi
    ;;
  run-shell)
    # No path arms a tmux-hosted helper any more; record one if it ever returns.
    printf '%s\n' "$*" >> "$state/run-shell-log"
    exit 0
    ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FAKE_PS_ROOT:-}" ]; then printf ' 4242     1 %s\n' "$FAKE_PS_ROOT"; exit 0; fi
exec /bin/ps "$@"
EOF
chmod +x "$FAKE_BIN/ps"
# tap-n27ug: intercept ONLY the detached self-compact worker; every other bun
# call execs the real bun captured before FAKE_BIN shadows it.
REAL_BUN="$(command -v bun)"
cat > "$FAKE_BIN/bun" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    *self-compact.ts*)
      [ -n "\${BUN_SHIM_LOG:-}" ] && printf '%s\n' "\$*" >> "\$BUN_SHIM_LOG"
      find "\$TAP_HOME/handoff" -maxdepth 1 -name '*.md' | wc -l >> "\$FAKE_TMUX_STATE/handoff-witness"
      exit 0 ;;
  esac
done
exec "$REAL_BUN" "\$@"
EOF
chmod +x "$FAKE_BIN/bun"
export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$WORK/fake-tmux"
mkdir -p "$FAKE_TMUX_STATE"
export BUN_SHIM_LOG="$WORK/bun-shim.log"

FOCUS='preserve the tap-joqz wake build in skills/self/ and runtime/bun/src/, including the handoff artifact and the queued resume ping'

fail() { echo "FAIL $1" >&2; exit 1; }
ok()   { echo "  $1 ok"; }
expect_rc() { [ "$3" -eq "$2" ] || fail "$1: expected exit $2, got $3"; ok "$1"; }
reset() { rm -f "${FAKE_TMUX_STATE:?}"/send-log "${FAKE_TMUX_STATE:?}"/enter-log \
                 "${FAKE_TMUX_STATE:?}"/run-shell-log "${FAKE_TMUX_STATE:?}"/input \
                 "${FAKE_TMUX_STATE:?}"/handoff-witness "${BUN_SHIM_LOG:?}"; rm -rf "${TAP_HOME:?}/handoff"; }
# The armed worker request, one field (JSON-encoded for objects, raw for strings).
armed() { # <field>
  local request
  request="$(find "$TAP_HOME/handoff" -maxdepth 1 -name 'subject-*.compact.json' 2>/dev/null | head -1)"
  [ -n "$request" ] || return 1
  python3 -B -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2], ""); print(v if isinstance(v, str) else json.dumps(v))' "$request" "$1"
}
# The spawn is detached, so its shim line can land after tap self returns.
worker_spawned() {
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    grep -qF 'self-compact.ts' "$BUN_SHIM_LOG" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

HANDOFF="$WORK/handoff.md"
cat > "$HANDOFF" <<'HEOF'
In flight: tap-joqz wake. PR not yet opened.
Next step: CONTRACT.md, then open the PR against origin/main.
HEOF

# --- (w) ordering + verification, Claude self path ---------------------------
echo "=== (w) ordering + verification ==="

reset
# stderr stays visible: the submit guard explains its own refusal, and
# discarding it turned a documented submit-unverified into a bare `got 5`.
rc=0; FAKE_TMUX_CMD=claude tself compact --pane fake-pane --handoff "$HANDOFF" "$FOCUS" || rc=$?
expect_rc "w1: compact with handoff succeeds" 0 "$rc"
python3 -B - "$(find "$TAP_HOME/handoff" -name '*.compact.json' | head -1)" <<'PROOF'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["session"] == "claude-session" and r["transcript"], r
assert r["queuedAt"] > 0 and "boundary" not in r, r
PROOF

# All Claude pane effects now belong to the detached worker. This fixture
# intercepts that worker, so the caller must emit neither prefix nor payload.
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "w2: caller typed before the worker"
[ ! -s "$FAKE_TMUX_STATE/enter-log" ] || fail "w3: caller pressed Enter before the worker"
[ "$(armed focus)" = "$FOCUS" ] || fail "w3b: queued focus was lost"
ok "w2-w3: focused control queued without caller pane effects"

PING="$(armed resumePing)" || fail "w4: no resume worker request on the bus"
case "$PING" in
  *"Post-compaction resume check."*) ok "w4: the armed worker carries the resume ping" ;;
  *) fail "w4: no resume ping in the armed worker: $PING" ;;
esac
[ "$(armed mode)" = claude ] || fail "w4b: armed worker is not in claude mode: $(armed mode)"
worker_spawned || fail "w4b: the worker was never spawned"
ok "w4b: the claude-mode Bun resume worker was spawned"
[ ! -e "$FAKE_TMUX_STATE/run-shell-log" ] || fail "w4c: a tmux run-shell helper was armed"
ok "w4c: no tmux run-shell helper armed"

# w5 is THE discriminating assertion. Ordering is the entire mechanism, and the
# property that matters is "processed after the compaction starts", which
# mid-turn injection broke while preserving send order (tap-ieiy). So NOTHING
# resembling the ping may appear in this process's own pane sends.
if [ -s "$FAKE_TMUX_STATE/send-log" ] && grep -q "Post-compaction" "$FAKE_TMUX_STATE/send-log"; then
  fail "w5: tap self submitted the ping into the pane itself — mid-turn that lands AHEAD of the compaction (tap-ieiy)"
fi
ok "w5: tap self never submits the ping itself; the worker sends it behind an observed compaction"


# --- (h) the handoff artifact ------------------------------------------------
echo "=== (h) handoff artifact ==="

# Written BEFORE any pane input. Asserted from the witness log rather than from
# the file merely existing at the end: "exists afterwards" is also true of a
# handoff written too late to survive the turn.
worker_spawned || fail "h1: worker not spawned"
FIRST_WITNESS="$(sed -n '1p' "$FAKE_TMUX_STATE/handoff-witness")"
[ "${FIRST_WITNESS:-0}" -ge 1 ] || fail "h1: handoff absent when the worker spawned"
ok "h1: handoff existed BEFORE worker-owned input could begin"

WROTE="$(find "$TAP_HOME/handoff" -maxdepth 1 -name 'subject-*.md' | head -1)"
[ -n "$WROTE" ] || fail "h2: no handoff file on the bus"
grep -q "PR not yet opened" "$WROTE" || fail "h2: handoff body not preserved"
ok "h2: agent-authored body preserved on the bus"

case "$PING" in
  *"$WROTE"*) ok "h3: ping names the exact path that was written" ;;
  *) fail "h3: ping does not name the written handoff path" ;;
esac
real() { python3 -B -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
[ "$(real "$(armed handoff)")" = "$(real "$WROTE")" ] || fail "h3: worker request handoff is not the written path: $(armed handoff)"
case "$PING" in
  *"tap poll subject"*) ok "h3b: registered seat's ping names its own handle to poll" ;;
  *) fail "h3b: ping does not tell the seat to poll its handle: $PING" ;;
esac

# EVERY COMMAND THE PING NAMES MUST BE RUNNABLE BY ITS READER. The ping is
# remediation text handed to a freshly-compacted agent with little else to go on,
# so a command that errors burns the one instruction it was given. `bd ready`
# fails with "no beads database found" from any pane whose cwd has no .beads.
mkdir -p "$WORK/nobeads"
reset
rc=0; FAKE_TMUX_CMD=claude FAKE_PANE_PATH="$WORK/nobeads" BEADS_DIR= tself compact \
  --pane fake-pane --handoff "$HANDOFF" "$FOCUS" 2>/dev/null || rc=$?
expect_rc "h3c: compact from a non-beads pane succeeds" 0 "$rc"
case "$(armed resumePing)" in
  *"bd ready"*) fail "h3c: ping names 'bd ready' from a pane where no beads database resolves" ;;
  *) ok "h3c: no-beads pane gets no bd-ready instruction" ;;
esac

mkdir -p "$WORK/withbeads/.beads"
reset
rc=0; FAKE_TMUX_CMD=claude FAKE_PANE_PATH="$WORK/withbeads" BEADS_DIR= tself compact \
  --pane fake-pane --handoff "$HANDOFF" "$FOCUS" 2>/dev/null || rc=$?
expect_rc "h3d: compact from a beads pane succeeds" 0 "$rc"
# Product emits 'bd ready' only when command -v bd AND beadsReachable (compact-focus.ts).
# GHA has .beads and no bd; gate the ping-content arm, not the file.
if command -v bd >/dev/null 2>&1; then
  case "$(armed resumePing)" in
    *"bd ready"*) ok "h3d: beads-backed pane DOES get the bd-ready instruction" ;;
    *) fail "h3d: ping dropped 'bd ready' where a beads database does resolve" ;;
  esac
else
  echo "SMOKE-SKIP: command-v-bd — h3d bd-ready ping-content; covering tap-mzhs9"
fi

# Ruling: ALWAYS arm, never conditionally — the agent decides whether work
# remains, not the arming logic. So a compact with no handoff still gets a ping.
reset
rc=0; FAKE_TMUX_CMD=claude tself compact --pane fake-pane "$FOCUS" 2>/dev/null || rc=$?
expect_rc "h4: compact without --handoff still succeeds" 0 "$rc"
armed resumePing >/dev/null || fail "h5: always-arm violated — no resume worker was armed without a handoff"
ok "h5: wake is armed even with no handoff (always-arm)"
case "$(armed resumePing)" in
  *"treat your summary as lossy"*) ;;
  *) fail "h6: no-handoff ping does not say the summary is lossy" ;;
esac
ok "h6: no-handoff ping states the summary is lossy rather than implying completeness"

# An EMPTY handoff is worse than none: it survives the compaction and reads as a
# positive statement that nothing was in flight. A false negative wearing an
# authoritative face.
reset
: > "$WORK/empty.md"
rc=0; FAKE_TMUX_CMD=claude tself compact --pane fake-pane --handoff "$WORK/empty.md" "$FOCUS" 2>/dev/null || rc=$?
expect_rc "h7: empty handoff refused" 1 "$rc"
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "h8: refused compact still injected into the pane"
ok "h8: refusal happened before any pane input"

reset
rc=0; FAKE_TMUX_CMD=claude tself compact --pane fake-pane --handoff "$WORK/does-not-exist.md" "$FOCUS" 2>/dev/null || rc=$?
expect_rc "h9: missing handoff file refused" 1 "$rc"

reset
rc=0; FAKE_TMUX_CMD=claude tself goal --pane fake-pane \
  --handoff "$HANDOFF" "Ship the wake. Prove it with the smoke output. Stop on a named blocker." 2>/dev/null || rc=$?
expect_rc "h10: --handoff rejected on the goal verb" 1 "$rc"

# --- (w7) ambient TAP_SV_TYPED_PREFIX must not leak (tap-lmbs) ----------------
# Reviewer-caught P1 in the shell era: an invocation-scoped prefix on the submit
# call let an ambient exported TAP_SV_TYPED_PREFIX survive past it and ride the
# next bare submit as an extra typed send. `tap self` passes its own prefix to
# each forwarded submit; an ambient value must still never reach any send.
echo "=== (w7) ambient TAP_SV_TYPED_PREFIX regression ==="
reset
rc=0
TAP_SV_TYPED_PREFIX='/ambient ' FAKE_TMUX_CMD=claude tself compact --pane fake-pane \
  --handoff "$HANDOFF" "$FOCUS" 2>/dev/null || rc=$?
expect_rc "w7-1: compact succeeds with an ambient TAP_SV_TYPED_PREFIX set" 0 "$rc"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "w7-2: caller emitted an ambient prefix"
[ "$(armed focus)" = "$FOCUS" ] || fail "w7-3: ambient prefix changed queued focus"
ok "w7-2/w7-3: caller emits no prefix and queues the exact focus"

# --- (f) a failed wake is LOUD ------------------------------------------------
echo "=== (f) failed wake is loud ==="

# An incomplete identity refuses the worker arm before any pane input.
reset
seat '{"instance":""}'
rc=0; FAKE_TMUX_CMD=claude tself compact --pane fake-pane --handoff "$HANDOFF" "$FOCUS" \
  2>"$WORK/arm-err.txt" || rc=$?
seat '{"instance":"subject|1"}'
expect_rc "f3: invalid worker identity refuses before input" 1 "$rc"
grep -q "identity is incomplete" "$WORK/arm-err.txt" \
  || fail "f4: arming failure was not announced on stderr: $(cat "$WORK/arm-err.txt")"
ok "f4: a failed arm is loud, not a clean receipt over a seat with no wake"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "f5: failed arm still typed a compact"
ok "f5: failed arm leaves the pane untouched"
armed mode >/dev/null && fail "f6: a worker request was written although the arm failed"
ok "f6: no worker request left behind by the failed arm"

# --- (c) Codex self path arms the proof-carrying worker -----------------------
echo "=== (c) codex chain ==="

# On Codex, tap self neither stages nor submits (tap-n27ug): the handoff is
# written first, then the detached Bun worker owns Escape, the one locked
# /compact submit, rollout proof and the resume. rc 0 means ARMED, not
# completed; the worker's receipt is the completion record.
ROLLOUT="$WORK/rollout.jsonl"
printf '%s\n' '{"type":"session_meta","payload":{"id":"codex-session-1"}}' \
  '{"type":"turn_context","payload":{"turn_id":"turn-1"}}' > "$ROLLOUT"
seat "{\"harness\":\"codex\",\"harness_session_id\":\"codex-session-1\",\"transcript_path\":\"$ROLLOUT\"}"
reset
rc=0; FAKE_TMUX_CMD=codex tself compact --pane fake-pane --handoff "$HANDOFF" "$FOCUS" 2>/dev/null || rc=$?
expect_rc "c1: codex compact arms the Bun worker" 0 "$rc"
worker_spawned || fail "c2: codex compact did not spawn the self-compact worker"
[ "$(armed turnId)" = turn-1 ] || fail "c2: worker request does not carry the proven turn: $(armed turnId)"
ok "c2: worker armed with the proven Codex turn"
case "$(real "$(armed handoff)")" in
  "$(real "$TAP_HOME/handoff")/subject-"*.md) ok "c2b: worker request carries the bus handoff path" ;;
  *) fail "c2b: worker request does not carry the bus handoff: $(armed handoff)" ;;
esac
case "$(armed resumePing)" in
  *"$FOCUS"*) ok "c2c: the focus rides the resume ping (bare /compact carries none)" ;;
  *) fail "c2c: codex resume ping lost the focus" ;;
esac
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "c3: codex path injected into the pane before the worker owns effects"
ok "c3: tap self sent nothing into a codex pane"

# --- (c-oc) OpenCode arms the same worker -------------------------------------
# No staging: the worker waits for two idle reads and submits bare /compact itself,
# so tap self sends nothing into the pane.
python3 -B - "$WORK/opencode.db" "$TAP_REGISTRY" <<'PYOC'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('oc-session'); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX part_message_id_id_idx ON part (message_id, id);")
db.close()
doc = json.load(open(sys.argv[2]))
doc["seats"]["subject"].update(harness="opencode", harness_session_id="oc-session", transcript_path=sys.argv[1])
json.dump(doc, open(sys.argv[2], "w"))
PYOC
reset
rc=0; FAKE_TMUX_CMD=opencode tself compact --pane fake-pane --handoff "$HANDOFF" "$FOCUS" 2>/dev/null || rc=$?
expect_rc "c-oc1: opencode compact arms the worker" 0 "$rc"
[ "$(armed mode)" = opencode ] || fail "c-oc2: worker is not in opencode mode: $(armed mode)"
case "$(armed resumePing)" in
  *"Post-compaction resume check."*"$FOCUS"*|*"$FOCUS"*"Post-compaction resume check."*) ;;
  *) fail "c-oc2: opencode arm is missing the resume ping or its focus" ;;
esac
worker_spawned || fail "c-oc2: opencode compact did not spawn the worker"
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "c-oc3: tap self staged input in an opencode pane"
ok "c-oc2: opencode arms the worker and stages nothing"

echo
echo "compact-wake: ok"
