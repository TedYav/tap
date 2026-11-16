# Contributing

Pull requests are welcome: fork the repository, branch, and open a PR against `main`.
AI-assisted PRs are welcome and carry the same evidence as any other PR.

## What you need

Git, Bash 5 or newer, Bun 1.4 or newer, tmux, jq, tar and lsof (the tools the installer
checks), plus Python 3.12 or newer for the shell test runner.

The shell test runner resets `PATH` to
`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` and admits only Bun from
elsewhere. A Bash, Python or tmux installed through pyenv, asdf, nix or Linuxbrew is not
seen there; install them where that path finds them.

## What CI checks

Every pull request runs on Ubuntu with a read-only token and no secrets:

1. `scripts/ci-sanity.sh`: parse sweeps and fast smoke tests, in a sandbox.
2. `(cd runtime/bun && bun install --frozen-lockfile && bun run typecheck)`.
3. The Bun test files listed in the workflow, through `bash runtime/bun/test/run.sh`: the part
   of the suite known to pass on Linux.
4. An install smoke: `./install.sh` into a throwaway `HOME`, then `tap help`.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) holds the exact commands and the
sandbox environment each one runs in. Copy that environment if you run the first or fourth
check yourself: run bare, the install smoke installs TAP into your real home directory.

## Test what you changed

Run the tests that cover your change through the supported runners:

```bash
bash scripts/smoke-all.sh --only <shell-test-file>
bash runtime/bun/test/run.sh <bun-test-file>
```

Never run a test file bare. The runners give each test a sandbox `HOME`, private TAP state
and a private tmux server; a bare `bun test` or a hand-run script uses your real ones.

You do not need to run the whole suite. It is large, it is developed and run on macOS, and
the maintainers run it there. An unattended full run refuses unless `TAP_RUNNER_ALLOW=1`
is set.

## What a pull request needs

- Green CI.
- The runner commands you ran and their results.
- What changed and why.

Reviews are best effort, with no response-time guarantee. There is no DCO or CLA; by
opening a PR you license your contribution under the repository's [MIT license](LICENSE).
