---
title: A zero at the boundary is a claim about the instrument
date: 2026-09-04
last_updated: 2026-09-26
category: best-practices
module: tooling
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - "a count, a match, or a listing comes back empty and that emptiness would license the next action"
  - "a one-off pipeline ends in wc -l, grep -c, or test -z"
  - "a command's exit status is discarded because only its stdout is being read"
tags:
  - instrument-design
  - boundary-values
  - shell-pipelines
---

# A zero at the boundary is a claim about the instrument

A broken instrument and a true empty result produce the same bytes. Elsewhere in
its range, a failure looks wrong: a negative, a trace, a garbage string. At the
boundary, `0` and "no matches" look like success. Before that result licenses a
delete, a re-send, or a stand-down, the instrument has to show that failure
would have looked different.

## Five ways failure collapses into empty

**1. Stderr was the error, and stdout was empty.**

```bash
git diff --name-only origin/main...<branch> | wc -l
```

With no merge base, the three-dot form prints `fatal: no merge base` on stderr
and nothing on stdout. `wc -l` counts that nothing and reports `0`. A two-dot
diff of the same branch lists the files. Read the exit status. `set -o pipefail`,
or capture stderr separately. A pipeline that ends in `wc -l` has already thrown
away the only evidence that the command failed.

**2. The glob failed because the directory was large.**

```bash
ls *.md | wc -l
find . -name '*.md' | wc -l
```

The shell expands `*.md` to more arguments than it can pass. `ls` never runs,
`Argument list too long` goes to stderr, and `wc -l` counts the empty stdout
as `0`. `find` lists the files. The same shape run twice
(`ls | wc -l` and `ls | grep -c`) fails together. A second command has to be
shaped differently.

**3. The search ran on the rendered pane.**

```bash
tmux capture-pane -p -t %37 | grep -c <payload-id>
tmux capture-pane -p -J -t %37 | grep -c <payload-id>
```

Without `-J`, long lines wrap for display and a single id can split across
rows, so the count is `0` for a string that is on the pane. That `0` reads as
"it never arrived" and licenses a re-send of something already delivered.

**4. `timeout` printed nothing, and `head` hid the status.**

A short `timeout` around `tap outstanding` can return no output while a longer
run prints the count and a non-zero status. Piping that command to `head`
discards the exit code as well. Empty output from an outstanding-work check
reads as "nothing owed," which is the condition for standing down.

**5. An unbraced colon empties both revisions.**

```bash
o=$(git rev-parse $OLD:src/file)
n=$(git rev-parse $NEW:src/file)
[ "$o" = "$n" ] && echo "SAME BLOB"
```

In zsh, `:` after a bare variable name starts a history modifier only when the
next character is a modifier. `s` is one, so `$OLD:src/file` fails with
`bad substitution`. `$OLD:path` does not, because `p` is not a modifier. Both
variables stay empty, and the test prints `SAME BLOB`. Quoting does not fix a
path that starts with a modifier: `"$OLD:src/file"` still parses it. Brace the
name so the colon falls outside the expansion, and refuse to compare values
the commands did not return:

```bash
o=$(git rev-parse "${OLD}:src/file") && n=$(git rev-parse "${NEW}:src/file") \
  && [ -n "$o" ] && [ -n "$n" ] && [ "$o" = "$n" ] && echo "SAME BLOB"
```

## The practice

When a count comes back at the boundary, check the instrument before writing
the finding.

- Read the exit status, and stop discarding stderr.
- Re-derive a licensing zero with a second, differently-shaped command.
- Prefer the instrument that can refuse. An instrument whose failure mode is
  silence cannot authorize a deletion. Where only a silent instrument exists,
  its `0` is a prompt to find a louder one.

A count that licenses a closeout also has to name its population. A static
search read as call volume, or a rolling status file read as the whole history
after it has dropped the oldest run, measures a narrower set than the number
claims. If the accounting record is unavailable, the count is unknown.

An empty result is usually a real empty result. Check the instrument when that
empty result is the reason for the next action, especially when the action
cannot be undone.

## A working instrument, the wrong baseline

A check can be correct and still not support the decision. Four symbols present
on `main` and present in the branch's files are not evidence that the branch's
work landed, if those symbols already existed at the merge base. Re-running the
check does not help. The comparison has to be: present on the branch, absent at
the merge base, present on `main`.

## Existence checks that cannot refuse

`test -e`, `test -L`, and `os.path.lexists` return "absent" when a parent
directory cannot be searched. `test -L` and `os.path.lexists` still report a
symlink they can see, including one that dangles or points at itself. They
return "absent" for `ELOOP` only when the path has to walk through that loop.
A licensing absence has to come from a check that reports the lookup failure,
such as `lstat` treating only `ENOENT` and `ENOTDIR` as absence.
