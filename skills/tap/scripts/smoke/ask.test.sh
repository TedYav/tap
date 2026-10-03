#!/usr/bin/env bash
# ask.test.sh — tap-rjdi: stateless one-shot cross-harness invocation.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
FAKE_BIN="$WORK/bin"
CAPTURE="$WORK/capture"
export TAP_HOME="$WORK/bus" CAPTURE
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$FAKE_BIN" "$CAPTURE" "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$TAP_HOME/payloads/existing.md" <<'EOF'
existing bus evidence
EOF
cat > "$TAP_HOME/receipts/existing.done" <<'EOF'
existing receipt evidence
EOF
PROMPT="$WORK/prompt.md"
cat > "$PROMPT" <<'EOF'
Review the adapter table.
Keep literal `ticks` and $(shell forms) as data.
EOF

cat > "$WORK/fake-harness" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
name="$(basename "$0")"
printf '%s\0' "$@" > "${CAPTURE:?}/$name.argv"
cat > "${CAPTURE:?}/$name.stdin"
# Publish ATOMICALLY: the parent polls for this path's EXISTENCE and then reads it
# once, so a plain redirect (which creates it empty and fills it later) can hand
# that read a blank PID -- int('') raises, and the cancellation assertions below
# never run. Rename is the only publish where existence implies content.
if [ -n "${FAKE_PID_FILE:-}" ]; then
  printf '%s\n' "$$" > "$FAKE_PID_FILE.partial"
  mv -f "$FAKE_PID_FILE.partial" "$FAKE_PID_FILE"
fi
printf 'diagnostic from %s\n' "$name" >&2
if [ -n "${FAKE_BLOCK_FILE:-}" ]; then read -r _ < "$FAKE_BLOCK_FILE"; fi
if [ -z "${FAKE_SILENT:-}" ]; then printf 'answer from %s\n' "$name"; fi
exit "${FAKE_EXIT:-0}"
SH
chmod +x "$WORK/fake-harness"
for name in claude codex opencode cursor-agent hermes agy; do
  ln -s "$WORK/fake-harness" "$FAKE_BIN/$name"
done
ln -s "$(command -v bun)" "$FAKE_BIN/bun"
export PATH="$FAKE_BIN:$PATH"

fail() { echo "ask: $*" >&2; exit 1; }

tree_hash() {
  python3 -B - "$1" <<'PY'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
for path in sorted(root.rglob("*")):
    rel = path.relative_to(root).as_posix().encode()
    digest.update(b"d\0" if path.is_dir() else b"f\0")
    digest.update(rel + b"\0")
    if path.is_file():
        digest.update(path.read_bytes())
print(digest.hexdigest())
PY
}

assert_adapter() { # <harness> <binary> <expected-argv-json> <stdin|argument>
  local harness="$1" binary="$2" expected="$3" prompt_mode="$4" out err
  rm -f "$CAPTURE/$binary.argv" "$CAPTURE/$binary.stdin"
  err="$WORK/$harness.success.err"
  out="$(bash "$TAP" ask "$harness" -f "$PROMPT" --model named-tier 2>"$err")" \
    || fail "$harness adapter exited nonzero"
  [ "$out" = "answer from $binary" ] \
    || fail "$harness stdout changed: [$out]"
  grep -qx "diagnostic from $binary" "$err" \
    || fail "$harness stderr diagnostic was swallowed or changed"
  python3 -B - "$CAPTURE/$binary.argv" "$expected" <<'PY'
import json
import pathlib
import sys

got = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
if got and got[-1] == b"":
    got.pop()
got = [item.decode() for item in got]
want = json.loads(sys.argv[2])
if got != want:
    raise SystemExit(f"adapter argv mismatch\n got: {got!r}\nwant: {want!r}")
PY
  case "$prompt_mode" in
    stdin)
      cmp -s "$PROMPT" "$CAPTURE/$binary.stdin" \
        || fail "$harness did not receive the prompt on stdin byte-for-byte" ;;
    argument)
      [ ! -s "$CAPTURE/$binary.stdin" ] \
        || fail "$harness unexpectedly received prompt bytes on stdin" ;;
    *) fail "test bug: unknown prompt mode $prompt_mode" ;;
  esac
  echo "ask: $harness adapter: ok"
}

before="$(tree_hash "$TAP_HOME")"

# A FIXTURE CATALOG, exported for the preset arms only. sandbox-pins.sh pins
# XDG_CONFIG_HOME at an empty sandbox dir on purpose, and its own comment says a
# smoke that genuinely exercises config exports its own — without this, every arm
# below would refuse preset_config_missing and prove only that the sandbox has no
# catalog. It must never read the live machine file: that is an operator file
# that changes under the suite.
ASK_XDG="$WORK/askcfg"
mkdir -p "$ASK_XDG/tap"
cat > "$ASK_XDG/tap/config.toml" <<'TOML'
version = 2

[presets.sol-max]
description = "Fixture preset for the ask arms"
harness = "claude"
params.model = "opus[1m]"
TOML

# --preset is IMPLEMENTED now (tap-8nob); the preset_scope refusal is retired.
# What these arms actually pinned — a named, structured refusal that fires BEFORE
# any prompt read or harness effect — is the property worth keeping, so it is
# repointed at the refusals that replaced it rather than deleted with the class.
# A preset name that cannot be honored must still cost nothing.
#
# BOTH SPELLINGS STAY COVERED. The retired refusal caught --preset and --preset=,
# so accepting only the split form would have quietly turned half of a working
# refusal into "unknown option"; this arm makes that regression impossible.
for spelling in split equals; do
  rm -f "$CAPTURE/claude.argv" "$CAPTURE/claude.stdin"
  case "$spelling" in
    split) preset_args=(--preset __nosuch_preset__) ;;
    equals) preset_args=(--preset=__nosuch_preset__) ;;
  esac
  set +e
  XDG_CONFIG_HOME="$ASK_XDG" TAP_JSON=1 bash "$TAP" ask claude -f "$PROMPT" "${preset_args[@]}" \
    >"$WORK/preset-$spelling.out" 2>"$WORK/preset-$spelling.err"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "$spelling unknown preset unexpectedly succeeded"
  [ ! -s "$WORK/preset-$spelling.err" ] \
    || fail "$spelling preset JSON refusal contaminated stderr"
  python3 -B - "$WORK/preset-$spelling.out" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert payload["ok"] is False, payload
# The catalog's own not-found class, not a spelling-specific one: an unknown
# preset reads identically here and on `tap session launch`.
assert payload["error_class"] == "preset_not_found", payload
assert "__nosuch_preset__" in payload["detail"], payload
# A refusal that does not name what IS available is a dead end.
assert "choose an available preset" in payload["action"], payload
PY
  [ ! -e "$CAPTURE/claude.argv" ] \
    || fail "$spelling unknown preset launched the harness before refusing"
done

# Completeness: a preset names every tuning value, so --preset with --model
# refuses instead of picking a winner — same class and rule as session launch.
rm -f "$CAPTURE/claude.argv" "$CAPTURE/claude.stdin"
set +e
XDG_CONFIG_HOME="$ASK_XDG" TAP_JSON=1 bash "$TAP" ask claude -f "$PROMPT" --preset sol-max --model sonnet \
  >"$WORK/preset-combined.out" 2>/dev/null
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "--preset with --model unexpectedly succeeded"
python3 -B - "$WORK/preset-combined.out" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert payload["error_class"] == "preset_not_composable", payload
PY
[ ! -e "$CAPTURE/claude.argv" ] \
  || fail "--preset with --model launched the harness before refusing"

[ "$(tree_hash "$TAP_HOME")" = "$before" ] \
  || fail "preset refusals changed TAP state"
echo "ask: preset refusals are structured and cost nothing (both spellings): ok"

# Prompt paths must be regular files. A nonblocking open is load-bearing here:
# the previous read_text path blocks forever when the path names a FIFO.
FIFO_PROMPT="$WORK/prompt.fifo"
mkfifo "$FIFO_PROMPT"
rm -f "$CAPTURE/claude.argv" "$CAPTURE/claude.stdin"
python3 -B - "$TAP" "$FIFO_PROMPT" "$CAPTURE" <<'PY'
import pathlib
import subprocess
import sys

tap, fifo, capture = sys.argv[1:]
try:
    result = subprocess.run(
        ["bash", tap, "ask", "claude", "-f", fifo],
        capture_output=True,
        text=True,
        timeout=1,
    )
except subprocess.TimeoutExpired:
    raise SystemExit("tap ask blocked while reading a FIFO prompt path")

if result.returncode == 0:
    raise SystemExit("tap ask accepted a FIFO prompt path")
want = f"tap ask: prompt path is not a regular file: {fifo}\n"
if result.stderr != want:
    raise SystemExit(
        f"FIFO refusal mismatch\n got: {result.stderr!r}\nwant: {want!r}"
    )
if (pathlib.Path(capture) / "claude.argv").exists():
    raise SystemExit("tap ask launched the harness before refusing the FIFO")
PY
echo "ask: FIFO prompt path refuses without blocking or launching: ok"

assert_adapter claude claude \
  '["--print","--no-session-persistence","--model","named-tier"]' stdin
assert_adapter codex codex \
  '["exec","--ephemeral","--color","never","--model","named-tier","-"]' stdin
assert_adapter opencode opencode \
  "$(python3 -B -c 'import json,sys; print(json.dumps(["run","--model","named-tier","--",open(sys.argv[1]).read()]))' "$PROMPT")" argument
assert_adapter cursor cursor-agent \
  "$(python3 -B -c 'import json,sys; print(json.dumps(["--print","--mode","ask","--model","named-tier","--",open(sys.argv[1]).read()]))' "$PROMPT")" argument
assert_adapter hermes hermes \
  "$(python3 -B -c 'import json,sys; print(json.dumps(["--model","named-tier","--oneshot="+open(sys.argv[1]).read()]))' "$PROMPT")" argument
assert_adapter agy agy \
  "$(python3 -B -c 'import json,sys; print(json.dumps(["--model","named-tier","--print="+open(sys.argv[1]).read()]))' "$PROMPT")" argument

# Omitting --model must omit both the flag and any model value from the adapter
# argv rather than smuggling a default named tier into the invocation.
rm -f "$CAPTURE/claude.argv" "$CAPTURE/claude.stdin"
out="$(bash "$TAP" ask claude -f "$PROMPT" 2>"$WORK/claude.no-model.err")" \
  || fail "claude no-model invocation exited nonzero"
[ "$out" = "answer from claude" ] || fail "claude no-model stdout changed: [$out]"
python3 -B - "$CAPTURE/claude.argv" <<'PY'
import pathlib
import sys

got = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
if got and got[-1] == b"":
    got.pop()
got = [item.decode() for item in got]
want = ["--print", "--no-session-persistence"]
if got != want:
    raise SystemExit(f"no-model argv mismatch\n got: {got!r}\nwant: {want!r}")
if "--model" in got or "named-tier" in got:
    raise SystemExit(f"no-model invocation leaked a model selector: {got!r}")
PY
cmp -s "$PROMPT" "$CAPTURE/claude.stdin" \
  || fail "claude no-model invocation changed the prompt bytes"
grep -qx "diagnostic from claude" "$WORK/claude.no-model.err" \
  || fail "claude no-model stderr diagnostic was swallowed or changed"
echo "ask: omitted model stays absent from adapter argv: ok"

# --- POSITIONAL GRAMMAR (standardized grammar, 2026-08-16) ---
# PLACED BEFORE THE CANCELLATION AND TIMEOUT ARMS DELIBERATELY. Those arms leave a
# deliberately-blocked fake harness behind, and a later arm that runs a harness to
# completion inherits the wait — the symptom is this file hanging rather than
# failing, which reads as a machine problem instead of a test-ordering one. Any
# arm that expects a harness to RETURN belongs above them.
# -----------------
# ask's positional now names a PRESET or a HARNESS, the grammar the other two
# doors take. Four properties are argv-decidable and each has cost a real defect
# in this lane, so each gets an arm rather than a shared happy path.
ASK_XDG="$WORK/askcfg"; mkdir -p "$ASK_XDG/tap"
cat > "$ASK_XDG/tap/config.toml" <<'TOML'
version = 2

[presets.smokepreset]
harness = "codex"

[presets.smokepreset.params]
config = "smoke_marker=1"
TOML

# (a) BOTH SPELLINGS REACH THE SAME INVOCATION. The positional and --preset are
# two ways to name one preset; if they diverged, the docs would be right about
# one of them and silently wrong about the other.
rm -f "$CAPTURE/codex.argv"
XDG_CONFIG_HOME="$ASK_XDG" bash "$TAP" ask smokepreset -f "$PROMPT" >/dev/null 2>&1 \
  || fail "(grammar) a preset positional did not run"
positional_argv="$(tr '\0' ' ' < "$CAPTURE/codex.argv")"
rm -f "$CAPTURE/codex.argv"
XDG_CONFIG_HOME="$ASK_XDG" bash "$TAP" ask --preset smokepreset -f "$PROMPT" >/dev/null 2>&1 \
  || fail "(grammar) --preset did not run"
flag_argv="$(tr '\0' ' ' < "$CAPTURE/codex.argv")"
[ "$positional_argv" = "$flag_argv" ] \
  || fail "(grammar) the two spellings built different argv: '$positional_argv' vs '$flag_argv'"
grep -q -- "smoke_marker=1" <<<"$positional_argv" \
  || fail "(grammar) the preset's tuning never reached the harness: $positional_argv"
echo "ask: positional and --preset build the same invocation: ok"

# (b) A HARNESS POSITIONAL DOES NOT NEED THE CATALOG. This is the live-regression
# arm: a preset-first implementation that opened the catalog to decide "not a
# preset" broke plain `tap ask claude` on any machine whose config.toml was
# invalid — over a preset nobody named. The catalog here is deliberately broken.
BROKEN_XDG="$WORK/brokencfg"; mkdir -p "$BROKEN_XDG/tap"
printf 'version = 2\n\n[presets.busted]\nnosuchkey = "x"\n' > "$BROKEN_XDG/tap/config.toml"
XDG_CONFIG_HOME="$BROKEN_XDG" bash "$TAP" ask claude -f "$PROMPT" >"$WORK/broken.out" 2>"$WORK/broken.err" \
  || fail "(grammar) a harness positional must not depend on a readable catalog: $(cat "$WORK/broken.err")"
grep -q "answer from claude" "$WORK/broken.out" \
  || fail "(grammar) harness positional did not produce the harness answer under an invalid catalog"
echo "ask: a harness positional resolves without reading the catalog: ok"

# (c) A NAME THAT IS NEITHER refuses naming BOTH namespaces, because with one
# positional covering two namespaces "unknown harness" alone is a half-answer.
set +e
XDG_CONFIG_HOME="$ASK_XDG" bash "$TAP" ask nosuchthing -f "$PROMPT" >/dev/null 2>"$WORK/neither.err"
neither_rc=$?
set -e
[ "$neither_rc" -ne 0 ] || fail "(grammar) an unknown positional must refuse"
grep -q "neither a known harness nor a known preset" "$WORK/neither.err" \
  || fail "(grammar) the refusal must name both namespaces: $(cat "$WORK/neither.err")"
echo "ask: an unknown positional names both namespaces: ok"

# (d) -m IS A LITERAL BODY. It arrives as one argv element and tap must never
# re-parse it. The exposure -m carries is the COMPOSING shell (which is why -f
# stays preferred), so this arm proves the half tap owns: what reached tap is
# what reaches the harness, backticks and $(...) intact as data.
rm -f "$CAPTURE/claude.stdin"
literal='ticks `date` and $(uname) stay data'
bash "$TAP" ask claude -m "$literal" >/dev/null 2>&1 \
  || fail "(grammar) -m did not run"
[ "$(cat "$CAPTURE/claude.stdin")" = "$literal" ] \
  || fail "(grammar) -m body was altered in transit: $(cat "$CAPTURE/claude.stdin")"
set +e
bash "$TAP" ask claude -m x -f "$PROMPT" >/dev/null 2>"$WORK/both.err"
both_rc=$?
set -e
[ "$both_rc" -ne 0 ] || fail "(grammar) -f and -m together must refuse"
echo "ask: -m carries a literal body and refuses alongside -f: ok"

# (e) A PRESET MAY NOT RESTATE A FLAG THE ADAPTER OWNS (preset_adapter_conflict).
# This class shipped with ZERO coverage: the gate reviewer deleted the guard entirely and
# smoke, presets-verb, and all 665 python tests stayed green — the same way this
# PR's first blocker shipped. Both owner sources are exercised, because keying on
# headless_args alone missed native_timeout_flag and let the agy shape through.
CONFLICT_XDG="$WORK/conflictcfg"; mkdir -p "$CONFLICT_XDG/tap"
cat > "$CONFLICT_XDG/tap/config.toml" <<'TOML'
version = 2

[presets.curmode]
harness = "cursor"

[presets.curmode.params]
mode = "agent"

[presets.agytimeout]
harness = "agy"

[presets.agytimeout.params]
print-timeout = "5s"

[presets.cleanpreset]
harness = "claude"

[presets.cleanpreset.params]
effort = "high"

# A param whose VALUE looks like an adapter-owned flag. Legal, and it collides
# with nothing — the preset defines `foo`, not `mode`.
[presets.flagvalue]
harness = "cursor"

[presets.flagvalue.params]
foo = "--mode"

[presets.envpreset]
harness = "claude"

[presets.envpreset.env]
PRESET_SMOKE_FLAG = "from-preset"
TOML

# cursor's `--mode ask` comes from the adapter table. Silently appending it
# produced a duplicate flag whose resolution is the harness's business — and one
# reading turns a bounded question into an acting agent.
for conflict in "curmode:--mode:cursor-agent"; do
  preset="${conflict%%:*}"; rest="${conflict#*:}"
  flag="${rest%%:*}"; binary="${rest##*:}"
  rm -f "$CAPTURE/$binary.argv"
  set +e
  XDG_CONFIG_HOME="$CONFLICT_XDG" bash "$TAP" ask "$preset" -m x \
    >/dev/null 2>"$WORK/conflict.err"
  conflict_rc=$?
  set -e
  [ "$conflict_rc" -ne 0 ] \
    || fail "(grammar) preset '$preset' restating $flag must refuse, got rc=0"
  grep -q -- "$flag" "$WORK/conflict.err" \
    || fail "(grammar) the $preset refusal must name $flag: $(cat "$WORK/conflict.err")"
  # The refusal must PRECEDE the harness, or it is a message about something that
  # already happened.
  [ ! -f "$CAPTURE/$binary.argv" ] \
    || fail "(grammar) preset '$preset' reached the harness before refusing: $(tr '\0' ' ' < "$CAPTURE/$binary.argv")"
done

# agy's --print-timeout is no longer an adapter-owned flag: tap ask passes the
# prompt as the joined --print=<prompt> and forwards no native timeout of its
# own, so a preset that declares print-timeout is legitimate passthrough ahead
# of the prompt, not a duplicate of something tap fixes.
rm -f "${CAPTURE:?}/agy.argv"
out="$(XDG_CONFIG_HOME="$CONFLICT_XDG" bash "$TAP" ask agytimeout -m x 2>"$WORK/agytimeout.err")" \
  || fail "(grammar) preset 'agytimeout' with its own --print-timeout must run: $(cat "$WORK/agytimeout.err")"
[ "$out" = "answer from agy" ] \
  || fail "(grammar) agytimeout stdout changed: [$out]"
python3 -B - "$CAPTURE/agy.argv" <<'PY'
import pathlib
import sys

got = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
if got and got[-1] == b"":
    got.pop()
want = [b"--print-timeout", b"5s", b"--print=x"]
if got != want:
    raise SystemExit(f"agy passthrough mismatch\n got: {got!r}\nwant: {want!r}")
PY

# A preset whose params do NOT collide still runs, so the guard refuses the
# conflict rather than presets carrying params at all.
rm -f "$CAPTURE/claude.argv"
XDG_CONFIG_HOME="$CONFLICT_XDG" bash "$TAP" ask cleanpreset -m x >/dev/null 2>&1 \
  || fail "(grammar) a non-colliding preset must still run"
grep -q -- "--effort" <<<"$(tr '\0' ' ' < "$CAPTURE/claude.argv")" \
  || fail "(grammar) the non-colliding preset's tuning did not reach the harness"
# THE GUARD MUST KEY ON PARAM KEYS, NOT RENDERED ARGV. `params.foo = "--mode"`
# renders `--foo --mode`, and a scan of argv tokens read that VALUE as though the
# preset had defined `params.mode` — refusing a legal catalog. The rendering is
# lossy in exactly this way: params_to_argv emits `true` as a bare `--flag`, so
# `('--foo','--mode')` is either two bare flags or one key with a flag-shaped
# value, and argv alone cannot tell them apart. A guard that refuses a legal
# config is worse than the duplicate flag it exists to prevent.
#
# Asserted by ABSENCE of the conflict refusal, not by exit status: cursor-agent
# legitimately rejects `--mode --foo` on its own terms, so rc is nonzero either
# way and keying on it would pass under the bug.
set +e
XDG_CONFIG_HOME="$CONFLICT_XDG" bash "$TAP" ask flagvalue -m x \
  >/dev/null 2>"$WORK/flagvalue.err"
set -e
grep -q "which tap ask already fixes" "$WORK/flagvalue.err" \
  && fail "(grammar) a param VALUE that looks like a flag was mistaken for a key: $(cat "$WORK/flagvalue.err")"
echo "ask: a flag-shaped param VALUE is not mistaken for a conflicting key: ok"

# (f) AN AMBIENT ENV COLLISION IS ANNOUNCED, KEY ONLY.
# The overlay already gives the child the preset's value; doing it silently is
# what diverged from the durable and crew launch paths, which have always emitted
# exactly one notice per colliding key (CONTRACT §preset env). An operator whose
# exported variable lost to a preset otherwise had no way to know.
#
# THE VALUE MUST NOT APPEAR. The key fence is NAME-based and deliberately permits
# plural forms, so a key like HF_TOKENS clears it — printing its value would put a
# credential into pane transcripts and anything pasted out of them (the rule:
# keep the key, drop the value). This arm asserts the absence of both values, not
# just the presence of the key.
set +e
PRESET_SMOKE_FLAG=from-shell XDG_CONFIG_HOME="$CONFLICT_XDG" bash "$TAP" ask envpreset -m x \
  >/dev/null 2>"$WORK/envnotice.err"
set -e
grep -q "overriding ambient ENV var PRESET_SMOKE_FLAG" "$WORK/envnotice.err" \
  || fail "(grammar) a colliding preset env key must be announced: $(cat "$WORK/envnotice.err")"
grep -q "from-shell" "$WORK/envnotice.err" \
  && fail "(grammar) the notice echoed the AMBIENT value: $(cat "$WORK/envnotice.err")"
grep -q "from-preset" "$WORK/envnotice.err" \
  && fail "(grammar) the notice echoed the DECLARED value — a name-based fence permits plural keys, so this is a credential leak: $(cat "$WORK/envnotice.err")"

# No collision means no notice: this fires on DISAGREEMENT, not on every preset env key.
set +e
XDG_CONFIG_HOME="$CONFLICT_XDG" bash "$TAP" ask envpreset -m x \
  >/dev/null 2>"$WORK/envquiet.err"
set -e
grep -q "overriding ambient" "$WORK/envquiet.err" \
  && fail "(grammar) a preset env key with no ambient collision must stay quiet: $(cat "$WORK/envquiet.err")"

# A structured caller is promised one object and no stderr contamination.
set +e
TAP_JSON=1 PRESET_SMOKE_FLAG=from-shell XDG_CONFIG_HOME="$CONFLICT_XDG" bash "$TAP" ask envpreset -m x \
  >/dev/null 2>"$WORK/envjson.err"
set -e
grep -q "overriding ambient" "$WORK/envjson.err" \
  && fail "(grammar) TAP_JSON=1 must suppress the collision notice: $(cat "$WORK/envjson.err")"
echo "ask: an ambient env collision is announced key-only and stays quiet otherwise: ok"

echo "ask: a preset restating an adapter-owned flag refuses before the harness: ok"


# The harness owns its own exit status; tap ask must not repaint a failed answer
# as success or discard response text already written to stdout.
set +e
FAKE_EXIT=23 bash "$TAP" ask codex -f "$PROMPT" >"$WORK/failed.out" 2>"$WORK/failed.err"
rc=$?
set -e
[ "$rc" -eq 23 ] || fail "harness exit 23 became $rc"
[ "$(cat "$WORK/failed.out")" = "answer from codex" ] || fail "failed harness stdout was swallowed"
grep -qx "diagnostic from codex" "$WORK/failed.err" \
  || fail "failed harness stderr diagnostic was swallowed or changed"
echo "ask: harness stdout, stderr, and exit status pass through: ok"

# An exit-0 harness that writes nothing to stdout is a failure, not a success:
# the harness's own stderr complaint stays visible above tap's refusal, so the
# silent-failure shape (empty stdout, exit 0) cannot read as an answer.
set +e
FAKE_SILENT=1 bash "$TAP" ask agy -f "$PROMPT" >"$WORK/silent.out" 2>"$WORK/silent.err"
silent_rc=$?
set -e
[ "$silent_rc" -ne 0 ] || fail "an empty-stdout exit-0 harness passed as success"
[ ! -s "$WORK/silent.out" ] || fail "silent harness produced stdout: $(cat "$WORK/silent.out")"
grep -qx "diagnostic from agy" "$WORK/silent.err" \
  || fail "silent-harness stderr diagnostic was swallowed: $(cat "$WORK/silent.err")"
grep -q "tap ask: agy produced no output" "$WORK/silent.err" \
  || fail "empty-output refusal missing: $(cat "$WORK/silent.err")"
echo "ask: exit 0 with empty stdout refuses instead of passing: ok"

# A prompt that begins with a dash is still the message. Positional-prompt
# harnesses get a -- separator, value-flag harnesses the joined --flag=prompt,
# so neither parser can read the prompt back as an option.
dash_argv_check() { # <capture-file> <expected-argv-json>
  python3 -B - "$1" "$2" <<'PY'
import json
import pathlib
import sys

got = [item.decode() for item in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0") if item]
want = json.loads(sys.argv[2])
if got != want:
    raise SystemExit(f"dash-prompt argv deformed\n got: {got!r}\nwant: {want!r}")
PY
}
DASH_PROMPT="$WORK/dash.md"
printf -- '-not-a-flag body\n' > "$DASH_PROMPT"
rm -f "${CAPTURE:?}/opencode.argv" "${CAPTURE:?}/agy.argv"
out="$(bash "$TAP" ask opencode -f "$DASH_PROMPT" 2>/dev/null)" \
  || fail "dash-prompt ask for opencode exited nonzero"
[ "$out" = "answer from opencode" ] \
  || fail "dash-prompt stdout changed for opencode: [$out]"
dash_argv_check "$CAPTURE/opencode.argv" '["run","--","-not-a-flag body\n"]'
out="$(bash "$TAP" ask agy -f "$DASH_PROMPT" 2>/dev/null)" \
  || fail "dash-prompt ask for agy exited nonzero"
[ "$out" = "answer from agy" ] \
  || fail "dash-prompt stdout changed for agy: [$out]"
dash_argv_check "$CAPTURE/agy.argv" '["--print=-not-a-flag body\n"]'
echo "ask: a leading-dash prompt stays the message: ok"

# Cancellation must clean up the harness's whole session and return the shell's
# conventional signal-derived status, without leaking a Python traceback.
python3 -B - "$TAP" "$PROMPT" "$WORK" <<'PY'
import os
import pathlib
import signal
import subprocess
import sys
import time

tap, prompt, work = sys.argv[1:]
pid_path = pathlib.Path(work) / "cancel-child.pid"
block_path = pathlib.Path(work) / "cancel.block"
os.mkfifo(block_path)
DEADMAN_SECONDS = 300
env = os.environ.copy()
env["FAKE_PID_FILE"] = str(pid_path)
env["FAKE_BLOCK_FILE"] = str(block_path)
stderr_path = pathlib.Path(work) / "cancel.err"
stderr_stream = stderr_path.open("w")
wrapper = subprocess.Popen(
    ["bash", tap, "ask", "claude", "-f", prompt],
    stdout=subprocess.DEVNULL,
    stderr=stderr_stream,
    env=env,
)
child_pid = None

def captured_stderr():
    stderr_stream.flush()
    return stderr_path.read_text()

try:
    deadline = time.monotonic() + DEADMAN_SECONDS
    while not pid_path.exists():
        if wrapper.poll() is not None:
            raise SystemExit(
                f"tap ask exited before launching the blocked harness: "
                f"rc={wrapper.returncode}, stderr={captured_stderr()!r}"
            )
        if time.monotonic() >= deadline:
            raise SystemExit("blocked harness did not publish its PID before deadman")
        time.sleep(0.02)
    child_pid = int(pid_path.read_text().strip())

    wrapper.send_signal(signal.SIGTERM)
    try:
        wrapper.wait(timeout=DEADMAN_SECONDS)
    except subprocess.TimeoutExpired:
        raise SystemExit("tap ask cancellation reached the 300-second deadman")
    stderr = captured_stderr()
    if wrapper.returncode != 143:
        raise SystemExit(f"SIGTERM should exit 143, got {wrapper.returncode}")
    if "Traceback" in stderr:
        raise SystemExit(f"SIGTERM leaked a traceback: {stderr!r}")

    try:
        os.kill(child_pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise SystemExit(f"cancelled harness PID {child_pid} survived")
finally:
    if wrapper.poll() is None:
        wrapper.kill()
        wrapper.wait()
    if child_pid is not None:
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    stderr_stream.close()
PY
echo "ask: SIGTERM cancels and reaps the harness process group: ok"

# Native outer-timeout and process-group controls live in runtime/bun/test/ask.test.ts.

# Remove one fake from the otherwise controlled PATH: refusal must name the
# missing executable rather than falling through to a shell command-not-found.
rm "$FAKE_BIN/claude"
set +e
PATH="$FAKE_BIN:/usr/bin:/bin" bash "$TAP" ask claude -f "$PROMPT" \
  >"$WORK/absent.out" 2>"$WORK/absent.err"
rc=$?
set -e
[ "$rc" -eq 127 ] || fail "absent CLI should exit 127, got $rc"
grep -q "missing executable 'claude'" "$WORK/absent.err" \
  || fail "absent CLI refusal did not name claude"
echo "ask: absent harness CLI refuses clearly: ok"

set +e
bash "$TAP" ask unknown -f "$PROMPT" >"$WORK/unknown.out" 2>"$WORK/unknown.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "unknown harness should refuse"
grep -q "claude, codex, opencode, cursor, hermes, agy" "$WORK/unknown.err" \
  || fail "unknown harness refusal did not name the supported set"
echo "ask: unknown harness refuses with supported set: ok"

help_a="$(bash "$TAP" help ask)"
help_b="$(bash "$TAP" ask help)"
help_c="$(bash "$TAP" ask --help)"
[ "$help_a" = "$help_b" ] && [ "$help_a" = "$help_c" ] \
  || fail "the three ask help spellings diverged"
grep -q "each invocation starts fresh" <<<"$help_a" \
  || fail "ask help is missing the fresh-invocation guarantee"
grep -q "no TAP registration, bus, pane, or lifecycle state" <<<"$help_a" \
  || fail "ask help is missing the no-state guarantee"
grep -q "needs a follow-up conversation.*tap crew add" <<<"$help_a" \
  || fail "ask help is missing the crew escalation test"
grep -q "needs a durable restartable address.*tap session launch" <<<"$help_a" \
  || fail "ask help is missing the seat escalation test"
echo "ask: help states the stateless guarantee and escalation test: ok"

after="$(tree_hash "$TAP_HOME")"
[ "$before" = "$after" ] \
  || fail "ask or its help paths mutated TAP_HOME ($before -> $after)"
echo "ask: bus tree hash unchanged across success, failure, timeout, and help: ok"

echo "ask: all checks passed"
