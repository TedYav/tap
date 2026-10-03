---
title: "An apostrophe in a heredoc nested inside a quoted command substitution makes a script unloadable under bash 3.2 — and `bash -n` cannot see it"
date: 2026-07-25
category: integration-issues
module: TAP shell scripts and the smoke suite
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "unexpected EOF while looking for a matching quote, plus syntax error at end of file — both reported at the LAST line of the script, hundreds of lines from the cause"
  - "the script fails at exec — before `set -e`, before argument parsing, before any of its own error handling"
  - "`bash -n` passes clean on the same file, and CI stays green"
  - "the break appears after an edit that only added or reworded a comment"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - development_workflow
  - testing_framework
tags:
  - bash-3-2
  - macos
  - heredoc
  - command-substitution
  - parse-error
  - portability
  - merge-gate
---

# An apostrophe in a heredoc inside a quoted command substitution breaks bash 3.2

## Problem

macOS still ships `/bin/bash` 3.2, and `skills/tap/scripts/smoke/bash32-parse.test.sh`
parses every tracked and untracked `*.sh` file with it. Extensionless shell entry
points are outside that list. Bash 3.2 scans a `"$( … )"` span looking for
the closing `)` **without heredoc awareness**: the heredoc body inside is read as ordinary shell
text. A single apostrophe in that body therefore opens a quote span that swallows the closing
parenthesis, and the file stops parsing. The script fails at exec — before `set -e`, before
argument handling, before any error message it could have produced about itself.

The trap fires on a **comment**. Writing *"the row's stored id"* in a Python heredoc nested in a
double-quoted command substitution is enough to make the whole shell file unloadable, and no
part of that edit looks like it could affect parsing.

The shape that fails is `result="$(python3 -B - … <<'PY' … PY\n)"` once the heredoc body
contains an apostrophe. A syntax check on bash 5 stays green.

## Symptoms

Putting one apostrophe into a comment inside that shape makes `/bin/bash -n` fail at the
last line of the file:

```
$ /bin/bash -n script.sh
script.sh: line 1224: unexpected EOF while looking for matching `"'
script.sh: line 1225: syntax error: unexpected end of file
$ echo $?
2
```

**The diagnostic points at end-of-file, ~850 lines past the cause**, and names the quote
character the scan happened to be inside when it ran out of input — `"` here, `'` in other
compositions. Neither line, and neither character, is the apostrophe. Grep for `'` inside every
`"$( … )"` heredoc in the file rather than reading toward the reported line.

Meanwhile:

```
$ bash -n script.sh    # PATH bash is 5.3.9 here — same bytes
$ echo $?
0
```

## What Didn't Work

**`bash -n` — including the repo's own CI sweep.** `scripts/ci-sanity.sh` tier A runs
`bash -n` over every tracked `*.sh` (`git ls-files '*.sh'`), which resolves to **PATH bash**:
5.x on a dev machine, and newer than 3.2 on the Linux CI runner too. Bash ≥ 4 parses this shape
correctly, so the sweep is structurally incapable of catching the defect. The check is not
weak — it is asking a different interpreter.

**Reading the diff.** The change was a comment. Nothing in a review of the added prose suggests
a parse consequence, and the `'` is not a shell metacharacter in any context the author was
thinking about.

## Solution

Remove apostrophes from any text inside a heredoc that sits within a double-quoted command
substitution, and leave a note at the site so the next author does not reintroduce one:

```sh
# (No apostrophes below: this heredoc sits inside a command substitution, and
# bash 3.2 scans that span without heredoc awareness — see bash32-parse.)
```

Reword rather than escape: *"the row's stored id"* → *"the stored id of the row"*, or drop the
possessive. Escaping inside a heredoc changes the text the interpreter receives, which is a
different bug.

### The exact trigger, verified

The failure needs a specific composition. Compared on bash 3.2 and bash 5, one variable per run:

| Shape | 3.2 | 5.x |
|---|---|---|
| `out="$(cmd <<'PY'` … apostrophe … `PY\n)"` — heredoc in a **double-quoted** command substitution | **fail** | pass |
| `out=$(cmd <<'PY'` … apostrophe … `PY\n)` — same, **unquoted** | pass | pass |
| ``out=`cmd <<'PY'` `` … apostrophe … — backticks | pass | pass |
| `cmd <<'PY'` … apostrophe … — heredoc with no command substitution | pass | pass |
| double-quoted `"$( … )"`, heredoc contains `"` but no `'` | pass | pass |

So all three must hold: a heredoc, inside `$( … )`, inside double quotes. That is precisely the
shape `bash32-parse.test.sh`'s own header records from the earlier occurrence of this family —
*"a heredoc-inside-`$()`-inside-double-quotes pattern that bash 3.2 cannot parse"* — which broke
`tap register` for a seat whose minimal PATH resolved `env bash` to `/bin/bash`.

**Two refinements that make the trap intermittent**, and are worth knowing when diagnosing:

- **Parity.** An *even* number of apostrophes balances and parses clean; an *odd* number breaks.
  A file can be fixed accidentally by adding a second apostrophe, and broken later by removing
  one — with the edit that appears to break it being innocent.
- **A double-quoted run shelters it.** `print("it's here")` parses fine, because the `"` opens a
  double-quoted region in which `'` is literal to the scanner. So "there is already an
  apostrophe in this heredoc and it works" proves nothing about the next one.

## Why This Works

The scan is purely lexical and the heredoc is invisible to it. Bash 3.2 advances through the
`$( … )` span tracking quote state so it can find the matching `)`; it does not model
`<<'PY' … PY` as a region whose contents are data. An unmatched `'` therefore opens a
single-quote span that runs past the `)`, and the parser reports EOF while still looking for the
close. Bash ≥ 4 tracks the heredoc, so the same bytes are unambiguous — which is why the shape,
not the apostrophe, is what portability depends on. Removing the odd apostrophe restores the
scan on 3.2 and changes nothing on 5.x.

## Prevention

Two checks exist, and they do not ask the same interpreter.

- **`skills/tap/scripts/smoke/bash32-parse.test.sh`** runs `/bin/bash -n` over
  `git ls-files` of `*.sh`: tracked and untracked, ignored paths excluded, missing
  paths dropped, with a floor of 150. Extensionless shell entry points are not in
  that list. The check is not one of the smokes `scripts/ci-sanity.sh` runs, so a
  green required smoke job has not asked bash 3.2. On Linux CI `/bin/bash` is
  newer than 3.2, so the 3.2 question is the macOS run.
- **`scripts/ci-sanity.sh`** runs `bash -n` (PATH bash) over tracked `*.sh` files
  only (`git ls-files '*.sh'`, no untracked files). That bash is newer than 3.2
  on a dev machine and on the Linux runner, so the sweep cannot catch this shape.

A green PATH-bash sweep does not show that bash 3.2 can parse the file. A green
`/bin/bash` run shows that only when `/bin/bash` is 3.2, as on macOS.

When adding prose inside a heredoc in a command substitution, prefer the in-file note
above over remembering the rule.

## Related

- `AGENTS.md` §Contributing — the local-full-suite merge gate and the scope of the CI sanity
  subset.
