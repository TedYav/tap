#!/bin/sh
# Template for libexec/tap/bun in a TAP release artifact (the release build
# copies it there). It runs the sibling compiled router as Bun for TAP's own
# child processes, so an artifact install needs no Bun on PATH. The preload
# deletes BUN_BE_BUN before the child's code runs, so it never reaches a
# harness, a tmux server or a user command.
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 127
BUN_BE_BUN=1 exec "$here/tap" --preload "$here/../../runtime/bun/src/artifact-bun-preload.ts" "$@"
