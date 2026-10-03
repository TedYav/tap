#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bus/spool" "$WORK/bus/receipts"
cat > "$WORK/bus/spool/queued.meta.json" <<'JSON'
{"reason_class":"busy","reason":"pending-input","waiter_lifetime":"grace-window","deadline_epoch":2000000060,"next_probe_epoch":2000000001}
JSON
printf '%s\n' '---' 'id: queued' 'from: alice' 'to: peer' 'kind: ask' 'reply: expected' '---' 'body' > "$WORK/bus/spool/queued.md"
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
# The read-only explanation is native (queue-explanation.ts); called directly.
queue_explanation() { tap_bun_call queue-explanation "$1" queue-explanation.ts "$TAP_HOME" "$1"; }
tap_bun_call show-render queued show-render.ts "$WORK/bus/spool/queued.md" "$WORK/bus" queued fixture spool "$(TAP_HOME="$WORK/bus" queue_explanation queued)" > "$WORK/show"
python3 -B - "$WORK/show" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
for required in ('busy/pending-input', 'occupied composer', 'next probe:', 'grace deadline:', '.unconfirmed'):
    assert required in text, f'queue explanation missing {required!r}:\n{text}'
PY
# Default (non-verbose) send receipts must carry the explanation too. Exercise
# the native park route with an already-placed payload; pane flash and
# detached scheduling are external effects irrelevant to receipt wording here.
export TAP_HOME="$WORK/bus" TAP_SPOOL_DISABLE_DELIVERER=1 TAP_VERBOSE=0
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-park-placed-fixture.sh"
tap_ensure_dirs
printf '%s\n' '---' 'id: receipt' 'from: alice' 'to: peer' 'kind: ask' 'reply: expected' '---' 'body' > "$TAP_PAYLOADS/receipt.md"
# The park route (cue, spawn, backlog, receipt) runs natively behind spool_park_placed_fixture;
# no cue is passed and the deliverer is disabled by the pins, so nothing here is stubbed.
spool_park_placed_fixture receipt "$TAP_PAYLOADS/receipt.md" alice peer ask expected fixture:0.0 %401 '' "$TAP_HOME/registry.json" pending-input '' standard 60 0 > "$WORK/send"
python3 -B - "$WORK/send" <<'PY'
import pathlib, sys
text=pathlib.Path(sys.argv[1]).read_text()
for required in ('queued receipt', 'busy/pending-input', 'next probe:', 'grace deadline:', '.unconfirmed'):
    assert required in text, (required,text)
PY
# The shared read-only diagnostic renders terminal transport separately from
# settlement and never invents a future probe for an expired schedule.
printf '%s\n' '{"id":"queued","notice_id":"queued-delivery-unconfirmed"}' > "$TAP_RECEIPTS/queued.unconfirmed"
queue_explanation queued > "$WORK/terminal"
python3 -B - "$WORK/terminal" <<'PY'
import pathlib, sys
text=pathlib.Path(sys.argv[1]).read_text()
assert 'No further recipient attempt' in text and 'queued-delivery-unconfirmed' in text, text
assert 'next probe:' not in text, text
PY
# A landed sentinel must not inherit its old window label in either send format.
for json_mode in 0 1; do
  ident="injected-$json_mode"
  printf '%s\n' '---' "id: $ident" 'from: alice' 'to: peer' 'kind: ask' 'reply: expected' '---' 'body' > "$TAP_PAYLOADS/$ident.md"
  tap_bun_call submit-phase "$ident" submit-phase.ts "$TAP_HOME" "$ident" call-one injected-text-confirmed peer 0 0
  spool_park_placed_fixture "$ident" "$TAP_PAYLOADS/$ident.md" alice peer ask expected fixture:0.0 %401 '' "$TAP_HOME/registry.json" window '' standard 60 "$json_mode" > "$WORK/injected-$json_mode"
done
python3 -B - "$WORK" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
for mode in (0,1):
    text=(root/f'injected-{mode}').read_text()
    if mode:
        value=json.loads(text)
        assert value['status']=='queued' and value['phase']=='injected-enter-unconfirmed',value
        text=value['queue_explanation']
    assert 'injected; Enter unconfirmed (possible effect)' in text,text
    assert 'tap nudge peer' in text,text
    assert all(s not in text for s in ('recipient cooldown','next probe:','Queue: window')),text
PY
