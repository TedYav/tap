// darwin-residue-gate — the macOS residue gate (tap-1bus0 piece 2).
//
// Real-process control of the candidate checkout on the actual macOS floor: the Python 3.11
// interpreter install.sh recommends, actual Bash 3.2 parsing/negative syntax, and the health
// fixture PATH/socket guard parity arms. Linux CI cannot run this: the 2026-09-08/09 specimens
// (tap-7r3fn.128; a Cellar-ordered export) were Mac-only regressions that passed a green
// Linux full. The reply_send.py cancellation arm retired with the Bash reply body (cut sprint D).
//
// Contract: exit 0 PASS, 1 FAIL (an assertion failed), 2 INCOMPLETE (no 3.11 interpreter, dirty
// worktree, timeout, or a broken instrument). INCOMPLETE is never a silent pass. One receipt line
// on stdout records candidate HEAD + TREE, interpreter path + version, measured wall, and any
// override that was used, so a reviewer can tell what was tested.
//
// Not a slot, not a lock, no queue: rerunning is cheaper than coordinating (AGENTS.md § Contributing).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DEADLINE_MS = 9000; // hard bound; the order says under 10 s wall, all arms share this bound

type Outcome = { code: 0 | 1 | 2; verdict: string };

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Homebrew floor first (the interpreter install.sh recommends), PATH python3.11 last. Each probe is
 *  bounded by the remaining deadline so a hanging shim cannot hold the gate past its refusal. */
export function resolveInterpreter(env: NodeJS.ProcessEnv = process.env, timeoutMs = 5000): { path: string; version: string; source: string } | null {
  const deadline = Date.now() + timeoutMs;
  const candidates: [string, string][] = env.TAP_RESIDUE_PYTHON
    ? [[env.TAP_RESIDUE_PYTHON, "override TAP_RESIDUE_PYTHON"]]
    : [["/opt/homebrew/opt/python@3.11/bin/python3.11", "homebrew"], ["/usr/local/opt/python@3.11/bin/python3.11", "homebrew"], ["python3.11", "PATH"]];
  for (const [candidate, source] of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let out = "";
    try {
      const probe = Bun.spawnSync([candidate, "-c", "import sys; print(sys.executable); print('%d.%d.%d' % sys.version_info[:3])"], { stdout: "pipe", stderr: "pipe", env, timeout: remaining, killSignal: "SIGKILL" });
      if (probe.exitCode !== 0) continue;
      out = probe.stdout.toString().trim();
    } catch { continue; } // ENOENT: not installed at this path
    const [path, version] = out.split("\n");
    if (!path || !version?.startsWith("3.11.")) continue;
    return { path, version, source };
  }
  return null;
}

export function runPlatformProbes(root: string, env: NodeJS.ProcessEnv, deadline: number): Outcome {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { code: 2, verdict: "INCOMPLETE: timeout before platform probes" };
  // Keep the private tmux socket below its macOS pathname limit.
  const work = mkdtempSync(join(env.TMUX_TMPDIR ?? "/tmp", "dr-"));
  try {
    const result = Bun.spawnSync(["/bin/bash", join(root, "scripts/darwin-platform-probes.sh"), root, work], {
      env, stdout: "pipe", stderr: "pipe", timeout: remaining, killSignal: "SIGKILL",
    });
    if (Date.now() >= deadline) return { code: 2, verdict: "INCOMPLETE: timeout in platform probes" };
    const detail = result.stdout.toString().trim().replaceAll("\n", " | ");
    if (result.exitCode === 0) return { code: 0, verdict: detail };
    return { code: result.exitCode === 1 ? 1 : 2,
      verdict: detail || `INCOMPLETE: platform probe failed: ${result.stderr.toString().trim().replaceAll("\n", " | ")}` };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export async function runGate(root: string, env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  const started = performance.now();
  const deadline = Date.now() + Number(env.TAP_RESIDUE_DEADLINE_MS ?? DEFAULT_DEADLINE_MS);
  const recorded: string[] = [];
  const finish = (code: 0 | 1 | 2, tail: string): Outcome => {
    const wall = Math.round(performance.now() - started);
    const line = `darwin-residue: ${recorded.join(" ")} wall=${wall}ms — ${tail}`;
    return { code, verdict: line };
  };
  let head = "", tree = "";
  try {
    head = git(root, "rev-parse", "HEAD"); tree = git(root, "rev-parse", "HEAD^{tree}");
    recorded.push(`head=${head}`, `tree=${tree}`);
    const dirty = git(root, "status", "--porcelain", "--untracked-files=all");
    if (dirty) return finish(2, "INCOMPLETE: worktree dirty; the tree id would not name the tested bytes");
    recorded.push("worktree=clean");
  } catch (error) { return finish(2, `INCOMPLETE: ${(error as Error).message}`); }

  // The residue is macOS-only: Bash 3.2 and the Homebrew Python floor exist only there.
  if (process.platform !== "darwin") return finish(2, `INCOMPLETE: not macOS (platform=${process.platform}); this gate only means something on the Darwin floor`);
  recorded.push("platform=darwin");
  const interpreter = resolveInterpreter(env, deadline - Date.now());
  if (!interpreter && Date.now() >= deadline) return finish(2, "INCOMPLETE: timeout while probing Python 3.11 candidates (a hanging shim?)");
  if (!interpreter) return finish(2, "INCOMPLETE: no Python 3.11 interpreter (Homebrew python@3.11 or python3.11 on PATH); install the floor before gating");
  recorded.push(`interpreter=${interpreter.path}`, `version=${interpreter.version}`, `source=${interpreter.source}`);

  const platform = runPlatformProbes(root, { ...env, TAP_PYTHON: interpreter.path }, deadline);
  if (platform.code !== 0) return finish(platform.code, platform.verdict);
  recorded.push(platform.verdict);
  return finish(0, "PASS");
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const outcome = await runGate(root);
  process.stdout.write(outcome.verdict + "\n");
  process.exit(outcome.code);
}
