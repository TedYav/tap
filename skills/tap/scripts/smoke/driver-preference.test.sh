#!/usr/bin/env bash
# driver-preference.test.sh — the checked-in reference config declares no
# per-harness driver key (TAP 1.0, tap-49kp6).
#
# The resolver itself is native now: resolveConfiguredDriver in
# runtime/bun/src/verbs/send.ts, driven by runtime/bun/test/send-driver-preflight.test.ts.
# What stays here is the one arm about a shipped FILE rather than the resolver.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

fail() { echo "driver-preference: $*" >&2; exit 1; }

# --- (ref) the checked-in reference declares NO driver key at all -------------
# Two findings landed on this arm at once.
#
# sol-ponytail: the old version used awk plus a substring test, so it could GREEN
# on a family whose real assignment was `driver = "ccnative"` with the word tmux
# appearing in a trailing comment. A substring is not a value, and an arm that
# accepts a comment as evidence is asserting on prose.
#
# And the reference no longer carries `driver` keys at all. They selected the
# default the code already provides, and their only live effect was to brick
# Python 3.10 operators who copied the file: the courier cannot parse it there,
# so an existing preference it cannot read forced a choice between refusing every
# send and silently ignoring the operator. Removing a key that never did anything
# dissolved that choice.
#
# So this arm now asserts ABSENCE, and it parses with tomllib rather than
# pattern-matching.
_ref_out="$(python3 -I -B - "$ROOT/skills/tap/config/config.v3.toml" <<'ENDPY'
import sys, tomllib
with open(sys.argv[1], "rb") as fh:
    doc = tomllib.load(fh)
bad = []
for fam, table in (doc.get("harness") or {}).items():
    if isinstance(table, dict) and "driver" in table:
        bad.append("%s=%r" % (fam, table["driver"]))
# The roles table legitimately has its own `driver` key describing a human role.
# Only [harness.*] is in scope here -- which is exactly why a whole-document
# substring test could never have been the right instrument.
print(" ".join(bad))
ENDPY
)" || fail "(ref) could not parse the checked-in reference config"
[ -z "$_ref_out" ] || \
  fail "(ref) the checked-in reference declares harness driver keys ($_ref_out); selection is a code fact and a shipped key only breaks python3.10 operators who copy this file"
echo "driver-preference: (ref) the checked-in reference declares no harness driver key: ok"


echo "driver-preference: ok"
