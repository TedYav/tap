---
name: Bug report
about: Report a problem with TAP
labels:
  - bug
---

**What happened?**

A clear description of the bug, including what you expected to happen.

**Steps to reproduce**

Minimal steps, starting from a fresh terminal.

**Environment**

- OS and version (`uname -a`):
- tmux version (`tmux -V`):
- bash version (`bash --version | head -1`):
- harness and version (the agent TAP drives, e.g. Claude Code, Codex, opencode):

**`tap doctor` output**

**Warning: `tap doctor` output contains absolute paths from your machine. Redact anything you
would not publish before submitting.**

```
(paste tap doctor output here)
```

**Pane capture** (optional, but often decisive)

**Warning: pane captures contain absolute paths and message bodies — often including names and
content from your other work, not just TAP. Redact before submitting.**

```
(tmux capture-pane -p -t <session>:<window>.<pane>)
```
