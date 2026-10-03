#!/usr/bin/env bash
# tap.sh — stable root shim for the TAP transport.
# Enters through bin/tap, the same door as the installed `tap` command.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/tap" "$@"
