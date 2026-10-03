#!/usr/bin/env bash
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# embedded-python-heredoc-compile.test.sh — py_compile quoted stdin heredocs
# in BOTH suite buckets (tap-52ys).
#
# SEES: stdin-program-mode invocations of python3, $PY, $TAP_PYTHON,
# ${TAP_PYTHON:-python3}, or $REAL_PYTHON3 (quoted or not). Quoted delimiters
# only: <<'DELIM', <<"DELIM", <<-'DELIM', <<-"DELIM". DELIM is any quoted run,
# not only [A-Za-z0-9_]. Line-continuation is joined before the body starts
# (`|| fail` is still shell). Comment lines are not commands.
#
# STDIN-PROGRAM MODE (T10). Compile a heredoc only when it is python3's
# program: the first positional argument is absent or the token `-`. A
# short cluster naming `c` or `m` (`-c`, `-m`, `-Sc`, `-Bm`, attached
# forms) means the program is elsewhere; long options are left alone
# (`--check-hash-based-pycs` contains `c` and is unaffected). Other
# dashed tokens are treated as no-operand flags — that is the
# proposition, not python3's option grammar. Not claimed: operand-taking
# options (`-W`, `-X`) — those look like a script path and we skip. A
# non-program heredoc is still consumed through its closer so its body
# is not re-lexed as shell.
#
# `<<-` SEMANTICS (bash): leading tabs — not spaces — are stripped from every
# body line and from the closer before the interpreter sees the bytes. This
# sweeper strips leading tabs the same way; compiling the file's raw indent is a
# false red on valid code. Spaces-only indent is left intact.
#
# Other quoted-heredoc behaviour between delimiter and interpreter, enumerated:
# no parameter/command/arithmetic expansion (stored bytes ARE the body — we
# compile them); backslash is literal; closer is the first exact delimiter line
# (tab-prefixed only under `<<-`); delimiter line is not part of the body.
# Not claimed, not reproduced: unquoted <<DELIM (expands); backslash-quoted
# <<\\DELIM; CRLF/CR stripping; here-strings (<<<).
#
# ZERO-SPACE SPELLING (tap-iizaq). `python3<<'PY'` (no whitespace before `<<`) is valid
# bash and is swept: the argv group is optional, an empty argv is stdin-program mode.
# The command boundary is unchanged, so `python3x<<'PY'`, `mypython3<<'PY'` and the
# here-string `python3<<<'x'` are still not invocations.
#
# DOES NOT SEE: unquoted <<DELIM; python3 -c / -m / -Sc / -Bm / script-file
# (stdin is data, not source); cat-written interpreter stubs; any other
# $VAR that happens to hold python.
#
# DISCLOSURE — `echo python3 - <<'DATA'` (also cat/printf) false-REDs.
# The left boundary is `[\s;|&({]`, so whitespace is a command separator
# and argument-position python3 extracts DATA as source. Tightening to
# `;|&({` traded that class for quoted-separator false-REDs (`printf '%s\n'
# "; python3 - <<'DATA'"`). Quote-masking then lost 29 real invocations.
# Both character-class candidates measured indistinguishable in-tree
# (479=479 on main, 474=474 on the then-head), so this PR reverts and
# discloses. A corpus scan proves the change breaks nothing that exists;
# it says nothing about what the rule means — the echo shape is not in
# the corpus. Three boundaries have now passed one. The axis is closed
# to character classes.
#
# BYTECODE. py_compile gets cfile beside the temp source so the .pyc does
# not land in TMPDIR/__pycache__ (on a gate run that is /tmp/__pycache__,
# shared machine state the post-wave guard notices). Both files go in the
# same finally.
#
# THE DEFECT THIS PREVENTS. A fixture glob sweep stripped three quote-escapes
# inside a quoted python stdin heredoc in smoke/server-epoch-guard.test.sh.
# `bash -n` parsed the shell; ci-sanity's py_compile sweep only sees *.py
# files; smoke-all.sh does not run regress/. The file could not execute, and
# the merge gate stayed green by construction. AGENTS.md's own warning is the
# trap: several sweepers keyed exemptions on the literal string /smoke/, so
# moving a fixture silently unsanctioned it. Walk both buckets.
#
# A later hole: the matcher saw only python3 / $PY, so ${TAP_PYTHON:-python3}
# and $REAL_PYTHON3 produced ok 0 — "found nothing," not "compiled clean."
# Vacuous 0 is a fail; silent files are counted on the ok line.
#
# CONSUME THE BODY. After an opener, resume at the closer — body lines are not
# shell and must not be re-lexed for a nested `python3 … <<`. A closer is the
# first exact delimiter line (tab-prefixed only under `<<-`); `# PY` and a
# delimiter substring on a longer line are not closers. `# python3 <<` is not
# an opener (comment skip). Nothing else in that class: we do not parse Python
# string/comment state because we do not scan the body for openers.
#
# MORE THAN ONE OPENER ON A LINE (tap-7zewi). Bash reads the bodies of every
# heredoc a logical line opens, in order, whatever the interpreter. On a line that
# holds a Python stdin opener, the sweeper therefore consumes every `<<` opener on
# it — quoted, unquoted, `\DELIM`, `<<-` — and compiles each body that belongs to a
# stdin-program-mode Python opener, applying that opener's own `<<-` rule. A
# non-Python opener before a Python one is consumed first, so the Python body is
# read from its own lines. A failure names `(heredoc K of N)` when the line opens
# several. Fail loud, not mis-sliced: a `<<` whose delimiter cannot be read
# (`<<"E"F`, `$((1<<2))`, `<<''`) or a missing closer is a named sweeper failure.
# Scope: only lines that already hold a Python opener are scanned this way; a
# `<<` inside a quoted string on such a line reads as an opener (loud if it has no
# closer). Not claimed: two heredocs feeding one command, whose last wins as stdin.
#
# Six rounds, one conflation — proximity of a heredoc to `python3` was
# standing in for "this heredoc is python3's program," a proposition nobody
# checked: T7 aliases omitted (false green); T8a empty session_name (not
# this file); T8b <<- tabs (false red); T9 nested opener re-lexed (false
# red); T10 data heredoc compiled as source (false red). T10 stated the
# proposition; the clustered-short clause states it more precisely (still
# a false red, not a new cause). T11 (command position) is the disclosure
# above, not a seventh precondition: a character-class left boundary
# cannot name command position. A finding that needs python3's argument
# grammar is a rewrite, not another precondition patch.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "embedded-python-heredoc-compile: $*" >&2; exit 1; }

scan() { # <root> [min-heredocs]
  "$PY" -B - "$1" "${2:-0}" <<'PY'
from pathlib import Path
import os
import py_compile
import re
import shlex
import sys
import tempfile

CMD = (
    r"(?P<cmd>python3|"
    r'"\$\{?PY\}?"|\$\{?PY\}?|'
    r'"\$REAL_PYTHON3"|\$REAL_PYTHON3|'
    r'"\$\{TAP_PYTHON:-python3\}"|\$\{TAP_PYTHON:-python3\}|'
    r'"\$TAP_PYTHON"|\$TAP_PYTHON)'
)
# Named quote group — a numeric backref shifts when argv is captured,
# and <<- then fails to match (the hyphen is group-3, not the closer).
# Left boundary `[\s;|&({]` — see DISCLOSURE in the file header.
INVOKE = re.compile(
    r"(?:^|[\s;|&({])\s*"
    + CMD
    + r"(?P<argv>(?:\s+[^<]*)?)(?P<open><<)(?P<dash>-?)\s*(?P<q>['\"])(?P<delim>[^'\"]+)(?P=q)"
)
# Any heredoc opener, quoted or not — bash reads every body a line opens, in
# order, so a Python body is only locatable once every opener before it is
# consumed. A bare delimiter is any shell word (`<<1` too); it must end at a word boundary; `<<"E"F` style splicing
# is refused by the caller rather than guessed.
OPENER = re.compile(
    r"<<(?P<dash>-?)\s*(?:(?P<q>['\"])(?P<delim>[^'\"]+)(?P=q)|\\?(?P<bare>[^\s;|&()<>'\"\\]+))"
    r"(?=$|[\s;|&()<>}])"
)
PLAIN = {"python3", "$PY", '"$PY"', "${PY}", '"${PY}"'}
PROGRAM_OPT = {"-c", "--command", "-m", "--module"}


def stdin_program_mode(argv):
    """True when stdin is python3's program, not its input.

    First positional argument is absent or the token `-`. A short cluster
    naming `c` or `m` means the program is elsewhere (covers `-c`, `-m`,
    `-Sc`, `-Bm`, attached forms). Long options are left alone. Other
    dashed tokens are treated as no-operand flags — not python3's option
    grammar. Not claimed: operand-taking options (`-W`, `-X`).
    """
    try:
        tokens = shlex.split(argv, posix=True)
    except ValueError:
        return False
    for t in tokens:
        if t in PROGRAM_OPT:
            return False
        if t.startswith("--"):
            continue
        if t.startswith("-") and t != "-":
            if "c" in t[1:] or "m" in t[1:]:
                return False
            continue
        return t == "-"
    return True


def heredoc_openers(logical):
    """Every heredoc opener on a logical line, in shell order.

    Returns (position, delimiter, strip_tabs) per opener. A here-string
    (`<<<`) is not an opener. Raises ValueError, naming the text, for a `<<`
    whose delimiter cannot be read — arithmetic shift, spliced quoting, an
    empty delimiter — so the caller fails loudly instead of slicing a body
    from a guessed delimiter.
    """
    found = []
    for m in re.finditer(r"(?<!<)<<(?!<)", logical):
        o = OPENER.match(logical, m.start())
        if o is None:
            raise ValueError(logical[m.start():][:40])
        found.append((m.start(), o.group("delim") or o.group("bare"), o.group("dash") == "-"))
    return found


def heredoc_span(lines, start, delim, strip_tabs):
    body = []
    j = start
    while j < len(lines):
        raw = lines[j]
        closer = raw.lstrip("\t") if strip_tabs else raw
        if closer == delim:
            return j, body
        body.append(raw.lstrip("\t") if strip_tabs else raw)
        j += 1
    return j, body

root = Path(sys.argv[1])
floor = int(sys.argv[2])
files = sorted(root.glob("skills/*/scripts/smoke/*.test.sh")) + sorted(
    root.glob("skills/*/scripts/regress/*.test.sh")
)
if not files:
    print(
        "embedded-python-heredoc-compile: no skills/*/scripts/{smoke,regress}/*.test.sh",
        file=sys.stderr,
    )
    raise SystemExit(1)

fails = []
n = 0
alias_n = 0
silent = []
for path in files:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    found = 0
    rel = path.as_posix()
    try:
        rel = str(path.relative_to(root))
    except ValueError:
        pass
    i = 0
    while i < len(lines):
        chunk = [lines[i]]
        while i < len(lines) and lines[i].endswith("\\"):
            i += 1
            if i < len(lines):
                chunk.append(lines[i])
        logical = " ".join(
            s[:-1].rstrip() if s.endswith("\\") else s for s in chunk
        )
        stripped = logical.lstrip()
        if stripped.startswith("#"):
            i += 1
            continue
        logical = re.split(r"\s#", logical, maxsplit=1)[0]
        py_openers = {m.start("open"): m for m in INVOKE.finditer(logical)}
        if py_openers:
            opener_line = i + 1
            try:
                openers = heredoc_openers(logical)
            except ValueError as e:
                fails.append(f"{rel}:{opener_line}: unparseable heredoc opener near {e!r}")
                i += 1
                continue
            # Bodies follow the line in opener order: consume every one, Python
            # or not, so each body is read from its own lines. A body is not
            # shell (T9); a data heredoc is not source (T10) but still consumed.
            cur = i + 1
            unclosed = False
            for k, (pos, delim, strip_tabs) in enumerate(openers, 1):
                where = f"{rel}:{opener_line}"
                if len(openers) > 1:
                    where += f" (heredoc {k} of {len(openers)})"
                j, body = heredoc_span(lines, cur, delim, strip_tabs)
                if j >= len(lines):
                    fails.append(f"{where}: unclosed heredoc {delim}")
                    unclosed = True
                    break
                cur = j + 1
                m = py_openers.get(pos)
                if m is None or not stdin_program_mode(m.group("argv")):
                    continue
                if m.group("cmd") not in PLAIN:
                    alias_n += 1
                n += 1
                found += 1
                fd, tmp = tempfile.mkstemp(suffix=".py")
                os.close(fd)
                cfile = tmp + "c"
                try:
                    open(tmp, "w", encoding="utf-8").write("\n".join(body) + "\n")
                    # cfile beside the source — default cache is TMPDIR/__pycache__.
                    py_compile.compile(tmp, cfile=cfile, doraise=True)
                except py_compile.PyCompileError as e:
                    last = str(e).strip().splitlines()[-1]
                    fails.append(f"{where}: {last}")
                finally:
                    os.unlink(tmp)
                    if os.path.exists(cfile):
                        os.unlink(cfile)
            if unclosed:
                break
            i = cur
            continue
        i += 1
    if found == 0:
        silent.append(rel)

# Recorded failures first: a sweeper error (unparseable opener, unclosed
# heredoc) must not be hidden behind the vacuous/floor exits it can cause.
if fails:
    print(
        "embedded-python-heredoc-compile: python-stdin heredoc failed py_compile:",
        file=sys.stderr,
    )
    for f in fails:
        print(f"  {f}", file=sys.stderr)
    raise SystemExit(1)
if n == 0:
    print(
        f"embedded-python-heredoc-compile: vacuous: {len(files)} file(s) matched "
        "the bucket globs, 0 python-stdin heredocs — ok 0 is not compiled-clean",
        file=sys.stderr,
    )
    for s in silent:
        print(f"  silent: {s}", file=sys.stderr)
    raise SystemExit(1)
if floor and n < floor:
    print(
        f"embedded-python-heredoc-compile: only {n} python-stdin heredoc(s) "
        f"(floor {floor}) — extractor drifted or the corpus moved",
        file=sys.stderr,
    )
    raise SystemExit(1)
print(f"ok {n} files={len(files)} silent={len(silent)} alias={alias_n}")
PY
}

# (1) Live suite — both buckets. Floor is a vacuous-pass guard, not a census.
live_out="$(scan "$ROOT" 100)" || fail "(1) a python-stdin heredoc in smoke/ or regress/ failed py_compile"
case "$live_out" in
  ok\ [0-9]*\ files=*\ silent=*\ alias=*) ;;
  *) fail "(1) unexpected scanner output: $live_out" ;;
esac
alias_n="${live_out##*alias=}"
[ "$alias_n" -ge 5 ] || fail "(1) expected >=5 alias heredocs (TAP_PYTHON / REAL_PYTHON3), got: $live_out"
echo "embedded-python-heredoc-compile: (1) live suite python-stdin heredocs compile ($live_out): ok"

# (2) MUTATION BAR — the exact T5 unescaping. Assembled so this file is not a hit.
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE/skills/tap/scripts/regress"
{
  printf '%s\n' "python3 - <<'PY'"
  printf '%s\n' "body = body.replace("
  printf '%s\n' '    "placeholder",'
  printf '%s\n' "    '  *pid*start_time*)       printf '%s\\\\n' \"\${FAKE_SERVER_EPOCH_RAW:-900:100}\" ;;'"
  printf '%s\n' ")"
  printf '%s\n' "PY"
} > "$FIXTURE/skills/tap/scripts/regress/offender.test.sh"
grep -q "printf '%s" "$FIXTURE/skills/tap/scripts/regress/offender.test.sh" \
  || fail "(2) fixture assembly failed — the stripped-quote line was not written"
mutation_out=""
if mutation_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(2) the check accepted the T5 unescaping that made server-epoch-guard unexecutable"
fi
case "$mutation_out" in
  *offender.test.sh*) ;;
  *) fail "(2) the check fired but did not name the offender: $mutation_out" ;;
esac
echo "embedded-python-heredoc-compile: (2) fires on the T5 stripped-quote heredoc: ok"

# (3) NEGATIVE — a python3 stub written with cat is bash, not stdin-to-python.
mkdir -p "$FIXTURE/skills/tap/scripts/smoke"
cat > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" <<'STUB'
cat > "$SHIM/python3" <<'SH'
#!/usr/bin/env bash
exec "$REAL_PYTHON3" "$@"
SH
python3 - <<'PY'
print(1)
PY
STUB
rm -f "$FIXTURE/skills/tap/scripts/regress/offender.test.sh"
neg_out="$(scan "$FIXTURE" 0)" || fail "(3) flagged a cat-written python3 stub or a valid print(1) heredoc: $neg_out"
[ "$neg_out" = "ok 1 files=1 silent=0 alias=0" ] || fail "(3) expected one python-stdin heredoc, got: $neg_out"
echo "embedded-python-heredoc-compile: (3) cat-written python3 stubs are not compiled; valid stdin compiles: ok"

# (4) CONTROL — the real ${TAP_PYTHON:-python3} shape must red, not ok 0.
{
  printf '%s\n' '"${TAP_PYTHON:-python3}" -B - <<'"'"'PY'"'"
  printf '%s\n' 'def broken(:'
  printf '%s\n' 'PY'
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q 'TAP_PYTHON:-python3' "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(4) fixture assembly failed — the TAP_PYTHON alias was not written"
alias_out=""
if alias_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(4) the TAP_PYTHON alias shape was invisible (ok 0 / compiled-clean): $alias_out"
fi
case "$alias_out" in
  *stub.test.sh*) ;;
  *) fail "(4) the check fired but did not name the TAP_PYTHON offender: $alias_out" ;;
esac
echo "embedded-python-heredoc-compile: (4) reds on the real TAP_PYTHON alias shape: ok"

# (5) VACUOUS — a bucket file with no python-stdin heredoc must not print ok 0.
printf '%s\n' 'echo hi' > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
vacuous_out=""
if vacuous_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(5) a silent bucket file printed success: $vacuous_out"
fi
case "$vacuous_out" in
  *vacuous*) ;;
  *) fail "(5) silent file did not fail vacuous: $vacuous_out" ;;
esac
case "$vacuous_out" in
  *stub.test.sh*) ;;
  *) fail "(5) vacuous fail did not name the silent file: $vacuous_out" ;;
esac
echo "embedded-python-heredoc-compile: (5) vacuous 0 is loud and names the silent file: ok"

# (6) `<<-` BODY TABS — bash strips them; compiling verbatim is a false red.
# At 8d6f0aad this fixture redded (tab-indented print is IndentationError).
# Assembled so this file is not itself a python-stdin hit.
{
  printf '%s\n' "python3 - <<-'PY'"
  printf '\t%s\n' 'print(1)'
  printf '%s\n' "PY"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q $'\tprint(1)' "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(6) fixture assembly failed — the tab-indented body was not written"
tab_out="$(scan "$FIXTURE" 0)" || fail "(6) tab-indented <<- body failed py_compile (tabs were not stripped): $tab_out"
[ "$tab_out" = "ok 1 files=1 silent=0 alias=0" ] || fail "(6) unexpected scanner output: $tab_out"
echo "embedded-python-heredoc-compile: (6) <<- tab-indented body compiles after strip: ok"

# (7) BODY IS NOT SHELL — a heredoc-shaped line inside a triple-quoted string
# must not start a second extract. At 6b6732d7 this redded (inner `def broken(:`
# compiled as Python). Assembled so this file is not itself a hit.
{
  printf '%s\n' "python3 - <<'PY'"
  printf '%s\n' 's = """'
  printf '%s\n' "python3 - <<'PY'"
  printf '%s\n' 'def broken(:'
  printf '%s\n' '"""'
  printf '%s\n' 'print(1)'
  printf '%s\n' "PY"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q "def broken(:" "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(7) fixture assembly failed — the nested opener-shaped string was not written"
nested_out="$(scan "$FIXTURE" 0)" \
  || fail "(7) valid outer heredoc with a nested-opener-shaped string failed py_compile: $nested_out"
[ "$nested_out" = "ok 1 files=1 silent=0 alias=0" ] \
  || fail "(7) expected one heredoc (the outer), got: $nested_out"
echo "embedded-python-heredoc-compile: (7) nested-opener-shaped string in a Python body is not re-lexed: ok"

# (8) STDIN-PROGRAM MODE — -c / -m / script-file heredocs are input, not
# source. At d1613552 this redded (DATA compiled as Python). Assembled so
# this file is not itself a python-stdin hit. Bare `python3` and `python3 -`
# still extract. DATA must be a SyntaxError — `this is not python` compiles
# (it is a comparison).
{
  printf '%s\n' "python3 -c 'import sys; print(sys.stdin.read())' <<'DATA'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "DATA"
  printf '%s\n' "python3 -m json.tool <<'DATA'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "DATA"
  printf '%s\n' "python3 ./script.py <<'DATA'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "DATA"
  printf '%s\n' "python3 <<'PY'"
  printf '%s\n' "print(1)"
  printf '%s\n' "PY"
  printf '%s\n' "python3 - <<'PY'"
  printf '%s\n' "print(1)"
  printf '%s\n' "PY"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q "python3 -c " "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(8) fixture assembly failed — the -c data heredoc was not written"
grep -q "python3 -m " "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(8) fixture assembly failed — the -m data heredoc was not written"
grep -q "python3 ./script.py " "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(8) fixture assembly failed — the script-file data heredoc was not written"
grep -q "not python data !!!" "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(8) fixture assembly failed — the non-Python DATA body was not written"
mode_out="$(scan "$FIXTURE" 0)" \
  || fail "(8) -c/-m/script-file data compiled as Python, or a valid stdin heredoc failed: $mode_out"
[ "$mode_out" = "ok 2 files=1 silent=0 alias=0" ] \
  || fail "(8) expected two stdin-program heredocs (bare and dash), got: $mode_out"
echo "embedded-python-heredoc-compile: (8) -c/-m/script-file data is not extracted; bare python3 and python3 - still are: ok"

# (9) BYTECODE STAYS WITH THE SOURCE. Default py_compile writes
# TMPDIR/__pycache__/ (on a gate run, /tmp/__pycache__). At 48366c46 a
# compile under an isolated TMPDIR left a .pyc there after the source
# was unlinked. Assembled so this file is not itself a hit.
{
  printf '%s\n' "python3 - <<'PY'"
  printf '%s\n' "print(1)"
  printf '%s\n' "PY"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
WATCH="$WORK/pycwatch"
mkdir -p "$WATCH"
pyc_out="$(TMPDIR="$WATCH" scan "$FIXTURE" 0)" \
  || fail "(9) valid stdin heredoc failed py_compile under isolated TMPDIR: $pyc_out"
[ "$pyc_out" = "ok 1 files=1 silent=0 alias=0" ] \
  || fail "(9) unexpected scanner output: $pyc_out"
leftover="$(find "$WATCH" -type f -print)"
[ -z "$leftover" ] \
  || fail "(9) compile left files under TMPDIR (bytecode cache?): $leftover"
echo "embedded-python-heredoc-compile: (9) bytecode does not land in TMPDIR/__pycache__: ok"

# (10) CLUSTERED SHORT -c/-m. A short cluster naming c or m means the
# program is elsewhere. The spaced `-Sc 'code'` form already skipped at
# 4332e6be (the code string is a positional). The hole is attached /
# operand-less clusters. At 4332e6be those extracted DATA. `-B -` still
# extracts. Assembled so this file is not a hit.
{
  printf '%s\n' "python3 -Sc'import sys; print(sys.stdin.read())' <<'DATA'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "DATA"
  printf '%s\n' "python3 -Bmjson.tool <<'DATA'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "DATA"
  printf '%s\n' "python3 -Sc <<'DATA'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "DATA"
  printf '%s\n' "python3 -B - <<'PY'"
  printf '%s\n' "print(1)"
  printf '%s\n' "PY"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q "python3 -Sc'" "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(10) fixture assembly failed — the attached -Sc data heredoc was not written"
grep -q "python3 -Bmjson.tool " "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(10) fixture assembly failed — the attached -Bm data heredoc was not written"
grep -q "python3 -Sc <<" "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(10) fixture assembly failed — the operand-less -Sc data heredoc was not written"
cluster_out="$(scan "$FIXTURE" 0)" \
  || fail "(10) clustered -Sc/-Bm data compiled as Python, or -B - stdin failed: $cluster_out"
[ "$cluster_out" = "ok 1 files=1 silent=0 alias=0" ] \
  || fail "(10) expected one stdin-program heredoc (-B -), got: $cluster_out"
echo "embedded-python-heredoc-compile: (10) clustered -Sc/-Bm data is not extracted; -B - still is: ok"

# (11) ZERO-SPACE `python3<<'PY'` (tap-iizaq). The argv group needed one whitespace char,
# so a heredoc with nothing between the command and `<<` was never swept. Positive: a
# broken body must RED, a valid one compile. Negative: `python3x<<`, `mypython3<<` and
# the here-string `python3<<<` are not python3 invocations, so their broken bodies must
# NOT be compiled (one valid zero-space heredoc keeps the sweep from being vacuous).
# Assembled so this file is not a hit.
{
  printf '%s\n' "python3<<'PY'"
  printf '%s\n' "def broken(:"
  printf '%s\n' "PY"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q "^python3<<'PY'" "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(11) fixture assembly failed — the zero-space heredoc was not written"
zero_out=""
if zero_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(11) a zero-space python3 heredoc with a syntax error was not swept: $zero_out"
fi
case "$zero_out" in
  *"failed py_compile"*stub.test.sh*) ;;
  *) fail "(11) the zero-space heredoc must fail py_compile and name the file (a vacuous 'nothing swept' is not that): $zero_out" ;;
esac
{
  printf '%s\n' "python3<<'PY'"
  printf '%s\n' "print(1)"
  printf '%s\n' "PY"
  printf '%s\n' "python3x<<'PY'"
  printf '%s\n' "def broken(:"
  printf '%s\n' "PY"
  printf '%s\n' "mypython3<<'PY'"
  printf '%s\n' "def broken(:"
  printf '%s\n' "PY"
  printf '%s\n' "python3<<<'def broken(:'"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q "^python3x<<'PY'" "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(11) fixture assembly failed — the python3x negatives were not written"
zneg_out="$(scan "$FIXTURE" 0)" \
  || fail "(11) python3x<<, mypython3<< or a here-string was treated as a python3 invocation: $zneg_out"
[ "$zneg_out" = "ok 1 files=1 silent=0 alias=0" ] \
  || fail "(11) expected exactly the one valid zero-space heredoc, got: $zneg_out"
echo "embedded-python-heredoc-compile: (11) zero-space python3 heredocs are swept; python3x, mypython3 and here-strings are not: ok"

PYBIN=python3 # fixtures name the second command through this so the live sweep is not a hit
# (12) SECOND OPENER ON ONE LINE (tap-7zewi). Bash reads every heredoc body a line
# opens, in order. The sweeper resumed at the first closer, so the second body was
# read as shell and invalid Python there escaped. Control: both valid compile two.
# Assembled so this file is not a hit.
{
  printf '%s\n' "python3 <<'A'; ${PYBIN} <<'B'"
  printf '%s\n' "print(1)"
  printf '%s\n' "A"
  printf '%s\n' "def broken(:"
  printf '%s\n' "B"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
grep -q "python3 <<'A'; ${PYBIN} <<'B'" "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh" \
  || fail "(12) fixture assembly failed — the two-opener line was not written"
two_out=""
if two_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(12) a broken second python heredoc on the same line escaped the sweep: $two_out"
fi
case "$two_out" in
  *"stub.test.sh:1 (heredoc 2 of 2)"*) ;;
  *) fail "(12) the failure must name the second heredoc of the line: $two_out" ;;
esac
{
  printf '%s\n' "python3 <<'A'; ${PYBIN} <<-'B'"
  printf '%s\n' "print(1)"
  printf '%s\n' "A"
  printf '\t%s\n' "print(2)"
  printf '\t%s\n' "B"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
both_out="$(scan "$FIXTURE" 0)" || fail "(12) two valid same-line python heredocs failed: $both_out"
[ "$both_out" = "ok 2 files=1 silent=0 alias=0" ] \
  || fail "(12) expected both same-line heredocs compiled (second with <<- tabs stripped), got: $both_out"
echo "embedded-python-heredoc-compile: (12) every python heredoc opened on one line is compiled, in order: ok"

# (13) MODE PER OPENER — data-mode and program-mode openers share a line in either
# order. The data body is consumed but not compiled; the program body is compiled.
{
  printf '%s\n' "python3 -c 'import sys' <<'D'; ${PYBIN} <<'P'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "D"
  printf '%s\n' "print(1)"
  printf '%s\n' "P"
  printf '%s\n' "python3 <<'P'; ${PYBIN} -m json.tool <<'D'"
  printf '%s\n' "print(1)"
  printf '%s\n' "P"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "D"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
mixed_out="$(scan "$FIXTURE" 0)" || fail "(13) a data-mode heredoc beside a program-mode one on one line failed: $mixed_out"
[ "$mixed_out" = "ok 2 files=1 silent=0 alias=0" ] \
  || fail "(13) expected exactly the two program-mode heredocs, got: $mixed_out"
{
  printf '%s\n' "python3 -c 'import sys' <<'D'; ${PYBIN} <<'P'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "D"
  printf '%s\n' "def broken(:"
  printf '%s\n' "P"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
if mixed_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(13) a broken program-mode heredoc after a data-mode one escaped: $mixed_out"
fi
case "$mixed_out" in
  *"(heredoc 2 of 2)"*) ;;
  *) fail "(13) the failure must name the second heredoc: $mixed_out" ;;
esac
echo "embedded-python-heredoc-compile: (13) data-mode and program-mode openers on one line are judged separately: ok"

# (14) NON-PYTHON OPENER FIRST. `cat <<X; ${PYBIN} <<'Y'` puts Y's body after X's
# closer; slicing from the line below read X's body as Python. Either direction of
# error is wrong: a data body compiled (false red) or a broken Python body never
# reached (false green). Quoted, unquoted and <<- first openers all consume.
{
  printf '%s\n' "cat <<X; ${PYBIN} <<'Y'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "X"
  printf '%s\n' "print(1)"
  printf '%s\n' "Y"
  printf '%s\n' "cat <<'X' | ${PYBIN} <<'Y'"
  printf '%s\n' "not python data !!!"
  printf '%s\n' "X"
  printf '%s\n' "print(1)"
  printf '%s\n' "Y"
  printf '%s\n' "cat <<-X; ${PYBIN} <<'Y'"
  printf '\t%s\n' "not python data !!!"
  printf '\t%s\n' "X"
  printf '%s\n' "print(1)"
  printf '%s\n' "Y"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
first_out="$(scan "$FIXTURE" 0)" || fail "(14) a non-python heredoc body before a python one was compiled as python: $first_out"
[ "$first_out" = "ok 3 files=1 silent=0 alias=0" ] \
  || fail "(14) expected the three python heredocs, got: $first_out"
{
  printf '%s\n' "cat <<X; ${PYBIN} <<'Y'"
  printf '%s\n' "print(1)"
  printf '%s\n' "X"
  printf '%s\n' "def broken(:"
  printf '%s\n' "Y"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
if first_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(14) a broken python body after a non-python heredoc was shifted onto the wrong lines and escaped: $first_out"
fi
case "$first_out" in
  *"(heredoc 2 of 2)"*) ;;
  *) fail "(14) the failure must name the python heredoc, the second on its line: $first_out" ;;
esac
echo "embedded-python-heredoc-compile: (14) a non-python opener before a python one does not shift the python body: ok"

# (15) LOUD, NOT MIS-SLICED — an opener whose delimiter cannot be known, or whose
# closer never arrives, names itself instead of guessing a body.  No padding
# heredoc: the named failure must surface even when nothing else compiled.
{
  printf '%s\n' "cat <<\"E\"F; ${PYBIN} <<'Y'"
  printf '%s\n' "print(1)"
  printf '%s\n' "Y"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
if loud_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(15) a heredoc opener with an unknowable delimiter was sliced anyway: $loud_out"
fi
case "$loud_out" in
  *"unparseable heredoc opener"*stub.test.sh*|*stub.test.sh*"unparseable heredoc opener"*) ;;
  *) fail "(15) the unparseable opener must be named: $loud_out" ;;
esac
{
  printf '%s\n' "cat <<NEVER; ${PYBIN} <<'Y'"
  printf '%s\n' "print(1)"
  printf '%s\n' "Y"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
if loud_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(15) an unclosed non-python heredoc was not reported: $loud_out"
fi
case "$loud_out" in
  *"unclosed heredoc NEVER"*) ;;
  *) fail "(15) the unclosed opener must be named: $loud_out" ;;
esac
{
  printf '%s\n' "python3 <<<'def broken(:'"
  printf '%s\n' "python3 <<'Y'; echo \$((1 <<< 2))"
  printf '%s\n' "print(1)"
  printf '%s\n' "Y"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
here_out="$(scan "$FIXTURE" 0 2>&1)" || fail "(15) a here-string beside a python opener was read as a heredoc: $here_out"
[ "$here_out" = "ok 1 files=1 silent=0 alias=0" ] || fail "(15) expected the one python heredoc, got: $here_out"
echo "embedded-python-heredoc-compile: (15) unknowable or unclosed openers are named; here-strings are not openers: ok"

# (16) VALID SHELL THE SCAN MUST NOT REJECT — a numeric bare delimiter after a
# Python opener. (A comment glued to an operator, `;# ... <<X`, is NOT covered:
# the comment cut stays whitespace-only, so that shape is a loud unclosed-heredoc
# red. Widening the cut to `;&|()` made a quoted delimiter containing `;#` vanish
# from the sweep — a silent false green, the worse direction. See arm 17.)
{
  printf '%s\n' "python3 <<'Y'; cat <<1"
  printf '%s\n' "print(1)"
  printf '%s\n' "Y"
  printf '%s\n' "data !!!"
  printf '%s\n' "1"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
valid_out="$(scan "$FIXTURE" 0 2>&1)" || fail "(16) valid shell was rejected (numeric delimiter): $valid_out"
[ "$valid_out" = "ok 1 files=1 silent=0 alias=0" ] || fail "(16) expected the one python heredoc, got: $valid_out"
echo "embedded-python-heredoc-compile: (16) a numeric delimiter after a python opener is not a bad opener: ok"

# (17) QUOTED DELIMITER CONTAINING `;#` — the comment cut must not eat the opener.
# A broken body under a `;#`-bearing quoted delimiter must still RED.
{
  printf '%s\n' "python3 <<'PY;#X'"
  printf '%s\n' "def broken(:"
  printf '%s\n' "PY;#X"
} > "$FIXTURE/skills/tap/scripts/smoke/stub.test.sh"
if cut_out="$(scan "$FIXTURE" 0 2>&1)"; then
  fail "(17) a quoted delimiter containing ;# hid a broken python body from the sweep: $cut_out"
fi
case "$cut_out" in
  *"failed py_compile"*stub.test.sh*) ;;
  *) fail "(17) the broken body must fail py_compile and name the file: $cut_out" ;;
esac
echo "embedded-python-heredoc-compile: (17) the comment cut does not hide a quoted ;# delimiter: ok"

echo "embedded-python-heredoc-compile: ok"
