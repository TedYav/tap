#!/usr/bin/env python3
"""Machine-wide smoke-all advisory slot (tap-m8of).

flock on ~/.tap/locks/smoke-all.lock names one observed runner. Ordinary
contenders continue at reduced concurrency; controlled measurement probes
still use the lock as exclusion authority. The lease JSON only names the
holder, so a stale or corrupt lease cannot wedge the slot.

The lock lives as long as the holding process keeps the fd open. Kernel drops
it on death (including kill -9). Bash cannot take flock(2) without flock(1)
(util-linux; absent on macOS), so a python launcher holds the fd and runs
smoke-all as its child.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any, Optional, TextIO, Tuple


# The .lock file is the flock TARGET and is permanent by design. Release closes
# the fd (and clears the lease JSON); it never unlinks this path. Do not "fix"
# persistence by deleting it on release — that would reintroduce a stale-file
# presence wedge the identity-only lease exists to prevent. Presence of this
# file is NOT "slot busy"; only a held flock is.
LOCK_NAME = "smoke-all.lock"
LEASE_NAME = "smoke-all.lease.json"
ERROR_CLASS = "suite_slot_busy"


def lock_home() -> str:
    override = os.environ.get("TAP_SUITE_LOCK_HOME", "").strip()
    if override:
        return os.path.abspath(override)
    return os.path.join(os.path.expanduser("~"), ".tap", "locks")


def lock_path(home: Optional[str] = None) -> str:
    return os.path.join(home or lock_home(), LOCK_NAME)


def lease_path(home: Optional[str] = None) -> str:
    return os.path.join(home or lock_home(), LEASE_NAME)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_lease(home: Optional[str] = None) -> dict[str, Any]:
    path = lease_path(home)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError, TypeError):
        return {}


def write_lease(fd: TextIO, fields: dict[str, Any], home: Optional[str] = None) -> None:
    """Write lease JSON. fd is the held lock file (authority); lease is identity only."""
    home = home or lock_home()
    os.makedirs(home, exist_ok=True)
    path = lease_path(home)
    payload = dict(fields)
    payload.setdefault("pid", os.getpid())
    payload.setdefault("started_at", _utc_now())
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    # Touch the lock file so mtime reflects acquire (debug aid only).
    try:
        fd.flush()
    except Exception:
        pass


def clear_lease(home: Optional[str] = None) -> None:
    path = lease_path(home)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but not signalable by us — treat as alive (fail closed for unlock).
        return True
    else:
        return True


def _seat_from_whoami() -> Optional[str]:
    """Observational pane→handle lookup. Never invent from cwd."""
    # PATH may contain Debian's unrelated node-tap test runner, which writes
    # .nyc_output even for `tap whoami`. Only this checkout owns this lookup;
    # a missing shim or unregistered seat must stay unresolved.
    here = os.path.dirname(os.path.abspath(__file__))
    tap_sh = os.path.join(here, "tap.sh")
    if not os.path.isfile(tap_sh):
        return None
    try:
        proc = subprocess.run(
            ["bash", tap_sh, "whoami"],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    seat = (proc.stdout or "").strip().splitlines()
    return seat[0].strip() if seat else None


def resolve_seat() -> Tuple[Optional[str], str]:
    """Resolve holder identity at acquire time.

    Returns (seat, source) where source is:
      declared — TAP_SUITE_SEAT / TAP_SELF / TAP_HANDLE (caller-stated)
      observed — tap whoami pane→registry lookup (last resort)
      none — unresolved

    Cwd is never consulted — path fragments are not handles. Observed must
    not be presented with the same confidence as declared.
    """
    for key in ("TAP_SUITE_SEAT", "TAP_SELF", "TAP_HANDLE"):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value, "declared"
    observed = _seat_from_whoami()
    if observed:
        return observed, "observed"
    return None, "none"


def _lease_with_patience(home: str, attempts: int = 5, interval: float = 0.2) -> dict[str, Any]:
    """tap-agfo: the lease is legitimately empty in two held-flock windows —
    the acquire→write_lease gap in suite-slot-run, and clear_lease before
    close. A busy refusal observed inside such a window would fall through to
    an unlabeled process search, so give the writer a bounded ~1 s to land the
    identity before falling back. A lease WITH a pid returns on the first read;
    only the genuinely empty window pays the wait."""
    lease = read_lease(home)
    for _ in range(attempts - 1):
        if lease.get("pid") is not None:
            return lease
        time.sleep(interval)
        lease = read_lease(home)
    return lease


def format_busy_refusal(home: Optional[str] = None, unlock_cmd: Optional[str] = None) -> str:
    home = home or lock_home()
    lease = _lease_with_patience(home)
    pid = lease.get("pid", "?")
    cwd = lease.get("cwd", "(unknown)")
    started = lease.get("started_at", "(unknown)")
    seat = lease.get("seat") or lease.get("holder_seat") or "(unknown)"
    seat_source = lease.get("seat_source") or "none"
    argv0 = lease.get("argv0") or lease.get("command") or "(unknown)"
    requested, requested_source = resolve_seat()
    requested_display = requested or "(unknown)"
    if unlock_cmd is None:
        # Prefer repo-relative path when we can infer it from this file location.
        here = os.path.dirname(os.path.abspath(__file__))
        unlock_cmd = f"bash {here}/suite-slot-unlock.sh"
    lines = [
        f"smoke-all: suite slot busy (error_class={ERROR_CLASS})",
        "  admission_blocker: suite_holder",
        f"  requested_seat: {requested_display}",
        f"  requested_seat_source: {requested_source}",
        f"  holder_pid: {pid}",
        f"  holder_cwd: {cwd}",
        f"  holder_started: {started}",
        f"  holder_seat: {seat}",
        f"  holder_seat_source: {seat_source}",
        f"  holder_command: {argv0}",
        "  next: wait for that process to finish — inspect with:",
    ]
    if isinstance(pid, int) or (isinstance(pid, str) and pid.isdigit()):
        lines.append(f"    ps -p {pid} -o pid,etime,command")
    else:
        # tap-agfo: no lease pid means the holder's identity never landed (or
        # is already gone). A process search is EVIDENCE, not a named holder —
        # say so instead of presenting the grep as if it were the lease.
        lines.append("    lease not yet written; process search follows (a search, not a named holder):")
        lines.append("    ps -ax | grep smoke-all")
    lines.extend(
        [
            "  if that pid is gone but this refusal persists:",
            f"    {unlock_cmd}",
            "  do not poll smoke-all.lock — that file is permanent; retry this command",
            "  controlled measurement remains exclusive; ordinary suites may overlap",
        ]
    )
    return "\n".join(lines)


def format_busy_advisory(home: Optional[str] = None) -> str:
    """Name the current holder without presenting contention as a refusal."""
    lease = read_lease(home)
    pid = lease.get("pid", "?")
    seat = lease.get("seat") or lease.get("holder_seat") or "(unknown)"
    started = lease.get("started_at", "(unknown)")
    return (
        "suite-slot: advisory contention; continuing with reduced concurrency "
        f"holder_pid={pid} holder_seat={seat} holder_started={started}"
    )


def try_acquire(home: Optional[str] = None) -> Tuple[Optional[TextIO], Optional[str]]:
    """Non-blocking exclusive flock. Returns (fd, None) or (None, refusal_text)."""
    home = home or lock_home()
    os.makedirs(home, exist_ok=True)
    path = lock_path(home)
    fd = open(path, "a+", encoding="utf-8")
    try:
        fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fd.close()
        return None, format_busy_refusal(home)
    except OSError:
        fd.close()
        return None, format_busy_refusal(home)
    # Keep the lock fd out of the suite child. Three independent guards, any one
    # sufficient: PEP 446 O_CLOEXEC on open, this explicit FD_CLOEXEC, and
    # suite-slot-run's Popen(close_fds=True) (the primary on modern Python).
    try:
        flags = fcntl.fcntl(fd.fileno(), fcntl.F_GETFD)
        fcntl.fcntl(fd.fileno(), fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)
    except OSError:
        pass
    return fd, None


def unlock(home: Optional[str] = None) -> Tuple[int, str]:
    """Clear stale lock/lease when holder pid is dead. Refuse if pid is alive.

    Returns (exit_code, message). flock is the authority — unlinking files while
    a live holder still has the fd open does not steal the slot; we still refuse
    so the door never claims to unlock a live run.
    """
    home = home or lock_home()
    lease = read_lease(home)
    pid = lease.get("pid")
    if isinstance(pid, int) or (isinstance(pid, str) and str(pid).isdigit()):
        pid_i = int(pid)
        if pid_alive(pid_i):
            msg = (
                f"suite-slot-unlock: refusing — holder pid {pid_i} is still alive "
                f"(error_class={ERROR_CLASS})\n"
                f"  inspect: ps -p {pid_i} -o pid,etime,command\n"
                "  wait for that process to finish; do not kill the suite to clear the slot"
            )
            return 1, msg
    # Pid dead, missing, or unreadable — clear sidecar files.
    cleared = []
    for label, path in (("lease", lease_path(home)), ("lock", lock_path(home))):
        try:
            os.unlink(path)
            cleared.append(label)
        except FileNotFoundError:
            pass
    if not cleared:
        return 0, "suite-slot-unlock: nothing to clear (slot already free)"
    return 0, f"suite-slot-unlock: cleared {', '.join(cleared)} under {home}"


def build_lease_fields(command: list[str]) -> dict[str, Any]:
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = "(unknown)"
    seat, seat_source = resolve_seat()
    return {
        "pid": os.getpid(),
        "started_at": _utc_now(),
        "cwd": cwd,
        "argv0": " ".join(command) if command else sys.argv[0],
        "seat": seat,
        "seat_source": seat_source,
        "lock_home": lock_home(),
    }
