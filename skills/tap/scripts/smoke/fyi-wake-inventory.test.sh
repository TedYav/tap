#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# fyi-wake-inventory.test.sh — tap-31it: every PRODUCTION `--fyi` send must decide,
# visibly, whether it may be held.
#
# `--fyi` stamps reply=settle-only, which makes a send eligible for courier
# PRE-SETTLEMENT (CONTRACT §Courier deferred auto-settlement): the courier writes
# the `.done` when the digest doorbell lands, so the recipient owes nothing for
# what it reads. That is correct for bookkeeping traffic and WRONG for traffic
# somebody is waiting on — a reply, a nudge, a notice telling a peer its payloads
# will go unsettled while it waits on them — whose settlement must stay owed.
#
# tap-7r3fn.20: this comment used to justify `--wake` by ARRIVAL ("traffic whose
# value is prompt arrival") and to describe the eligibility as a 5-to-10-minute
# hold before the body reaches the seat. Both were true of the enqueue-started
# hold this bead deleted. `--wake` is inert on the delivery axis (ruling 51); what
# it still buys is the settlement half, which is what this inventory guards.
#
# Three call sites were patched with `--wake` when the feature landed and two more
# were found by review afterwards, in the same class, by re-reading the same files.
# That is the signature of an invariant with no mechanical owner, so this file is
# the owner: a new `--fyi` send site fails here until someone states which side of
# the line it is on.
#
# SCOPE, deliberately: production shell and python under skills/ and scripts/.
# Test code is excluded because a fixture chooses delivery timing to exercise
# something else, and several legitimately want the held path. THREE buckets exist
# and all three are excluded by path: `smoke/`, `regress/`, and the vendored python
# suite at `skills/tap/scripts/tests/` — a sweeper that knew only about the
# first two scanned the python tests as production on its first run. A fourth test
# bucket must be added here or it will be read as production code.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SCAN="$(mktemp "${TMPDIR:-/tmp}/fyi-wake-scan.XXXXXX.py")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$SCAN"' EXIT

# The predicate lives in a file and takes its root as an argument, so the negative
# case runs the SAME code against a planted tree. (An earlier draft re-invoked this
# test from the planted directory; it resolved the git toplevel, scanned the real
# repo, and recursed until the runner killed it.)
cat > "$SCAN" <<'PY'
import os, re, subprocess, sys

root = sys.argv[1]
os.chdir(root)
# A decision token: the send declined PRE-SETTLEMENT (--wake, --in-reply-to),
# never enters the class (--ask, --reply, --expect-reply, --urgent), or is a kind
# the carve-out excludes outright.
#
# `--in-reply-to` JOINED THIS LIST WITH RULING 51 (tap-7r3fn.20). The guard's
# question is "did this send state a PRE-SETTLEMENT decision" — it owns who ends
# up owing the `tap done`, not when the body arrives, which is `--delivery`'s
# job since the window landed. It used to
# accept only one spelling of the answer. An ANSWER now declines pre-settlement
# from the stamped field rather than from a flag — tap-send.sh reads
# `IN_REPLY_TO` at the eligibility gate — so a reply outbound is exactly as
# decided as it was when it carried `--wake`, and more so: the stamp is
# unconditional where the flag was added on two branches out of three. Without
# this row the guard would demand a flag whose only remaining effect is a
# deprecation notice aimed at a user who never typed it.
EXEMPT_CODE = ("--wake", "--in-reply-to", "--ask", "--expect-reply", "--urgent",
               "--kind probe", "--kind notice", '"probe"', '"notice"')
# `--reply` is an --ask alias; substring match would also hit `--reply-to`.
EXEMPT_REPLY_FLAG = re.compile(r'(?:^|[\s])--reply(?:[\s]|$)')

roots = [d for d in ("skills", "scripts") if os.path.isdir(d)]
TOKENIZED = """["']tap["'],[[:space:]]*["']send["']"""
# TWO populations, because `--fyi` is only ONE way to reach reply=settle-only.
# An unattended or poll-mode sender stamps settle-only with no flag at all, so a
# `--fyi`-only scan reports compliance while the implicit class goes unmarked —
# the documented cron-watch liveness recipe was exactly that shape. Every actual
# courier INVOCATION must therefore state a decision, whatever flags it happens
# to spell.
out = subprocess.run(["grep", "-rnIE", "--include=*.sh", "--include=*.py", "-e", "--fyi",
                      "-e", "tap-send[.]sh", "-e", "send_sh", "-e", "tap[[:space:]]+send",
                      "-e", TOKENIZED, *roots],
                     capture_output=True, text=True).stdout

QUOTED = re.compile(r'"[^"]*"|\'[^\']*\'|`[^`]*`')
# `str(send_sh)` rather than the bare variable: the launcher ASSIGNS that path on
# its own line, and an assignment is not a call. `tap send` is the PUBLIC spelling
# of the same courier call (tap-m5oq): a production script that shells out to the
# installed `tap` reaches the same settle-only class as one calling tap-send.sh.
INVOCATION = re.compile(r'(tap-send\.sh|str\(send_sh\)|\btap\s+send\b)')
# A python argv list spells the call as quoted tokens, so it is quoted BY CONSTRUCTION
# and is recognised on the raw line, before quoted spans are stripped.
TOKENIZED_RE = re.compile(r"""["']tap["']\s*,\s*["']send["']""")

def is_invocation(line, path):
    # Strip quoted spans FIRST: `tap_fail … "tap send <id> --from x"` names a
    # remedy inside a string, and a scanner that counted those would drown the
    # real call sites in prose it cannot fix. Two spans are CODE in shell and are
    # kept: a backtick span is command substitution, and a double-quoted span that
    # holds `$(` or a backtick substitutes too. In python a backtick span is prose
    # (a docstring naming `tap send --id`), so only there is it dropped.
    shell = path.endswith(".sh")
    def drop(m):
        span = m.group(0)
        if span[0] == "`":
            return "" if not shell else span
        if span[0] == '"' and shell and ("$(" in span or "`" in span):
            return span
        return ""
    bare = QUOTED.sub(drop, line)
    return bool(INVOCATION.search(bare)) or bool(TOKENIZED_RE.search(line))

def strip_comment_block(text):
    return "\n".join(strip_comment(l) for l in text.splitlines())

def strip_comment(line):
    # Full-line comment -> nothing. Trailing ` # ...` -> cut. Crude on purpose: a
    # `#` inside a quoted string over-cuts, which only ever makes this guard
    # STRICTER (it can lose an exemption, never invent one).
    if line.lstrip().startswith("#"):
        return ""
    return re.split(r"\s#", line, maxsplit=1)[0]

bad = []
for hit in out.splitlines():
    parts = hit.split(":", 2)
    if len(parts) < 3:
        continue
    path, lineno = parts[0], int(parts[1])
    if "/smoke/" in path or "/regress/" in path or "/scripts/tests/" in path:
        continue
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        continue
    text = lines[lineno - 1]
    if not strip_comment(text):
        continue                      # prose ABOUT the flag is not a send
    if "--fyi" not in text and not is_invocation(text, path):
        continue                      # a mention of the script, not a call
    # ARRAY-ARG CALLS BIND BY NAME, NOT BY PROXIMITY. `"$DIR/tap-send.sh"
    # "${send_args[@]}"` carries its decision inside the array, which may be built
    # anywhere in the file — so the decision is looked for in the assignments to
    # THAT array (`send_args+=(…)` / `send_args=(…)`), never in a wider window. A
    # window big enough to reach it would also let an unrelated neighbouring call
    # borrow its exemption, which is the reflexive-waiver failure this guard exists
    # to avoid.
    arrays = re.findall(r'\$\{(\w+)\[@\]\}', text)
    # AN ARRAY BUILD BINDS BY NAME TOO, which is the same rule one paragraph
    # down, applied where it was previously missed. `send_args+=(--fyi)` carries
    # `--fyi` on a line that is not a call at all: the decision lives in the
    # array, exactly as it does for the invocation that later expands it. Before
    # ruling 51 no line looked like this — every `--fyi` build also carried
    # `--wake` inline — so the case never arose and the guard judged such a line
    # in isolation, demanding a flag on a fragment rather than on the send.
    #
    # Deliberately keyed on an assignment to THIS array, never a window: the
    # borrowed-waiver failure the rule below names applies here identically.
    build = re.match(r'\s*(\w+)(?:\+)?=\(', text)
    if build and not arrays:
        arrays = [build.group(1)]
    if arrays:
        joined = "\n".join(
            l for l in lines
            for a in arrays
            if re.match(r'\s*%s(\+)?=\(' % re.escape(a), l)
        )
        if any(tok in strip_comment_block(joined) for tok in EXEMPT_CODE) \
                or EXEMPT_REPLY_FLAG.search(strip_comment_block(joined)):
            continue
    # THE LOGICAL CALL EXPRESSION, not a fixed window (partner review, round 2): a
    # seven-line window lets two adjacent calls share one exemption, and a guard
    # whose waivers drift onto their neighbours is a guard nobody can fail. The
    # call is the hit line plus its backslash continuations in both directions,
    # and — for python — the bracket span it opens.
    start = lineno - 1
    while start > 0 and lines[start - 1].rstrip().endswith("\\"):
        start -= 1
    end = lineno - 1
    while end + 1 < len(lines) and (lines[end].rstrip().endswith("\\")
                                    or lines[end].count("[") > lines[end].count("]")):
        end += 1
    call = lines[start:end + 1]
    # Comment-sensitive in BOTH directions, which is why this is not a grep:
    # `--wake` must appear in CODE (a comment that merely mentions the flag is
    # prose — an early draft passed a send whose flag had been deleted because the
    # comment above it said the word), while `autosettle-exempt:` is a written
    # waiver and therefore lives in a comment — and must be ATTACHED: the two
    # lines immediately above the call, or trailing on it, so it cannot be
    # inherited by whatever call is written next to it later.
    code = strip_comment_block("\n".join(call))
    waiver_span = lines[max(0, start - 2):end + 1]
    if any(tok in code for tok in EXEMPT_CODE) or EXEMPT_REPLY_FLAG.search(code) \
            or "autosettle-exempt:" in "\n".join(waiver_span):
        continue
    bad.append((path, lineno, lines[lineno - 1].strip()))

for path, lineno, text in bad:
    print("fyi-wake-inventory: %s:%d sends (--fyi or a courier call) with no pre-settlement decision" % (path, lineno), file=sys.stderr)
    print("  --> add --wake if the recipient must still owe a tap done for it,", file=sys.stderr)
    print("      --in-reply-to if it is an answer someone is waiting on, or the marker", file=sys.stderr)
    print('      "autosettle-exempt: <why courier pre-settlement is fine here>" beside it', file=sys.stderr)
    print("      (this guard is about SETTLEMENT, not arrival — for arrival pass", file=sys.stderr)
    print("       --delivery interrupt; --wake is delivery-inert since ruling 51)", file=sys.stderr)
    print("      " + text, file=sys.stderr)
sys.exit(1 if bad else 0)
PY

python3 -B "$SCAN" "$ROOT" || { echo "fyi-wake-inventory: FAIL" >&2; exit 1; }

# The guard must be able to fail, and on the case that actually fooled it: a send
# whose neighbouring COMMENT says `--wake` while the command itself does not.
plant() { # plant <name> <body> [ext]: a private planted tree holding one production script
  mkdir -p "$TMP/$1/skills/x/scripts"
  printf '%s\n' "$2" > "$TMP/$1/skills/x/scripts/rogue.${3:-sh}"
}
scan_rc() { python3 -B "$SCAN" "$TMP/$1" >/dev/null 2>&1 && echo 0 || echo 1; }

plant legacy '#!/usr/bin/env bash
# This notice needs --wake because its recipient must still owe a tap done.
bash tap-send.sh peer -m "silent by accident" --from robot --fyi'
[ "$(scan_rc legacy)" = 1 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard accepted a planted unmarked send" >&2; exit 1; }
# …and it must ACCEPT the same site once the flag is on the command, or it is
# rejecting everything and proves nothing.
sed -i.bak 's/--fyi$/--fyi --wake/' "$TMP/legacy/skills/x/scripts/rogue.sh"
rm -f "${TMP:?}/legacy/skills/x/scripts/rogue.sh.bak"
[ "$(scan_rc legacy)" = 0 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard rejected a correctly marked send" >&2; exit 1; }

# The PUBLIC spelling is a call site too (tap-m5oq): an unmarked `tap send` is RED,
# a marked one is green, and a `tap send` named inside a quoted remedy or a backtick
# span is teaching prose, not a call, and must not be counted.
plant public '#!/usr/bin/env bash
tap send peer -m "hello" --from robot'
[ "$(scan_rc public)" = 1 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard accepted a planted unmarked public tap send" >&2; exit 1; }
plant public_marked '#!/usr/bin/env bash
tap send peer -m "hello" --from robot --wake'
[ "$(scan_rc public_marked)" = 0 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard rejected a correctly marked public tap send" >&2; exit 1; }
plant public_quoted '#!/usr/bin/env bash
tap_fail "no reply yet; run: tap send <id> --from robot"
echo '"'"'see `tap send --id X` for details'"'"''
[ "$(scan_rc public_quoted)" = 0 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard counted a quoted tap send remedy as a call site" >&2; exit 1; }
# In shell a backtick span, and a double-quoted span holding `$(`, are command
# substitution: those ARE call sites and must RED. In python a backtick span is prose.
plant public_backtick '#!/usr/bin/env bash
out=`tap send peer -m hi --from robot`'
[ "$(scan_rc public_backtick)" = 1 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard missed a backtick-substituted tap send in shell" >&2; exit 1; }
plant public_dquote_subst '#!/usr/bin/env bash
echo "sent: $(tap send peer -m hi --from robot)"'
[ "$(scan_rc public_dquote_subst)" = 1 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard missed a tap send substituted inside double quotes" >&2; exit 1; }
plant public_py_prose '"""Callers pass `tap send --id X` here."""' py
[ "$(scan_rc public_py_prose)" = 0 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard counted python backtick prose as a call site" >&2; exit 1; }
# Tokenised and irregular-whitespace spellings are call sites too (review finding).
plant public_argv '#!/usr/bin/env python3
import subprocess
subprocess.run(["tap", "send", "peer", "-m", "hi", "--from", "robot"])' py
[ "$(scan_rc public_argv)" = 1 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard missed an unmarked python argv-list tap send" >&2; exit 1; }
plant public_argv_marked '#!/usr/bin/env python3
import subprocess
subprocess.run(["tap", "send", "peer", "-m", "hi", "--from", "robot", "--wake"])' py
[ "$(scan_rc public_argv_marked)" = 0 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard rejected a marked python argv-list tap send" >&2; exit 1; }
plant public_spaced '#!/usr/bin/env bash
tap  send peer -m "hello" --from robot'
[ "$(scan_rc public_spaced)" = 1 ] \
  || { echo "fyi-wake-inventory: SELF-CHECK: the guard missed a double-space tap  send" >&2; exit 1; }

echo "fyi-wake-inventory: every production --fyi send states its pre-settlement decision; guard proven to fail on an unmarked send and pass a marked one: ok"
