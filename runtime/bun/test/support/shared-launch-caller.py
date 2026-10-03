"""Invoke the unchanged caller surface against candidate or pinned source."""
import contextlib
import dataclasses
import json
import pathlib
import sys
import types
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / "skills/tap/scripts/session"))
import launcher

kind, raw = sys.argv[2:4]
record = launcher.SessionRecord(**json.loads(raw))
root = record.cwd
args = types.SimpleNamespace(dry_run=False, json=True, attach=False, harness=record.harness,
    key=record.tag, legacy_name=None, resume_query=None, all=False, force=True, model=None, teams=False)
# Attach is outside the moved transaction; let the mutation bodies run live.
# The candidate's resume forms exec resume.ts, whose attach tail detaches
# here because this caller has no controlling terminal.
with contextlib.ExitStack() as tails:
    for tail in ("resume_attach_tail", "attach_after_launch"):
        if hasattr(launcher, tail):
            tails.enter_context(patch.object(launcher, tail, return_value=0))
    if kind in ("new", "replacement"):
        # Pinned pre-cut source only: the candidate launches through new.ts
        # (support/shared-launch-native.ts).
        code = launcher.execute_fresh_launch(record, args, attach=False)
    elif kind == "adopted":
        # A bare harness key with no record: each implementation allocates
        # the adopted seat from the same registry through its own caller.
        args.key = record.harness
        code = launcher.cmd_resume(args)
    elif kind == "resume":
        code = launcher.cmd_resume(args)
    elif kind == "resume-all" and hasattr(launcher, "cmd_resume_all"):
        # Pinned pre-cut source: the Python cohort body itself.
        args.all = True
        args.key = None
        args.harness = None
        code = launcher.cmd_resume_all(args, launcher.registry_session_state(root), root)
    elif kind == "resume-all":
        # Candidate: the retained direct door execs the native cohort owner.
        code = launcher.main(["resume", "--all", "--json"])
    elif kind == "restart":
        code = launcher.cmd_restart(args)
    elif kind == "seat-up":
        path = launcher.tap_registry_path(root)
        row = json.loads(path.read_text())["seats"][record.tag]
        argv = [root, record.base, record.tag, json.dumps(row), str(path)]
        if hasattr(launcher, "internal_seat_up"):
            # Pinned pre-cut source: the retired `_seat-up` door.
            code = launcher.internal_seat_up(argv)
        else:
            # Candidate: the door was a one-line transport to this worker op.
            code = launcher._launcher_bridge.call("seat-up", argv=argv)
    else:
        raise AssertionError(kind)
raise SystemExit(code)
