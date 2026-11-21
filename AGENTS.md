# AGENTS.md

TAP (TAP Agent Protocol) lets AI coding agents coordinate through a file bus and a tmux courier:
agents register their panes, exchange messages, and hand work to each other without a human
relaying. This file orients an agent (or a human driving one) working in this repository.

- Run the tests that cover your change with the supported runners: `bash scripts/smoke-all.sh --only <file>`
  for shell tests, `bash runtime/bun/test/run.sh <file>` for Bun tests. Never run test files bare:
  the runners supply sandbox HOME, state paths and a private tmux server that bare runs lack.
- For a new setting or harness, start with the [extension guide](skills/extend/SKILL.md).
  Make and test your changes in this checkout. If other agents depend on the live
  installation, work in a separate checkout so edits cannot reach their next command.
- For Bun runtime changes, run `bun install --frozen-lockfile` once from
  `runtime/bun` in a fresh checkout, then run `bun run typecheck` there.
- Before a manual product check, run `tap help skill extend`. Confirm the returned
  `skills/extend/SKILL.md` belongs to the checkout you mean to exercise. If the
  installed command points elsewhere, use this checkout’s test runners to verify
  your edits before switching the installation.

## Contributing (PR flow)

[CONTRIBUTING.md](CONTRIBUTING.md) lists the prerequisites, the checks CI runs on every pull
request, and what a pull request needs. Follow that page before opening one.
