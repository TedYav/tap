#!/usr/bin/env bash
# admin-rebuild-registry.test.sh — recover pane seats after a registry nuke.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# Physical paths: the live marker enrolls realpaths, and assertions below compare them.
WORK="$(cd "$(mktemp -d)" && pwd -P)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index" PATH="$FAKE_BIN:$PATH"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  list-panes)
    # tap-ua9l re-gate: this fake ECHOES THE REQUESTED FORMAT with placeholder
    # substitution, exactly as real tmux does, and composes NOTHING of its own.
    # That distinction is the whole point of the fixture. The previous version
    # read the format only to decide whether to add a column and then emitted
    # its own record with its own separators, so it answered a caller who had
    # asked for literal backslash-t with real tabs — and the smoke stayed green
    # over the very defect it exists to catch (tmux does not expand escapes in
    # a format; a single-quoted \t reaches the reader as two characters and
    # IFS=$'\t' splits nothing). Substituting into the caller's own string
    # means the SEPARATORS come from the caller, so a wrongly-quoted format now
    # produces a record the reader cannot split, which is what real tmux does.
    #
    # The FAKE_TMUX_PANES fixtures stay semantic (address, id, command, path),
    # tab-separated as the fake's own input representation; what leaves this
    # process is the format string with those values substituted in.
    # FAKE_SWEEP_EPOCH_RAW lets the sweep record and the later standalone probe
    # disagree, which is a server rebirth landing mid-command.
    shift
    _fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -F) _fmt="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    _epoch="${FAKE_SWEEP_EPOCH_RAW-${FAKE_EPOCH_RAW-900:100}}"
    printf '%s\n' "$FAKE_TMUX_PANES" | while IFS=$'\t' read -r _addr _pid _cmd _path; do
      [ -n "$_addr" ] || continue
      _out="$_fmt"
      _out="${_out//'#{session_name}:#{window_index}.#{pane_index}'/$_addr}"
      _out="${_out//'#{pane_id}'/$_pid}"
      _out="${_out//'#{pane_current_command}'/$_cmd}"
      _out="${_out//'#{pane_dead}'/0}"
      _out="${_out//'#{pid}:#{start_time}'/$_epoch}"
      _out="${_out//'#{pane_current_path}'/$_path}"
      printf '%s\n' "$_out"
    done
    ;;
  display-message)
    # tap-24f: the sweep stamps rebuilt rows with the SERVER epoch it observed,
    # and consults the same value when deciding whether an existing row's stored
    # pane id is still meaningful. Empty FAKE_EPOCH_RAW simulates an
    # unobservable server.
    for a in "$@"; do
      case "$a" in
        *pid*start_time*) [ -n "${FAKE_EPOCH_RAW-900:100}" ] || exit 1
                          printf '%s\n' "${FAKE_EPOCH_RAW-900:100}"; exit 0 ;;
      esac
    done
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

new_team() {
  mkdir -p "$1/.tap/bus/payloads" "$1/.tap/bus/receipts"
}
index_team() {
  python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$1" "$2" <<'PY'
import json, os, sys
path, name, root = sys.argv[1:4]
os.makedirs(os.path.dirname(path), exist_ok=True)
data = json.load(open(path)) if os.path.exists(path) else {"schema": "0.20", "teams": {}}
data["teams"][name] = {"root": root, "registry_location": os.path.join(root, ".tap/bus/registry.json"),
                       "state": "registered"}
json.dump(data, open(path, "w"), indent=2, sort_keys=True)
PY
}

Alpha="$WORK/Alpha"; Beta="$WORK/Beta"
new_team "$Alpha"; new_team "$Beta"
index_team Alpha "$Alpha"; index_team Beta "$Beta"
cat > "$Alpha/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Alpha"},"seats":{"pollbot":{"status":"active","delivery":"poll","wake_url":"https://example.test/poll"},"stale":{"status":"active","pane":"old:0.0","pane_id":"%old","harness":"codex"},"terra":{"status":"active","pane":"old:0.1","pane_id":"%old-terra","harness":"claude"}}}
JSON
cat > "$Beta/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Beta"},"seats":{}}
JSON
export FAKE_TMUX_PANES="$(printf 'Alpha/terra:0.0\t%%101\tcodex\t%s\nBeta/scout:0.0\t%%202\tclaude\t%s' "$Alpha" "$Beta")"

admin_help="$("$TAP" help admin)"
grep -Fq 'rebuild-registry [--yes] [--json]' <<<"$admin_help" \
  || { echo "admin-rebuild: help omits rebuild-registry" >&2; exit 1; }

# Bare rebuild is the preview: it discovers both live pane seats but writes
# neither registry. This must fail until the new admin verb exists.
before_alpha="$(cat "$Alpha/.tap/bus/registry.json")"
preview="$("$TAP" admin rebuild-registry --json)" || { echo "admin-rebuild: preview failed" >&2; echo "$preview" >&2; exit 1; }
printf '%s' "$preview" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["dry_run"] is True, d
assert {(x["team"], x["handle"]) for x in d["planned"]} == {("Alpha", "terra"), ("Beta", "scout")}, d
' || { echo "admin-rebuild: preview shape wrong" >&2; echo "$preview" >&2; exit 1; }
[ "$before_alpha" = "$(cat "$Alpha/.tap/bus/registry.json")" ] || { echo "admin-rebuild: preview mutated Alpha" >&2; exit 1; }

# The DEFAULT (no --json) human render is the invocation an operator actually
# types — and the only coverage this verb had was --json, so its human renderer
# shipped broken: the render step took its program text from a heredoc AND its
# data from a pipe, and a heredoc redirect wins, so `json.load(sys.stdin)` read
# an exhausted stdin and raised a bare traceback (exit 1) instead of the report.
# Assert the human path: exit 0, one line per planned seat, no raw traceback
# (the structured-failure contract), and still non-mutating.
set +e
human="$("$TAP" admin rebuild-registry 2>"$WORK/human.err")"; human_rc=$?
set -e
[ "$human_rc" = 0 ] || { echo "admin-rebuild: default human-mode preview exited $human_rc" >&2; cat "$WORK/human.err" >&2; exit 1; }
! grep -q 'Traceback' "$WORK/human.err" || { echo "admin-rebuild: human mode leaked a python traceback" >&2; cat "$WORK/human.err" >&2; exit 1; }
grep -Fq 'tap admin rebuild-registry: would rebuild Alpha/terra from Alpha/terra:0.0' <<<"$human" \
  || { echo "admin-rebuild: human preview missing Alpha/terra line" >&2; echo "$human" >&2; exit 1; }
grep -Fq 'tap admin rebuild-registry: would rebuild Beta/scout from Beta/scout:0.0' <<<"$human" \
  || { echo "admin-rebuild: human preview missing Beta/scout line" >&2; echo "$human" >&2; exit 1; }
[ "$before_alpha" = "$(cat "$Alpha/.tap/bus/registry.json")" ] || { echo "admin-rebuild: human preview mutated Alpha" >&2; exit 1; }

# The human APPLY path shares that renderer and flips the verb to "rebuilt".
set +e
human_apply="$("$TAP" admin rebuild-registry --yes 2>"$WORK/human-apply.err")"; human_apply_rc=$?
set -e
[ "$human_apply_rc" = 0 ] || { echo "admin-rebuild: human-mode apply exited $human_apply_rc" >&2; cat "$WORK/human-apply.err" >&2; exit 1; }
grep -Fq 'tap admin rebuild-registry: rebuilt Alpha/terra from Alpha/terra:0.0' <<<"$human_apply" \
  || { echo "admin-rebuild: human apply missing rebuilt line" >&2; echo "$human_apply" >&2; exit 1; }

# --yes atomically upserts observable pane truth (including a conflicting stale
# handle) while retaining unobservable poll and dead-pane provenance.
applied="$("$TAP" admin rebuild-registry --yes --json)" || { echo "admin-rebuild: apply failed" >&2; echo "$applied" >&2; exit 1; }
printf '%s' "$applied" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["dry_run"] is False, d
assert {(x["team"], x["handle"]) for x in d["applied"]} == {("Alpha", "terra"), ("Beta", "scout")}, d
' || { echo "admin-rebuild: apply shape wrong" >&2; echo "$applied" >&2; exit 1; }
python3 -B - "$Alpha/.tap/bus/registry.json" "$Beta/.tap/bus/registry.json" <<'PY' || { echo "admin-rebuild: merge invariant broken" >&2; exit 1; }
import json, sys
alpha, beta = [json.load(open(path))["seats"] for path in sys.argv[1:3]]
assert alpha["terra"]["pane_id"] == "%101" and alpha["terra"]["harness"] == "codex", alpha
assert alpha["terra"]["pane"] == "Alpha/terra:0.0", alpha
assert alpha["pollbot"]["delivery"] == "poll", alpha
assert alpha["stale"]["pane_id"] == "%old", alpha
assert beta["scout"]["pane_id"] == "%202" and beta["scout"]["harness"] == "claude", beta
PY

# A driver and crew pane share the driver's tmux session, so session-name
# derivation alone produces fable twice. The stable driver pane identity must
# retain fable and the unregistered crew pane needs a deterministic suffix.
CrewTeam="$WORK/tap"; new_team "$CrewTeam"; index_team tap "$CrewTeam"
cat > "$CrewTeam/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"tap"},"seats":{"fable":{"status":"active","delivery":"pane","pane":"tap/fable:0.0","pane_id":"%601","harness":"claude"}}}
JSON
export FAKE_TMUX_PANES="$(printf 'tap/fable:0.0\t%%601\tclaude\t%s\ntap/fable:1.0\t%%602\tcodex\t%s' "$CrewTeam" "$CrewTeam")"
set +e
crew_result="$($TAP admin rebuild-registry --yes --json 2>&1)"; crew_rc=$?
set -e
[ "$crew_rc" = 0 ] || { echo "admin-rebuild: crew session recovery failed" >&2; echo "$crew_result" >&2; exit 1; }
printf '%s' "$crew_result" | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = {(x["team"], x["handle"], x["pane_id"]) for x in d["applied"]}
assert ("tap", "fable", "%601") in rows, rows
assert ("tap", "fable-2", "%602") in rows, rows
' || { echo "admin-rebuild: crew pane plan was not identity-stable" >&2; echo "$crew_result" >&2; exit 1; }
python3 -B - "$CrewTeam/.tap/bus/registry.json" <<'PY' || { echo "admin-rebuild: crew pane registry write was wrong" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1]))["seats"]
assert agents["fable"]["pane_id"] == "%601", agents
assert agents["fable-2"]["pane_id"] == "%602", agents
PY

# The operator's manual incapable mark is state, not damage: the rebuild may
# refresh the attested pane identity a marked row carries, but the
# suspended/incapable pair survives — public registration stays the only door
# that clears it.
IncapTeam="$WORK/incap"; new_team "$IncapTeam"; index_team incap "$IncapTeam"
cat > "$IncapTeam/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"incap"},"seats":{"scout":{"status":"suspended","status_reason":"incapable","delivery":"pane","pane":"incap/old:0.9","pane_id":"%old-scout","harness":"claude"}}}
JSON
export FAKE_TMUX_PANES="$(printf 'incap/scout:0.0\t%%701\tclaude\t%s' "$IncapTeam")"
incap_result="$($TAP admin rebuild-registry --yes --json)" || { echo "admin-rebuild: incapable preservation run failed" >&2; echo "$incap_result" >&2; exit 1; }
python3 -B - "$IncapTeam/.tap/bus/registry.json" <<'PY' || { echo "admin-rebuild: incapable mark did not survive the rebuild" >&2; cat "$IncapTeam/.tap/bus/registry.json" >&2; exit 1; }
import json, sys
scout = json.load(open(sys.argv[1]))["seats"]["scout"]
assert scout["status"] == "suspended" and scout["status_reason"] == "incapable", scout
assert scout["pane"] == "incap/scout:0.0" and scout["pane_id"] == "%701", scout
assert scout["server_epoch"] == "srv:900:100", scout
PY

# A pane outside every enrolled root is not evidence for any team and must not
# create a row merely because its tmux session name looks team-qualified.
outside="$WORK/outside"; mkdir -p "$outside"
cp "$Alpha/.tap/bus/registry.json" "$WORK/alpha-before-outside.json"
cp "$Beta/.tap/bus/registry.json" "$WORK/beta-before-outside.json"
export FAKE_TMUX_PANES="$(printf 'Alpha/escaped:0.0\t%%401\tcodex\t%s' "$outside")"
outside_result="$($TAP admin rebuild-registry --yes --json)" || { echo "admin-rebuild: outside-root run failed" >&2; echo "$outside_result" >&2; exit 1; }
printf '%s' "$outside_result" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["planned"] == [] and d["applied"] == [], d
' || { echo "admin-rebuild: outside-root pane was planned" >&2; echo "$outside_result" >&2; exit 1; }
cmp -s "$WORK/alpha-before-outside.json" "$Alpha/.tap/bus/registry.json" \
  || { echo "admin-rebuild: outside-root pane mutated Alpha" >&2; exit 1; }
cmp -s "$WORK/beta-before-outside.json" "$Beta/.tap/bus/registry.json" \
  || { echo "admin-rebuild: outside-root pane mutated Beta" >&2; exit 1; }

echo "admin-rebuild: preview is pure; --yes keeps driver identity, suffixes crew panes, and skips outside roots: ok"

# --- tap-24f finding 3: the rebuild must not LAUNDER a stale row's handle ------
# A pane id is only evidence of WHICH SEAT a pane is when the row that recorded
# it belongs to the current tmux server. After a rebirth the numbering restarts,
# so a dead opus row's "%6" can collide with the live fable pane's "%6" — and
# preserving the handle on that collision writes fable's live pane into the
# registry under the name "opus". Rebuild is a RECOVERY command; laundering a
# stranger's pane into a stale identity is the opposite of recovery.
Laundry="$WORK/Laundry"; new_team "$Laundry"; index_team Laundry "$Laundry"
cat > "$Laundry/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Laundry"},"seats":{"opus":{"status":"active","delivery":"pane","pane":"Laundry/opus:0.0","pane_id":"%6","harness":"claude","server_epoch":"srv:800:50"}}}
JSON
export FAKE_TMUX_PANES="$(printf 'Laundry/fable:0.0\t%%6\tclaude\t%s' "$Laundry")"
launder="$($TAP admin rebuild-registry --yes --json)" || { echo "admin-rebuild: laundering run failed" >&2; echo "$launder" >&2; exit 1; }
python3 -B - "$Laundry/.tap/bus/registry.json" <<'PY' || { echo "admin-rebuild: stale-row laundering gate failed" >&2; cat "$Laundry/.tap/bus/registry.json" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1]))["seats"]
# The live pane's identity comes from the LIVE session name, not from the stale
# row that happens to share its recycled id.
assert "fable" in agents, agents
assert agents["fable"]["pane_id"] == "%6", agents
assert agents["fable"]["pane"] == "Laundry/fable:0.0", agents
assert agents["fable"]["server_epoch"] == "srv:900:100", agents
# opus keeps its own (now unobservable) provenance and does NOT acquire the
# live pane. Rebuild is additive: it never deletes a row it cannot observe.
assert agents["opus"]["pane"] == "Laundry/opus:0.0", agents
assert agents["opus"].get("server_epoch") == "srv:800:50", agents
PY
echo "admin-rebuild: a stale row never launders a live stranger's pane into its handle: ok"

# --- tap-24f rollout migration: the fixture the whole migration story rests on -
# Pre-wave rows carry NO epoch stamp, which is exactly the fleet state on the
# day this ships. `tap admin rebuild-registry` is the documented one-time
# migration step, so over unstamped rows whose ids have already been recycled it
# must: derive every handle from the LIVE session sweep, refuse the old pane-id
# carryover, and stamp what it writes with the epoch it observed. If this
# fixture ever goes red, the rollout instructions in CONTRACT.md are wrong.
Migrate="$WORK/Migrate"; new_team "$Migrate"; index_team Migrate "$Migrate"
cat > "$Migrate/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Migrate"},"seats":{"legacy":{"status":"active","delivery":"pane","pane":"Migrate/legacy:0.0","pane_id":"%7","harness":"claude"}}}
JSON
export FAKE_TMUX_PANES="$(printf 'Migrate/scout:0.0\t%%7\tcodex\t%s' "$Migrate")"
migrate="$($TAP admin rebuild-registry --yes --json)" || { echo "admin-rebuild: migration run failed" >&2; echo "$migrate" >&2; exit 1; }
python3 -B - "$Migrate/.tap/bus/registry.json" <<'PY' || { echo "admin-rebuild: unstamped migration rebuild was wrong" >&2; cat "$Migrate/.tap/bus/registry.json" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1]))["seats"]
assert "scout" in agents, agents
assert agents["scout"]["pane_id"] == "%7", agents
assert agents["scout"]["harness"] == "codex", agents
# The stamp is what makes the rebuilt row destructively usable afterwards.
assert agents["scout"]["server_epoch"] == "srv:900:100", agents
# The unstamped legacy row did NOT capture the live pane.
assert agents["legacy"]["pane"] == "Migrate/legacy:0.0", agents
assert agents["legacy"]["harness"] == "claude", agents
PY
echo "admin-rebuild: unstamped rows migrate from the live sweep and gain the current stamp: ok"

# Scratch-only interlock (tap-kf9): rebuild never deletes a row, but --yes still
# REWRITES a registry file per enrolled team, so a caller who declared a scratch
# prefix must not be able to stamp rows into a real team's registry. The bare
# preview writes nothing and stays available. Every case above runs with
# TAP_SCRATCH_ONLY unset and is itself the unchanged-behavior guard.
#
# Scope note, RETIRED by tranche B (tap-ua9l) landing on top of this section.
# This block was written carrying a caveat that no longer holds and would now
# read as false: that the fake tmux above emitted real tabs no matter what -F
# format was asked for, while the production sweep asked with a single-quoted
# '\t' that tmux never expands — so discovery planned zero seats in production
# and this interlock arm could not fire there at all. Both halves are fixed
# above: the fake now echoes the REQUESTED format with placeholder
# substitution, and the sweep asks with an ANSI-C quoted format. Discovery
# therefore produces a real plan and the refusal below is exercised over one.
# The format string itself is pinned by construction rather than by an
# assertion here — the fake takes its separators from the caller, so a
# regression to a non-expanding format makes every case in this file that
# expects a non-empty plan go red.
export FAKE_TMUX_PANES="$(printf 'Alpha/terra:0.0\t%%101\tcodex\t%s' "$Alpha")"
cp "$Alpha/.tap/bus/registry.json" "$WORK/alpha-before-scratch.json"
set +e
scratch_out="$(TAP_SCRATCH_ONLY="$WORK/elsewhere" "$TAP" admin rebuild-registry --yes 2>&1)"; scratch_rc=$?
set -e
[ "$scratch_rc" != 0 ] || { echo "admin-rebuild: --yes must refuse a registry outside the declared scratch prefix" >&2; echo "$scratch_out" >&2; exit 1; }
[[ "$scratch_out" == *"TAP_SCRATCH_ONLY"* ]] || { echo "admin-rebuild: scratch refusal must name the interlock" >&2; echo "$scratch_out" >&2; exit 1; }
[[ "$scratch_out" == *"$Alpha/.tap/bus/registry.json"* ]] || { echo "admin-rebuild: scratch refusal must name the resolved registry" >&2; echo "$scratch_out" >&2; exit 1; }
cmp -s "$WORK/alpha-before-scratch.json" "$Alpha/.tap/bus/registry.json" \
  || { echo "admin-rebuild: a refused apply must not rewrite the registry" >&2; exit 1; }
TAP_SCRATCH_ONLY="$WORK/elsewhere" "$TAP" admin rebuild-registry >/dev/null 2>&1 \
  || { echo "admin-rebuild: the non-writing preview must stay available under a declaration" >&2; exit 1; }
TAP_SCRATCH_ONLY="$WORK" "$TAP" admin rebuild-registry --yes >/dev/null 2>&1 \
  || { echo "admin-rebuild: a covering declaration must permit the apply" >&2; exit 1; }

echo "admin-rebuild: --yes honors TAP_SCRATCH_ONLY and the non-writing preview stays available: ok"

# --- tap-kf9 condition (b): DISCOVERY AND REFUSAL, PROVEN TOGETHER ------------
# The interlock's rebuild arm shipped DORMANT and the merge-time record says so:
# the sweep asked tmux for a single-quoted '\t' that tmux never expands, so
# against a real server it planned ZERO seats, and with an empty plan there is
# no registry for the guard to check. Its only coverage was the section above,
# which proves "GIVEN a discovered plan, the refusal fires" — the plan's
# existence was a premise, not an assertion. Both halves are now real (the
# format is ANSI-C quoted; the fake above echoes the CALLER's format with
# placeholder substitution, so its separators come from the caller exactly as a
# real server's do), so this is the case that could not be written before: one
# fixture in which the sweep is asserted to FIND work and the interlock is
# asserted to REFUSE it.
#
# The fixture is the incident's own shape rather than a single team. The wipe
# that caused tap-kf9 crossed 22 enrolled teams; a plan spanning two roots, only
# ONE of which escapes the declared prefix, is the smallest fixture that can
# tell "refuse before any write" apart from "refuse before writing the offending
# team". The in-prefix team is deliberately planned FIRST, so a guard that
# checked only the plan's first registry — or that checked each registry as it
# reached it in the write loop — would have already rewritten a registry by the
# time it reached the one that escapes. That registry being byte-identical
# afterwards is the assertion that matters; "it exited non-zero" is not.
SANDBOX="$WORK/sandbox"; SandRoot="$SANDBOX/Sand"; VaultRoot="$WORK/vault/Vault"
new_team "$SandRoot"; new_team "$VaultRoot"
index_team Sand "$SandRoot"; index_team Vault "$VaultRoot"
cat > "$SandRoot/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Sand"},"seats":{"resident":{"status":"active","delivery":"poll","wake_url":"https://example.test/sand"}}}
JSON
cat > "$VaultRoot/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Vault"},"seats":{"resident":{"status":"active","delivery":"poll","wake_url":"https://example.test/vault"}}}
JSON
export FAKE_TMUX_PANES="$(printf 'Sand/keeper:0.0\t%%501\tcodex\t%s\nVault/keeper:0.0\t%%502\tclaude\t%s' "$SandRoot" "$VaultRoot")"

# DISCOVERY, asserted rather than assumed — and asserted under the SAME
# declaration that refuses below, so neither half can be green while the other
# is hollow. The non-writing preview is ungated by design, which is what makes
# it usable as the discovery probe here.
combo_preview="$(TAP_SCRATCH_ONLY="$SANDBOX" "$TAP" admin rebuild-registry --json)" \
  || { echo "admin-rebuild: combined-path preview failed" >&2; exit 1; }
printf '%s' "$combo_preview" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["dry_run"] is True, d
rows = [(x["team"], x["handle"], x["pane_id"]) for x in d["planned"]]
# The sweep FOUND WORK: two real seats, each derived from a live pane record
# that the fake emitted by substituting into the format the sweep asked for.
assert rows == [("Sand", "keeper", "%501"), ("Vault", "keeper", "%502")], rows
' || { echo "admin-rebuild: the sweep must discover both seats before the refusal means anything" >&2; echo "$combo_preview" >&2; exit 1; }

cp "$SandRoot/.tap/bus/registry.json" "$WORK/sand.before"
cp "$VaultRoot/.tap/bus/registry.json" "$WORK/vault.before"
set +e
combo_out="$(TAP_SCRATCH_ONLY="$SANDBOX" "$TAP" admin rebuild-registry --yes --json 2>"$WORK/combo.err")"; combo_rc=$?
set -e
[ "$combo_rc" != 0 ] || { echo "admin-rebuild: a plan that escapes the declared prefix must refuse" >&2; echo "$combo_out" >&2; exit 1; }
# The CLASS, not just the prose (the same argument the generation-move case
# makes below): the detail text rides on whatever class is emitted, so grepping
# the message cannot tell scratch_only_refused from a registry_invalid that
# sends the operator off to repair a registry the refusal never touched.
printf '%s' "$combo_out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["ok"] is False, d
assert d["error_class"] == "scratch_only_refused", d
' || { echo "admin-rebuild: the combined-path refusal must carry error_class scratch_only_refused on stdout" >&2; echo "$combo_out" >&2; cat "$WORK/combo.err" >&2; exit 1; }
[[ "$combo_out" == *"$VaultRoot/.tap/bus/registry.json"* ]] \
  || { echo "admin-rebuild: the refusal must name the registry that escaped the prefix" >&2; echo "$combo_out" >&2; exit 1; }
[[ "$combo_out" == *"$SANDBOX"* ]] || { echo "admin-rebuild: the refusal must name the DECLARED prefix" >&2; echo "$combo_out" >&2; exit 1; }
# THE ASSERTION THIS CASE EXISTS FOR. Not "it refused" — that a refused apply
# left REAL STATE byte-identical, including the team the guard had already
# cleared as in-prefix and would have written first.
cmp -s "$WORK/sand.before" "$SandRoot/.tap/bus/registry.json" \
  || { echo "admin-rebuild: a refused apply rewrote the IN-PREFIX team's registry — the guard ran too late" >&2
       diff "$WORK/sand.before" "$SandRoot/.tap/bus/registry.json" >&2 || true; exit 1; }
cmp -s "$WORK/vault.before" "$VaultRoot/.tap/bus/registry.json" \
  || { echo "admin-rebuild: a refused apply rewrote the escaping team's registry" >&2
       diff "$WORK/vault.before" "$VaultRoot/.tap/bus/registry.json" >&2 || true; exit 1; }

# The same discovered plan, under a declaration that covers BOTH roots, applies
# in full — so the refusal above is the prefix talking, not a plan that could
# never have been written.
TAP_SCRATCH_ONLY="$WORK" "$TAP" admin rebuild-registry --yes --json >/dev/null 2>&1 \
  || { echo "admin-rebuild: a declaration covering both roots must permit the same plan" >&2; exit 1; }
python3 -B - "$SandRoot/.tap/bus/registry.json" "$VaultRoot/.tap/bus/registry.json" <<'PY' || { echo "admin-rebuild: the permitted apply did not write both discovered seats" >&2; exit 1; }
import json, sys
sand, vault = [json.load(open(path))["seats"] for path in sys.argv[1:3]]
assert sand["keeper"]["pane_id"] == "%501", sand
assert vault["keeper"]["pane_id"] == "%502", vault
PY
echo "admin-rebuild: the sweep discovers a multi-team plan and the interlock refuses it with every registry byte-unchanged: ok"

# --- tap-ua9l finding 7: a rebirth between the sweep and the write ------------
# The sweep read the panes under generation 900:100; by the time the plan is
# applied the server is 901:200, so every id in the plan belongs to a server
# that is gone. Writing them would stamp dead identity as current — finding 3's
# laundering arriving through time instead of through rows — so the command
# refuses and leaves the registry exactly as it found it.
Drift="$WORK/Drift"; new_team "$Drift"; index_team Drift "$Drift"
cat > "$Drift/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Drift"},"seats":{"resident":{"status":"active","delivery":"pane","pane":"Drift/resident:0.0","pane_id":"%9","harness":"claude","server_epoch":"srv:900:100"}}}
JSON
cp "$Drift/.tap/bus/registry.json" "$WORK/drift.before"
export FAKE_TMUX_PANES="$(printf 'Drift/scout:0.0\t%%20\tcodex\t%s' "$Drift")"
rc=0
drift_out="$(FAKE_SWEEP_EPOCH_RAW=900:100 FAKE_EPOCH_RAW=901:200 $TAP admin rebuild-registry --yes --json 2>&1)" || rc=$?
[ "$rc" != 0 ] || { echo "admin-rebuild: a generation move during the sweep must refuse" >&2; echo "$drift_out" >&2; exit 1; }
grep -q 'generation moved' <<<"$drift_out" || { echo "admin-rebuild: refusal must say the generation moved" >&2; echo "$drift_out" >&2; exit 1; }
# The CLASS, not just the prose: the detail text rides on whatever class is
# emitted, so grepping the message alone cannot tell server_epoch_moved from a
# registry_invalid that misdirects the operator to repair an intact registry.
grep -q '"error_class":"server_epoch_moved"' <<<"$drift_out" || {
  echo "admin-rebuild: refusal must carry error_class server_epoch_moved" >&2; echo "$drift_out" >&2; exit 1; }
grep -q '"action":"tap admin rebuild-registry"' <<<"$drift_out" || {
  echo "admin-rebuild: refusal must tell the operator to rerun, not to repair the registry" >&2
  echo "$drift_out" >&2; exit 1; }
cmp -s "$Drift/.tap/bus/registry.json" "$WORK/drift.before" || {
  echo "admin-rebuild: a refused rebuild must not touch the registry" >&2
  diff "$WORK/drift.before" "$Drift/.tap/bus/registry.json" >&2 || true; exit 1; }
# Same fixture, quiet server: the rebuild lands and stamps what it observed.
FAKE_SWEEP_EPOCH_RAW=901:200 FAKE_EPOCH_RAW=901:200 $TAP admin rebuild-registry --yes --json >/dev/null || {
  echo "admin-rebuild: quiet-server rebuild should still apply" >&2; exit 1; }
python3 -B - "$Drift/.tap/bus/registry.json" <<'PY2' || { echo "admin-rebuild: quiet-server rebuild wrote the wrong stamp" >&2; cat "$Drift/.tap/bus/registry.json" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1]))["seats"]
assert agents["scout"]["server_epoch"] == "srv:901:200", agents
PY2
echo "admin-rebuild: a rebirth between the pane sweep and the write refuses, and writes nothing: ok"

# --- reserved handles never enter the plan (tap-7af) ---------------------------
# rebuild-registry derives handles from LIVE tmux session names, so a session
# literally named "<team>/help" would mint agents.help here — a THIRD claim path,
# independent of tap register and the launcher's claim_pending_handle.
#
# It matters more than the other two, not less: this is the broom operators reach
# for after chaos, so whatever it leaves behind is trusted afterwards. And with
# universal `tap <verb> help` routing on top, a minted `help` seat makes
# `tap poll help` print help instead of polling it.
#
# BEHAVIOURAL, not structural: it stages a live pane and asserts the registry.
# A structural assertion (grep the source for a guard) would pass without the
# rebuild ever running.
Res="$WORK/Res"; new_team "$Res"; index_team Res "$Res"
cat > "$Res/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Res"},"seats":{}}
JSON
export FAKE_TMUX_PANES="$(printf 'Res/help:0.0\t%%777\tcodex\t%s\nRes/scout:0.0\t%%778\tclaude\t%s' "$Res" "$Res")"
reserved_warning="tap admin rebuild-registry: skipping pane 'Res/help:0.0' — derived handle 'help' is the CLI help keyword (so 'tap <verb> help' is unambiguous for every verb) and cannot be a seat handle"

plan="$(FAKE_SWEEP_EPOCH_RAW=902:300 FAKE_EPOCH_RAW=902:300 "$TAP" admin rebuild-registry --json 2>"$WORK/reserved-preview.err")" \
  || { echo "admin-rebuild: reserved-handle preview failed" >&2; exit 1; }
grep -Fqx "$reserved_warning" "$WORK/reserved-preview.err" \
  || { echo "admin-rebuild: reserved-handle preview omitted its refusal warning" >&2; cat "$WORK/reserved-preview.err" >&2; exit 1; }
printf '%s' "$plan" | python3 -c '
import json, sys
d = json.load(sys.stdin)
handles = {(x["team"], x["handle"]) for x in d["planned"]}
assert ("Res", "help") not in handles, f"reserved handle entered the plan: {handles}"
assert ("Res", "scout") in handles, f"the legitimate seat was dropped too: {handles}"
' || { echo "admin-rebuild: reserved handle reached the rebuild plan" >&2; echo "$plan" >&2; exit 1; }

FAKE_SWEEP_EPOCH_RAW=902:300 FAKE_EPOCH_RAW=902:300 "$TAP" admin rebuild-registry --yes --json \
  >/dev/null 2>"$WORK/reserved-apply.err" \
  || { echo "admin-rebuild: reserved-handle apply failed" >&2; exit 1; }
grep -Fqx "$reserved_warning" "$WORK/reserved-apply.err" \
  || { echo "admin-rebuild: reserved-handle apply omitted its refusal warning" >&2; cat "$WORK/reserved-apply.err" >&2; exit 1; }
python3 -B - "$Res/.tap/bus/registry.json" <<'PY3' || { echo "admin-rebuild: reserved handle was WRITTEN to the registry" >&2; cat "$Res/.tap/bus/registry.json" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1]))["seats"]
assert "help" not in agents, f"agents.help was minted by rebuild-registry: {sorted(agents)}"
# CONTROL: the sweep must still have done its job. A guard that skipped every
# row would satisfy the assertion above.
assert "scout" in agents, f"the legitimate seat was not rebuilt: {sorted(agents)}"
PY3
echo "admin-rebuild: a session named <team>/help never mints a reserved handle: ok"

# --- a DECIDED binding survives recovery (tap-68lp) ----------------------------
# rebuild-registry reconstructs rows from OBSERVED tmux state. Its own comment
# says only facts attested by the pane sweep may be written — and
# registered_from_worktree was the one field violating that, because it is
# DECIDED at registration, not observed. Overwriting it regenerates a DERIVED
# binding over a DECIDED one, which is the back door that would have let the
# whole tap-68lp invariant be laundered by a recovery command.
#
# Recovery may RESTORE a missing binding. It may never RE-DECIDE one.
Dec="$WORK/Dec"; new_team "$Dec"; index_team Dec "$Dec"
python3 -B - "$Dec/.tap/bus/registry.json" <<'PYSEED'
import json, sys
json.dump({"schema": "0.20", "team": {"name": "Dec"},
           "seats": {"keeper": {"status": "active", "pane": "old:0.0", "pane_id": "%old",
                                 "harness": "codex",
                                 "registered_from_worktree": "/decided/elsewhere"}}},
          open(sys.argv[1], "w"), indent=2, sort_keys=True)
PYSEED
export FAKE_TMUX_PANES="$(printf 'Dec/keeper:0.0\t%%911\tcodex\t%s' "$Dec")"
FAKE_SWEEP_EPOCH_RAW=903:400 FAKE_EPOCH_RAW=903:400 "$TAP" admin rebuild-registry --yes --json >/dev/null \
  || { echo "admin-rebuild: decided-binding rebuild failed" >&2; exit 1; }
python3 -B - "$Dec/.tap/bus/registry.json" <<'PYCHK' || { echo "admin-rebuild: a DECIDED binding was re-decided by recovery" >&2; cat "$Dec/.tap/bus/registry.json" >&2; exit 1; }
import json, sys
a = json.load(open(sys.argv[1]))["seats"]["keeper"]
assert a["registered_from_worktree"] == "/decided/elsewhere", \
    f"binding was overwritten with the observed root: {a['registered_from_worktree']}"
# CONTROL: the sweep must still have done its job on the observed facts, or this
# would pass for a rebuild that did nothing at all.
assert a["pane_id"] == "%911", f"sweep did not update pane_id: {a}"
PYCHK
echo "admin-rebuild: a decided registered_from_worktree survives recovery: ok"

# --- malformed observation refuses the whole rebuild before any apply --------
Malformed="$WORK/Malformed"; new_team "$Malformed"; index_team Malformed "$Malformed"
cat > "$Malformed/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"Malformed"},"seats":{"keeper":{"status":"active","delivery":"poll"}}}
JSON
malformed_before="$(cat "$Malformed/.tap/bus/registry.json")"
export FAKE_TMUX_PANES="$(printf 'Malformed/scout:0.0\t%%tap-claude\tcodex\t%s' "$Malformed")"
set +e
malformed_out="$(FAKE_SWEEP_EPOCH_RAW=904:500 FAKE_EPOCH_RAW=904:500 "$TAP" admin rebuild-registry --yes --json 2>&1)"
malformed_rc=$?
set -e
[ "$malformed_rc" -ne 0 ] || {
  echo "admin-rebuild: malformed observed pane_id was accepted" >&2
  echo "$malformed_out" >&2
  exit 1
}
[[ "$malformed_out" == *"invalid pane_id"* ]] || {
  echo "admin-rebuild: malformed pane_id refusal did not name the bad field" >&2
  echo "$malformed_out" >&2
  exit 1
}
[ "$malformed_before" = "$(cat "$Malformed/.tap/bus/registry.json")" ] || {
  echo "admin-rebuild: malformed pane_id changed registry bytes" >&2
  exit 1
}
echo "admin-rebuild: malformed observed pane_id refuses before registry apply: ok"
