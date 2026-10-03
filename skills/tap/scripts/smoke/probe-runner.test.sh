#!/usr/bin/env bash
# scripts/probe.sh runs one saved file inside the smoke runner's boundary (tap-7r3fn.161).
# One end-to-end control over a fixture checkout: hostile inherited pins, scratch
# writes, child failure, signal cleanup, refusals, and an external canary that
# stays unchanged. Then the same control against a runner whose environment
# scrub is bypassed, which must go red.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
mkdir -p "$WORK/repo/scripts" "$WORK/repo/skills/tap/scripts/smoke" "$WORK/repo/tmp/seat" "$WORK/locks"
cp "$ROOT/scripts/smoke-all.sh" "$ROOT/scripts/probe.sh" "$ROOT/scripts/ignored-state-tripwire.py" \
  "$ROOT/scripts/suite-slot-run.py" "$ROOT/scripts/suite_slot.py" "$WORK/repo/scripts/"
cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" \
  "$WORK/repo/skills/tap/scripts/smoke/"
python3 -I -B - "$WORK" <<'PY'
import hashlib, os, pathlib, signal, subprocess, sys, time

work = pathlib.Path(sys.argv[1])
repo = work / "repo"
runner_src = (repo / "scripts/smoke-all.sh").read_text()
failures = []

PROBE = r'''#!/usr/bin/env bash
mode="${1:-ok}"; shift || true
out="$TAP_PROBE_CHECKOUT/tmp/seat/result.$mode"
{
  for v in HOME TAP_HOME TMUX TMUX_PANE CLAUDE_CONFIG_DIR CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID \
           TAP_TRANSCRIPT_PATH TAP_INDEX_HOME TAP_LOCK_DIR TMUX_TMPDIR; do
    if [ -n "${!v+x}" ]; then printf '%s=%s\n' "$v" "${!v}"; else printf '%s=<unset>\n' "$v"; fi
  done
  printf 'PWD=%s\n' "$PWD"
  printf 'CHECKOUT=%s\n' "$TAP_PROBE_CHECKOUT"
  i=0; for a in "$@"; do printf 'ARG%d=%s\n' "$i" "$a"; i=$((i + 1)); done
} >"$out"
: >"$PWD/scratch-marker"
: >"$HOME/home-marker"
case "$mode" in
  ok) exit 0 ;;
  fail) exit 7 ;;
  move) mv "$1" "$1.moved"; exit 0 ;;
  sleep)
    printf '%s\n' "$$" >"$TAP_PROBE_CHECKOUT/tmp/seat/probe.pid"
    sleep 300 &
    printf '%s\n' "$!" >"$TAP_PROBE_CHECKOUT/tmp/seat/sleeper.pid"
    wait ;;
esac
'''
(repo / "tmp/seat/p.sh").write_text(PROBE)
(repo / "tmp/seat/notes.txt").write_text("not a probe\n")
(repo / "tmp/seat/adir.sh").mkdir()
(repo / "tmp/seat/escape.sh").symlink_to("/etc/hosts")
(repo / "tmp/other").mkdir()
(repo / "tmp/other/o.sh").write_text('#!/usr/bin/env bash\n: >"$TAP_PROBE_CHECKOUT/tmp/other/executed"\n')
(repo / "tmp/seat/cross.sh").symlink_to("../other/o.sh")

def tree_digest(*roots):
    rows = {}
    for root in roots:
        for path in sorted(pathlib.Path(root).rglob("*")):
            rows[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "dir"
    return rows

def make_hostile(name):
    base = work / name
    dirs = {k: base / k for k in ("home", "taphome", "claude", "index", "tmuxtmp")}
    for d in dirs.values():
        d.mkdir(parents=True)
        (d / "canary.txt").write_text("canary " + name + "\n")
    (dirs["home"] / ".tap").mkdir()
    (dirs["home"] / ".tap" / "victim.txt").write_text("operator state\n")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(dirs["home"]),
        "TAP_HOME": str(dirs["taphome"]),
        "CLAUDE_CONFIG_DIR": str(dirs["claude"]),
        "TAP_INDEX_HOME": str(dirs["index"]),
        "TMUX_TMPDIR": str(dirs["tmuxtmp"]),
        "TMUX": str(dirs["tmuxtmp"] / "sock,1,0"),
        "TMUX_PANE": "%99",
        "CLAUDE_CODE_SESSION_ID": "hostile-session",
        "CODEX_THREAD_ID": "hostile-thread",
        "TAP_TRANSCRIPT_PATH": str(dirs["claude"] / "t.jsonl"),
        "TAP_SUITE_LOCK_HOME": str(work / "locks"),
    }
    return env, dirs

def run_probe(env, args, runner=None, timeout=180):
    cmd = ["bash", str(runner or repo / "scripts/probe.sh")] + args
    p = subprocess.run(cmd, cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, timeout=timeout)
    return p.returncode, p.stdout

def read_result(mode):
    rows = {}
    path = repo / "tmp/seat" / ("result." + mode)
    for line in path.read_text().splitlines():
        key, _, value = line.partition("=")
        rows[key] = value
    return rows

def boundary_failures(rows, dirs):
    bad = []
    if str(dirs["home"]) in rows.get("HOME", "") or "/smoke-all-sandbox." not in rows.get("HOME", ""):
        bad.append("probe HOME is not a private sandbox home: " + rows.get("HOME", "?"))
    for name in ("TAP_HOME", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID",
                 "CODEX_THREAD_ID", "TAP_TRANSCRIPT_PATH"):
        if rows.get(name) != "<unset>":
            bad.append("inherited %s reached the probe: %s" % (name, rows.get(name)))
    if rows.get("TAP_INDEX_HOME", "").startswith(str(dirs["index"])):
        bad.append("inherited TAP_INDEX_HOME reached the probe")
    if not rows.get("TMUX_TMPDIR", "").startswith("/tmp/tap-tmux."):
        bad.append("probe tmux namespace is not the private one: " + rows.get("TMUX_TMPDIR", "?"))
    cwd = rows.get("PWD", "")
    if not cwd or os.path.realpath(cwd).startswith(os.path.realpath(str(repo))):
        bad.append("probe cwd is not scratch outside the checkout: " + cwd)
    if os.path.realpath(rows.get("CHECKOUT", "")) != os.path.realpath(str(repo)):
        bad.append("TAP_PROBE_CHECKOUT is not the reviewed checkout: " + rows.get("CHECKOUT", "?"))
    return bad

# 1. Hostile pins, scratch writes, literal argv, external canary.
env, dirs = make_hostile("hostile")
before = tree_digest(*dirs.values())
args = ["tmp/seat/p.sh", "--", "ok", "one", "two words", "--help", "$(echo no)"]
rc, out = run_probe(env, args)
if rc != 0:
    failures.append("ok probe exited %d: %s" % (rc, out[-1500:]))
else:
    rows = read_result("ok")
    failures += boundary_failures(rows, dirs)
    expected = ["one", "two words", "--help", "$(echo no)"]
    got = [rows.get("ARG%d" % i) for i in range(len(expected) + 1)]
    if got != expected + [None]:
        failures.append("probe argv was not literal: %r" % got)
    if os.path.exists(rows.get("PWD", "/nonexistent")):
        failures.append("scratch cwd survived the run: " + rows["PWD"])
    sandbox = os.path.dirname(os.path.dirname(rows.get("HOME", "/nonexistent")))
    if os.path.exists(sandbox):
        failures.append("runner sandbox survived the run: " + sandbox)
    if "probe: ok" not in out or "not merge evidence" not in out:
        failures.append("success line missing or not labelled non-evidence: " + out[-600:])
    if "all 1 files passed" in out or "smoke-all: ok" in out:
        failures.append("probe printed a suite receipt")
    print("probe: hostile pins scrubbed, argv literal, scratch removed")

# 2. A failing probe stays a failure, and cleanup still happens.
rc, out = run_probe(env, ["tmp/seat/p.sh", "--", "fail"])
if rc != 7 or "probe: FAILED" not in out or "exit=7" not in out:
    failures.append("failing probe was not reported with its own status (rc=%d): %s" % (rc, out[-800:]))
else:
    rows = read_result("fail")
    if os.path.exists(rows.get("PWD", "/nonexistent")):
        failures.append("scratch survived a failing probe")
    print("probe: exit 7 preserved; scratch removed")

# 3. Refusals: stable id, one recovery line, no probe run.
for label, refusal_args, ident in (
    ("no file", [], "bad_args"),
    ("missing", ["tmp/seat/nope.sh"], "missing_file"),
    ("directory", ["tmp/seat/adir.sh"], "not_regular"),
    ("extension", ["tmp/seat/notes.txt"], "unsupported_extension"),
    ("symlink escape", ["tmp/seat/escape.sh"], "path_outside_tmp"),
    ("outside tmp", ["scripts/probe.sh"], "path_outside_tmp"),
    ("cross-seat symlink", ["tmp/seat/cross.sh"], "path_outside_tmp"),
):
    rc, out = run_probe(env, refusal_args)
    if rc != 64 or ("probe: error=%s:" % ident) not in out or "probe: recovery:" not in out:
        failures.append("refusal %s: rc=%d, expected 64 with error=%s: %s" % (label, rc, ident, out[-500:]))
if (repo / "tmp/other/executed").exists():
    failures.append("a cross-seat symlink ran the other seat's source")
# A failed sandbox allocation refuses before any root-level write.
env_alloc = dict(env, TMPDIR=str(work / "absent" / "dir"))
rc, out = run_probe(env_alloc, ["tmp/seat/p.sh", "--", "ok"])
if (rc != 1 or "probe: error=isolation_failed:" not in out or "probe: recovery:" not in out
        or "Read-only file system" in out or "/operator-tap-home" in out):
    failures.append("failed sandbox allocation was not refused cleanly (rc=%d): %s" % (rc, out[-700:]))
# A sandbox inside ANOTHER git checkout is refused too.
other = work / "other-checkout"
other.mkdir()
subprocess.run(["git", "init", "-q", str(other)], check=True)
env_other = dict(env, TMPDIR=str(other))
rc, out = run_probe(env_other, ["tmp/seat/p.sh", "--", "ok"])
if rc != 1 or "probe: error=isolation_failed:" not in out or "inside a git checkout" not in out:
    failures.append("a sandbox inside another checkout was not refused (rc=%d): %s" % (rc, out[-700:]))
print("probe: nine refusals carry a stable id and a recovery line")

# 4. Signal cleanup: TERM reaches the runner; probe, its child, and the roots go.
for name in ("probe.pid", "sleeper.pid"):
    (repo / "tmp/seat" / name).unlink(missing_ok=True)
foreign = subprocess.Popen(["sleep", "300"], start_new_session=True)
log = (work / "signal.log").open("w")
p = subprocess.Popen(["bash", str(repo / "scripts/probe.sh"), "tmp/seat/p.sh", "--", "sleep"], cwd=repo, env=env,
                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
try:
    for _ in range(300):
        if (repo / "tmp/seat/sleeper.pid").exists() and p.poll() is None:
            break
        time.sleep(0.1)
    if not (repo / "tmp/seat/sleeper.pid").exists():
        failures.append("signal arm never reached the probe: " + (work / "signal.log").read_text()[-1200:])
    else:
        probe_pid = int((repo / "tmp/seat/probe.pid").read_text())
        sleeper_pid = int((repo / "tmp/seat/sleeper.pid").read_text())
        rows = read_result("sleep")
        sandbox = os.path.dirname(os.path.dirname(rows["HOME"]))
        tmux_root = os.path.dirname(rows["TMUX_TMPDIR"])
        p.send_signal(signal.SIGTERM)
        for _ in range(100):
            if p.poll() is not None and not alive(probe_pid) and not alive(sleeper_pid):
                break
            time.sleep(0.1)
        if p.poll() is None or alive(probe_pid) or alive(sleeper_pid):
            failures.append("TERM left the runner, probe or its child alive")
        else:
            if p.returncode != 143:
                failures.append("TERM exit was %s, expected 143" % p.returncode)
            for left in (sandbox, tmux_root, rows["PWD"]):
                if os.path.exists(left):
                    failures.append("signal cleanup left a runner root behind: " + left)
            if foreign.poll() is not None:
                failures.append("an unrelated process was reaped")
            print("probe: TERM reaped the probe and its child and removed the runner roots")
finally:
    for pid in (p.pid,):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    foreign.terminate()
    foreign.wait(timeout=3)
    log.close()

# 5. External canary unchanged after every arm above.
after = tree_digest(*dirs.values())
if before != after:
    changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    failures.append("external canary changed: " + ", ".join(changed))
else:
    print("probe: external canary unchanged")

# 6. A state-predicate failure wins over the probe's own zero exit.
env_state, dirs_state = make_hostile("hostile-state")
victim = dirs_state["home"] / ".tap" / "victim.txt"
rc, out = run_probe(env_state, ["tmp/seat/p.sh", "--", "move", str(victim)])
if rc != 1 or "protected operator state deleted" not in out or "exit=0" not in out:
    failures.append("state failure did not win over a zero probe exit (rc=%d): %s" % (rc, out[-900:]))
else:
    print("probe: state-predicate failure wins (rc 1) over probe exit 0")

# 7. Mutation: bypass the shared boundary's environment scrub in a copy; the
# same hostile control must go red.
mutant = repo / "scripts/smoke-all.sh"
mutated_text = runner_src
for needle in ("  /usr/bin/env -i\n", "    env -i\n"):
    if mutated_text.count(needle) != 1:
        failures.append("mutation anchor not found exactly once: %r" % needle)
    mutated_text = mutated_text.replace(needle, needle.replace(" -i", ""))
mutant.write_text(mutated_text)
try:
    env_mut, dirs_mut = make_hostile("hostile-mut")
    rc, out = run_probe(env_mut, ["tmp/seat/p.sh", "--", "ok"])
    if rc != 0:
        failures.append("mutated runner did not reach the probe (rc=%d): %s" % (rc, out[-800:]))
    else:
        red = boundary_failures(read_result("ok"), dirs_mut)
        if not red:
            failures.append("bypassing the shared boundary was NOT detected: the control is vacuous")
        else:
            print("SMOKE-RECEIPT: probe-runner mutation red (env scrub bypassed): " + red[0])
finally:
    mutant.write_text(runner_src)

for failure in failures:
    print("FAIL: " + failure, file=sys.stderr)
raise SystemExit(bool(failures))
PY
