import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const repo = resolve(import.meta.dir, "../../..");
const original = { ...process.env };
const roots: string[] = [];
afterEach(() => { process.env = { ...original }; for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync("/tmp/tap-init-"); roots.push(root);
  process.env.HOME = join(root, "home");
  process.env.TAP_INDEX_HOME = join(root, "index");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.SHELL = "/bin/zsh";
  for (const p of [process.env.HOME, process.env.TAP_INDEX_HOME, process.env.XDG_CONFIG_HOME]) mkdirSync(p!, { recursive: true });
  return root;
}

// A review catch: the signpost consent loop treats an ended
// terminal (EOF/EIO from a vanished pty) as the affirmative default, so losing
// the terminal at the prompt wrote AGENTS.md instead of ending the command.
// The default belongs to a completed empty line only; EOF is a refusal.
test("terminal loss at the signpost prompt refuses instead of writing AGENTS.md", () => {
  const root = fixture();
  const bin = join(root, "tools"); mkdirSync(bin);
  for (const name of ["bash", "bun", "dirname", "git", "readlink"]) symlinkSync(Bun.which(name)!, join(bin, name));
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Inside a fresh git repo init reaches the AGENTS.md signpost offer.
  Bun.spawnSync([join(bin, "git"), "init", "-q", root], { env: process.env, timeout: 10000 });
  // A pty that is not a controlling terminal: closing the master gives the
  // prompt EIO/EOF with no SIGHUP — the same tap-ryhno orphan shape.
  const result = Bun.spawnSync([Bun.which("python3")!, "-c", String.raw`
import os, pty, select, subprocess, sys, time
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[1],'init'],stdin=slave,stdout=slave,stderr=slave,cwd=sys.argv[3],env=dict(os.environ,PATH=sys.argv[2]+':'+os.environ['PATH']))
os.close(slave)
output=b''
def until(needle):
    global output
    end=time.monotonic()+10
    while needle not in output:
        if time.monotonic()>end: raise AssertionError(output.decode(errors='replace'))
        if select.select([master],[],[],.1)[0]: output+=os.read(master,65536)
try:
    until(b'No AGENTS.md here')
    os.close(master)
    code=p.wait(timeout=10)
    print('EXIT',code)
    assert code!=0, code
finally:
    if p.poll() is None: p.kill();p.wait()
`, join(repo, "bin/tap"), bin, root], { env: process.env, timeout: 30000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString(), result.stderr.toString()).toContain("EXIT ");
  expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
}, 30000);

// docs/GETTING-STARTED.md promises `tap init --yes` initializes without
// questions. In a terminal it still asked for the signpost, so a scripted
// first run from a terminal stalled on a prompt the flag was meant to answer.
// Each mode runs in its own fresh git repo under a real pty.
function ptyInit(args: string[], answer: string | null) {
  const root = fixture();
  const bin = join(root, "tools"); mkdirSync(bin);
  for (const name of ["bash", "bun", "dirname", "git", "readlink"]) symlinkSync(Bun.which(name)!, join(bin, name));
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  Bun.spawnSync([join(bin, "git"), "init", "-q", root], { env: process.env, timeout: 10000 });
  const result = Bun.spawnSync([Bun.which("python3")!, "-c", String.raw`
import os, pty, select, subprocess, sys, time
master,slave=pty.openpty()
args=sys.argv[4].split(',') if sys.argv[4] else []
p=subprocess.Popen([sys.argv[1],'init']+args,stdin=slave,stdout=slave,stderr=slave,cwd=sys.argv[3],env=dict(os.environ,PATH=sys.argv[2]+':'+os.environ['PATH']))
os.close(slave)
output=b''
end=time.monotonic()+20
answered=False
while p.poll() is None and time.monotonic()<end:
    if select.select([master],[],[],.1)[0]:
        try: chunk=os.read(master,65536)
        except OSError: break
        if not chunk: break
        output+=chunk
    if sys.argv[5]=='enter' and not answered and b'No AGENTS.md here' in output:
        os.write(master,b'\n'); answered=True
if p.poll() is None: p.kill()
code=p.wait(timeout=10)
try:
    while select.select([master],[],[],.2)[0]:
        chunk=os.read(master,65536)
        if not chunk: break
        output+=chunk
except OSError: pass
print('EXIT',code)
print('OUTPUT',output.decode(errors='replace'))
`, join(repo, "bin/tap"), bin, root, args.join(","), answer ?? "none"], { env: process.env, timeout: 40000 });
  return { root, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("--yes in a terminal writes the signpost without asking; plain init still asks", () => {
  const yes = ptyInit(["--yes"], null);
  expect(yes.out, yes.err).toContain("EXIT 0");
  expect(yes.out).not.toContain("No AGENTS.md here");
  expect(existsSync(join(yes.root, "AGENTS.md"))).toBe(true);
  const ask = ptyInit([], "enter");
  expect(ask.out, ask.err).toContain("No AGENTS.md here");
  expect(ask.out).toContain("EXIT 0");
  expect(existsSync(join(ask.root, "AGENTS.md"))).toBe(true);
}, 90000);
