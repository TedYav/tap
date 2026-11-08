#!/usr/bin/env bash
# self.test.sh — outside-in smokes for `tap self` (runtime/bun/src/verbs/self.ts)
#
# Coverage:
#   (a) Refusals before any pane effect: slash injection, the shared compact
#       narrowing owner, multiline, unknown verb, harness mismatch, missing
#       TMUX_PANE, unregistered pane, and the per-harness DEGRADED matrix.
#   (c) Submit-verify integration via shared tap_submit_verify (mock tmux),
#       including the exact constructed command per verb (send-log assertion),
#       owner-witness refusals, the resume-worker arm, and the Codex handoff gate.
# The text gates themselves are unit-tested in runtime/bun/test/self-gate.test.ts.
#
# SAFETY: All pane injection uses a MOCK tmux binary isolated to a temp dir.
# This test NEVER targets a live agent pane.
#
# bash 3.2 portable, python3 -B for any escape handling.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1
# tap-goe3f: the fixture's registry binds `srv:fixture`, which no numeric
# pid:start_time probe can produce; pin the generation so the observed epoch
# equals the bound one on both sides of the shell/Bun boundary.
export TAP_SERVER_EPOCH='srv:fixture'

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
PASTE_FIXTURES="$ROOT/skills/tap/scripts/smoke/fixtures/submit-verify"
TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME FAKE_TMUX_FIXTURES="$PASTE_FIXTURES"

# --- fake tmux (same pattern as tap's submit-verify.test.sh, plus a send log) --
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${FAKE_TMUX_UNAVAILABLE:-}" = "1" ] && exit 1
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="$1"
shift

capture_fixture() {
  local fixture="$1" escaped="$2"
  if [ "$escaped" = 1 ]; then
    cat "$fixture"
  else
    python3 -B - "$fixture" <<'PY'
import re, sys
print(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", open(sys.argv[1]).read()), end="")
PY
  fi
}

replace_owner_once() {
  local marker="${1:-}"
  [ -n "$marker" ] || return 0
  [ ! -e "$marker" ] || return 0
  : > "$marker"
  python3 -B - "${FAKE_OWNER_REGISTRY:?}" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
rows = doc.get("seats") or doc.get("agents")
rows["subject"]["instance"] = "subject|successor"
with open(path, "w") as output:
    json.dump(doc, output)
PY
}

rebind_owner_once() {
  local marker="${1:-}"
  [ -n "$marker" ] || return 0
  [ ! -e "$marker" ] || return 0
  : > "$marker"
  python3 -B - "${FAKE_OWNER_REGISTRY:?}" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
rows = doc.get("seats") or doc.get("agents")
rows["subject"]["pane"] = "replacement-pane"
rows["subject"]["pane_id"] = "%replacement"
with open(path, "w") as output:
    json.dump(doc, output)
PY
}

case "$cmd" in
  display-message)
    # A pane that no longer exists: answer with tmux's recognized absence
    # error. Since d1767d995 an exit-0 empty record reads as unverifiable, not
    # gone (unit3-tmux.test.ts made the same change). tmux 3.8 itself
    # answers exit 0 empty; tap-xaeik tracks how that case should classify.
    [ "${FAKE_TMUX_GONE:-}" = 1 ] && { echo "can't find pane: fake-pane" >&2; exit 1; }
    for arg in "$@"; do
      case "$arg" in
        # tap-goe3f: answer the identity gate's composite pane observation and the server
        # generation probe before the bare pane_id pattern swallows them.
        *pane_id*session_name*pane_current_command*)
          printf '%%4242\tfixture/subject\t4242\t%s\t0\n' "${FAKE_TMUX_CMD:-claude}"; exit 0 ;;
        *pane_id*session_name*)
          printf '%%4242\tfixture/subject\t4242:100\n'; exit 0 ;;
        *start_time*)
          echo "4242:100"; exit 0 ;;
        *pane_id*) echo "%4242"; exit 0 ;;
        *pane_pid*) echo "4242"; exit 0 ;;
        *pane_current_command*)
          echo "${FAKE_TMUX_CMD:-claude}"; exit 0 ;;
        *pane_in_mode*) echo "0"; exit 0 ;;
      esac
    done
    echo ""
    ;;
  capture-pane)
    # Model the owner replacement after /self's wrapper check but before the
    # submit primitive's first injection. The primitive must leave no stale
    # slash-command or payload text in the successor's composer.
    replace_owner_once "${FAKE_OWNER_REPLACE_ON_CAPTURE_FILE:-}"
    rebind_owner_once "${FAKE_OWNER_REBIND_ON_CAPTURE_FILE:-}"
    prompt="${FAKE_TMUX_PROMPT:-›}"
    escaped=0
    for arg in "$@"; do [ "$arg" = "-e" ] && escaped=1; done
    # tap-lmbs: real paste-collapse only ever happens on a LARGE burst — the
    # whole premise of this bug. The typed prefix (e.g. "/compact ") is a
    # handful of characters and would never collapse on its own; gate the
    # fixture on size so an unconditional collapse-on-any-input mock doesn't
    # make the short prefix stage look dropped when it landed correctly.
    if [ -f "$state/input" ] && [ -n "${FAKE_TMUX_PASTE_COLLAPSE:-}" ] \
      && [ "$(wc -c < "$state/input" | tr -d ' ')" -gt 100 ]; then
      fixture="$FAKE_TMUX_FIXTURES/${FAKE_TMUX_PASTE_COLLAPSE}-paste-collapse.ansi"
      [ -f "$fixture" ] || exit 2
      capture_fixture "$fixture" "$escaped"
      exit 0
    fi
    if [ "${FAKE_TMUX_CMD:-claude}" = "opencode" ]; then
      # opencode's TUI input box (same fixture as tap's submit-verify smoke)
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
      exit 0
    fi
    # Claude's REAL input box: prompt row, then continuation rows, bounded by the
    # bottom border with the shortcuts footer under it. The chrome is not
    # decoration here — readers that bound the box on that border return nothing
    # without it, so a prompt-line-only mock silently exercises a different code
    # path than production. That gap is exactly how a region guard which refused
    # every real render shipped green (tap-tx3s); render the chrome so this mock
    # and the pane agree on shape.
    if [ -f "$state/input" ]; then
      printf '%s %s\n' "$prompt" "$(sed -n '1p' "$state/input")"
      sed -n '2,$p' "$state/input"
    else
      printf '%s \n' "$prompt"
    fi
    # Claude only: codex's band has no bordered box, and painting one here would
    # feed its reader rows it treats as draft text. Mock geometry is per harness
    # for the same reason the readers are.
    # Everything reaching here that is not codex renders Claude's box — including
    # the version-string pane command (d7), whose harness TAP resolves to claude
    # via the process root, so its GEOMETRY must be claude's too. Keying on the
    # raw FAKE_TMUX_CMD string instead would have left that case chrome-free and
    # exercising a shape no pane produces.
    if [ "${FAKE_TMUX_CMD:-claude}" != "codex" ]; then
      printf '%s\n' '──────────────────────────────────────────'
      printf '%s\n' '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    fi
    ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift                          # drop -l
      if [ "${FAKE_TMUX_CMD:-claude}" = "opencode" ] && [ "${1:-}" = "--" ]; then
        # Model the live OpenCode input-mode bug: the option-terminated form
        # does not land; the courier must use bare literal keystrokes.
        exit 0
      fi
      [ "${1:-}" = "--" ] && shift   # option terminator
      if [ -n "${FAKE_OWNER_REPLACE_ON_INJECT_FILE:-}" ] \
          && [ ! -e "$FAKE_OWNER_REPLACE_ON_INJECT_FILE" ]; then
        replace_owner_once "$FAKE_OWNER_REPLACE_ON_INJECT_FILE"
      fi
      # The payload extends the typed command prefix, as literal keys do.
      printf '%s' "${1:-}" >> "$state/input"
      printf '%s\n' "${1:-}" >> "$state/send-log"
      [ -n "${FAKE_TMUX_EVENT_LOG:-}" ] && printf 'INJECT %s\n' "${1:-}" >> "$FAKE_TMUX_EVENT_LOG"
      exit 0
    fi
    if [ "${1:-}" = "C-u" ]; then
      rm -f "$state/input"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then
      printf 'Enter\n' >> "$state/enter-log"
      [ -n "${FAKE_TMUX_EVENT_LOG:-}" ] && printf 'ENTER\n' >> "$FAKE_TMUX_EVENT_LOG"
      rm -f "$state/input"
      exit 0
    fi
    ;;
  run-shell)
    [ "${1:-}" = "-b" ] && shift
    [ "${1:-}" = "-t" ] || exit 92
    shift
    [ -n "${1:-}" ] || exit 93
    shift
    [[ "${1:-}" == *" >/dev/null 2>&1 || true" ]] || exit 94
    printf '%s\n' "${1:-}" >> "$state/run-shell-log"
    if [ "${FAKE_TMUX_RUN_SHELL_FAIL:-}" = "1" ]; then exit 1; fi
    exit 0
    ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FAKE_PS_ROOT:-}" ]; then
  printf ' 4242 4242 4242 %s\n' "$FAKE_PS_ROOT"
  exit 0
fi
exec /bin/ps "$@"
EOF
chmod +x "$FAKE_BIN/ps"
# Intercept the two self worker spawns so the smoke can
# observe its request without running a real pane effect. Everything
# else (lib.sh tap_bun_call/tap_bun_exec) execs the real bun captured here,
# before FAKE_BIN shadows it.
REAL_BUN="$(command -v bun)"
cat > "$FAKE_BIN/bun" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    *self-compact.ts*|*self-rebrief.ts*)
      [ -n "\${BUN_SHIM_LOG:-}" ] && printf '%s\n' "\$*" >> "\$BUN_SHIM_LOG"
      exit 0 ;;
  esac
done
exec "$REAL_BUN" "\$@"
EOF
chmod +x "$FAKE_BIN/bun"
export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
mkdir -p "$FAKE_TMUX_STATE"

SAFE_GOAL='The /self skill for runtime/bun/src/verbs/self.ts is complete: smoke test green (exit 0), install.sh links the skill, and the PR is open. Prove it with smoke output and the PR URL. Stop on a named blocker or after 30 turns.'
DEFAULT_HANDOFF="$TAP_HOME/default-handoff.md"
printf 'Next step: preserve the current test work\n' > "$DEFAULT_HANDOFF"
SAFE_COMPACT='preserve the /self skill build in skills/self/: verb gates, smoke-test port, the CONTRACT.md pointer fix, and the open codex-glyph question'
SAFE_LOOP='check whether PR 42 in Example-Org/tap has new review comments and address them on branch SelfSkill'

fail() { echo "FAIL $1" >&2; exit 1; }

expect_rc() { # <label> <expected-rc> <actual-rc>
  [ "$3" -eq "$2" ] || fail "$1: expected exit $2, got $3"
  echo "  $1 ok"
}

# Every case runs `tap self` as the registered seat `subject` bound to the mock
# pane. The text allowlist itself is unit-tested in runtime/bun/test/self-gate.test.ts;
# this smoke keeps the edges only a real invocation has: the shared lib narrowing
# owner, seat resolution, the forwarded submit, and the worker arm.
OWNER_ROOT="$TAP_HOME/owner-root"
OWNER_BUS="$OWNER_ROOT/.tap/bus"
OWNER_REG="$OWNER_ROOT/.tap/team-registry.json"
OWNER_MARKER="$TAP_HOME/owner-replaced"
mkdir -p "$OWNER_BUS" "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$OWNER_ROOT" "$OWNER_REG" <<'PY'
import json, os, sys
global_path, root, registry = sys.argv[1:]
os.makedirs(os.path.dirname(global_path), exist_ok=True)
json.dump({"schema":"0.20","teams":{"fixture":{"root":root,"registry_location":registry}}}, open(global_path,"w"))
open(root+"/claude.jsonl", "w").write(json.dumps({"type":"user","sessionId":"claude-session"})+"\n")
json.dump({"schema":"0.20","team":{"name":"fixture","worktree_root":root},"seats":{"subject":{"status":"active","instance":"subject|old","pane":"fake-pane","pane_id":"%4242","session":"fixture/subject","server_epoch":"srv:fixture","server_socket":"/fixture/tmux.sock","harness":"claude","harness_session_id":"claude-session","transcript_path":root+"/claude.jsonl"}}}, open(registry,"w"))
PY
seat_reset() { # <harness>: restore the bound row between cases
  python3 -B - "$OWNER_REG" "$1" <<'PY'
import json, sys
path, harness = sys.argv[1:]
doc = json.load(open(path))
doc["seats"]["subject"].update({"instance":"subject|old","pane":"fake-pane","pane_id":"%4242","harness":harness})
json.dump(doc, open(path,"w"))
PY
}
tself() { (cd "$OWNER_ROOT" && TAP_HOME="$OWNER_BUS" TAP_REGISTRY="$OWNER_REG" "$TAP" self "$@"); }
clean_pane() { rm -f "${FAKE_TMUX_STATE:?}/input" "${FAKE_TMUX_STATE:?}/send-log" "${FAKE_TMUX_STATE:?}/enter-log" "${FAKE_TMUX_STATE:?}/run-shell-log"; }

# --- (a) refusals before any pane effect -------------------------------------------
echo "=== (a) refusals ==="

clean_pane
rc=0; tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "/dr --full" 2>/dev/null || rc=$?
expect_rc "a1: slash injection rejected" 1 "$rc"

rc=0; tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "focus only on the API refactor" 2>/dev/null || rc=$?
expect_rc "a2: exclusive compact focus rejected by the shared lib owner" 1 "$rc"

rc=0; tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "preserve the refactor and ignore the test failures" 2>/dev/null || rc=$?
expect_rc "a3: destructive compact directive rejected" 1 "$rc"

rc=0; tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane $'preserve docs/plans/x.md work\n/loop cancel' 2>/dev/null || rc=$?
expect_rc "a4: multiline text rejected" 1 "$rc"

rc=0; tself nuke --pane fake-pane "anything" 2>/dev/null || rc=$?
expect_rc "a5: unknown verb rejected" 1 "$rc"

err="$TAP_HOME/harness-mismatch.err"
rc=0; tself goal --pane fake-pane --harness codex "$SAFE_GOAL" 2>"$err" || rc=$?
expect_rc "a6: --harness contradicting the registered seat rejected" 1 "$rc"
grep -qF "registered harness 'claude'" "$err" || fail "a6: refusal does not name the registered harness"

# A harness Bash subprocess has no TMUX_PANE. It must refuse rather than let
# tmux resolve the human's currently focused pane as the /self target.
err="$TAP_HOME/missing-own-pane.err"
rc=0; TMUX_PANE="" tself compact --handoff "$DEFAULT_HANDOFF" "$SAFE_COMPACT" 2>"$err" || rc=$?
expect_rc "a7: missing TMUX_PANE refuses default pane resolution" 1 "$rc"
grep -qF 'TMUX_PANE' "$err" || fail "a7: refusal did not name TMUX_PANE"
grep -qF 'inside tmux' "$err" || fail "a7: refusal did not name the inside-tmux recovery"
grep -qF -- '--pane' "$err" || fail "a7: refusal did not name the explicit-pane recovery"

# The worker needs a registered seat, so an unregistered pane is refused before
# the /compact rather than compacted with no resume.
python3 -B - "$OWNER_REG" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1])); doc["seats"]["subject"]["pane_id"] = "%9999"; json.dump(doc, open(sys.argv[1], "w"))
PY
rc=0; tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "$SAFE_COMPACT" 2>"$TAP_HOME/unregistered.err" || rc=$?
expect_rc "a8: unregistered pane refused" 1 "$rc"
seat_reset claude
rc=0; FAKE_TMUX_GONE=1 tself goal --pane fake-pane "$SAFE_GOAL" 2>/dev/null || rc=$?
expect_rc "a8b: a gone pane keeps exit 3" 3 "$rc"

# The live process picks the protocol: a row that lags a process replacement is refused.
rc=0; FAKE_TMUX_CMD=codex tself goal --pane fake-pane "$SAFE_GOAL" 2>"$TAP_HOME/live-harness.err" || rc=$?
expect_rc "a8c: live harness differing from the registered row refused" 1 "$rc"
grep -qF "runs 'codex'" "$TAP_HOME/live-harness.err" || fail "a8c: refusal does not name the live harness: $(cat "$TAP_HOME/live-harness.err")"

# A handoff must be a regular file: a FIFO would block the read before any effect.
mkfifo "$TAP_HOME/handoff.fifo"
rc=0; tself compact --pane fake-pane --handoff "$TAP_HOME/handoff.fifo" -- "$SAFE_COMPACT" 2>"$TAP_HOME/fifo.err" || rc=$?
expect_rc "a8d: non-regular handoff refused without blocking" 1 "$rc"
grep -qF 'regular file' "$TAP_HOME/fifo.err" || fail "a8d: refusal does not say regular file"
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "a1-a8b: a refusal injected into the pane: $(cat "$FAKE_TMUX_STATE/send-log")"

for pair in "loop codex" "goal opencode" "compact cursor-agent"; do
  set -- $pair
  seat_reset "$2"
  case "$1" in goal) text="$SAFE_GOAL" ;; compact) text="$SAFE_COMPACT" ;; *) text="$SAFE_LOOP" ;; esac
  extra=(); [ "$1" != compact ] || extra=(--handoff "$DEFAULT_HANDOFF")
  rc=0; tself "$1" ${extra[@]+"${extra[@]}"} --pane fake-pane "$text" 2>"$TAP_HOME/degraded.err" || rc=$?
  expect_rc "a9: $1 on $2 degrades" 6 "$rc"
  grep -qF 'DEGRADED' "$TAP_HOME/degraded.err" || fail "a9: $1 on $2 did not say DEGRADED"
done
seat_reset claude
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "a9: a degraded verb injected into the pane"

# Every self reset validates an explicit audience before copying or arming.
python3 -B - "$OWNER_REG" <<'PYREG'
import json, sys
p=sys.argv[1]; r=json.load(open(p)); r["seats"]["inactive"]={**r["seats"]["subject"],"status":"gone"}; json.dump(r,open(p,"w"))
PYREG
for verb in compact rebrief clear; do
  for recipient in absent subject inactive; do
    args=("$verb" --pane fake-pane --handoff "$DEFAULT_HANDOFF" --notify "$recipient")
    [ "$verb" != compact ] || args+=(-- "$SAFE_COMPACT")
    rc=0; tself "${args[@]}" 2>"$TAP_HOME/notify.err" || rc=$?
    expect_rc "notify: $verb rejects $recipient" 1 "$rc"
    grep -qF 'different active teammate' "$TAP_HOME/notify.err" || fail "notify: wrong refusal"
  done
done
[ ! -d "$OWNER_BUS/handoff" ] || fail "notify refusal copied or armed a reset"
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "notify refusal injected input"

# An operator-only reset arms with no outcome audience and preserves its verb.
for verb in rebrief clear; do
  rc=0; tself "$verb" --pane fake-pane --handoff "$DEFAULT_HANDOFF" 2>"$TAP_HOME/$verb-arm.err" || rc=$?
  expect_rc "operator-only: $verb arms with no notify" 8 "$rc"
  grep -qF "$verb recovery ARMED" "$TAP_HOME/$verb-arm.err" || fail "operator-only: invoked verb lost"
done
grep -qF 'clear is deprecated' "$TAP_HOME/clear-arm.err" || fail "clear alias lacks migration line"
python3 -B - "$OWNER_BUS/handoff" <<'REQUESTS'
import json, pathlib, sys
requests=[json.loads(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob('*.json') if not p.name.endswith('.receipt.json')]
assert {r['verb'] for r in requests} == {'clear', 'rebrief'}, requests
assert all('notify' not in r and pathlib.Path(r['handoff']).read_text().strip() for r in requests), requests
REQUESTS
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "caller reset input before detached worker"

# --- (c) submit-verify integration ------------------------------------------------
echo "=== (c) submit-verify integration ==="

# Claude compact now only arms the worker; even trailing-space focus is
# normalized in the actual producer before it reaches the durable request.
clean_pane
: > "$TAP_HOME/bun-shim.log"
rc=0; BUN_SHIM_LOG="$TAP_HOME/bun-shim.log" tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "$SAFE_COMPACT   " 2>"$TAP_HOME/queued.err" || rc=$?
expect_rc "c1: Claude compact queues its worker" 0 "$rc"
grep -q 'compact QUEUED' "$TAP_HOME/queued.err" || fail "c1b: queued outcome not reported"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "c1c: caller typed before the worker"
[ ! -s "$FAKE_TMUX_STATE/enter-log" ] || fail "c1d: caller sent Enter before the worker"
python3 -B - "$OWNER_BUS/handoff" "$SAFE_COMPACT" <<'QUEUED' || fail "c1e: invalid queued request"
import json, pathlib, sys
path = max(pathlib.Path(sys.argv[1]).glob('*.compact.json'), key=lambda p: p.stat().st_mtime_ns)
r = json.loads(path.read_text())
assert r['mode'] == 'claude' and r['focus'] == sys.argv[2], r
assert isinstance(r['queuedAt'], int) and r['queuedAt'] > 0, r
assert 'boundary' not in r, r
receipt = json.loads(path.with_suffix('.receipt.json').read_text())
assert receipt['state'] == 'queued' and receipt['queuedAt'], receipt
QUEUED

# A human draft is never cleared or fused by the caller while it arms a wait.
clean_pane
printf 'human draft still being composed' > "$FAKE_TMUX_STATE/input"
rc=0; tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "$SAFE_COMPACT" 2>/dev/null || rc=$?
expect_rc "c1f: compact queues behind a human draft" 0 "$rc"
[ "$(cat "$FAKE_TMUX_STATE/input")" = 'human draft still being composed' ] || fail "c1f: caller changed the draft"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "c1f: caller typed into the draft"
[ ! -s "$FAKE_TMUX_STATE/enter-log" ] || fail "c1f: caller submitted the draft"

clean_pane
rc=0; tself loop --pane fake-pane --interval 5m "$SAFE_LOOP" 2>/dev/null || rc=$?
expect_rc "c2: loop submit verified" 0 "$rc"
[ "$(sed -n '1p' "$FAKE_TMUX_STATE/send-log")" = "/loop 5m " ] \
  || fail "c2b: send-log stage 1 is not the typed '/loop 5m ' prefix"
grep -q "^$SAFE_LOOP \[\[sv:self-" "$FAKE_TMUX_STATE/send-log" \
  || fail "c2c: send-log missing payload stage '<prompt> [[sv:...]]'"
echo "  c2b: typed '/loop 5m ' prefix stage + pasted payload stage correct ok"

clean_pane
rc=0; tself loop --pane fake-pane -- "$SAFE_LOOP" 2>/dev/null || rc=$?
expect_rc "c3: dynamic loop (no interval) submit verified" 0 "$rc"
[ "$(sed -n '1p' "$FAKE_TMUX_STATE/send-log")" = "/loop " ] \
  || fail "c3b: send-log stage 1 is not the typed intervalless '/loop ' prefix"
grep -q "^$SAFE_LOOP \[\[sv:self-" "$FAKE_TMUX_STATE/send-log" \
  || fail "c3c: send-log missing payload stage '<prompt> [[sv:...]]'"
echo "  c3b: typed intervalless '/loop ' prefix stage + pasted payload stage correct ok"

# goal verb: same two-stage contract as compact/loop. An ambient typed prefix
# must not leak into the submit: the verb sets its own for each call (tap-lmbs).
clean_pane
rc=0; TAP_SV_TYPED_PREFIX='/leak ' tself goal --pane fake-pane "$SAFE_GOAL" 2>/dev/null || rc=$?
expect_rc "c3d: goal submit verified" 0 "$rc"
[ "$(sed -n '1p' "$FAKE_TMUX_STATE/send-log")" = "/goal " ] \
  || fail "c3e: send-log stage 1 is not the typed '/goal ' prefix"
python3 - "$FAKE_TMUX_STATE/send-log" "$SAFE_GOAL" <<'GOAL' \
  || fail "c3f: goal chunks changed or duplicated the payload"
import pathlib, re, sys
payload = ''.join(pathlib.Path(sys.argv[1]).read_text().splitlines()[1:])
assert re.fullmatch(re.escape(sys.argv[2]) + r' \[\[sv:self-[^\]]+\]\]', payload)
GOAL
echo "  c3e: typed '/goal ' prefix stage + pasted payload stage correct ok"

# A background-tool wrapper check is not the effect boundary. Replace the
# selected owner during the first injection and prove the shared submit
# primitive refuses before Enter. The same witness is then required on the
# resume worker that outlives this process.
rm -f "${OWNER_MARKER:?}"; clean_pane
rc=0
(TAP_CALLER_SELECTED_HANDLE=subject TAP_CALLER_SELECTED_INSTANCE='subject|old' \
  FAKE_OWNER_REGISTRY="$OWNER_REG" FAKE_OWNER_REPLACE_ON_CAPTURE_FILE="$OWNER_MARKER" \
  tself goal --pane fake-pane "$SAFE_GOAL") \
  >/dev/null 2>"$TAP_HOME/owner-direct.err" || rc=$?
expect_rc "c3g: synchronous submit refuses a replacement owner before injection" 1 "$rc"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "c3g: successor received typed text: $(cat "$FAKE_TMUX_STATE/send-log")"
[ ! -s "$FAKE_TMUX_STATE/input" ] || fail "c3g: successor composer contains stale text: $(cat "$FAKE_TMUX_STATE/input")"
[ ! -s "$FAKE_TMUX_STATE/enter-log" ] || fail "c3g: successor received Enter: $(cat "$FAKE_TMUX_STATE/enter-log")"

seat_reset claude
rm -f "${OWNER_MARKER:?}"; clean_pane
rc=0
(TAP_CALLER_SELECTED_HANDLE=subject TAP_CALLER_SELECTED_INSTANCE='subject|old' \
  TAP_CALLER_SELECTED_PANE=fake-pane TAP_CALLER_SELECTED_PANE_ID='%4242' \
  TAP_CALLER_SELECTED_SESSION='fixture/subject' TAP_CALLER_SELECTED_EPOCH='srv:fixture' TAP_CALLER_SELECTED_SOCKET='/fixture/tmux.sock' \
  FAKE_OWNER_REGISTRY="$OWNER_REG" FAKE_OWNER_REBIND_ON_CAPTURE_FILE="$OWNER_MARKER" \
  tself goal --pane fake-pane "$SAFE_GOAL") \
  >/dev/null 2>"$TAP_HOME/owner-rebind.err" || rc=$?
expect_rc "c3h: synchronous submit refuses a same-instance pane rebind before injection" 1 "$rc"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "c3h: rebound successor received typed text: $(cat "$FAKE_TMUX_STATE/send-log")"
[ ! -s "$FAKE_TMUX_STATE/enter-log" ] || fail "c3h: rebound successor received Enter: $(cat "$FAKE_TMUX_STATE/enter-log")"

seat_reset claude
clean_pane
printf 'successor draft' > "$FAKE_TMUX_STATE/input"
rm -f "${OWNER_MARKER:?}"
rc=0
(TAP_CALLER_SELECTED_HANDLE=subject TAP_CALLER_SELECTED_INSTANCE='subject|old' \
  TAP_CALLER_SELECTED_PANE=fake-pane TAP_CALLER_SELECTED_PANE_ID='%4242' \
  TAP_CALLER_SELECTED_SESSION='fixture/subject' TAP_CALLER_SELECTED_EPOCH='srv:fixture' TAP_CALLER_SELECTED_SOCKET='/fixture/tmux.sock' \
  FAKE_OWNER_REGISTRY="$OWNER_REG" FAKE_OWNER_REPLACE_ON_CAPTURE_FILE="$OWNER_MARKER" \
  tself goal --pane fake-pane "$SAFE_GOAL") \
  >/dev/null 2>"$TAP_HOME/owner-draft.err" || rc=$?
# Shared draft protection now refuses before the later owner recheck. The
# changed refusal class must still preserve the successor's input completely.
expect_rc "c3i: draft protection preserves a replacement owner's draft" 4 "$rc"
[ -f "$OWNER_MARKER" ] || fail "c3i: owner replacement fixture did not run"
grep -q 'draft grace' "$TAP_HOME/owner-draft.err" || fail "c3i: refusal did not come from draft protection"
[ "$(cat "$FAKE_TMUX_STATE/input")" = 'successor draft' ] || fail "c3i: replacement owner's draft was changed"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "c3i: replacement owner received typed text"
[ ! -s "$FAKE_TMUX_STATE/enter-log" ] || fail "c3i: replacement owner received Enter"

seat_reset claude
clean_pane
C3J_SHIM="$TAP_HOME/bun-shim-c3j.log"
: > "$C3J_SHIM"
rc=0
(TAP_CALLER_SELECTED_HANDLE=subject TAP_CALLER_SELECTED_INSTANCE='subject|old' \
  TAP_CALLER_SELECTED_PANE=fake-pane TAP_CALLER_SELECTED_PANE_ID='%4242' \
  TAP_CALLER_SELECTED_SESSION='fixture/subject' TAP_CALLER_SELECTED_EPOCH='srv:fixture' TAP_CALLER_SELECTED_SOCKET='/fixture/tmux.sock' \
  BUN_SHIM_LOG="$C3J_SHIM" \
  tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "$SAFE_COMPACT") \
  >/dev/null 2>"$TAP_HOME/owner-inline.err" || rc=$?
expect_rc "c3j: compact with owner witness queues the worker" 0 "$rc"
# The worker binds the registered seat itself and rechecks it before the resume.
# The worker is spawned detached, so its shim line can land after tap self returns.
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do grep -qF 'self-compact.ts' "$C3J_SHIM" && break; sleep 0.25; done
grep -qF 'self-compact.ts' "$C3J_SHIM" || fail "c3j: compact did not spawn the resume worker: $(cat "$TAP_HOME/owner-inline.err")"
c3j_request="$(awk '{print $NF}' "$C3J_SHIM" | tail -1)"
[ -n "$c3j_request" ] || fail "c3j: no worker request on the bus"
python3 -B - "$c3j_request" <<'PY' || fail "c3j: worker request does not bind the seat or carry the ping"
import json, sys
r = json.load(open(sys.argv[1]))
assert r["mode"] == "claude" and r["handle"] == "subject", r
assert r["bound"]["paneId"] == "%4242" and r["bound"]["instance"] == "subject|old", r
assert "Post-compaction resume check." in r["resumePing"], r
assert r["queuedAt"] > 0 and "boundary" not in r, r
PY
[ ! -e "$FAKE_TMUX_STATE/run-shell-log" ] || fail "c3j: a legacy tmux run-shell helper was armed"
echo "  c3g-c3j: synchronous, clearing, rebound-pane, and worker effects carry the selected owner witness ok"

# The deferred worker arm (opencode here) rechecks the owner too, as self.sh did
# before exec: a successor in the same pane gets nothing armed.
seat_reset opencode
python3 -B - "$OWNER_REG" <<'PY2'
import json, sys
doc = json.load(open(sys.argv[1])); doc["seats"]["subject"]["instance"] = "subject|successor"; json.dump(doc, open(sys.argv[1], "w"))
PY2
clean_pane
rm -rf "${OWNER_BUS:?}/handoff"
rc=0
(TAP_CALLER_SELECTED_HANDLE=subject TAP_CALLER_SELECTED_INSTANCE='subject|old' \
  TAP_CALLER_SELECTED_PANE=fake-pane TAP_CALLER_SELECTED_PANE_ID='%4242' \
  TAP_CALLER_SELECTED_SESSION='fixture/subject' TAP_CALLER_SELECTED_EPOCH='srv:fixture' \
  FAKE_TMUX_CMD=opencode tself compact --handoff "$DEFAULT_HANDOFF" --pane fake-pane "$SAFE_COMPACT") >/dev/null 2>"$TAP_HOME/owner-deferred.err" || rc=$?
expect_rc "c3k: deferred compact arm refuses a replaced owner" 1 "$rc"
grep -qF 'owner changed' "$TAP_HOME/owner-deferred.err" || fail "c3k: refusal does not name the owner change: $(cat "$TAP_HOME/owner-deferred.err")"
[ -z "$(find "$OWNER_BUS/handoff" -maxdepth 1 -name '*.compact.json' 2>/dev/null)" ] || fail "c3k: a worker was armed for a replaced owner"
seat_reset claude

# Shared draft protection refuses self-control while human input is pending.
clean_pane
printf 'pending human text' > "$FAKE_TMUX_STATE/input"
rc=0; tself goal --pane fake-pane "$SAFE_GOAL" 2>/dev/null || rc=$?
expect_rc "c4: pending human input defers self-control" 4 "$rc"
[ "$(cat "$FAKE_TMUX_STATE/input")" = 'pending human text' ] || fail "c4b: pending input was changed"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "c4c: typed text reached the pending draft"
[ ! -s "$FAKE_TMUX_STATE/enter-log" ] || fail "c4d: Enter reached the pending draft"

# --- (c6/c7) Codex compaction is handoff-gated self work (tap-n27ug) -----------
seat_reset codex
clean_pane
err="$TAP_HOME/codex-no-handoff.err"
: > "$TAP_HOME/bun-shim.log"
rc=0; FAKE_TMUX_CMD="codex" BUN_SHIM_LOG="$TAP_HOME/bun-shim.log" \
  tself compact --pane fake-pane "$SAFE_COMPACT" 2>"$err" || rc=$?
expect_rc "c6: codex compact without a handoff refuses" 1 "$rc"
grep -qF "/tap:self compact" "$err" || fail "c6b: refusal does not name the supported command"
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "c6c: refusal still injected into the pane"
grep -qF 'self-compact.ts' "$TAP_HOME/bun-shim.log" && fail "c6d: refusal still reached the Bun worker"

# The handoff reaches the bus BEFORE the worker arm, so it survives whatever the
# arm decides. This fixture seat has no bound rollout, so the arm refuses after it.
CODEX_HANDOFF="$TAP_HOME/codex-handoff.md"
printf 'in-flight: verify the codex compact handoff gate\n' > "$CODEX_HANDOFF"
rc=0; FAKE_TMUX_CMD="codex" BUN_SHIM_LOG="$TAP_HOME/bun-shim.log" \
  tself compact --pane fake-pane --handoff "$CODEX_HANDOFF" -- "$SAFE_COMPACT" \
  2>"$TAP_HOME/codex-handoff.err" || rc=$?
expect_rc "c7: codex compact without a bound rollout refuses at the arm" 1 "$rc"
grep -qF 'identity is unverified' "$TAP_HOME/codex-handoff.err" || fail "c7b: arm refusal not reported: $(cat "$TAP_HOME/codex-handoff.err")"
copied="$(find "$OWNER_BUS/handoff" -maxdepth 1 -name 'subject-*.md' | head -1)"
[ -n "$copied" ] || fail "c7c: handoff was not copied to the bus before the arm"
grep -qF 'in-flight: verify the codex compact handoff gate' "$copied" || fail "c7d: handoff copy lost the body"
grep -qF '# Authored compact brief' "$copied" || fail "c7e: handoff copy lacks its header"
[ ! -e "$FAKE_TMUX_STATE/send-log" ] || fail "c7f: codex path injected into the pane before the worker owns effects"
seat_reset claude

echo "self: ok"

# Detached helper failures remain inspectable without output or a nonzero status
# reaching tmux. Include shell-shaped arguments to catch accidental evaluation.
helper_log="$TAP_HOME/helper logs/output.log"
helper_stdout="$TAP_HOME/helper.stdout"
helper_stderr="$TAP_HOME/helper.stderr"
bash "$ROOT/skills/tap/scripts/run-shell-logged.sh" "$helper_log" \
  bash -c 'printf "%s\n" "$1"; echo diagnostic >&2; exit 7' bash 'literal $(false)' \
  >"$helper_stdout" 2>"$helper_stderr"
[ ! -s "$helper_stdout" ] && [ ! -s "$helper_stderr" ] || fail 'detached helper leaked output'
grep -Fq 'literal $(false)' "$helper_log" || fail 'helper arguments changed'
grep -Fq diagnostic "$helper_log" || fail 'helper stderr lost'
grep -q 'rc=7$' "$helper_log" || fail 'real helper status lost'
