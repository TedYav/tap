#!/usr/bin/env bash
# The gate's observational identity lookup must not execute an unrelated PATH tap.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
python3 -B - "$ROOT" <<'PY'
import importlib.util, os, pathlib, shutil, sys, tempfile
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as scratch:
    work = pathlib.Path(scratch)
    scripts = work / 'scripts'
    scripts.mkdir()
    shutil.copy(root / 'scripts/suite_slot.py', scripts / 'suite_slot.py')
    spec = importlib.util.spec_from_file_location('slot', scripts / 'suite_slot.py')
    slot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(slot)
    foreign = work / 'bin'
    foreign.mkdir()
    command = foreign / 'tap'
    command.write_text('#!/bin/sh\nmkdir -p .nyc_output\nprintf foreign-seat\\n\n')
    command.chmod(0o755)
    os.environ['PATH'] = str(foreign) + os.pathsep + os.environ['PATH']
    os.chdir(work)
    local = scripts / 'tap.sh'
    local.write_text('#!/bin/sh\n[ "$1" = whoami ] || exit 2\nprintf "local-seat\\n"\n')
    assert slot._seat_from_whoami() == 'local-seat', 'PATH command overrode repository identity'
    local.write_text('#!/bin/sh\nexit 1\n')
    assert slot._seat_from_whoami() is None, 'unregistered local seat fell through to PATH'
    local.unlink()
    assert slot._seat_from_whoami() is None, 'missing local shim fell through to PATH'
    assert not (work / '.nyc_output').exists(), 'lookup executed unrelated coverage producer'
    # Positive control: the competing executable is reachable and has an observable effect.
    import subprocess
    subprocess.run(['tap', 'whoami'], check=True, capture_output=True)
    assert (work / '.nyc_output').is_dir(), 'collision control never reached the foreign executable'
print('suite-slot-identity: local identity, unresolved identity, and PATH collision controls: ok')
PY
