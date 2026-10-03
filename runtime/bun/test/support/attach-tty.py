"""Kernel PTY/process-group controls; the tmux executable only records its tty."""
import errno
import json
import os
import pathlib
import pty
import select
import shutil
import time
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[4]


class NativeResumeAttachTermiosTests(unittest.TestCase):
    """resume.ts owns the terminal: exec'd from the door, it spawns tmux attach.

    After the door's execvp no Python survives, so Bun is the process whose std
    fds are the caller's tty. It ends through exitKeepingTerminal, which skips
    Bun's exit-time termios write-back (docs/solutions/integration-issues/a-bun-node-child-on-a-tuis-tty-restores-cooked-mode-at-exit.md), so the mode is
    left as the Python launcher left it. The shell stand-in here is the leader:
    it owns the foreground, reads ICANON before and after, and waits.
    """

    SCRIPT = """
import { attachTailInProcess } from %s;
import { exitKeepingTerminal } from %s;
await exitKeepingTerminal(await attachTailInProcess("resume", { name: "fixture/seat", harness: "claude", cwd: "/fixture", base: "fixture", tag: "seat", index: 1 }));
"""

    def _run(self, *, attach_rc=0, restore=True, background=False):
        import signal
        with tempfile.TemporaryDirectory() as tmp:
            work = pathlib.Path(tmp)
            fake = work / "tmux"
            # attach-session behaves like tmux: raw while attached, then (unless
            # told not to) back to the mode it found, and it marks its own exit.
            fake.write_text("#!" + sys.executable + "\n" +
                "import json,os,sys,termios,time,tty\n" +
                "if 'attach-session' in sys.argv:\n" +
                "    saved = termios.tcgetattr(0)\n" +
                "    tty.setraw(0)\n" +
                "    open(os.environ['ATTACH_CALLED'], 'w').write(json.dumps({'argv': sys.argv[1:], 'pgid': os.getpgrp(), 'foreground': os.tcgetpgrp(0), 'icanon': bool(termios.tcgetattr(0)[3] & termios.ICANON)}))\n" +
                "    time.sleep(0.3)\n" +
                "    if os.environ['ATTACH_RESTORE'] == '1': termios.tcsetattr(0, termios.TCSADRAIN, saved)\n" +
                "    os.write(1, b'<attach-exited>')\n" +
                "    sys.exit(int(os.environ['ATTACH_RC']))\n" +
                "sys.exit(1)\n")
            fake.chmod(0o755)
            script = work / "chain.ts"
            launcher = ROOT / "runtime/bun/src/launcher"
            script.write_text(self.SCRIPT % (json.dumps(str(launcher / "resume.ts")), json.dumps(str(launcher / "prompt.ts"))))
            leader = work / "leader.py"
            leader.write_text("""
import fcntl,json,os,pathlib,signal,subprocess,sys,termios,time
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.tcsetpgrp(0, os.getpgrp())
icanon = lambda: bool(termios.tcgetattr(0)[3] & termios.ICANON)
result = {'before': icanon(), 'leader_pgid': os.getpgrp()}
def detach_job_control():
    # A background job that ignores SIGTTOU/SIGTTIN must be refused by an
    # ownership check, not by the kernel happening to stop it.
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    signal.signal(signal.SIGTTIN, signal.SIG_IGN)
background = sys.argv[2] == 'background'
chain = subprocess.run([sys.argv[1], sys.argv[3]], process_group=0 if background else None,
                       preexec_fn=detach_job_control if background else None, timeout=15)
result['rc'] = chain.returncode
result['after'] = icanon()
time.sleep(0.5)  # nothing that outlived the command may restore a mode later
result['settled'] = icanon()
pathlib.Path(os.environ['PROBE_RESULT']).write_text(json.dumps(result))
""")
            env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
            env.update(PATH=str(work) + os.pathsep + env["PATH"], ATTACH_CALLED=str(work / "called"),
                       PROBE_RESULT=str(work / "result"), ATTACH_RC=str(attach_rc),
                       ATTACH_RESTORE="1" if restore else "0")
            bun = os.environ.get("TAP_SMOKE_BUN") or shutil.which("bun")
            if bun is None:
                raise RuntimeError("Bun is required for the native attach test")
            master, slave = pty.openpty()
            run = None
            try:
                run = subprocess.Popen([sys.executable, str(leader), bun, "background" if background else "foreground", str(script)],
                                       stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env=env)
                os.close(slave)
                slave = -1
                output = bytearray()
                deadline = time.monotonic() + 30
                while True:
                    self.assertLess(time.monotonic(), deadline, "PTY chain exceeded deadline")
                    if select.select([master], [], [], 0.05)[0]:
                        try:
                            chunk = os.read(master, 65536)
                            if not chunk:
                                break
                            output.extend(chunk)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            break
                text = output.decode(errors="replace")
                self.assertEqual(run.wait(timeout=5), 0, text)
                called = work / "called"
                return json.loads((work / "result").read_text()), (json.loads(called.read_text()) if called.exists() else None), text, bun
            finally:
                os.close(master)
                if slave >= 0:
                    os.close(slave)
                if run is not None and run.poll() is None:
                    run.kill()
                    run.wait(timeout=1)

    def test_the_owned_foreground_attaches_and_the_terminal_ends_where_it_began(self):
        result, attach, output, _bun = self._run()
        self.assertEqual(result["rc"], 0, output)
        self.assertEqual(attach["argv"], ["attach-session", "-t", "=fixture/seat"], output)
        # tmux runs as the foreground job on the caller's tty, in Bun's group.
        self.assertEqual(attach["pgid"], attach["foreground"], output)
        self.assertEqual(attach["pgid"], result["leader_pgid"], output)
        self.assertFalse(attach["icanon"], output)
        self.assertEqual((result["before"], result["after"], result["settled"]), (True, True, True), output)

    def test_an_attach_failure_narrates_after_the_child_detaches(self):
        result, attach, output, _bun = self._run(attach_rc=1)
        self.assertEqual(result["rc"], 0, output)
        self.assertIsNotNone(attach, output)
        receipt = "tap session: fixture/seat is running detached (attach failed); next: from a foreground terminal, run tap attach fixture/seat"
        self.assertIn(receipt, output)
        self.assertLess(output.index("<attach-exited>"), output.index(receipt), output)
        self.assertLess(output.index("<attach-exited>"), output.index("could not attach to fixture/seat (tmux exit 1)"), output)

    def test_a_background_job_is_refused_by_foreground_ownership_and_never_attaches(self):
        result, attach, output, _bun = self._run(background=True)
        self.assertEqual(result["rc"], 0, output)
        self.assertIsNone(attach, output)
        self.assertIn("tap session: fixture/seat is running detached (caller does not own foreground tty); next: from a foreground terminal, run tap attach fixture/seat", output)

    def test_the_exit_leaves_a_mode_its_child_left_as_the_python_launcher_did(self):
        # tmux left the tty raw (a crash, not a detach). Bun's own exit-time
        # write-back would put back its startup mode; exitKeepingTerminal skips
        # it, so the tty stays as tmux left it, exactly as with the Python door.
        result, attach, output, _bun = self._run(restore=False)
        self.assertEqual(result["rc"], 0, output)
        self.assertFalse(attach["icanon"], output)
        self.assertEqual((result["before"], result["after"], result["settled"]), (True, False, False), output)


if __name__ == "__main__":
    unittest.main()
