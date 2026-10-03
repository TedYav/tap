"""Drive one command as the foreground job of a PRIVATE pseudo-terminal.

argv: <keys-json> <command...>. keys-json is a list of strings; each is written
to the master after the prompt text appears (a key of "\\x03" is Ctrl-C, which
the line discipline turns into SIGINT for the foreground process group; "\\x1c"
is Ctrl-\\, which it turns into SIGQUIT).
PTY_PROMPT_MARKER names the prompt's closing text (default `[Y/n] `; the
choice chooser ends with `(Esc quits): `).
Prints one JSON object: `stty -g` before and after (read by the session
leader itself, because macOS revokes a terminal when its session leader
exits), the command's exit status, and everything written to the terminal.
The leader's INT and QUIT traps are no-op HANDLERS, not ignores, so the command
still starts with the default SIGINT and SIGQUIT dispositions.
"""
import json
import os
import select
import signal
import sys
import tempfile
import time

keys = json.loads(sys.argv[1])
marker = os.environ.get("PTY_PROMPT_MARKER", "[Y/n] ").encode()
command = sys.argv[2:]
state = tempfile.mkdtemp(prefix="pty-")
leader = ['/bin/sh', '-c', 'trap : INT QUIT; stty -g > "$0/before"; "$@"; rc=$?; stty -g > "$0/after"; exit $rc', state, *command]
master, slave = os.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    # Opening the slave by name after setsid makes it the controlling terminal.
    name = os.ttyname(slave)
    tty = os.open(name, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(tty, fd)
    os.close(tty)
    os.close(slave)
    try:
        os.tcsetpgrp(0, os.getpgrp())
    except OSError:
        pass
    os.execvp(leader[0], leader)

output = bytearray()
pending = list(keys)
deadline = time.monotonic() + 60
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            chunk = b""
        output.extend(chunk)
    # Each key waits for a fresh prompt question to be on screen.
    if pending and output.count(marker) > len(keys) - len(pending):
        time.sleep(0.2)
        os.write(master, pending.pop(0).encode())
    done, raw = os.waitpid(pid, os.WNOHANG)
    if done:
        status = raw
        break
if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
while True:
    ready, _, _ = select.select([master], [], [], 0.2)
    if not ready:
        break
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    output.extend(chunk)
def read(name):
    try:
        with open(os.path.join(state, name)) as handle:
            return handle.read().strip()
    except OSError:
        return None
print(json.dumps({
    "before": read("before"),
    "after": read("after"),
    "exit": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
    "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
    "output": output.decode("utf-8", "replace"),
}))
