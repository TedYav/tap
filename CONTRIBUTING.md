# Contributing

Pull requests are welcome — fork the repository, branch, and open a PR against `main`. Before
opening one, run the test suite once from a checkout: `bash scripts/smoke-all.sh`. It needs tmux
installed and an interactive terminal; a single test runs with `bash scripts/smoke-all.sh --only
<file>`, and an unattended (no-tty) full run must set `TAP_RUNNER_ALLOW=1`. AI-assisted PRs are
welcome and carry the same evidence as any other PR: green CI plus `bash scripts/smoke-all.sh
--only <file>` runs for the tests touching your change, and a description of what changed and
why. There is no DCO or CLA; by opening a PR you license your contribution under the
repository's [MIT license](LICENSE).
