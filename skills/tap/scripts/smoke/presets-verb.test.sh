#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# presets-verb.test.sh — tap-8nob. `tap presets` is the discovery door, and the
# session advisory points at it from an always-in-context surface.
#
# NEVER READS THE LIVE MACHINE CATALOG. Every arm points XDG_CONFIG_HOME at a
# fixture dir: the real config.toml is an operator file that changes under us,
# is 0600, and asserting against it would make this suite a report on the operator's
# machine rather than on this code (TAP_HOME-isolation doctrine, generalized —
# the preset path resolves through XDG_CONFIG_HOME, so that is the lever).
#
# ARM 4 IS THE ONE THAT EARNS ITS KEEP. The advisory ships in the same PR as the
# verb precisely so the always-in-context text never names a command that
# errors, and the bead's sequencing note ("verbs first, advisory last") was
# after that guarantee. Commit order cannot deliver it; asserting that every
# `tap ...` spelling in the new advisory block is a real, routable verb can, and
# it stays true for every later edit of either file. It already caught one: the
# first draft advertised `tap ask <preset>`, and ask takes a HARNESS.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "presets-verb: $*" >&2; exit 1; }

# A fixture catalog: two presets, one WITHOUT metadata/description, so the
# renderer is exercised on a sparse row rather than only on rich ones.
mkdir -p "$WORK/cfg/tap"
cat > "$WORK/cfg/tap/config.toml" <<'TOML'
version = 2

[roles]
reviewer = "reads a diff and reports findings"
leader = "holds the baton"

[presets.alpha]
description = "Alpha preset for the fixture"
harness = "claude"
params.model = "opus[1m]"
metadata.summary = "A much longer prose summary that must NOT appear in the description column."
metadata.primary_roles = [ "leader", "reviewer" ]

[presets.bare]
harness = "codex"

# SUMMARY BUT NO DESCRIPTION — the only configuration that can catch a fallback
# from one field to the other. `alpha` has both, so a `description or summary`
# substitution is invisible there: the correct value wins either way. This row is
# the arm's discriminating case, and without it the no-substitution assertion
# passes under a mutant that adds exactly that fallback.
[presets.summaryonly]
harness = "claude"
metadata.summary = "Long prose that is NOT a one-line description column value."
TOML

run() { XDG_CONFIG_HOME="$WORK/cfg" bash "$TAP" presets "$@"; }

# --- (1) HAPPY PATH: the columns the bead names, from the fixture ------------
out="$(run 2>"$WORK/err")" || fail "(1) tap presets failed: $(cat "$WORK/err")"
grep -q '^PRESET' <<<"$out"                  || fail "(1) no header row: $out"
grep -qE '^alpha +claude +anthropic +opus\[1m\]' <<<"$out" \
  || fail "(1) alpha row missing name/harness/family/model: $out"
grep -q 'Alpha preset for the fixture' <<<"$out" || fail "(1) description column missing: $out"
grep -q 'leader, reviewer' <<<"$out"         || fail "(1) primary roles missing: $out"
grep -q '^bare *codex' <<<"$out"             || fail "(1) a preset with no metadata must still list: $out"
# description is the SHORT label; metadata.summary is long prose and must not be
# substituted for it, or the column stops being a column.
grep -q 'much longer prose summary' <<<"$out" \
  && fail "(1) metadata.summary leaked into the description column: $out"
# The discriminating case: this preset has a summary and NO description, so a
# `description or summary` fallback shows up here and nowhere else.
grep -q 'Long prose that is NOT' <<<"$out" \
  && fail "(1) metadata.summary substituted for a MISSING description — they are different fields: $out"
grep -q '^summaryonly *claude' <<<"$out" \
  || fail "(1) a preset with no description must still list, with an empty column: $out"
grep -q 'tap session launch' <<<"$out"       || fail "(1) output must name the launch door: $out"

# --- (2) DEGRADE: missing catalog is a NOTICE, not an error ------------------
# The discovery verb must survive the states a launch refuses — an operator asks
# "what can I launch?" exactly when something is wrong.
set +e
XDG_CONFIG_HOME="$WORK/empty" bash "$TAP" presets >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
[ "$rc" = 0 ] || fail "(2) a missing catalog must exit 0 (notice, not error), got rc=$rc"
grep -q 'no saved presets' "$WORK/err" || fail "(2) missing catalog said nothing: $(cat "$WORK/err")"
grep -q "$WORK/empty/tap/config.toml" "$WORK/err" || fail "(2) missing catalog must name its path"
grep -q 'tap launch claude newcomer' "$WORK/err" || fail "(2) missing catalog must offer a bare launch"
! grep -q 'writable' "$WORK/err" || fail "(2) missing catalog must not suggest permission repair"

# Malformed TOML takes the same path — not a traceback, not a nonzero exit.
mkdir -p "$WORK/bad/tap"
printf 'this is not = valid toml [[[\n' > "$WORK/bad/tap/config.toml"
set +e
XDG_CONFIG_HOME="$WORK/bad" bash "$TAP" presets >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
[ "$rc" = 0 ] || fail "(2) a malformed catalog must exit 0, got rc=$rc: $(cat "$WORK/err")"
grep -qi 'traceback' "$WORK/err" && fail "(2) malformed catalog leaked a traceback: $(cat "$WORK/err")"
# The message must NAME THE FILE THAT FAILED, and say what was wrong with it.
# A generic "no readable preset catalog" was indistinguishable between a missing
# file and a broken one — and worse, it always reconstructed the config.toml path
# even when the loader had actually reached and failed on the LEGACY presets.toml,
# sending the operator to repair a file that was not the problem.
grep -q "$WORK/bad/tap/config.toml" "$WORK/err" \
  || fail "(2) the malformed-catalog notice must name the failing path: $(cat "$WORK/err")"
grep -qi 'invalid preset config' "$WORK/err" \
  || fail "(2) the malformed-catalog notice must say the config is invalid, not merely unreadable: $(cat "$WORK/err")"
# ONE sentence, and no machine token in it. The verb used to append the error's
# own message -- which already leads with the class token and its own
# `invalid preset config <path>:` -- to a lead-in it rebuilt itself, so the
# operator read the path and the phrase twice with `preset_config_invalid:`
# wedged between them. Every grep above passed throughout, because each asserted
# that a string was PRESENT and the doubled sentence contains both of them.
# OCCURRENCES, not matching lines: the doubled sentence was one line carrying the
# phrase twice, so `grep -c` reported 1 and agreed with a defect it was written to
# catch. The emptiness check is the instrument's own refusal -- a notice that
# wrote nothing also counts zero, and zero is not "said it once".
[ -s "$WORK/err" ] || fail "(2) the malformed-catalog notice wrote nothing at all"
hits="$(awk '{ n += gsub(/invalid preset config/, "&") } END { print n+0 }' "$WORK/err")"
[ -n "$hits" ] && [ "$hits" = 1 ] \
  || fail "(2) the notice must say 'invalid preset config' exactly once, got $hits: $(cat "$WORK/err")"
grep -q 'preset_config_' "$WORK/err" \
  && fail "(2) the operator sentence must not carry a machine class token: $(cat "$WORK/err")"

# THE OTHER TWO DEGRADATION CLASSES. The three assertions above ran on malformed
# TOML only, and malformed TOML is the one class whose `detail` already opens with
# "invalid preset config" — so they proved the marker survives, not that it is
# present. An insecure mode and an out-of-range integer both refuse with a detail
# that opens with the PATH instead, and both shipped a sentence CONTRACT.md:1896
# forbids while every arm here stayed green. A rule stated more broadly than its
# controls reach is a rule nothing enforces.
degradation_sentence() { # <label> <fixture-dir>
  local label="$1" fixture="$2"
  set +e
  XDG_CONFIG_HOME="$fixture" bash "$TAP" presets >"$WORK/out" 2>"$WORK/err"
  local rc=$?
  set -e
  [ "$rc" = 0 ] || fail "(2) $label must still exit 0, got rc=$rc: $(cat "$WORK/err")"
  [ -s "$WORK/err" ] || fail "(2) $label wrote no notice at all"
  local hits
  hits="$(awk '{ n += gsub(/invalid preset config/, "&") } END { print n+0 }' "$WORK/err")"
  [ -n "$hits" ] && [ "$hits" = 1 ] \
    || fail "(2) $label must say 'invalid preset config' exactly once, got $hits: $(cat "$WORK/err")"
  grep -q 'preset_config_' "$WORK/err" \
    && fail "(2) $label must not carry a machine class token: $(cat "$WORK/err")"
  grep -q "$fixture/tap/config.toml" "$WORK/err" \
    || fail "(2) $label must name the failing path: $(cat "$WORK/err")"
}

mkdir -p "$WORK/insecure/tap"
printf 'version = 3\n[presets.alpha]\nharness = "claude"\n' > "$WORK/insecure/tap/config.toml"
chmod 666 "$WORK/insecure/tap/config.toml"
degradation_sentence "an insecure (group/world-writable) catalog" "$WORK/insecure"

# The integer ceiling is OUR representation limit, not a fault in their file, and
# it is the one class ruled to refuse rather than resolve policy empty — so it
# must still reach the operator as a properly marked invalid-config sentence.
mkdir -p "$WORK/oversized/tap"
printf 'version = 3\nhuge = 9007199254740993\n[presets.alpha]\nharness = "claude"\n' \
  > "$WORK/oversized/tap/config.toml"
chmod 600 "$WORK/oversized/tap/config.toml"
degradation_sentence "an out-of-range integer catalog" "$WORK/oversized"

# THE LEGACY CASE, which is what made this distinction load-bearing:# THE LEGACY CASE, which is what made this distinction load-bearing: config.toml
# absent, legacy presets.toml present and broken. The loader reaches presets.toml,
# so that is the file the operator must fix.
mkdir -p "$WORK/legacy/tap"
printf 'version = 1\nbroken [[[\n' > "$WORK/legacy/tap/presets.toml"
set +e
XDG_CONFIG_HOME="$WORK/legacy" bash "$TAP" presets >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
[ "$rc" = 0 ] || fail "(2) a broken legacy catalog must still exit 0, got rc=$rc"
grep -q "$WORK/legacy/tap/presets.toml" "$WORK/err" \
  || fail "(2) a broken LEGACY catalog must name presets.toml, not config.toml: $(cat "$WORK/err")"
# "not config.toml" is half the claim, and it is the half that went unchecked.
# The lead-in was rebuilt from the config directory whenever the error carried no
# `path` attribute, so the sentence pointed at config.toml and named the real
# file further along the same line -- sending the operator to repair a file that
# was fine, which is the defect the comment above describes, reintroduced.
grep -q "$WORK/legacy/tap/config.toml" "$WORK/err" \
  && fail "(2) a broken LEGACY catalog must not name config.toml at all: $(cat "$WORK/err")"

# An absent catalog is a healthy zero-preset install.
grep -q 'no saved presets' <<<"$(XDG_CONFIG_HOME="$WORK/empty" bash "$TAP" presets 2>&1)" \
  || fail "(2) an absent catalog must report the neutral empty state"

# --- (3) --json is the stable machine surface -------------------------------
js="$(run --json 2>/dev/null)" || fail "(3) --json failed"
python3 - "$js" <<'PY' || fail "(3) --json shape assertions failed (see traceback above)"
import json, sys
doc = json.loads(sys.argv[1])
assert "source" in doc, f"(3) --json must carry a source key: {sorted(doc)}"
names = [p["name"] for p in doc["presets"]]
assert names == ["alpha", "bare", "summaryonly"], names
alpha = doc["presets"][0]
assert alpha["harness"] == "claude", alpha
assert alpha["model"] == "opus[1m]", alpha
assert alpha["roles"] == "leader, reviewer", alpha
assert doc["source"].endswith("/tap/config.toml"), doc["source"]
# A sparse preset carries empty strings, never missing keys: a consumer indexing
# row["model"] must not have to guess which shape it got.
assert doc["presets"][1]["model"] == "", doc["presets"][1]
assert doc["presets"][1]["roles"] == "", doc["presets"][1]
# Same no-substitution property on the machine surface, on the row that can show it.
assert doc["presets"][2]["description"] == "", doc["presets"][2]
PY
# source=null is what distinguishes "no catalog readable" from "zero presets",
# and a consumer cannot tell those apart without it.
js_missing="$(XDG_CONFIG_HOME="$WORK/empty" bash "$TAP" presets --json 2>/dev/null)"
python3 - "$js_missing" <<'PY' || fail "(3) --json missing-catalog shape failed (see traceback above)"
import json, sys
doc = json.loads(sys.argv[1])
assert "source" in doc, f"(3) --json must carry source even with no catalog: {sorted(doc)}"
assert doc["source"] is None, doc
assert doc["presets"] == [], doc
PY

# --- (4) EVERY COMMAND THE ADVISORY NAMES MUST BE A ROUTABLE VERB ------------
# The advisory is always in context, so a stale spelling there is worse than a
# missing one: it teaches a wrong command to every seat on every session start.
ADVISORY="$ROOT/skills/tap/templates/advisory.md"
# Anchor on `tap presets`, not on the heading text: the heading is prose that
# gets re-worded (it already has, twice), and an arm that dies on a re-word is an
# arm that gets deleted rather than fixed. The block is "the discovery heading
# through the next heading", found by the verb it must lead with.
block="$(awk '/^## .*tap presets/{f=1} f&&/^## /&&!/tap presets/{f=0} f' "$ADVISORY")"
[ -n "$block" ] || fail "(4) the discovery block is missing from $ADVISORY"
grep -q 'tap presets' <<<"$block" || fail "(4) the discovery door must lead: $block"

verbs="$(grep -oE '^  tap [a-z]+( [a-z]+)?' <<<"$block" | sed 's/^  tap //' | sort -u)"
[ -n "$verbs" ] || fail "(4) no tap commands parsed out of the advisory block"
while IFS= read -r v; do
  [ -n "$v" ] || continue
  head="${v%% *}"
  # `tap help <verb>` is the routing surface: an unknown verb prints the generic
  # listing instead of a verb line, which is the discriminator used here.
  # CAPTURE WHOLE, SLICE AFTER — never `... | head -1` under `set -o pipefail`.
  # `tap help <verb>` prints many lines; head -1 exits as soon as it has one, and
  # on a platform whose pipe buffer is smaller than the remaining output the
  # writer is still writing, takes SIGPIPE, and the command substitution exits
  # 141. pipefail promotes that to a failure of THIS test, on a machine where
  # nothing is actually wrong — a portability flake in the merge gate, which is
  # the one place a flake is most expensive. Slicing a variable cannot signal.
  helped_all="$(bash "$TAP" help "$head" 2>&1)"
  helped="${helped_all%%$'\n'*}"
  # Two live page styles: the older one opens with the "tap <verb> ..." usage line, the NAME-style page opens with
  # "NAME" and names the verb on its next line. An unknown verb prints neither ("tap: no help for ...").
  second="${helped_all#*$'\n'}"; second="${second%%$'\n'*}"
  { grep -q "^tap $head" <<<"$helped" || { [ "$helped" = NAME ] && grep -q "^  tap $head " <<<"$second"; }; } \
    || fail "(4) advisory names '$v' but 'tap help $head' does not describe it (got: $helped)"
done <<< "$verbs"

# GRAMMAR, not just verb existence. A routable verb can still be advertised with
# a spelling it rejects, which is the same "names a command that errors" failure
# one level down.
#
# THIS ARM'S CLAIM INVERTED, deliberately (standardization, 2026-08-16). It
# used to assert `tap ask <harness>` and that session launch was the ONLY verb
# whose positional was a preset. All three doors now take <preset|harness>, so the
# old assertions are the ones that would ship a lie — the reversal is the fix, not
# a regression. Both directions are asserted below: the uniform spelling must be
# present, and the retired flag form must actually refuse.
for door in "tap ask" "tap crew add" "tap session launch"; do
  grep -q "$door <preset|harness>" <<<"$block" \
    || fail "(4) '$door' must advertise the uniform <preset|harness> positional: $block"
done
# The advisory must NOT teach handle derivation: the rule was walked back, and a
# doc that still promises `<preset>-<name>` sends agents to a handle that will not
# exist. Asserted as an absence, because that is the failure mode here.
grep -q -- '-<name>' <<<"$block" \
  && fail "(4) the advisory still teaches handle derivation, which was removed: $block"

# Each advertised POSITIONAL must be accepted by its verb. An unknown preset name
# is the expected refusal here; option-rejection vocabulary is what would mean the
# advertised grammar does not exist, so key on that only.
ask_probe="$(bash "$TAP" ask __nosuch__ -m x 2>&1 || true)"
grep -qiE "unknown option|unexpected arg" <<<"$ask_probe" \
  && fail "(4) the advisory advertises 'tap ask <preset|harness>' but the positional is REJECTED: $ask_probe"
crew_probe="$(bash "$TAP" crew add __nosuch__ 2>&1 || true)"
grep -qiE "unknown option|unexpected arg" <<<"$crew_probe" \
  && fail "(4) the advisory advertises 'tap crew add <preset|harness>' but the positional is REJECTED: $crew_probe"

# THE RETIREMENT IS LOAD-BEARING, so it is asserted rather than assumed. `--harness`
# shipped and callers exist; retiring it silently would turn a working invocation
# into a generic unknown-option message that names no replacement. The refusal must
# name the new form, or the retirement is a trap instead of a migration.
retired="$(bash "$TAP" crew add claude --harness claude 2>&1 || true)"
grep -q 'retired' <<<"$retired" \
  || fail "(4) crew add --harness must refuse AS RETIRED, naming the positional form: $retired"
grep -q 'tap crew add' <<<"$retired" \
  || fail "(4) the retired-flag refusal must spell the replacement invocation: $retired"

# --- (5) THE POSITIVE PATH: a valid preset must actually DELIVER its tuning ---
# Every other preset arm on ask and crew is a REFUSAL test, and that is exactly
# how the blocker shipped: resolve_preset returned only (harness, model), so
# `tap ask --preset` silently dropped params beyond model AND the preset's env
# while every refusal arm stayed green. Refusals can all pass while the happy
# path diverges — a preset that means different tuning depending on which verb
# reads it is worse than no preset door, because the name looks authoritative.
#
# The discriminator is an EFFECT, not a message: a fake harness on PATH records
# the argv it was handed and whether the preset's env var reached its process.
POS="$WORK/positive"
mkdir -p "$POS/cfg/tap" "$POS/bin"
# NOTE: the preset env fence refuses TAP_*-prefixed keys (identity/transport
# namespace), so the flag below is deliberately un-prefixed. The TAP_SMOKE_*
# variables are the TEST's own capture channel, never the preset's env.
cat > "$POS/cfg/tap/config.toml" <<'TOML'
version = 2

[presets.rich]
description = "Carries a non-model param AND an env var"
harness = "claude"
params.model = "opus[1m]"
params.effort = "high"
env.PRESET_SMOKE_FLAG = "on"
TOML

cat > "$POS/bin/claude" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${TAP_SMOKE_ARGV:?}.tmp"
mv -f "${TAP_SMOKE_ARGV:?}.tmp" "${TAP_SMOKE_ARGV:?}"
printf '%s\n' "${PRESET_SMOKE_FLAG:-<UNSET>}" > "${TAP_SMOKE_ENV:?}.tmp"
mv -f "${TAP_SMOKE_ENV:?}.tmp" "${TAP_SMOKE_ENV:?}"
echo "answer"
# Under crew add the pane process must outlive the launch: the crew lifetime binding treats an exited
# child as a lost generation. The ask half leaves TAP_SMOKE_HOLD unset and returns as before.
[ -z "${TAP_SMOKE_HOLD:-}" ] || exec sleep 600
FAKE
chmod +x "$POS/bin/claude"
printf 'prompt\n' > "$POS/prompt.md"

TAP_SMOKE_ARGV="$POS/argv.txt" TAP_SMOKE_ENV="$POS/env.txt" \
  PATH="$POS/bin:$PATH" XDG_CONFIG_HOME="$POS/cfg" \
  bash "$TAP" ask claude -f "$POS/prompt.md" \
  --preset rich >/dev/null 2>&1 || true

[ -f "$POS/argv.txt" ] \
  || fail "(5) ask --preset never reached the harness at all"
grep -q -- '--model opus\[1m\]' "$POS/argv.txt" \
  || fail "(5) ask --preset dropped the preset's MODEL: $(cat "$POS/argv.txt")"
# The two the blocker lost. Model alone passing is precisely what made the bug
# invisible, so these are asserted separately rather than as one "tuning" check.
grep -q -- '--effort high' "$POS/argv.txt" \
  || fail "(5) ask --preset dropped a non-model param (harness_passthrough): $(cat "$POS/argv.txt")"
[ "$(cat "$POS/env.txt")" = "on" ] \
  || fail "(5) ask --preset did not put the preset's env in the child: $(cat "$POS/env.txt")"

# CREW RENDERS THE SAME PRESET THE SAME WAY — driven through the public door.
# The bug was a DIVERGENCE between two verbs reading one name, so the arm still
# compares ask and crew on the same fake-harness discriminator. Crew is no
# longer invoked as a module, though: `tap crew add` runs end to end against a
# fixture team on a private tmux server, the seat pane executes the rendered
# command, and the same fake harness records the same three effects the ask
# half asserted above. Direct module execution left the test with no witness
# that the public verb reaches this renderer at all.
CREW_ROOT="$(mktemp -d "${TMUX_TMPDIR:?run through smoke-all --only}/presets-crew.XXXXXX")"
CREW_ROOT="$(cd "$CREW_ROOT" && pwd -P)"
REAL_TMUX="$(command -v tmux)"
CREW_SOCKET="$CREW_ROOT/tmux.sock"
CREW_TEAM="$CREW_ROOT/PresetsCrew"
CREW_CAPTURE="$CREW_ROOT/keys"
cleanup_crew() {
  "$REAL_TMUX" -S "$CREW_SOCKET" kill-server 2>/dev/null || true
  rm -rf "${WORK:?}"
  rm -rf "${CREW_ROOT:?}"
}
trap cleanup_crew EXIT
mkdir -p "$CREW_TEAM/.tap/bus" "$CREW_ROOT/index" "$CREW_ROOT/bin"
printf '{"schema":"0.20","teams":{}}\n' > "$CREW_ROOT/index/global-registry.json"
: > "$CREW_CAPTURE"
# The fixture's environment is scoped to this subshell. Arm 6 below was written
# for the runner sandbox — no TMUX, sandbox-pinned index, no seat identity — and
# a leaked export would silently hand it a live enrolled team (and any arm
# appended later would inherit one too).
(
  # The seat pane inherits the SERVER's environment, so the capture channel, the
  # fixture harness on PATH, and the preset catalog must be visible there before
  # the seat window exists.
  export REAL_TMUX CREW_SOCKET CREW_CAPTURE TAP_SMOKE_HOLD=1 TAP_SMOKE_ARGV="$POS/crew-argv.txt" \
    TAP_SMOKE_ENV="$POS/crew-env.txt" XDG_CONFIG_HOME="$POS/cfg" \
    TAP_INDEX_HOME="$CREW_ROOT/index" TAP_HOME="$CREW_TEAM/.tap/bus" TAP_SELF=driver \
    PATH="$CREW_ROOT/bin:$POS/bin:$PATH"
  cat > "$CREW_ROOT/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
if [ "${1:-}" = -S ]; then [ "$2" = "$CREW_SOCKET" ] || exit 99; shift 2; fi
if [ "${1:-}" = send-keys ]; then printf '%s\n' "$*" >> "${CREW_CAPTURE:?}"; fi
exec "${REAL_TMUX:?}" -S "$CREW_SOCKET" "$@"
TMUX
  chmod +x "$CREW_ROOT/bin/tmux"
  git -C "$CREW_TEAM" init -q
  # The crew lifetime contract requires an actual durable parent harness: a harmless
  # process named like one in the caller pane, with a registry row that binds it.
  ln -s /bin/sleep "$CREW_ROOT/bin/codex-parent"
  "$REAL_TMUX" -S "$CREW_SOCKET" new-session -d -s PresetsCrew/driver -c "$CREW_TEAM" "$CREW_ROOT/bin/codex-parent 600"
  export TMUX="$CREW_SOCKET,0,0"
  TMUX_PANE="$("$REAL_TMUX" -S "$CREW_SOCKET" display-message -p -t PresetsCrew/driver '#{pane_id}')"
  export TMUX_PANE
  CREW_TTY="$("$REAL_TMUX" -S "$CREW_SOCKET" display-message -p -t "$TMUX_PANE" '#{pane_tty}')"
  export CREW_TTY
  PARENT_EPOCH="$("$REAL_TMUX" -S "$CREW_SOCKET" display-message -p -t "$TMUX_PANE" '#{pid}:#{start_time}')"
  export PARENT_EPOCH
  # The test runner is outside tmux; bind only its caller-terminal probe to the fixture pane.
  cat > "$CREW_ROOT/bin/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *'ppid='*'tty='*) printf '1 %s\n' "${CREW_TTY#/dev/}" ;;
  *) exec /bin/ps "$@" ;;
esac
PS
  chmod +x "$CREW_ROOT/bin/ps"
  python3 - "$CREW_ROOT" <<'PY'
import json,os,pathlib,sys
w=pathlib.Path(sys.argv[1]);root=w/'PresetsCrew';reg=root/'.tap/team-registry.json'
reg.write_text(json.dumps({'schema':'0.20','team':{'name':'PresetsCrew','worktree_root':str(root)},'seats':{
 'driver':{'delivery':'pane','harness':'codex','status':'active','instance':'driver|fixture',
           'pane_id':os.environ['TMUX_PANE'],'pane':'PresetsCrew/driver:0.0','session':'PresetsCrew/driver',
           'server_epoch':'srv:'+os.environ['PARENT_EPOCH'],'server_socket':os.environ['CREW_SOCKET']}}}))
(w/'index/global-registry.json').write_text(json.dumps({'schema':'0.20','teams':{
 'PresetsCrew':{'root':str(root),'registry_location':str(reg),'state':'registered'}}}))
PY

  ( cd "$CREW_TEAM" && bash "$TAP" crew add claude probe --preset rich ) \
    >"$POS/crew.log" 2>&1 || fail "(5) crew add refused a valid preset: $(cat "$POS/crew.log")"
  grep -q 'started PresetsCrew/probe (claude, model=opus\[1m\]) in ' "$POS/crew.log" \
    || fail "(5) crew add receipt does not name the preset-resolved model: $(cat "$POS/crew.log")"
  [ "$(wc -l < "$CREW_CAPTURE")" -eq 2 ] \
    || fail "(5) crew launch must send one literal line and one Enter: $(cat "$CREW_CAPTURE")"
  # The fake harness writes argv first, env second: waiting for argv alone
  # could read env.txt mid-write on correct behavior. Both captures, nonempty.
  for i in {1..100}; do [ -s "$POS/crew-argv.txt" ] && [ -s "$POS/crew-env.txt" ] && break; sleep 0.1; done
  [ -s "$POS/crew-argv.txt" ] && [ -s "$POS/crew-env.txt" ] \
    || fail "(5) crew add never reached the harness in the pane: $(cat "$POS/crew.log")"
  grep -q -- '--model opus\[1m\]' "$POS/crew-argv.txt" \
    || fail "(5) crew dropped the preset's MODEL: $(cat "$POS/crew-argv.txt")"
  grep -q -- '--effort high' "$POS/crew-argv.txt" \
    || fail "(5) crew dropped the preset's non-model param: $(cat "$POS/crew-argv.txt")"
  [ "$(cat "$POS/crew-env.txt")" = "on" ] \
    || fail "(5) crew did not put the preset's env in the child: $(cat "$POS/crew-env.txt")"
  python3 - "$CREW_ROOT" <<'PY' || fail "(5) crew registry row lost the preset tuning"
import json,pathlib,sys
row=json.loads((pathlib.Path(sys.argv[1])/'PresetsCrew/.tap/team-registry.json').read_text())['seats']['probe']
assert row['crew'] is True,row
assert row['harness']=='claude',row
assert row['preset']['name']=='rich',row
assert row['model']=='opus[1m]',row
PY
)

# --- (6) PUBLIC AND INSTALLED-STYLE ENTRIES USE NATIVE DISCOVERY ------------
# Poison Python: discovery must work without importing the retired reader.
mkdir -p "$WORK/native-bin"
cat > "$WORK/native-bin/python3" <<'SH'
#!/usr/bin/env bash
echo 'unexpected Python dependency' >&2
exit 99
SH
chmod +x "$WORK/native-bin/python3"
ln -s "$ROOT/bin/tap" "$WORK/native-bin/tap"
for entry in "$ROOT/bin/tap" "$WORK/native-bin/tap"; do
  : > "$WORK/route"
  PATH="$WORK/native-bin:$PATH" XDG_CONFIG_HOME="$WORK/cfg" TAP_BUN_ROUTE_TRACE="$WORK/route" \
    "$entry" presets --json > "$WORK/native.json" 2> "$WORK/native.err" \
    || fail "(6) public discovery still depends on Python: $(cat "$WORK/native.err")"
  [ "$(cat "$WORK/native.json")" = "$js" ] || fail "(6) public entry changed catalog JSON"
  grep -q 'native.*presets' "$WORK/route" || fail "(6) presets did not route natively"
done

echo "presets-verb: ok"
