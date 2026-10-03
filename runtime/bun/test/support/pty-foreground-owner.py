"""Drive one command against a foreground owner that changes the tty mode mid-life.

argv: <work> <shape> <command...>. Without --in-pty this process opens a fresh
private PTY and re-runs itself as that PTY's session leader, then drains it.
The command must park on an explicit rendezvous: it touches <work>/reached and
waits for <work>/release (a fake `tmux` on PATH does this). While it is parked
the leader, which owns the foreground, switches the tty to raw, releases it,
waits for it (noticing a job-control stop), and writes ICANON before, during,
after exit and 0.3 s later to $PROBE_RESULT.

Shapes: bg-ignored and bg-default run the command as a background job (its own
process group, with SIGTTOU/SIGTTIN ignored or default); stdin-pipe,
stdout-pipe and out-err-pipe run it in the foreground with those fds piped.
"""
import errno, os, pty, select, subprocess, sys, time

if sys.argv[1] != "--in-pty":
    master, slave = pty.openpty()
    run = subprocess.Popen([sys.executable, __file__, "--in-pty", *sys.argv[1:]],
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            output.extend(chunk)
        elif run.poll() is not None:
            break
    rc = run.wait(timeout=5)
    sys.stderr.write(output.decode(errors="replace")[-2000:])
    sys.exit(rc)

del sys.argv[1]
import fcntl, json, pathlib, signal, termios, tty

work, shape, command = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.tcsetpgrp(0, os.getpgrp())
icanon = lambda: bool(termios.tcgetattr(0)[3] & termios.ICANON)
result = {"shape": shape, "before": icanon()}

def ignore_job_control():
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    signal.signal(signal.SIGTTIN, signal.SIG_IGN)

kwargs = {}
if shape == "bg-ignored":
    kwargs = dict(process_group=0, preexec_fn=ignore_job_control)
elif shape == "bg-default":
    kwargs = dict(process_group=0)
elif shape == "stdin-pipe":
    kwargs = dict(stdin=subprocess.PIPE)
elif shape == "stdout-pipe":
    kwargs = dict(stdout=subprocess.PIPE)
elif shape == "out-err-pipe":
    kwargs = dict(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
else:
    raise SystemExit(f"unknown shape {shape}")
child = subprocess.Popen(command, **kwargs)
if child.stdin:
    child.stdin.close()
deadline = time.monotonic() + 20
while not (work / "reached").exists():
    if time.monotonic() > deadline or child.poll() is not None:
        result["error"] = f"no rendezvous (rc={child.poll()})"
        break
    time.sleep(0.02)
if "error" not in result:
    tty.setraw(0)  # the foreground owner changes mode while the candidate lives
    result["during"] = icanon()
    (work / "release").write_text("")
    deadline = time.monotonic() + 20
    status = None
    while time.monotonic() < deadline:
        pid, raw = os.waitpid(child.pid, os.WNOHANG | os.WUNTRACED)
        if pid:
            status = raw
            break
        time.sleep(0.02)
    if status is None:
        result["exit"] = "timeout"
    elif os.WIFSTOPPED(status):
        result["exit"] = f"stopped:{signal.Signals(os.WSTOPSIG(status)).name}"
        os.killpg(child.pid, signal.SIGKILL) if shape.startswith("bg") else child.kill()
        os.waitpid(child.pid, 0)
    else:
        result["exit"] = os.WEXITSTATUS(status) if os.WIFEXITED(status) else f"signal:{os.WTERMSIG(status)}"
    result["after"] = icanon()
    time.sleep(0.3)
    result["settled"] = icanon()
pathlib.Path(os.environ["PROBE_RESULT"]).write_text(json.dumps(result))
