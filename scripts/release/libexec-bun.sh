#!/bin/sh
# Template for libexec/tap/bun in a TAP release artifact (the release build
# copies it there). It runs the sibling compiled router as Bun for TAP's own
# child processes, so an artifact install needs no Bun on PATH. The preload
# deletes BUN_BE_BUN before the child's code runs, so it never reaches a
# harness, a tmux server or a user command.
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 127
# Run as the Bun command line, the router loads "$PWD/bunfig.toml" (its preload
# scripts run before the entry file) and "$PWD/.env" whatever it was compiled
# with, and a child inherits the directory the user is working in. Name TAP's
# own configuration and turn the env file off. Bun exits on a configuration
# path it cannot read, so the empty device stands in when none is shipped.
config="$here/../../runtime/bun/tap-bunfig.toml"
[ -f "$config" ] || config=/dev/null
BUN_BE_BUN=1 exec "$here/tap" --config="$config" --no-env-file --preload "$here/../../runtime/bun/src/artifact-bun-preload.ts" "$@"
