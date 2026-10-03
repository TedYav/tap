#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export TAP_CLAUDE_HOME="$WORK/empty-claude"

ok=0
bad=0
fail() { echo "setup-repo-hardening: FAIL $1" >&2; bad=$((bad + 1)); }
pass() { echo "setup-repo-hardening: ($1) $2: ok"; ok=$((ok + 1)); }

fresh_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
}

run_repo() {
  local dir="$1" flag="$2" scope="$3" rc=0
  (cd "$dir" && env -u TAP_HOME "$TAP" setup $flag >"$scope/out" 2>"$scope/err") || rc=$?
  echo "$rc"
}

no_tmp_residue() {
  local dir="$1" found=""
  found="$(ls "$dir"/.AGENTS.md.* 2>/dev/null || true)"
  [ -z "$found" ]
}

ino_of() {
  python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_ino)' "$1"
}

lino_of() {
  python3 -c 'import os,sys; print(os.lstat(sys.argv[1]).st_ino)' "$1"
}

SCOPE1="$WORK/write-through"
mkdir -p "$SCOPE1/real"
printf 'operator notes below\n' > "$SCOPE1/real/AGENTS.md"
fresh_repo "$SCOPE1/repo"
ln -s ../real/AGENTS.md "$SCOPE1/repo/AGENTS.md"
RC1="$(run_repo "$SCOPE1/repo" --repo "$SCOPE1")"
[ "$RC1" = 0 ] || fail "arm1 symlink rc=$RC1 (want 0)"
[ -L "$SCOPE1/repo/AGENTS.md" ] || fail "arm1 repo/AGENTS.md no longer a symlink (typechange)"
grep -q '<!-- TAP:BEGIN -->' "$SCOPE1/real/AGENTS.md" || fail "arm1 target missing TAP:BEGIN marker"
no_tmp_residue "$SCOPE1/repo" || fail "arm1 temp residue in repo"
grep -qF 'real/AGENTS.md' "$SCOPE1/out" || fail "arm1 stdout does not name the target"
if [ "$bad" = 0 ]; then pass 1 "setup --repo writes through a regular single-link symlinked target"; fi

SCOPE2="$WORK/hard-link"
fresh_repo "$SCOPE2"
printf 'plain notes\n' > "$SCOPE2/AGENTS.md"
ln "$SCOPE2/AGENTS.md" "$SCOPE2/AGENTS.alias"
RC2="$(run_repo "$SCOPE2" --repo "$SCOPE2")"
[ "$RC2" = 2 ] || fail "arm2 hard link rc=$RC2 (want 2)"
[ "$(ino_of "$SCOPE2/AGENTS.md")" = "$(ino_of "$SCOPE2/AGENTS.alias")" ] || fail "arm2 inode split (names no longer hard-linked)"
if grep -q '<!-- TAP:BEGIN -->' "$SCOPE2/AGENTS.md"; then fail "arm2 AGENTS.md gained the marker"; fi
if grep -q '<!-- TAP:BEGIN -->' "$SCOPE2/AGENTS.alias"; then fail "arm2 alias gained the marker"; fi
grep -q 'hard link' "$SCOPE2/err" || fail "arm2 stderr does not name the hard link"
if [ "$bad" = 0 ]; then pass 2 "hard-linked AGENTS.md refuses with exit 2 and no split"; fi

SCOPE3="$WORK/dangling"
fresh_repo "$SCOPE3"
ln -s missing "$SCOPE3/AGENTS.md"
RC3="$(run_repo "$SCOPE3" --repo "$SCOPE3")"
[ "$RC3" = 2 ] || fail "arm3 dangling rc=$RC3 (want 2)"
[ -L "$SCOPE3/AGENTS.md" ] || fail "arm3 dangling link not preserved"
[ ! -e "$SCOPE3/missing" ] || fail "arm3 dangling target was created"
grep -q 'does not exist' "$SCOPE3/err" || fail "arm3 stderr does not name the missing target"
if [ "$bad" = 0 ]; then pass 3 "dangling symlink refuses with exit 2 and creates nothing"; fi

SCOPE4="$WORK/yes-through"
mkdir -p "$SCOPE4/real"
printf 'operator notes below\n' > "$SCOPE4/real/AGENTS.md"
fresh_repo "$SCOPE4/repo"
ln -s ../real/AGENTS.md "$SCOPE4/repo/AGENTS.md"
RC4="$(run_repo "$SCOPE4/repo" --yes "$SCOPE4")"
[ "$RC4" = 0 ] || fail "arm4 --yes rc=$RC4 (want 0)"
[ -L "$SCOPE4/repo/AGENTS.md" ] || fail "arm4 --yes typechanged the link"
grep -q '<!-- TAP:BEGIN -->' "$SCOPE4/real/AGENTS.md" || fail "arm4 --yes target missing marker"
no_tmp_residue "$SCOPE4/repo" || fail "arm4 temp residue in repo"
if [ "$bad" = 0 ]; then pass 4 "the same write-through policy holds under --yes"; fi

SCOPE5="$WORK/absent"
fresh_repo "$SCOPE5"
RC5="$(run_repo "$SCOPE5" --repo "$SCOPE5")"
[ "$RC5" = 0 ] || fail "arm5 absent rc=$RC5 (want 0)"
[ -f "$SCOPE5/AGENTS.md" ] && [ ! -L "$SCOPE5/AGENTS.md" ] || fail "arm5 AGENTS.md not created as a regular file"
grep -q '<!-- TAP:BEGIN -->' "$SCOPE5/AGENTS.md" || fail "arm5 created file missing marker"
if [ "$bad" = 0 ]; then pass 5 "absent AGENTS.md still takes the ordinary create path"; fi

SCOPE6="$WORK/non-regular"
mkdir -p "$SCOPE6/real-dir"
fresh_repo "$SCOPE6/repo"
ln -s ../real-dir "$SCOPE6/repo/AGENTS.md"
RC6="$(run_repo "$SCOPE6/repo" --repo "$SCOPE6")"
[ "$RC6" = 2 ] || fail "arm6 non-regular target rc=$RC6 (want 2)"
[ -L "$SCOPE6/repo/AGENTS.md" ] || fail "arm6 link not preserved"
[ -d "$SCOPE6/real-dir" ] || fail "arm6 target directory disturbed"
if [ "$bad" = 0 ]; then pass 6 "symlink to a non-regular target refuses with exit 2"; fi

SCOPE7="$WORK/linked-link"
mkdir -p "$SCOPE7/real"
printf 'plain notes\n' > "$SCOPE7/real/AGENTS.md"
fresh_repo "$SCOPE7/repo"
ln -s ../real/AGENTS.md "$SCOPE7/repo/AGENTS.md"
python3 -c 'import os, sys; os.link(sys.argv[1], sys.argv[2], follow_symlinks=False)' "$SCOPE7/repo/AGENTS.md" "$SCOPE7/repo/AGENTS.alias"
RC7="$(run_repo "$SCOPE7/repo" --repo "$SCOPE7")"
[ "$RC7" = 2 ] || fail "arm7 hard-linked symlink rc=$RC7 (want 2)"
[ -L "$SCOPE7/repo/AGENTS.md" ] || fail "arm7 AGENTS.md no longer a symlink"
[ -L "$SCOPE7/repo/AGENTS.alias" ] || fail "arm7 AGENTS.alias no longer a symlink"
[ "$(lino_of "$SCOPE7/repo/AGENTS.md")" = "$(lino_of "$SCOPE7/repo/AGENTS.alias")" ] || fail "arm7 symlink inode split (names no longer hard-linked)"
grep -q 'hard-linked names' "$SCOPE7/err" || fail "arm7 stderr does not name the hard-linked symlink"
grep -q 'ambiguous linked path' "$SCOPE7/err" || fail "arm7 stderr does not name the ambiguity"
if grep -q '<!-- TAP:BEGIN -->' "$SCOPE7/real/AGENTS.md"; then fail "arm7 target gained the marker"; fi
if [ "$bad" = 0 ]; then pass 7 "a hard-linked symlink path refuses with exit 2 and leaves every name undisturbed"; fi

SCOPE8="$WORK/check-through"
fresh_repo "$SCOPE8"
RC8W="$(run_repo "$SCOPE8" --repo "$SCOPE8")"
[ "$RC8W" = 0 ] || fail "arm8 seeding write rc=$RC8W (want 0)"
ln "$SCOPE8/AGENTS.md" "$SCOPE8/AGENTS.alias"
cp "$SCOPE8/AGENTS.alias" "$SCOPE8/alias.before"
RC8="$(run_repo "$SCOPE8" "--repo --check" "$SCOPE8")"
[ "$RC8" = 0 ] || fail "arm8 check through hard link rc=$RC8 (want 0)"
grep -q 'is current' "$SCOPE8/out" || fail "arm8 check does not report current"
[ "$(ino_of "$SCOPE8/AGENTS.md")" = "$(ino_of "$SCOPE8/AGENTS.alias")" ] || fail "arm8 check split the hard link"
cmp -s "$SCOPE8/alias.before" "$SCOPE8/AGENTS.alias" || fail "arm8 alias changed under check"
cmp -s "$SCOPE8/alias.before" "$SCOPE8/AGENTS.md" || fail "arm8 AGENTS.md changed under check"
no_tmp_residue "$SCOPE8" || fail "arm8 temp residue"
if [ "$bad" = 0 ]; then pass 8 "--check reads through a hard-linked path and reports current without touching either name"; fi

SCOPE9="$WORK/non-tty-eof"
fresh_repo "$SCOPE9"
RC9=0
(cd "$SCOPE9" && printf '' | env -u TAP_HOME "$TAP" setup >"$SCOPE9/out" 2>"$SCOPE9/err") || RC9=$?
[ "$RC9" = 0 ] || fail "arm9 EOF rc=$RC9 (want 0)"
[ ! -e "$SCOPE9/AGENTS.md" ] || fail "arm9 EOF wrote AGENTS.md"
grep -q 'skipped AGENTS.md signpost' "$SCOPE9/out" || fail "arm9 stdout does not say skipped"
if [ "$bad" = 0 ]; then pass 9 "EOF is no answer, not the affirmative default"; fi

SCOPE10="$WORK/non-tty-newline"
fresh_repo "$SCOPE10"
RC10=0
(cd "$SCOPE10" && printf '\n' | env -u TAP_HOME "$TAP" setup >"$SCOPE10/out" 2>"$SCOPE10/err") || RC10=$?
[ "$RC10" = 0 ] || fail "arm10 newline rc=$RC10 (want 0)"
[ ! -e "$SCOPE10/AGENTS.md" ] || fail "arm10 newline through a pipe wrote AGENTS.md"
[ ! -e "$SCOPE10/.tap/config" ] || fail "arm10 newline through a pipe wrote .tap/config"
grep -q 'skipped AGENTS.md signpost' "$SCOPE10/out" || fail "arm10 stdout does not say skipped"
if [ "$bad" = 0 ]; then pass 10 "a newline without a terminal never reaches the default"; fi

SCOPE11="$WORK/tty-default"
fresh_repo "$SCOPE11"
cat > "$WORK/tty-probe.py" <<'PY'
import os, pty, select, subprocess, sys, time
tap, scope = sys.argv[1], sys.argv[2]
env = dict(os.environ)
env.pop("TAP_HOME", None)
master, slave = pty.openpty()
child = subprocess.Popen([tap, "setup"], cwd=scope, env=env, stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b""
def until(needle):
    global output
    deadline = time.monotonic() + 15
    while needle not in output:
        if time.monotonic() > deadline: raise AssertionError(output.decode(errors="replace"))
        if select.select([master], [], [], 0.1)[0]:
            try: chunk = os.read(master, 65536)
            except OSError: break
            if not chunk: break
            output += chunk
try:
    # setup defers init's signpost offer, then asks its own two questions.
    until(b"successfully initialized team: tty-default")
    until(b"Install TAP AGENTS.md signpost? [Y/n]"); os.write(master, b"\n")
    until(b"Write .tap/config template? [Y/n]"); os.write(master, b"n\n")
    until(b"tap setup: ready")
    if child.poll() is None: child.wait(timeout=10)
    assert child.returncode == 0, output.decode(errors="replace")
    print(output.decode(errors="replace"))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
PY
RC11=0
OUT11="$(python3 "$WORK/tty-probe.py" "$TAP" "$SCOPE11")" || RC11=$?
[ "$RC11" = 0 ] || fail "arm11 pty rc=$RC11 (want 0)"
grep -qF 'signpost? [Y/n]' <<<"$OUT11" || fail "arm11 signpost prompt does not offer the affirmative default"
grep -qF 'template? [Y/n]' <<<"$OUT11" || fail "arm11 template prompt does not offer the affirmative default"
grep -q 'wrote AGENTS.md TAP signpost' <<<"$OUT11" || fail "arm11 Enter did not take the default and write the signpost"
grep -q '<!-- TAP:BEGIN -->' "$SCOPE11/AGENTS.md" || fail "arm11 AGENTS.md missing the marker"
[ ! -e "$SCOPE11/.tap/config" ] || fail "arm11 declining the template still wrote .tap/config"
if [ "$bad" = 0 ]; then pass 11 "pty Enter accepts the signpost; explicit decline leaves the template absent"; fi

SCOPE12="$WORK/symlink-loop"
fresh_repo "$SCOPE12"
ln -s AGENTS.md "$SCOPE12/AGENTS.md"
RC12="$(run_repo "$SCOPE12" --repo "$SCOPE12")"
[ "$RC12" = 2 ] || fail "arm12 symlink loop rc=$RC12 (want 2)"
[ -L "$SCOPE12/AGENTS.md" ] || fail "arm12 self-link not preserved"
grep -q 'could not be resolved' "$SCOPE12/err" || fail "arm12 stderr does not name the loop"
if grep -q 'Traceback' "$SCOPE12/err"; then fail "arm12 traceback leaked"; fi
no_tmp_residue "$SCOPE12" || fail "arm12 temp residue"
if [ "$bad" = 0 ]; then pass 12 "a cyclic symlink refuses with exit 2 and no traceback"; fi

[ "$bad" = 0 ] || { echo "setup-repo-hardening: $bad assertion(s) failed" >&2; exit 1; }
echo "setup-repo-hardening: setup --repo writes through a regular single-link target and refuses the rest"
