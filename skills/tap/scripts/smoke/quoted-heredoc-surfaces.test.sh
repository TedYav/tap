#!/usr/bin/env bash
# quoted-heredoc-surfaces.test.sh — tap-liero U3
# The three shell-facing message verbs present one safe, pasteable default on every
# high-traffic instruction surface. The permissive -m API remains documented as an
# alternative; this control rejects only executable examples that make it primary.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "quoted-heredoc-surfaces: $*" >&2
  exit 1
}

python3 - "$ROOT" <<'PY'
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
required = {
    "skills/tap/QUICK-REFERENCE.md": ("send", "reply", "escalate"),
    "skills/tap/SKILL.md": ("send",),
    "skills/send/SKILL.md": ("send",),
    "skills/reply/SKILL.md": ("reply",),
    "skills/escalate/SKILL.md": ("escalate",),
    "skills/lead/references/choreography-best-practices.md": ("send", "escalate"),
}

for relative, verbs in required.items():
    text = (root / relative).read_text()
    if re.search(r"-f\s+/tmp/(?:reply|question)\.md\b", text):
        raise SystemExit(f"quoted-heredoc-surfaces: shared fixed body path in {relative}")
    if "creates a unique file by default" in text:
        raise SystemExit(f"quoted-heredoc-surfaces: Write tool does not allocate paths in {relative}")
    lines = text.splitlines()
    for verb in verbs:
        needle = f"tap {verb} "
        has_file_first = any(
            needle in line and ("-f <path>" in line or ("-f " in line and "<<" not in line and "-m" not in line))
            for line in lines
        )
        has_heredoc_alt = any(needle in line and "-f - <<'EOF'" in line for line in lines)
        if not has_file_first:
            raise SystemExit(
                f"quoted-heredoc-surfaces: {relative} does not present "
                f"tap {verb} with file-first -f <path>"
            )
        if not has_heredoc_alt:
            raise SystemExit(
                f"quoted-heredoc-surfaces: {relative} does not present "
                f"tap {verb} with quoted-heredoc alternative -f - <<'EOF'"
            )

example = re.compile(r"^(?:[$>]\s*)?tap (send|reply|escalate)\b.*(?:^|\s)-m(?:\s|$)")
carriers = set(required)
dispatch_roots = ("skills/lead", "skills/drive", "skills/pair")
instruction_carriers = {"AGENTS.md", "install.sh"}
carriers.update(instruction_carriers)
for directory in dispatch_roots:
    carriers.update(
        str(path.relative_to(root)) for path in (root / directory).glob("**/*.md")
    )
for relative in sorted(carriers):
    for number, line in enumerate((root / relative).read_text().splitlines(), 1):
        candidate = line.strip().lstrip("-* ").strip("`").split(" #", 1)[0]
        inline_commands = (
            re.findall(r"`([^`]+)`", line)
            if relative.startswith(dispatch_roots) or relative in instruction_carriers
            else ()
        )
        if example.search(candidate) or any(example.search(command) for command in inline_commands):
            raise SystemExit(
                f"quoted-heredoc-surfaces: stale executable -m example at "
                f"{relative}:{number}: {line.strip()}"
            )

# A nested Markdown fence can look right while its indented EOF remains body text
# when copied raw. Drive the actual snippet through bash's parser.
using_tap = (root / "skills/tap/SKILL.md").read_text().splitlines()
start = next(i for i, line in enumerate(using_tap) if "tap send glm --ask -f - <<'EOF'" in line)
stop = next(i for i in range(start + 1, len(using_tap)) if using_tap[i].strip() == "```")
snippet = "\n".join(using_tap[start:stop]) + "\n"
parsed = subprocess.run(["bash", "-n"], input=snippet, text=True, capture_output=True)
if parsed.returncode or parsed.stderr:
    raise SystemExit(
        "quoted-heredoc-surfaces: using-tap's presented heredoc is not pasteable: "
        + parsed.stderr.strip()
    )

stale_primary = {
    "skills/tap/USAGE.md": (
        "Use `-m` for short plain text.",
        "The quoted-heredoc form is the default",
    ),
    "skills/tap/scripts/CONTRACT.md": (
        "then send with `tap send <to> -m",
        "`tap escalate (-m",
        "**Primary address form:** `tap send <team>/<handle> (-m",
        "**Primary address form:** `tap send <team>/<handle> -f - <<'EOF'`\n",
        "canonical presentation: literal stdin answer",
        "canonical presentation: literal stdin question",
        "-f - <<'EOF'`; put the body on following lines",
    ),
    "skills/send/SKILL.md": (
        "the same heredoc form",
    ),
}
# tap-4eyx5 holds tap poll's emitted -m recovery string, its matching CONTRACT
# transcription, and the sibling tap-reply.sh hints as one runtime-owned change.
for relative, needles in stale_primary.items():
    text = (root / relative).read_text()
    for needle in needles:
        if needle in text:
            raise SystemExit(
                f"quoted-heredoc-surfaces: stale primary -m syntax in {relative}: {needle}"
            )
PY

help_out="$(bash "$ROOT/bin/tap" help)"
send_help="$(bash "$ROOT/bin/tap" help send)"
reply_help="$(bash "$ROOT/bin/tap" help reply)"
escalate_help="$(bash "$ROOT/bin/tap" help escalate)"

grep -Fq "tap send <peer> -f <file>" <<<"$help_out" \
  || fail "overview does not present tap send with file-first -f <path>"
grep -Fq "tap reply <id> -f <file>" <<<"$help_out" \
  || fail "overview does not present tap reply with file-first -f <path>"
grep -Fq "tap escalate -f <file>" <<<"$help_out" \
  || fail "overview does not present tap escalate with file-first -f <path>"
grep -Fq "tap send <to|team/to>" <<<"$send_help" && grep -Fq -- "-f <path>" <<<"$send_help" \
  || fail "tap help send does not present file-first -f <path>"
grep -Fq "tap reply <id|team/id|path>" <<<"$reply_help" && grep -Fq -- "-f <path>" <<<"$reply_help" \
  || fail "tap help reply does not present file-first -f <path>"
grep -Fq "tap escalate" <<<"$escalate_help" && grep -Fq -- "-f <path>" <<<"$escalate_help" \
  || fail "tap help escalate does not present file-first -f <path>"
# Verify heredoc alternative is still mentioned in the detailed help
grep -Fq "<<'EOF'" <<<"$send_help" || fail "tap help send does not mention the quoted-heredoc alternative"
grep -Fq "<<'EOF'" <<<"$reply_help" || fail "tap help reply does not mention the quoted-heredoc alternative"
grep -Fq "<<'EOF'" <<<"$escalate_help" || fail "tap help escalate does not mention the quoted-heredoc alternative"

mkdir -p "$WORK/repo/.tap/bus"
printf '{}\n' >"$WORK/repo/.tap/bus/registry.json"
advisory="$("$ROOT/bin/tap" help advisory)"
printf '%s\n' "$advisory" >"$WORK/advisory.txt"
python3 - "$WORK/advisory.txt" <<'PY'
import pathlib
import sys

lines = pathlib.Path(sys.argv[1]).read_text().splitlines()
for verb in ("send", "reply"):
    file_first = any(f"tap {verb} " in line and "-f <path>" in line for line in lines)
    if not file_first:
        raise SystemExit(
            f"quoted-heredoc-surfaces: advisory does not present tap {verb} with file-first -f <path>"
        )
    heredoc_lines = [i for i, line in enumerate(lines) if f"tap {verb} " in line and "<<'EOF'" in line]
    if not heredoc_lines:
        raise SystemExit(
            f"quoted-heredoc-surfaces: advisory does not present tap {verb} with <<'EOF' alternative"
        )
    start = heredoc_lines[0]
    if not lines[start].endswith("<<'EOF'"):
        raise SystemExit(
            f"quoted-heredoc-surfaces: advisory {verb} opener has shell tokens after <<'EOF': "
            f"{lines[start]}"
        )
    eof_found = False
    body_found = False
    for j in range(start + 1, min(start + 5, len(lines))):
        if lines[j] == "EOF":
            eof_found = True
            break
        if lines[j].strip():
            body_found = True
    if not body_found:
        raise SystemExit(
            f"quoted-heredoc-surfaces: advisory {verb} heredoc has no body between opener and EOF"
        )
    if not eof_found:
        raise SystemExit(
            f"quoted-heredoc-surfaces: advisory {verb} heredoc has no closing EOF within 4 lines of opener"
        )
PY
if grep -Eq '^  tap (send|reply|escalate) .* -m([[:space:]]|$)' <<<"$advisory"; then
  fail "on-demand advisory still presents an executable -m example"
fi

echo "quoted-heredoc-surfaces: canonical docs, live help, and advisory: ok"
