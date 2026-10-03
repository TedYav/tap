#!/usr/bin/env python3
"""Refuse known source shapes that can escape suite-owned state roots."""

from dataclasses import dataclass
from pathlib import Path
import re
import sys


@dataclass(frozen=True)
class Finding:
    line: int
    reason: str


_OPERATOR_HOME = re.compile(
    r"(?:^|[;\s'\"])(?:export\s+)?HOME\s*=\s*"
    r"['\"]?(?:/Users/|/home/|~(?:/|['\"]|$))"
)
_EXTERNAL_SOCKET = re.compile(
    r"(?:\btmux\b|TMUX_BIN).*?(?:^|\s)-S(?:\s+)?['\"]?"
    r"(?:/private/|/tmp/|/Users/|/home/|~)",
    re.IGNORECASE | re.DOTALL,
)
_ROOT_RESET = re.compile(
    r"(?:^|[;\s])(?:export\s+)?(?:TMUX|TMUX_TMPDIR)\s*=\s*['\"]?"
    r"(?:/private/|/tmp(?=/|['\";\s]|$)|/Users/|/home/|~)"
)
_ROOT_UNSET = re.compile(r"(?:^|[;\s])unset\s+(?:TMUX\s+)*TMUX_TMPDIR(?:\s|$)")
_ABSOLUTE_TMUX = re.compile(
    r"(?:^|[;\s'\"=(])(?:/(?:opt/homebrew|usr/local|usr)/bin|/bin)/tmux\b"
)
_UNSAFE_NAME = re.compile(r"(?:\btmux\b|TMUX_BIN).*?(?:^|\s)-L(?:\s+)?['\"]?(?:\.\.?/|/)")
_GENERATED_EXTERNAL = re.compile(
    r"subprocess\.(?:run|Popen)\s*\(.*?(?:/usr/bin/)?tmux.*?['\"]-S['\"]"
    r".*?['\"](?:/private/|/tmp/|/Users/|/home/|~)",
    re.DOTALL,
)
_ENV_RECONSTRUCTION = re.compile(
    r"\benv\b.*?(?:-u|--unset(?:=|\s+))\s*TMUX_TMPDIR\b", re.DOTALL
)
_PATH_RECONSTRUCTION = re.compile(
    r"(?:^|[;\s])PATH\s*=\s*.*?\btmux\b", re.IGNORECASE | re.DOTALL
)


def _statements(text: str) -> tuple[tuple[int, str], ...]:
    lines = text.splitlines()
    result: list[tuple[int, str]] = []
    index = 0
    while index < len(lines):
        start = index + 1
        block = [lines[index]]
        bracketed = "subprocess.run([" in lines[index] or "subprocess.Popen([" in lines[index]
        balance = lines[index].count("[") - lines[index].count("]") if bracketed else 0
        while index + 1 < len(lines) and (block[-1].rstrip().endswith("\\") or balance > 0):
            index += 1
            block.append(lines[index])
            if bracketed:
                balance += lines[index].count("[") - lines[index].count("]")
        result.append((start, "\n".join(block)))
        index += 1
    return tuple(result)


def scan(path: Path) -> tuple[Finding, ...]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return (Finding(0, "read-error"),)
    findings: list[Finding] = []
    for line, statement in _statements(text):
        if statement.lstrip().startswith("#"):
            continue
        if _OPERATOR_HOME.search(statement):
            findings.append(Finding(line, "operator-home-reset"))
        elif (
            _EXTERNAL_SOCKET.search(statement)
            or _UNSAFE_NAME.search(statement)
            or _GENERATED_EXTERNAL.search(statement)
        ):
            findings.append(Finding(line, "external-tmux-socket"))
        elif _ROOT_RESET.search(statement) and not re.search(
            r"(?:fake|mock|ambient)[-_a-z0-9]*", statement, re.IGNORECASE
        ):
            findings.append(Finding(line, "tmux-root-reset"))
        elif _ROOT_UNSET.search(statement):
            findings.append(Finding(line, "tmux-root-reset"))
        elif _ABSOLUTE_TMUX.search(statement):
            findings.append(Finding(line, "absolute-real-tmux"))
        if _ENV_RECONSTRUCTION.search(statement):
            findings.append(Finding(line, "note:tmux-environment-reconstruction"))
        if _PATH_RECONSTRUCTION.search(statement):
            findings.append(Finding(line, "note:tmux-path-reconstruction"))
    return tuple(findings)


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: smoke_hermeticity_lint.py <smoke-file>...", file=sys.stderr)
        return 64
    blocking = False
    for raw in argv:
        path = Path(raw)
        for finding in scan(path):
            print(f"{path}:{finding.line}:{finding.reason}")
            if not finding.reason.startswith("note:"):
                blocking = True
    return 1 if blocking else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
