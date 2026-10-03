import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { invocationMemoActive, onInvocationMemoScope } from "./invocation-memo";

export type GitRootProbe =
  | { kind: "repo"; top: string }
  | { kind: "none" }
  | { kind: "unobservable"; detail: string };

/**
 * Classify a directory for git: a repository (with its top level), positively
 * outside every repository, or unobservable. Only exit 128 with git's own
 * "not a git repository" answer counts as outside; a missing binary or any
 * other failure is unobservable, never evidence (RULE 19).
 *
 * The probe result is memoized per process invocation, keyed by the
 * realpath of the directory: one CLI invocation asks the same question of the
 * same directory up to five times (enrollment walk, worktree derivation,
 * authority validation, bus-home discovery), and `git rev-parse` for one dir
 * cannot change answer within a single invocation. The RAW three-way result
 * is memoized — callers that collapse it (top-or-empty) keep their own
 * collapse, so an unobservable git never becomes a positive "outside".
 */
const gitRootMemo = new Map<string, GitRootProbe>();
onInvocationMemoScope(() => { gitRootMemo.clear(); });

/** The memo key: the directory PLUS the git-relevant environment the probe
 *  would spawn under. Production invocations hold one environment for their
 *  lifetime, so the key is stable and the memo collapses; a test (or caller)
 *  that swaps PATH for a git shim gets a distinct key rather than a frozen
 *  first answer. */
function gitRootKey(dir: string): string {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // A directory that cannot be realpath'd (missing, or a file) probes as-is.
  }
  const env = process.env;
  return [real, env.PATH ?? "", env.GIT_DIR ?? "", env.GIT_WORK_TREE ?? "", env.GIT_INDEX_FILE ?? ""].join("\u0000");
}

export function probeGitRoot(dir: string): GitRootProbe {
  // Scoped and opt-in: only a `withInvocationMemo` scope (the register verb's
  // own body) may reuse an answer. Anyone else — `tap init` probing around its
  // own `git init`, a long-lived process — gets a fresh probe, exactly as
  // before the collapse.
  const key = gitRootKey(dir);
  if (invocationMemoActive()) {
    const hit = gitRootMemo.get(key);
    if (hit) return hit;
  }
  const git = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const top = (git.stdout ?? "").trim();
  let probe: GitRootProbe;
  if (git.status === 0 && top) probe = { kind: "repo", top };
  else if (git.status === 128 && /not a git repository/i.test(git.stderr ?? "")) probe = { kind: "none" };
  else probe = { kind: "unobservable", detail: git.error?.message ?? ((git.stderr ?? "").trim() || `git exited ${git.status}`) };
  if (invocationMemoActive()) gitRootMemo.set(key, probe);
  return probe;
}

/** `git rev-parse --show-toplevel` for `dir`, or "" when git names none. */
export function memoizedToplevel(dir: string): string {
  const probe = probeGitRoot(dir);
  return probe.kind === "repo" ? probe.top : "";
}
