#!/usr/bin/env bash
# python-inline-isolated.test.sh — shipped shell runs inline python under -I (tap-8e3xh).
#
# `python3 -` and `python3 -c` put the CALLER'S CWD at the front of sys.path. TAP
# verbs and hooks run from whatever repository the agent is in, so a repo carrying
# its own json.py or calendar.py had it imported and executed with the agent's
# credentials (reproduced through tomllib). `-I` drops the cwd entry,
# PYTHONPATH and user site. Blocks that import TAP's own modules insert their
# directory explicitly, so they do not need the cwd.
#
#   (2) SWEEP  — no tracked, shipped shell file runs inline python without -I. Shell is chosen
#                by shape: every .sh plus every extensionless file whose first line is a
#                bash/sh shebang (bin/tap, the tracker's hook scripts, ...).
#                Tests and docs are out of scope: they run in sandbox cwds.
#   (3) SWEEP SEES VARIABLES — the same scanner, run on a scratch repo planted
#                with literal and variable-selected interpreters, reports each.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
fail() { echo "python-inline-isolated: $*" >&2; exit 1; }

# The retired tap_error_json renderer has only fixture callers now. Its shadow
# test no longer establishes a production property; retain the shipped-code
# scanner and positive/negative planted interpreter controls below.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/py-isolated.XXXXXX")"
trap 'rm -rf "${WORK:?}"' EXIT

# --- (2) sweep ---------------------------------------------------------------
# The scanner prints its file count on stdout and offenders on stderr, so a scan
# that read nothing cannot pass as a clean one.
cat > "$WORK/sweep.py" <<'PY'
import os, re, stat, subprocess, sys
# Shell is selected by shape, as bash32-parse.test.sh does: every .sh plus every
# extensionless file whose first line is a bash/sh shebang. Scripts with no .sh
# suffix (bin/tap, the tracker's hooks) run inline python from any repo (tap-18seq).
def ls(*flags):
    out = subprocess.run(["git", "ls-files", "-z", *flags], capture_output=True, check=True).stdout.decode()
    return [f for f in out.split("\0") if f]
gone = set(ls("--deleted"))      # deleted-but-indexed paths: named by git, no existence poll
shebang = re.compile(rb"#!.*(bash|/sh|env sh)")
def shell(f):
    # stat before any open: a FIFO, socket or device is never a candidate, and opening a
    # writerless FIFO would block the sweep. An unreadable regular file raises, visibly.
    try:
        regular = stat.S_ISREG(os.stat(f).st_mode)
    except FileNotFoundError:    # a dangling symlink has nothing to scan
        return False
    if f in gone or not regular:
        return False
    if f.endswith(".sh"):
        return True
    with open(f, "rb") as fh:
        return bool(shebang.match(fh.readline()))
files = [f for f in ls() if shell(f) and "/smoke/" not in f and "/regress/" not in f
         and not f.startswith(("docs/", "runtime/bun/test/"))]
# The interpreter is either literal python3 or a variable naming one
# ("${TAP_PYTHON:-python3}", "$PY", $python): the runner selects its python by
# variable, so a literal-only pattern passes those sites unread.
interp = r"(?:\bpython3|\$\{?[A-Za-z_]*(?:PY|Py|py)[A-Za-z_]*(?::-python3)?\}?\"?)"
inline = re.compile(interp + r"((?:\s+-[A-Za-z]+)*)\s+(?:-c\b|-(?=\s|$|[<\"']))")
bad = []
for f in files:
    for n, line in enumerate(open(f, encoding="utf-8", errors="replace"), 1):
        for m in inline.finditer(line):
            if "-I" not in m.group(1).split():
                bad.append(f"  {f}:{n}: {line.strip()[:120]}")
print(len(files))
if len(sys.argv) > 1:            # the discovered set, for the self-check below
    open(sys.argv[1], "w").write("\n".join(files) + "\n")
if bad:
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)
PY
scanned="$(cd "$ROOT" && python3 -I "$WORK/sweep.py" "$WORK/discovered")" || fail "(2) inline python without -I in shipped shell (above); add -I, and insert sys.path explicitly for TAP modules"
[ "${scanned:-0}" -gt 20 ] || fail "(2) the sweep read only '${scanned:-}' files; the scan is broken, not clean"
# Shape selection must reach scripts with no .sh name: bin/tap is one, and at least
# one more extensionless script (the tracker's hooks) must be in the set too.
grep -qx 'bin/tap' "$WORK/discovered" || fail "(2) the sweep did not discover bin/tap; shebang selection is broken"
[ "$(grep -cv '\.sh$' "$WORK/discovered")" -gt 1 ] || fail "(2) the sweep found no extensionless script besides bin/tap; shebang selection is broken"
echo "python-inline-isolated: (2) $scanned shipped shell files, no inline python without -I: ok"

# --- (3) the sweep sees variable-selected interpreters -----------------------
# The runner picks its python by variable; a review
# found twelve such sites that a literal-only pattern passed. Each plant below
# must be reported, and the isolated control must not be. Plant 1 reads stdin
# by redirect, not a heredoc: embedded-python-heredoc-compile scans this file's
# lines and would read an inner <<'PY' as an unclosed python heredoc.
PLANT="$WORK/plant"
mkdir -p "$PLANT"
git -C "$PLANT" init -q
cat > "$PLANT/plant.sh" <<'SH'
"${TAP_PYTHON:-python3}" -B - "$x" < "$script"
exec "$PY" -B -c 'pass'
effective="$($python -B -c 'pass')"
"$_smoke_py" -c "$CODE"
python3 -c 'pass'
"${TAP_PYTHON:-python3}" -I -B -c 'pass'
SH
# Shape selection: an extensionless bash-shebang file is swept; a python-shebang one is not.
cat > "$PLANT/plant-hook" <<'SH'
#!/usr/bin/env bash
python3 -c 'pass'
SH
cat > "$PLANT/plant-notshell" <<'SH'
#!/usr/bin/env python3
python3 -c 'pass'
SH
git -C "$PLANT" add plant.sh plant-hook plant-notshell
planted="$(cd "$PLANT" && python3 -I "$WORK/sweep.py" 2>&1 >/dev/null)" \
  && fail "(3) the sweep passed a scratch repo planted with unisolated python"
for n in 1 2 3 4 5; do
  printf '%s\n' "$planted" | grep -q "plant.sh:$n:" || fail "(3) the sweep missed planted line $n: $(sed -n "${n}p" "$PLANT/plant.sh")"
done
printf '%s\n' "$planted" | grep -q "plant-hook:2:" || fail "(3) the sweep missed the extensionless bash-shebang plant"
! printf '%s\n' "$planted" | grep -q "plant-notshell" || fail "(3) the sweep read a python-shebang file as shell"
! printf '%s\n' "$planted" | grep -q "plant.sh:6:" || fail "(3) the sweep flagged the isolated control line"
echo "python-inline-isolated: (3) literal and variable-selected interpreters are both swept: ok"

echo "python-inline-isolated: ok"
