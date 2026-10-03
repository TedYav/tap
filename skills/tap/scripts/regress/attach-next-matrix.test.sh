#!/usr/bin/env bash
# attach-next-matrix.test.sh — exhaustive stable `tap attach --next` matrix.
#
# Parser exclusivity, strict->, in-tmux cursor edges, remaining sole-candidate
# exclusions, fail-closed registry, and docs needles. The poll-skip causal
# mutant died with the Bash body it mutated (R11 U-A); its semantic coverage
# lives in runtime/bun/test/team.test.ts (nextEligible drops delivery:poll).
# Load-bearing next/wrap/current-team/filter/delegation smoke:
#   skills/tap/scripts/smoke/attach-next.test.sh
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/attach-next-fixture.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/attach-next-fixture.sh"

# --- parser matrix ------------------------------------------------------------
# Both orders for target/--next and interactive/--next; --no-resume; duplicate.
parse_arm() {
  local name="$1"; shift
  : > "$FAKE_EVENTS"
  set +e
  env -u TMUX TAP_JSON=1 "$TAP" attach "$@" >"$WORK/out" 2>"$WORK/err"
  local prc=$?
  set -e
  [ "$prc" = 1 ] || fail "$name expected exit 1, got $prc" "$(cat "$WORK/out"; cat "$WORK/err")"
  local klass
  klass="$(error_class "$(cat "$WORK/out")")"
  [ "$klass" = usage_error ] || fail "$name expected usage_error, got $klass" "$(cat "$WORK/out"; cat "$WORK/err")"
  logged 'attach-session|switch-client' && fail "$name must not mutate tmux" "$(cat "$FAKE_EVENTS")"
  echo "attach-next: parser $name: ok"
}

parse_arm "target then --next" sol --next
parse_arm "--next then target" --next sol
parse_arm "-i then --next" -i --next
parse_arm "--next then -i" --next -i
parse_arm "--interactive then --next" --interactive --next
parse_arm "--next then --interactive" --next --interactive
parse_arm "--no-resume then --next" --no-resume --next
parse_arm "--next then --no-resume" --next --no-resume
parse_arm "duplicate --next" --next --next

# --- strict > : current=alpha unattached must pick charlie, not self ----------
cat > "$FAKE_SESSIONS" <<'EOF'
demo/alpha	1:1	0
demo/bravo	1:1	1
demo/charlie	1:1	0
EOF
write_panes
write_registry
export FAKE_PS_MODE=tty FAKE_CALLER_PANE="%11"
run_next_inside "%11"
[ "$rc" = 0 ] || fail "strict-greater from unattached alpha should hop to charlie" "$(cat "$WORK/out"; cat "$WORK/err")"
logged 'switch-client.*demo/charlie|attach-session.*demo/charlie' \
  || fail "current=alpha (eligible) must pick next=charlie, not self" "$(cat "$FAKE_EVENTS")"
logged 'switch-client.*demo/alpha|attach-session.*demo/alpha' \
  && fail ">= instead of > would hop to self (alpha); strict > must not" "$(cat "$FAKE_EVENTS")"
echo "attach-next: strict greater than current skips self: ok"

# --- unobservable in-tmux is not outside --------------------------------------
write_sessions
write_panes
write_registry
export FAKE_CALLER_PANE="none"
: > "$FAKE_EVENTS"
set +e
env TMUX="/tmp/tap-next.sock,1,0" FAKE_PS_MODE=unobservable TAP_JSON=1 \
  "$TAP" attach --next >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
[ "$rc" = 1 ] || fail "unobservable in-tmux must refuse, got $rc" "$(cat "$WORK/out"; cat "$WORK/err")"
[ "$(error_class "$(cat "$WORK/out")")" = caller_identity_unobservable ] \
  || fail "unobservable in-tmux expected caller_identity_unobservable" "$(cat "$WORK/out")"
logged 'attach-session|switch-client' \
  && fail "unobservable in-tmux must not hop (treating as outside would attach-session alpha)" "$(cat "$FAKE_EVENTS")"
echo "attach-next: unobservable in-tmux refuses, does not start at first eligible: ok"

# --- unregistered in-tmux is a missing cursor, not unobservable / outside -----
# Observable pane, resolve rc=2 (not generation_unverifiable): no TAP handle, so
# scan starts at first eligible. Mutating this arm into the unobservable refusal
# would RED; so would treating TMUX-set as "must have a roster row".
write_sessions
write_panes
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "demo" },
  "seats": {
    "alpha":    { "pane": "demo/alpha:0.0",   "pane_id": "%11", "harness": "claude", "status": "active", "session": "demo/alpha",   "server_epoch": "900:100", "boot_id": "boot:2" },
    "charlie":  { "pane": "demo/charlie:0.0", "pane_id": "%13", "harness": "claude", "status": "active", "session": "demo/charlie", "server_epoch": "900:100", "boot_id": "boot:2" }
  }
}
JSON
export FAKE_CALLER_PANE="%12" FAKE_PS_MODE=tty
run_next_inside "%12"
[ "$rc" = 0 ] || fail "unregistered in-tmux --next should hop to first eligible" "$(cat "$WORK/out"; cat "$WORK/err")"
[ "$(error_class "$(cat "$WORK/out")" 2>/dev/null || true)" = caller_identity_unobservable ] \
  && fail "unregistered in-tmux must not be caller_identity_unobservable" "$(cat "$WORK/out")"
logged 'switch-client.*demo/alpha|attach-session.*demo/alpha' \
  || fail "unregistered in-tmux must start at first eligible alpha" "$(cat "$FAKE_EVENTS")"
echo "attach-next: unregistered in-tmux starts at first eligible: ok"

write_registry

# --- remaining sole-candidate exclusions --------------------------------------
# The poll sole-candidate itself is retained in the smoke; the attached/gone/
# offline/unknown exclusions live here.
write_sole delta '{"delivery":"poll","harness":"claude","status":"active","unattended":true,"pane":"demo/delta:0.0","pane_id":"%21","session":"demo/delta","server_epoch":"900:100","boot_id":"boot:2"}'
printf 'demo/delta\t1:1\t0\n' > "$FAKE_SESSIONS"
printf 'demo/delta\tdemo/delta:0.0\t%%21\tclaude\t121\t1:1\t0\n' > "$FAKE_PANES"
assert_selector_empty poll

write_sole bravo '{"pane":"demo/bravo:0.0","pane_id":"%12","harness":"claude","status":"active","session":"demo/bravo","server_epoch":"900:100","boot_id":"boot:2"}'
printf 'demo/bravo\t1:1\t1\n' > "$FAKE_SESSIONS"
printf 'demo/bravo\tdemo/bravo:0.0\t%%12\tclaude\t112\t1:1\t0\n' > "$FAKE_PANES"
assert_selector_empty attached

write_sole echo '{"pane":"demo/echo:0.0","pane_id":"%99","harness":"claude","status":"active","session":"demo/echo","server_epoch":"900:100","boot_id":"boot:2"}'
: > "$FAKE_SESSIONS"
: > "$FAKE_PANES"
assert_selector_empty gone

write_sole foxtrot '{"pane":"demo/foxtrot:0.0","pane_id":"%14","harness":"claude","status":"suspended","status_reason":"server_restarted","session":"demo/foxtrot"}'
printf 'demo/foxtrot\t1:1\t0\n' > "$FAKE_SESSIONS"
printf 'demo/foxtrot\tdemo/foxtrot:0.0\t%%14\tclaude\t114\t1:1\t0\n' > "$FAKE_PANES"
assert_selector_empty offline

write_sole golf '{"harness":"claude","status":"active","server_epoch":"900:100","boot_id":"boot:2"}'
: > "$FAKE_SESSIONS"
: > "$FAKE_PANES"
assert_selector_empty unknown

write_sessions
write_panes
write_registry

# --- missing acting registry refuses closed ------------------------------------
# (The absent-marker "invalid team.name" arm is gone: under the born-live marker
# the team name is the enrollment key, never the bus registry's own claim.)
ROOT_ABS="$(cd "$TEAM_ROOT" && pwd -P)"
ACTING_REG="$ROOT_ABS/.tap/team-registry.json"
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{"alpha":{"pane":"demo/alpha:0.0","pane_id":"%11","harness":"claude","status":"active","session":"demo/alpha","server_epoch":"900:100","boot_id":"boot:2"}}}
JSON
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{"demo":{"enrolled_at":"t","registry_location":"$ACTING_REG","root":"$ROOT_ABS","state":"registered"}}}
JSON
rm -f "$ACTING_REG"
run_next
[ "$rc" = 1 ] || fail "missing acting registry expected exit 1, got $rc" "$(cat "$WORK/out"; cat "$WORK/err")"
[ "$(error_class "$(cat "$WORK/out")")" = registry_unreachable ] \
  || fail "missing acting registry expected registry_unreachable" "$(cat "$WORK/out")"
logged 'attach-session|switch-client' \
  && fail "missing acting registry must not hop" "$(cat "$FAKE_EVENTS")"
echo "attach-next: missing acting registry refuses registry_unreachable: ok"


# --- docs: grammar/semantics only inside tap attach --next windows ------------
# File-wide search lets CONTRACT "current team" elsewhere hide a --next scope
# mutation (remote team). Each needle is matched in the 900-char window after
# every `tap attach --next` occurrence, whitespace-flattened.
docs_must() {
  local f="$1" path; shift
  case "$f" in /*) path="$f" ;; *) path="$ROOT/$f" ;; esac
  grep -F -- 'tap attach --next' "$path" >/dev/null \
    || fail "docs drift: $f must name tap attach --next"
  local needle
  for needle in "$@"; do
    python3 -c '
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
needle = sys.argv[2]
windows = []
start = 0
token = "tap attach --next"
while True:
    i = text.find(token, start)
    if i < 0:
        break
    windows.append(text[i:i + 900])
    start = i + len(token)
span = " ".join(" ".join(w.split()) for w in windows)
sys.exit(0 if needle in span else 1)
' "$path" "$needle" \
      || fail "docs drift: $f --next entry must carry: $needle"
  done
}
# The help catalog left tap.sh for the native help renderer; check the rendered `tap help attach` text instead.
"$TAP" help attach >"$WORK/attach-help.txt" 2>&1 || fail "tap help attach failed" "$(cat "$WORK/attach-help.txt")"
docs_must "$WORK/attach-help.txt" \
  "--next takes no target" \
  "mutually exclusive with --interactive and with --no-resume" \
  "on THIS team" \
  "strictly after the current handle" \
  "not_attachable" \
  "unobservable in-tmux" \
  "not a registered TAP" \
  "--no-resume <team>/<handle>"
# CONTRACT/USAGE/SKILL are pointer stubs; the --next prose lives on
# the protocol page. The two re-aimed needles are that page's own sentences for
# the same claims ("seat"→"handle" wording; the refusal spelled out).
docs_must "skills/tap/protocol/delivery/cli-surface-the-whole-thing-part-09.md" \
  "on the current team from the shared batch classifier" \
  "takes no target" \
  "error_class=usage_error" \
  "an empty eligible set is error_class=not_attachable" \
  "strictly after the observable current handle then wrap" \
  "caller_identity_unobservable" \
  "observable in-tmux pane that is not a registered TAP seat" \
  "--no-resume <team>/<handle> using the acting team name"
docs_must "skills/tap/protocol/delivery/cli-surface-the-whole-thing-part-09.md" \
  "on the current team" \
  "strictly after the observable current handle then wrap" \
  "takes no target" \
  "--interactive" \
  "--no-resume <team>/<handle>" \
  "not_attachable" \
  "not a registered TAP seat"
docs_must "skills/tap/protocol/delivery/cli-surface-the-whole-thing-part-09.md" \
  "on the current team" \
  "strictly after the observable current handle then wrap" \
  "takes no target" \
  "--no-resume <team>/<handle>" \
  "not_attachable" \
  "unobservable in-tmux caller is error_class=caller_identity_unobservable" \
  "not a registered TAP seat"
echo "attach-next: help and protocol page carry --next grammar: ok"

echo "attach-next-matrix: ok"
