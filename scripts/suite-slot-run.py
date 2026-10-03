#!/usr/bin/env python3
"""Observe the advisory smoke-all slot and run a child.

Usage:
  suite-slot-run.py -- <command> [args...]
  TAP_SUITE_SLOT_PROBE=1 suite-slot-run.py -- <ignored>

Env:
  TAP_SUITE_LOCK_HOME  override lock dir (tests); default ~/.tap/locks
  TAP_SUITE_SLOT_PROBE=1  acquire-or-refuse, print, release, exit (no child)
  TAP_SUITE_SLOT=bypass   not handled here — smoke-all.sh skips re-exec
  TAP_SUITE_SEAT=<handle>  declared holder identity written into the lease
                           (else TAP_SELF / TAP_HANDLE / observational whoami)
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys

# Allow `python3 scripts/suite-slot-run.py` without installing a package.
_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

import suite_slot  # noqa: E402


def _parse_argv(argv: list[str]) -> list[str]:
    if not argv:
        print(
            "suite-slot-run: usage: suite-slot-run.py -- <command> [args...]",
            file=sys.stderr,
        )
        sys.exit(64)
    if argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("suite-slot-run: missing command after --", file=sys.stderr)
        sys.exit(64)
    return argv


def main() -> int:
    cmd = _parse_argv(sys.argv[1:])
    home = suite_slot.lock_home()
    load1m = f"{os.getloadavg()[0]:.2f}"

    fd, refusal = suite_slot.try_acquire(home)
    if fd is None:
        if os.environ.get("TAP_SUITE_SLOT_PROBE", "").strip() == "1":
            print(refusal or suite_slot.format_busy_refusal(home), file=sys.stderr)
            return 1
        print(suite_slot.format_busy_advisory(home), file=sys.stderr, flush=True)
        env = os.environ.copy()
        env["TAP_SUITE_SLOT_CHECKED"] = "1"
        env["TAP_SUITE_SLOT_CONTENDED"] = "1"
        env["TAP_SUITE_LOAD1M"] = load1m
        return _run_child(cmd, env)

    fields = suite_slot.build_lease_fields(cmd)
    suite_slot.write_lease(fd, fields, home)

    if os.environ.get("TAP_SUITE_SLOT_PROBE", "").strip() == "1":
        print(
            f"suite-slot: acquired (probe) pid={os.getpid()} home={home}",
            flush=True,
        )
        suite_slot.clear_lease(home)
        fd.close()
        return 0

    env = os.environ.copy()
    env["TAP_SUITE_SLOT_CHECKED"] = "1"
    env["TAP_SUITE_SLOT_CONTENDED"] = "0"
    env["TAP_SUITE_LOAD1M"] = load1m
    env["TAP_SUITE_SLOT_HELD"] = "1"
    # Advertise holder identity for nested tooling / refusal readers.
    env["TAP_SUITE_SLOT_PID"] = str(os.getpid())

    print(f"suite-slot: advisory slot acquired load1m={load1m}", flush=True)
    try:
        return _run_child(cmd, env)
    finally:
        suite_slot.clear_lease(home)
        try:
            fd.close()
        except Exception:
            pass


def _run_child(cmd: list[str], env: dict[str, str]) -> int:
    child: subprocess.Popen | None = None

    def _forward(signum, _frame):
        if child is not None and child.poll() is None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass

    # Propagate termination to the suite child; our fd close on exit frees the slot.
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            signal.signal(sig, _forward)
        except (ValueError, OSError):
            pass

    child = subprocess.Popen(cmd, env=env)
    rc = child.wait()
    return rc if isinstance(rc, int) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
