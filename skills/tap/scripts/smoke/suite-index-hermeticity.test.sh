#!/usr/bin/env bash
# suite-index-hermeticity.test.sh — tap-x8ns / tap-lesh: smoke-all pins every
# HOME-resolved machine path (TAP_INDEX_HOME, TAP_SESSION_MANIFEST,
# OPENCODE_DB_PATH, TAP_VERSION_SEEN_PATH) so a live flip marker under the
# admitted HOME cannot receive enroll writes / session residue / live opencode
# reads / version-seen growth (the last via expanduser("~"), not $HOME).
#
# Arms:
#   (a) fixed runner + absent fallback stores + registering smoke
#       → fallback registry/version stores remain absent; all
#         four pins present
#   (b) unisolated control (TAP_INDEX_HOME unset) → registry write lands
#   (c) one RED mutation per variable: export survives entry, omitted from
#       worker allowlist → HOME default is used (mutant workers do NOT
#       self-guard; they proceed to the leak so the decisive branch is live)
#
# Suite seed is marker-ABSENT. Live-arm smokes mint their own fixture markers
# via per-test TAP_INDEX_HOME overrides.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="$ROOT/scripts/smoke-all.sh"
TAP="$ROOT/scripts/tap.sh"
PY="${TAP_PYTHON:-python3}"
# Unpinned HOME-write controls need a team outside system temporary roots.
# Keep scratch in the checkout's ignored tmp/ so enrollment reaches that effect.
mkdir -p "$ROOT/tmp"
WORK="$(mktemp -d "$ROOT/tmp/suite-index-hermeticity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
fail () { echo "suite-index-hermeticity: $1" >&2; exit 1; }

# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

FIXTURE_HOME="$WORK/home"
FIXTURE_LOCKS="$WORK/locks"
REAL_INDEX="$FIXTURE_HOME/.tap"
REAL_REG="$REAL_INDEX/global-registry.json"
REAL_MANIFEST="$REAL_INDEX/sessions.json"
REAL_VERSION_SEEN="$REAL_INDEX/version-seen.json"
REAL_OPENCODE_DB="$FIXTURE_HOME/.local/share/opencode/opencode.db"
FAKE_BIN="$WORK/bin"
mkdir -p "$FIXTURE_HOME" "$FIXTURE_LOCKS" "$REAL_INDEX" \
  "$(dirname "$REAL_OPENCODE_DB")" "$FAKE_BIN"

# These write canaries begin absent. They observe fallback creation without
# pre-populating a store that a copied reference could mistake for operator state.
canary_image() { if [ -e "$1" ]; then shasum -a 256 "$1" | awk '{print $1}'; else printf ABSENT; fi; }
reg_hex() { canary_image "$REAL_REG"; }
seen_hex() { canary_image "$REAL_VERSION_SEEN"; }
BEFORE="$(reg_hex)"
BEFORE_SEEN="$(seen_hex)"
[ "$BEFORE" = ABSENT ] && [ "$BEFORE_SEEN" = ABSENT ] || fail "canary stores were pre-populated"
# This is input to the read-leak arm, not a write canary: it must exist to
# prove an unpinned OPENCODE_DB_PATH can expose the caller's database bytes.
printf 'canary-opencode-db\n' > "$REAL_OPENCODE_DB"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t%s\n' "%301" "${FAKE_SESSION:-idxiso/alice}" "901:301" ;;
      *pane_id*session_name*pid*start_time*|*pane_id*session_name*pid*)
        printf '%s\t%s\t%s\n' "%301" "${FAKE_SESSION:-idxiso/alice}" "901:301" ;;
      *pane_id*session_name*) printf '%s\t%s\n' "%301" "${FAKE_SESSION:-idxiso/alice}" ;;
      *pane_id*) echo "%301" ;;
      *session_name*) echo "${FAKE_SESSION:-idxiso/alice}" ;;
      *pid*start_time*) echo "901:301" ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*) echo "${FAKE_TMUX_PATH:-/tmp}" ;;
      *) echo "" ;;
    esac ;;
  has-session) exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

make_team() {
  local team="$1"
  mkdir -p "$team/.tap/bus/payloads" "$team/.tap/bus/receipts"
  git -C "$team" init -q
  git -C "$team" config user.email "tap@test"
  git -C "$team" config user.name "tap"
  git -C "$team" commit --allow-empty -qm init >/dev/null
}

# make_fixture_suite <dest> <worker> <team> <handle> <mode>
# mode=isolated → self-guards that pins are set and off the real index
# mode=mutant   → NO self-guard; proceeds to the HOME-default leak
make_fixture_suite() {
  local dest="$1" worker="$2" team="$3" handle="$4" mode="$5"
  mkdir -p "$dest/scripts" "$dest/skills/tap/scripts/smoke"
  cp "$SMOKE_ALL" "$dest/scripts/smoke-all.sh"
  cp "$ROOT/scripts/ignored-state-tripwire.py" "$dest/scripts/ignored-state-tripwire.py"
  cp "$ROOT/scripts/suite-slot-run.py" "$dest/scripts/suite-slot-run.py"
  cp "$ROOT/scripts/suite_slot.py" "$dest/scripts/suite_slot.py"
  cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" \
    "$dest/skills/tap/scripts/smoke/smoke-preflight.sh"
  cp "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" \
    "$dest/skills/tap/scripts/smoke/smoke_hermeticity_lint.py"

  git -C "$dest" init -q
  git -C "$dest" config user.email "tap@test"
  git -C "$dest" config user.name "tap"
  git -C "$dest" commit --allow-empty -qm init >/dev/null

  # Worker bodies are written via python (quoted heredoc) so this file stays
  # clean for prose-eval-inventory — unquoted <<EOF templates with $( are the
  # tap-psif class that lint refuses.
  local marker="$WORK/leaked-$worker"
  local session_name
  session_name="$(basename "$team")/$handle"
  "$PY" -B - "$dest/skills/tap/scripts/smoke/${worker}.test.sh" "$mode" \
    "$TAP" "$ROOT" "$FAKE_BIN" "$team" "$session_name" "$worker" "$handle" \
    "$REAL_INDEX" "$REAL_MANIFEST" "$REAL_OPENCODE_DB" "$REAL_VERSION_SEEN" \
    "$marker" <<'PY'
from pathlib import Path
import sys
path, mode, tap, root, fake_bin, team, session_name, worker, handle, \
    real_index, real_manifest, real_opencode, real_seen, marker = sys.argv[1:15]
helpers = f"{root}/skills/tap/scripts/smoke/helpers.sh"
if mode == "isolated":
    body = f"""#!/usr/bin/env bash
set -euo pipefail
TAP={tap!r}
# shellcheck source=helpers.sh
. {helpers!r}
export PATH={fake_bin!r}:"$PATH" TMUX="/fake/tmux/socket"
export FAKE_TMUX_PATH={team!r}
export FAKE_SESSION={session_name!r}
[ -n "${{TAP_INDEX_HOME:-}}" ] || {{ echo "{worker}: TAP_INDEX_HOME unset" >&2; exit 1; }}
[ -n "${{TAP_SESSION_MANIFEST:-}}" ] || {{ echo "{worker}: TAP_SESSION_MANIFEST unset" >&2; exit 1; }}
[ -n "${{OPENCODE_DB_PATH:-}}" ] || {{ echo "{worker}: OPENCODE_DB_PATH unset" >&2; exit 1; }}
[ -n "${{TAP_VERSION_SEEN_PATH:-}}" ] || {{ echo "{worker}: TAP_VERSION_SEEN_PATH unset" >&2; exit 1; }}
case "$TAP_INDEX_HOME" in
  {real_index!r}|$HOME/.tap)
    echo "{worker}: TAP_INDEX_HOME still points at real index: $TAP_INDEX_HOME" >&2
    exit 1 ;;
esac
[ -f "$TAP_INDEX_HOME/global-registry.json" ] \\
  && [ "$(cat "$TAP_INDEX_HOME/global-registry.json")" = '{{"schema":"0.20","teams":{{}}}}' ] \\
  || {{ echo "{worker}: suite index home must start as the born-live seed" >&2; exit 1; }}
[ "$TAP_SESSION_MANIFEST" != {real_manifest!r} ] \\
  || {{ echo "{worker}: TAP_SESSION_MANIFEST still the HOME default" >&2; exit 1; }}
[ "$OPENCODE_DB_PATH" != {real_opencode!r} ] \\
  || {{ echo "{worker}: OPENCODE_DB_PATH still the HOME default" >&2; exit 1; }}
[ ! -f "$OPENCODE_DB_PATH" ] \\
  || {{ echo "{worker}: OPENCODE_DB_PATH must be absent (clean-machine shape)" >&2; exit 1; }}
[ "$TAP_VERSION_SEEN_PATH" != {real_seen!r} ] \\
  || {{ echo "{worker}: TAP_VERSION_SEEN_PATH still the HOME default" >&2; exit 1; }}
(
  cd {team!r}
  unset TAP_HOME
  tap_smoke_quiet "$TAP" in {handle!r} --delivery poll
) || {{ echo "{worker}: tap in failed" >&2; exit 1; }}
echo "{worker}: ok"
"""
else:
    body = f"""#!/usr/bin/env bash
set -euo pipefail
TAP={tap!r}
export PATH={fake_bin!r}:"$PATH" TMUX="/fake/tmux/socket"
export FAKE_TMUX_PATH={team!r}
export FAKE_SESSION={session_name!r}
case {worker!r} in
  *-index|*-seen)
    (
      cd {team!r}
      unset TAP_HOME
      "$TAP" in {handle!r} --delivery poll >/dev/null
    ) || {{ echo "{worker}: tap in failed" >&2; exit 1; }}
    ;;
  *-manifest)
    target="${{TAP_SESSION_MANIFEST:-$HOME/.tap/sessions.json}}"
    mkdir -p "${{target%/*}}"
    printf '%s\\n' '{{"sessions":[{{"name":"leaked-mutant"}}]}}' > "$target"
    ;;
  *-opencode)
    resolved="${{OPENCODE_DB_PATH:-$HOME/.local/share/opencode/opencode.db}}"
    [ -f "$resolved" ] || {{ echo "{worker}: expected HOME-default opencode db at $resolved" >&2; exit 1; }}
    grep -q 'canary-opencode-db' "$resolved" \\
      || {{ echo "{worker}: HOME-default db is not the canary" >&2; exit 1; }}
    ;;
  *) echo "{worker}: unknown mutant kind" >&2; exit 1 ;;
esac
printf 'leaked\\n' > {marker!r}
echo "{worker}: leaked"
"""
Path(path).write_text(body)
PY
  chmod +x "$dest/skills/tap/scripts/smoke/${worker}.test.sh"
}

run_inner_suite() {
  local dest="$1" out="$2"
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" \
    LANG="C" \
    LC_CTYPE="en_US.UTF-8" \
    TZ="UTC" \
    TAP_PYTHON="$PY" \
    TAP_SUITE_SLOT="bypass" \
    TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
    bash "$dest/scripts/smoke-all.sh" -j 1 \
    >"$out" 2>&1
}

drop_worker_allowlist_var() {
  # <smoke-all-path> <VARNAME> — keep entry admit, remove from worker for-name list
  local path="$1" var="$2"
  "$PY" -B - "$path" "$var" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
var = sys.argv[2]
text = p.read_text()
# Worker allowlist entries look like: "    VARNAME \\\n"
needle = f"    {var} \\\n"
if needle not in text:
    # last item before `do` may lack trailing space-backslash in some forms;
    # our list always uses the backslash continuation form.
    raise SystemExit(f"worker allowlist line for {var} not found")
# Remove only the FIRST worker-list occurrence after 'for name in'
idx = text.find("for name in \\")
if idx < 0:
    raise SystemExit("worker for-name loop not found")
pre, post = text[:idx], text[idx:]
if needle not in post:
    raise SystemExit(f"worker allowlist line for {var} not found after for-name")
post = post.replace(needle, "", 1)
p.write_text(pre + post)
PY
  grep -q "clean_env+=(\"${var}=" "$path" \
    || fail "mutation removed entry admit for $var"
  ! grep -q "$var" <<<"$(awk '/for name in \\/,/^  do$/' "$path")" \
    || fail "$var still in worker allowlist after mutation"
}


# ── tap-52ys: the four per-variable mutation arms removed (2026-08-14) ──────
# grok's ≤2: (a) the fixed runner leaves the operator's real global registry
# untouched, and (b) the unisolated control PROVES the check can fail — without
# (b), (a) is satisfied by a probe that never writes anything at all. That pair
# is the bidirectional statement; the four per-variable mutants (dropping each
# allowlist var in turn) re-proved it once per variable.
#
# Accepted gap, named: a NEW HOME-resolved variable added to the worker
# allowlist without an entry in the entry allowlist will not be caught here.

# --- (a) fixed runner leaves real global-registry untouched ------------------
TEAM_A="$WORK/idxiso"
make_team "$TEAM_A"
FIX_A="$WORK/repo-a"
make_fixture_suite "$FIX_A" "index-isolated-worker" "$TEAM_A" "alice" "isolated"
run_inner_suite "$FIX_A" "$WORK/isolated.out" \
  || { echo "suite-index-hermeticity: (a) inner suite failed" >&2; cat "$WORK/isolated.out" >&2; exit 1; }
grep -q 'TAP_INDEX_HOME=' "$WORK/isolated.out" \
  || fail "smoke-all did not announce TAP_INDEX_HOME"
grep -q 'TAP_SESSION_MANIFEST=' "$WORK/isolated.out" \
  || fail "smoke-all did not announce TAP_SESSION_MANIFEST"
grep -q 'OPENCODE_DB_PATH=' "$WORK/isolated.out" \
  || fail "smoke-all did not announce OPENCODE_DB_PATH"
grep -q 'TAP_VERSION_SEEN_PATH=' "$WORK/isolated.out" \
  || fail "smoke-all did not announce TAP_VERSION_SEEN_PATH"
[ "$(reg_hex)" = "$BEFORE" ] \
  || fail "(a) isolated run mutated \$HOME/.tap/global-registry.json"
[ "$(seen_hex)" = "$BEFORE_SEEN" ] \
  || fail "(a) isolated run mutated \$HOME/.tap/version-seen.json"
[ ! -f "$REAL_MANIFEST" ] \
  || fail "(a) isolated run wrote \$HOME/.tap/sessions.json"
echo "suite-index-hermeticity: (a) fixed runner leaves real global-registry untouched: ok"

# --- (d) SIBLING isolation: one file's marker is invisible to the next -------
#
# (a) proves the suite index is off the real HOME index. It does NOT prove the
# files are isolated from EACH OTHER, and they were not: TAP_INDEX_HOME was one
# directory per RUN handed to every worker, so the first smoke to publish a flip
# marker made every later smoke read the machine as post-flip. Their ephemeral
# teams are absent from that marker, so they resolved `unreachable` and refused
# with "acting registry unreachable — refusing tap team against a bus decoy".
# Measured on a large change: 52 regressions spread across the alphabet, order-
# dependent, which is why it read as intermittence rather than as one defect.
#
# Two files at -j 1, ordered by name: idx1pub publishes a marker into its own
# index; idx2obs is an ordinary isolated worker, whose EXISTING precondition
# already asserts its index is exactly the born-live seed (an empty 0.20
# marker). That precondition is the whole
# control — no new abstraction, and it fails for the right reason if the
# isolation regresses (partner review's ruling).
TEAM_D="$WORK/idxsib"
make_team "$TEAM_D"
FIX_D="$WORK/repo-d"
make_fixture_suite "$FIX_D" "idx2obs" "$TEAM_D" "carol" "isolated"
# The publisher is written directly rather than through make_fixture_suite: it
# needs no team and no tap invocation. The runner owes isolation to any file
# that publishes, whatever caused it to publish, so tying this to one verb would
# make it stop testing isolation the moment that verb changed.
# The publisher reports through a FILE, not stdout. A passing smoke writes to its
# own per-file log, not to the aggregate the outer test reads -- so grepping the
# suite output for its message reported "publisher did not run" for a publisher
# that ran fine. The sentinel path is baked in at write time, as the existing
# fixtures bake theirs, because the inner suite runs under env -i and inherits
# nothing from here.
make_publisher() { # <dest> <sentinel>
  "$PY" -B - "$1/skills/tap/scripts/smoke/idx1pub.test.sh" "$2" <<'PY'
from pathlib import Path
import sys
path, sentinel = sys.argv[1:3]
Path(path).write_text(f"""#!/usr/bin/env bash
set -euo pipefail
[ -n "${{TAP_INDEX_HOME:-}}" ] || {{ echo "idx1pub: TAP_INDEX_HOME unset" >&2; exit 1; }}
mkdir -p "$TAP_INDEX_HOME"
printf '%s %s %s\\n' "$TAP_INDEX_HOME" \\
  "$([ -d "$TAP_INDEX_HOME" ] && echo existed || echo missing)" \\
  "$(if [ ! -e "$TAP_INDEX_HOME/global-registry.json" ]; then echo unseeded; elif [ "$(cat "$TAP_INDEX_HOME/global-registry.json")" = '{{"schema":"0.20","teams":{{}}}}' ]; then echo seed; else echo premarked; fi)" > {sentinel!r}
printf '{{"schema":"0.20","teams":{{"idx1pub":{{"root":"/nonexistent"}}}}}}\\n' >"$TAP_INDEX_HOME/global-registry.json"
echo "idx1pub: published an enrolled marker into its own index"
""")
PY
  chmod +x "$1/skills/tap/scripts/smoke/idx1pub.test.sh"
}
PUB_RAN_D="$WORK/idx1pub-ran-d"
make_publisher "$FIX_D" "$PUB_RAN_D"

run_inner_suite "$FIX_D" "$WORK/sibling.out" \
  || { echo "suite-index-hermeticity: (d) inner suite failed" >&2; cat "$WORK/sibling.out" >&2; exit 1; }
[ -f "$PUB_RAN_D" ] \
  || fail "(d) the publisher did not run — the observer proved nothing"
# And the two indexes must differ, or (d) passed only because the publisher had
# not written yet rather than because the files are isolated.
[ "$(cut -d" " -f1 "$PUB_RAN_D")" != "$TAP_INDEX_HOME" ] \
  || fail "(d) the publisher shared this index — isolation absent"
echo "suite-index-hermeticity: (d) a sibling marker is invisible to the next file: ok"

# --- (e) RED control for (d): restore the shared index, require the failure ---
#
# Without this, (d) passes on a runner that has no per-file isolation at all,
# because nothing would have published before the observer read. The mutation is
# the incumbent line, so a revert of the fix reproduces the old runner exactly.
FIX_E="$WORK/repo-e"
make_fixture_suite "$FIX_E" "idx2obs" "$TEAM_D" "carol" "isolated"
PUB_RAN_E="$WORK/idx1pub-ran-e"
make_publisher "$FIX_E" "$PUB_RAN_E"
"$PY" -B - "$FIX_E/scripts/smoke-all.sh" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]); t = p.read_text()
# Restore the shared index while retaining allocation of the other private roots.
old = '"TAP_INDEX_HOME=$smoke_file_root/index"'
assert t.count(old) == 1, "mutation anchor missing — (e) would prove nothing"
p.write_text(t.replace(old, '"TAP_INDEX_HOME=$TAP_INDEX_HOME"', 1))
PY
if run_inner_suite "$FIX_E" "$WORK/sibling-red.out"; then
  echo "suite-index-hermeticity: (e) shared-index mutant PASSED — the (d) control cannot see the defect it exists for" >&2
  cat "$WORK/sibling-red.out" >&2
  exit 1
fi
grep -q 'suite index home must start as the born-live seed' "$WORK/sibling-red.out" \
  || fail "(e) mutant failed for an unrelated reason, not the sibling marker"
echo "suite-index-hermeticity: (e) shared-index mutant reds on the sibling marker: ok"

# --- (f) a failed index allocation FAILS the file, it does not run it --------
#
# An unchecked allocation is worse than no isolation: the worker body runs under
# plain bash -c with no errexit, so a failed mktemp left TAP_INDEX_HOME EMPTY,
# the smoke still executed, and a PASS row was appended. sandbox-pins.sh does not
# repair that -- its guards test whether the variable is UNSET and an explicitly
# empty value is preserved -- so consumers fall back to the HOME-resolved index
# and the contamination this change removes comes back, reported as a pass
# (review measured exactly that: status 0, body executed,
# index empty, PASS ledger written).
#
# The failure is injected by pointing the allocation at a path that cannot exist,
# which is deterministic and needs no permission games. The publisher fixture is
# reused as the canary BECAUSE it writes a sentinel: an absent sentinel is proof
# the body never ran, which a passing/failing status alone does not establish.
FIX_F="$WORK/repo-f"
make_fixture_suite "$FIX_F" "idx2obs" "$TEAM_D" "carol" "isolated"
PUB_RAN_F="$WORK/idx1pub-ran-f"
make_publisher "$FIX_F" "$PUB_RAN_F"
"$PY" -B - "$FIX_F/scripts/smoke-all.sh" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]); t = p.read_text()
old = 'mktemp -d "$TAP_SUITE_SANDBOX/f.XXXXXX" 2>/dev/null'
assert t.count(old) == 1, "allocation anchor missing — (f) would prove nothing"
p.write_text(t.replace(old, 'mktemp -d "/nonexistent-allocation-control/file.XXXXXX" 2>/dev/null', 1))
PY
if run_inner_suite "$FIX_F" "$WORK/alloc-fail.out"; then
  echo "suite-index-hermeticity: (f) a failed index allocation still PASSED the run — isolation can vanish silently" >&2
  cat "$WORK/alloc-fail.out" >&2
  exit 1
fi
[ ! -f "$PUB_RAN_F" ] \
  || fail "(f) the smoke body RAN despite a failed index allocation — it must never execute without isolation"
grep -q 'could not allocate per-file state' "$WORK/alloc-fail.out" \
  || fail "(f) the run failed without naming the allocation failure — a setup failure must be attributable"
echo "suite-index-hermeticity: (f) failed allocation fails the file and never runs it: ok"

# --- (g) normal allocation still mints a FRESH directory per invocation ------
# Born live: fresh means exactly the empty seed marker, never a sibling's team.
# Read what the publisher OBSERVED, not what survives: the inner suite sandbox is
# reaped when its run ends, so the allocated directory is legitimately gone by the
# time this arm looks. The first cut asserted -d on it and failed for exactly that
# reason — the runner was right and the assertion was unobservable after the fact.
_g_path="$(cut -d" " -f1 "$PUB_RAN_D")"
_g_existed="$(cut -d" " -f2 "$PUB_RAN_D")"
_g_clean="$(cut -d" " -f3 "$PUB_RAN_D")"
[ "$_g_existed" = existed ] \
  || fail "(g) the per-file index did not exist when the worker ran — allocation minted nothing"
[ "$_g_clean" = seed ] \
  || fail "(g) the per-file index was '$_g_clean', not the born-live seed — not a fresh directory"
case "$_g_path" in
  */f.*/index) echo "suite-index-hermeticity: (g) normal allocation minted a fresh per-invocation directory: ok" ;;
  *) fail "(g) the per-file index is not a minted directory: $_g_path" ;;
esac

# --- (b) unisolated control: unset TAP_INDEX_HOME → write lands --------------
TEAM_B="$WORK/leak"
make_team "$TEAM_B"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/tmux/socket"
export FAKE_TMUX_PATH="$TEAM_B" FAKE_SESSION="leak/bob"
export HOME="$FIXTURE_HOME"
unset TAP_INDEX_HOME
unset TAP_HOME
(
  cd "$TEAM_B"
  tap_smoke_quiet "$TAP" in bob --delivery poll
) || fail "(b) unisolated tap in bob failed"
[ "$(reg_hex)" != "$BEFORE" ] \
  || fail "(b) unisolated control did not write \$HOME/.tap/global-registry.json"
"$PY" -B - "$REAL_REG" <<'PY'
import json, sys
assert "leak" in (json.load(open(sys.argv[1])).get("teams") or {}), "leak team missing"
PY
echo "suite-index-hermeticity: (b) unisolated control writes real global-registry: ok"

echo "suite-index-hermeticity: ok"
