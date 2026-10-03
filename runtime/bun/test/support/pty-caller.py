"""Run one command on a private PTY as a foreground session leader, bounded.

argv: <bound-seconds> [--interrupt-on MARKER] <command...>. The child gets
the slave as its controlling terminal — the geometry of a human terminal
outside tmux. The leader drains the master until the child exits or the
bound passes; on the bound it kills the child's process group. With
--interrupt-on, the leader writes \\x03 to the master once MARKER first
appears in the drained output, exactly a human pressing Ctrl-C (the line
discipline delivers SIGINT to the foreground process group). One JSON line
goes to stdout: {code, timedOut, interrupted, output, elapsed}. Exit status
is 0 whenever the report was produced; the assertions live in the caller.

Python, not Bun: the repo has no Bun pty.fork (the precedent is
support/attach-tty.py), and the leader process must keep draining the master
while the child runs, which needs a real controlling-tty fork.
"""
import errno, json, os, pty, select, signal, sys, time

bound = float(sys.argv[1])
interrupted, marker, command = False, None, sys.argv[2:]
if command and command[0] == "--interrupt-on":
    interrupted, marker, command = True, command[1].encode(), command[2:]
marker_seen = False
start = time.monotonic()
pid, master = pty.fork()
if pid == 0:
    try:
        os.execvpe(command[0], command, os.environ)
    finally:
        os._exit(127)
data, status, timed_out, closed = b"", None, False, False
try:
    while True:
        if not closed and select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
                if chunk:
                    data += chunk
                    if marker is not None and not marker_seen and marker in data:
                        marker_seen = True
                        os.write(master, b"\x03")
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                # Every slave writer is gone; the child may still be exiting.
                closed = True
        elif closed:
            # Nothing more to read; do not spin while the child finishes.
            time.sleep(0.02)
        done, raw = os.waitpid(pid, os.WNOHANG)
        if done:
            status = raw
            break
        if time.monotonic() - start >= bound:
            timed_out = True
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(pid, 0)
            break
    if not closed:
        # A child that exits right after its last write leaves it buffered in
        # the master; drain to EOF/EIO so the report carries the final bytes.
        while True:
            try:
                if not select.select([master], [], [], 0.2)[0]:
                    break
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                data += chunk
            except OSError:
                break
finally:
    os.close(master)
print(json.dumps(dict(code=os.waitstatus_to_exitcode(status), timedOut=timed_out,
    interrupted=marker_seen, output=data.decode(errors="replace"), elapsed=round(time.monotonic() - start, 3))))
