#!/bin/bash
# tap-shell-body-guard.sh — the shell-body guard's door in a TAP release artifact
# (tap-7r3fn.192). A checkout registers tap-shell-body-guard.ts directly and its shebang
# finds Bun on PATH; an artifact has no Bun there, so its installer registers this file,
# which runs the guard through libexec/tap/bun. exec keeps the hook payload on stdin and
# the decision JSON on stdout, the guard's launch contract, and passes its exit status.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$here/../libexec/tap/bun" ]; then exec "$here/../libexec/tap/bun" "$here/tap-shell-body-guard.ts" "$@"; fi
exec bun "$here/tap-shell-body-guard.ts" "$@"
