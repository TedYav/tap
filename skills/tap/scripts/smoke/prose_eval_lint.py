#!/usr/bin/env python3
"""Prose→eval lint: unquoted heredocs that write executables (tap-psif class).

The fork bomb in opencode-sessionstart-bind.test.sh was an unquoted heredoc
writing a fake `tap` stub whose COMMENT contained backticks. The shell evaluated
them at write time; multi-line stdout spliced into the stub; PATH-shadowed
recursion followed.

Rule
----
Flag an **unquoted** heredoc (`<<WORD`, not `<<'WORD'` / `<<"WORD"`) when:
  1. Its body looks like it writes an executable (shebang, or redirect target
     is later `chmod +x`'d in the same file), AND
  2. The body contains a bare backtick or `$(` (not preceded by a backslash).

Two-way anti-masking allowlist (same shape as benign_vocab_lint.py):
  every hit is fixed or matched by an allowlist entry that names why;
  every allowlist entry must match a live hit (stale exemption → fail).

Run: python3 prose_eval_lint.py [--show]
  exit 0 = clean; exit 1 = unclassified hit or stale allowlist entry.
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
SMOKE = os.path.join(ROOT, "skills", "tap", "scripts", "smoke")

# (file_suffix, line_number_of_heredoc_start, reason)
# line is 1-based start of `<<WORD`. Keep empty unless a deliberate exception
# is required — the cousins and the bomb are FIXED, not allowlisted.
ALLOWLIST: list[tuple[str, int, str]] = [
    # Intentionally empty at ship: every known hit is quoted or rewritten.
    # Add entries only with a named reason; stale entries fail the lint.
]

# Matches <<WORD / <<-WORD / << WORD / <<'WORD', including trailing redirects
# like `cat <<EOF > "$path"` (review P1 / <<- note — end-anchored `\s*(?:#.*)?$`
# previously missed those forms and returned a confident green miss).
HEREDOC_START = re.compile(
    r"""(?P<pre>.*?)(?P<op><{2}-?)\s*(?P<quote>['"]?)(?P<word>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)"""
    r"""(?P<suffix>\s*(?:#.*|(?:>|>>|&>|>&).*)?)?$"""
)
CHMOD_X = re.compile(r"""chmod\s+(?:.*\s+)?\+x\s+["']?(?P<path>[^\s"']+)""")
# `cat > path <<EOF` (prefix redirect) or `cat <<EOF > path` (trailing).
REDIRECT_PREFIX = re.compile(
    r"""(?:cat|tee)\s*>\s*["']?(?P<path>[^\s"']+)["']?\s*<<"""
)
REDIRECT_TRAILING = re.compile(
    r"""(?:cat|tee)\s+<<[^>\n]*>\s*["']?(?P<path>[^\s"']+)"""
)


def iter_sh_files() -> list[str]:
    out = []
    for dirpath, _dirs, files in os.walk(SMOKE):
        for name in files:
            if name.endswith(".test.sh") or name.endswith(".sh"):
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def bare_eval_spans(body: str) -> list[str]:
    """Return descriptions of bare ` or $( in body (backslash-escaped OK)."""
    hits = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            i += 2
            continue
        if ch == "`":
            hits.append("backtick")
            i += 1
            continue
        if ch == "$" and i + 1 < len(body) and body[i + 1] == "(":
            hits.append("$(")
            i += 2
            continue
        i += 1
    return hits


def parse_heredocs(text: str) -> list[dict]:
    """Return [{start_line, word, quoted, body, redirect_path}] for each heredoc."""
    lines = text.splitlines()
    found = []
    i = 0
    while i < len(lines):
        raw = lines[i]
        # Skip comment-only lines so '# ... <<EOF ...' docs don't false-fire.
        if raw.lstrip().startswith("#"):
            i += 1
            continue
        m = HEREDOC_START.search(raw)
        if not m:
            i += 1
            continue
        word = m.group("word")
        quoted = bool(m.group("quote"))
        strip_tabs = m.group("op").endswith("-")  # <<- strips leading tabs
        rm = REDIRECT_PREFIX.search(raw) or REDIRECT_TRAILING.search(raw)
        redirect = rm.group("path") if rm else ""
        body_lines = []
        j = i + 1
        while j < len(lines):
            end = lines[j].lstrip("\t") if strip_tabs else lines[j]
            if end == word:
                break
            body_lines.append(lines[j])
            j += 1
        found.append(
            {
                "start_line": i + 1,
                "word": word,
                "quoted": quoted,
                "body": "\n".join(body_lines),
                "redirect": redirect,
                "end_line": j + 1 if j < len(lines) else j,
            }
        )
        i = j + 1
    return found


def chmod_plus_x_paths(text: str) -> set[str]:
    paths = set()
    for m in CHMOD_X.finditer(text):
        paths.add(m.group("path"))
    return paths


def writes_executable(h: dict, chmod_paths: set[str]) -> bool:
    body = h["body"].lstrip()
    if body.startswith("#!"):
        return True
    redir = h["redirect"]
    if not redir:
        return False
    # Exact or basename match against chmod +x targets (handles $WORK/fakebin/tap).
    if redir in chmod_paths:
        return True
    base = os.path.basename(redir.rstrip("\"'"))
    for p in chmod_paths:
        if os.path.basename(p.rstrip("\"'")) == base and base in (
            "tap",
            "tmux",
            "python3",
            "bash",
            "sh",
            "chmod",
        ):
            return True
        if p.endswith(redir) or redir.endswith(p):
            return True
        # $VAR/fakebin/tap vs "$WORK/fakebin/tap"
        if base == os.path.basename(p) and "fakebin" in p and "fakebin" in redir:
            return True
        if base == os.path.basename(p) and "MOCKBIN" in redir.upper():
            return True
        if base == "tap" and (p.endswith("/tap") or p.endswith('"/tap"')):
            return True
    return False


def collect_hits() -> list[dict]:
    hits = []
    for path in iter_sh_files():
        rel = os.path.relpath(path, ROOT)
        text = open(path, encoding="utf-8", errors="replace").read()
        chmod_paths = chmod_plus_x_paths(text)
        for h in parse_heredocs(text):
            if h["quoted"]:
                continue
            if not writes_executable(h, chmod_paths):
                continue
            spans = bare_eval_spans(h["body"])
            if not spans:
                continue
            hits.append(
                {
                    "file": rel,
                    "line": h["start_line"],
                    "word": h["word"],
                    "spans": sorted(set(spans)),
                    "redirect": h["redirect"],
                }
            )
    return hits


def allowlist_match(hit: dict) -> tuple[str, str] | None:
    for file_suffix, line, reason in ALLOWLIST:
        if hit["file"].endswith(file_suffix) and hit["line"] == line:
            return (file_suffix, reason)
    return None


def main() -> int:
    show = "--show" in sys.argv
    hits = collect_hits()
    unclassified = []
    used_allow: set[tuple[str, int, str]] = set()
    for hit in hits:
        m = allowlist_match(hit)
        if m:
            used_allow.add((m[0], hit["line"], m[1]))
            if show:
                print(f"ALLOW {hit['file']}:{hit['line']} <<{hit['word']} {hit['spans']} — {m[1]}")
            continue
        unclassified.append(hit)
        print(
            f"HIT  {hit['file']}:{hit['line']} <<{hit['word']} "
            f"redirect={hit['redirect']!r} eval={hit['spans']}",
            file=sys.stderr,
        )

    stale = []
    for entry in ALLOWLIST:
        file_suffix, line, reason = entry
        if not any(
            h["file"].endswith(file_suffix) and h["line"] == line for h in hits
        ):
            stale.append(entry)
            print(
                f"STALE allowlist {file_suffix}:{line} — {reason}",
                file=sys.stderr,
            )

    if show:
        print(f"# {len(hits)} hit(s), {len(unclassified)} unclassified, {len(stale)} stale")

    if unclassified or stale:
        if unclassified:
            print(
                f"prose_eval_lint: {len(unclassified)} unclassified hit(s) — "
                f"quote the heredoc, remove bare ` / $(, or allowlist with a named reason",
                file=sys.stderr,
            )
        if stale:
            print(
                f"prose_eval_lint: {len(stale)} stale allowlist entr(y/ies) — "
                f"remove them (two-way anti-masking)",
                file=sys.stderr,
            )
        return 1
    print(f"prose_eval_lint: ok — {len(hits)} hit(s) classified, allowlist live")
    return 0


if __name__ == "__main__":
    sys.exit(main())
