#!/usr/bin/env bash
# tap-7r3fn.81: a cursor overlay alone is not evidence of placeholder paint.
# Run through smoke-all --only; captures are files and no live pane is touched.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus" TAP_INDEX_HOME="$WORK/index"
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
fail() { echo "short-human-draft: $*" >&2; exit 1; }

# This is the committed live Claude capture with the cursor at the draft's
# first character. Short variants minimize its text while retaining its paint
# and geometry; they are derived controls, not additional live observations.
FIXTURE="$ROOT/skills/tap/scripts/smoke/fixtures/submit-verify/claude-draft-cursor-at-start.ansi"
python3 -B - "$FIXTURE" "$WORK" <<'PY'
from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text(); work=Path(sys.argv[2])
old='\x1b[7mh\x1b[0mello world draft'
assert old in source
variants={
    'plain-one':'S',
    'cursor-one':'\x1b[7mS\x1b[0m',
    'dim-glyph-cursor-one':'\x1b[7mS\x1b[0m',
    'cursor-three':'\x1b[7mS\x1b[0mou',
    'queued-hint':'\x1b[2mPress up to edit queued messages\x1b[0m',
    'cursor-hint':'\x1b[7mP\x1b[0;2mress up to edit queued messages\x1b[0m',
}
for name,text in variants.items():
    frame=source.replace(old,text)
    if name=='dim-glyph-cursor-one':
        frame=frame.replace('❯\xa0','\x1b[2m❯\xa0\x1b[0m')
    (work/name).write_text(frame)
PY

# Keep production inputline, escaped-inputline, glyph stripping and placeholder
# classification. Only the tmux transport is replaced by a captured frame: the
# pair the courier hands the native reader is "<bytes-of-escaped>\n<escaped><plain>",
# and tmux's plain view is the escaped capture without its escapes.
pair() {
  python3 -B - "$1" <<'PY'
import re,sys
esc=open(sys.argv[1],'rb').read()
plain=re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', esc)
sys.stdout.buffer.write(str(len(esc)).encode()+b'\n'+esc+plain)
PY
}
assert_input() {
  local got
  got="$( { pair "$1" | TAP_PANE_WIDTH=200 bun "$ROOT/runtime/bun/test/support/pending-input-cli.ts" %fixture claude || exit 1; printf X; } )" \
    || fail "$2: reader refused"
  got="${got%X}"
  [ "$got" = "text"$'\x1f'"$3" ] || fail "$2: expected '$3', got '$got'"
  echo "short-human-draft: $2: ok"
}
assert_input "$FIXTURE" 'original live draft' 'hello world draft'
assert_input "$WORK/plain-one" 'plain one-character draft' S
assert_input "$WORK/cursor-one" 'reverse-only one-character draft' S
assert_input "$WORK/dim-glyph-cursor-one" 'dim prompt glyph is not dim draft evidence' S
assert_input "$WORK/cursor-three" 'cursor plus ordinary draft text' Sou
# The hint wording is retained from the incident's actual clobber backup. Paint
# variants are explicit controls: a real dim span still supplies placeholder proof.
assert_input "$WORK/queued-hint" 'dim queued-message hint' ''
assert_input "$WORK/cursor-hint" 'cursor-split dim queued-message hint' ''
