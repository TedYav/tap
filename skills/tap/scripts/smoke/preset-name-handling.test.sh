#!/usr/bin/env bash
# preset-name-handling: what a preset does, and does NOT do, to a seat handle.
#
# DERIVATION WAS REMOVED (2026-08-17). `<preset>-<name>` prefixing
# shipped briefly and was walked back, because it re-encoded launch provenance
# into the NAME and every surface that keys on names collided with it: the resume
# picker stopped recognising existing seats, remediation strings named handles
# that would never exist, the sanitizer mangled dotted preset names, and a derived
# handle could land squarely on a DIFFERENT preset's name. Provenance was already
# durable on the session record, so the roster reads it from there instead.
#
# WHAT SURVIVED, and why each arm is still worth its line:
#   * a provided name is used AS GIVEN on BOTH arms — the property that replaced
#     derivation, and the one a future "helpful" rename would quietly break;
#   * a BARE positional still defaults the handle to the preset name (the 08-14
#     rider), including a DOTTED one — the case where handle literalness is still
#     load-bearing, since allocate_name would otherwise map `zz.p` onto `zz-p`;
#   * a preset named `help` refuses at the shared resolver, before any effect.
#
# ARMS: 1, 2, 3, 4, 4b, 6
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z: pin machine-resolved state for directly invoked bodies — the
# launcher resolves machine paths even on --dry-run arms.
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"

fail() { echo "preset-name-handling: $*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
mkdir -p "$REPO/.tap/bus" "$WORK/cfg/tap"
git init -q "$REPO"
printf '{"schema": "0.20", "team":{"name":"repo","worktree_root":"%s"},"seats":{}}\n' "$REPO" \
  > "$REPO/.tap/bus/registry.json"
cat > "$WORK/cfg/tap/config.toml" <<'TOML'
version = 2

[presets.zzp]
harness = "claude"

# Dots are legal in preset names (the catalog validator permits them) AND in
# handles (TAP_ID_RE). That combination is what arm 4 exists for.
[presets."zz.p"]
harness = "claude"

# A preset named `help` is CATALOG-LEGAL — the validator has no opinion about
# reserved handles — which is what makes arm 5 reachable.
[presets.help]
harness = "claude"
TOML

export XDG_CONFIG_HOME="$WORK/cfg"
# STUB TMUX — this arm drives the real launcher, and the launcher's session-name
# snapshot probe runs `tmux list-sessions -F #S`. A quiet host with no tmux
# server makes that exit nonzero, the snapshot reads UNOBSERVABLE, and the launch
# refuses — so the merge gate would depend on ambient tmux state. Reproduced by
# putting a failing tmux first on PATH: every `launch ... --dry-run` fails.
#
# `TMUX_FIXTURE=none` was invented here and is consumed nowhere in the repo; it
# looked like a fixture and configured nothing (review finding). This stub is the
# real thing: it answers the one probe the dry-run makes, reporting ZERO sessions
# observably (exit 0, no output) rather than "cannot tell" (nonzero). The suite's
# established pattern — a FAKE_BIN ahead of PATH — is the same one
# delivery-urgent.test.sh uses.
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'TMUX_STUB'
#!/usr/bin/env bash
# Observably zero sessions. Exit 0 with no output is the difference between
# "there are none" and "I could not look" — the launcher distinguishes them, and
# tmux_sessions_for_namespace() already turns a recognized no-server response
# into set(), so this is a state production reaches rather than a manufactured one.
#
# ASSERTING, NOT PERMISSIVE. The first version was
#     [ "$1" = list-sessions ] && exit 0
#     exit 0
# where the guard READ $1 and changed nothing: both arms exited 0, so every tmux
# subcommand got success plus empty output and the arm could not tell whether
# list-sessions was the only probe or merely the first. Refusing everything else
# turns that assumption into a claim the test PROVES — if the dry-run ever grows a
# second tmux call, this reds instead of silently satisfying it (review finding).
if [ "$1" = list-sessions ]; then
  exit 0
fi
echo "preset-name-handling stub: unexpected tmux call: $*" >&2
exit 99
TMUX_STUB
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
unset TMUX
cd "$REPO"

launched_name() {  # <positional> [label] -> the seat name the launcher would create
  local out
  out="$(TAP_HOME="$REPO/.tap/bus" bash "$TAP" session launch "$@" --dry-run --json 2>/dev/null | tail -1)" \
    || fail "launch $* --dry-run failed"
  printf '%s\n' "$out" | python3 -c '
import json, sys
argv = json.load(sys.stdin)["argv"]
# The seat name rides the harness argv; claude carries it as --name <team>/<handle>.
print(argv[argv.index("--name") + 1].split("/", 1)[1] if "--name" in argv else "")
' || fail "could not read the launched seat name from: $out"
}

# (1) A PROVIDED NAME IS USED AS GIVEN — preset arm.
got="$(launched_name zzp reviewer)"
[ "$got" = "reviewer" ] \
  || fail "(1) 'launch zzp reviewer' must seat 'reviewer' — a preset supplies the HARNESS, it does not rename the seat (got '$got')"

# (2) ...and the harness arm, so the two cannot drift apart again. They were
# briefly asymmetric, which is how a rule ended up applied where its rationale
# did not reach.
got="$(launched_name claude reviewer)"
[ "$got" = "reviewer" ] \
  || fail "(2) 'launch claude reviewer' must seat 'reviewer', got '$got'"

# (3) A BARE preset positional still defaults the handle to the preset name.
got="$(launched_name zzp)"
[ "$got" = "zzp" ] \
  || fail "(3) a bare preset positional must keep the handle zzp, got '$got'"

# (4) THE DOTTED BARE CASE. allocate_name sanitizes a NON-literal handle, mapping
# `zz.p` onto `zz-p`; the bare-preset branch marks it literal so the catalog name
# survives intact. That branch outlived derivation, and a sanitized handle no
# longer names the preset it came from.
got="$(launched_name 'zz.p')"
[ "$got" = "zz.p" ] \
  || fail "(4) a bare dotted preset must seat 'zz.p' literally, got '$got'"

# (4b) A DOTTED NAME THE OPERATOR TYPED survives on the LAUNCH door too.
# sanitize_component maps `review.er` onto `review-er`, and it ran in TWO places —
# the tag normalisation and named_session_name — so launch seated `review-er`
# while `crew add` kept `review.er`. The two doors this PR standardized disagreed
# on identical input, and the launch spelling could collide with a real
# `review-er`. A name that is already charset-legal is used as typed.
got="$(launched_name zzp 'review.er')"
[ "$got" = "review.er" ] \
  || fail "(4b) an explicit dotted name must be seated as typed, got '$got'"
got="$(launched_name claude 'review.er')"
[ "$got" = "review.er" ] \
  || fail "(4b) the harness door must agree with the preset door on the same name, got '$got'"

# ...and a name that is NOT charset-legal is still sanitized, so this is "skip
# cleaning what needs none", not "stop cleaning".
got="$(launched_name zzp 'a b')"
[ "$got" = "a-b" ] \
  || fail "(4b) an illegal handle must still be sanitized, got '$got'"

# (6) A RESERVED HANDLE REFUSES AT THE RESOLVER, BEFORE ANY EFFECT.
# `help` is a legal preset name and was a legal resolve-target answer, so
# `tap crew add help` passed crew's preflight and BUILT A TMUX WINDOW before
# tap-register.sh rejected the reserved handle and rolled it back. cmd_new has
# checked this for its own bare-preset tag all along; crew resolves through
# resolve-target, which did not — one rule living at one of two doors, the
# recurring shape of this lane.
#
# Asserted on the CREW door rather than on the resolver directly: crew add's
# FIRST step is resolving through the same shared resolver, so the refusal must
# surface through the public verb — argv-decidable, needing no tmux to
# demonstrate — and the assertion covers the door an operator actually runs.
set +e
reserved_out="$(TAP_HOME="$REPO/.tap/bus" bash "$TAP" crew add help 2>&1)"
reserved_rc=$?
set -e
[ "$reserved_rc" -ne 0 ] \
  || fail "(6) a preset named 'help' must refuse at the crew door, got rc=0: $reserved_out"
grep -q "reserved" <<<"$reserved_out" \
  || fail "(6) the refusal must say the handle is reserved: $reserved_out"
# The whole point is that it refuses BEFORE ANY EFFECT: the stub above refuses
# every non-list-sessions call with a marker, and crew's resolver runs before
# any tmux call, so the marker must be absent. If crew ever tries to build a
# window for 'help' before refusing, this reds.
grep -q "preset-name-handling stub" <<<"$reserved_out" \
  && fail "(6) crew reached tmux before refusing the reserved handle: $reserved_out"

echo "preset-name-handling: a provided name is used as given; bare presets keep theirs: ok"
