# Structured failures and JSON output — source part 5 of 7

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0101 start=676835 end=677604 sha256=27491eaabca530ac498278f307b2bf7b84c3b2735480cc34d64eada13ee967ae fragment=5/7 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
Successful warnings are exempt from the failure-line rule: malformed-payload warnings in `poll`/`outstanding`, registry/info warnings from `register`, and `doctor` report warnings are not `error_class` lines when the command is otherwise reporting state. `poll`/`outstanding` exit `0` whether or not items exist (CLI-EXIT-0): listed items are state, not failure.

`--json` is explicit opt-in; no TTY detection changes structure. It is supported on `whoami`, `send`, `poll`, `outstanding`, `team`, `register`/`in`, `health`, `admin dashboard`, `admin refresh`, `admin retire`, `admin rebuild-registry`, `doctor`, `init`, and `peek`. On ordinary failures with `--json`, stdout contains `{"ok":false,"error_class":"...","action":"...",...}` and nothing is written to stderr. Success/status shapes are:

