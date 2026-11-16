# AGENTS.md

TAP (TAP Agent Protocol) lets AI coding agents coordinate through a file bus and a tmux courier:
agents register their panes, exchange messages, and hand work to each other without a human
relaying. This file orients an agent (or a human driving one) working in this repository.

- Run the tests that cover your change with the supported runners: `bash scripts/smoke-all.sh --only <file>`
  for shell tests, `bash runtime/bun/test/run.sh <file>` for Bun tests. Never run test files bare:
  the runners supply sandbox HOME, state paths and a private tmux server that bare runs lack.
- Use the installed `tap` CLI, not a path into this checkout, when exercising the product.

## Contributing (PR flow)

[CONTRIBUTING.md](CONTRIBUTING.md) lists the prerequisites, the checks CI runs on every pull
request, and what a pull request needs. Follow that page before opening one.
