import { launchWorkdir } from "./workdir";
import { FORKABLE_HARNESSES } from "../harness-families";
import { randomUUID } from "node:crypto";
import { resolveCatalog } from "./catalog";
import { permissionArgv, type PermissionMode } from "./permissions";
// Dark argv planner. Port of launcher.build_harness_invocation.
// Environment composition is applyLaunchEnv in plan.ts. This file originates none.

import { resolvedResumeIdentity } from "./resume-identity";
import { modelArgv } from "./tuning";
import {
  LauncherError,
  UNBOUND_RESUME_IDENTITY,
  type Invocation,
  type ResumeIdentity,
  type SessionRecord,
} from "./types";

export {
  LauncherError,
  UNBOUND_RESUME_IDENTITY,
  type Invocation,
  type ResumeIdentity,
  type SessionRecord,
};

/**
 * Match Python: resolve the Hermes CLI on PATH, independent of the installer home.
 */
export const HERMES_BIN = "hermes";

/** The launcher-attested identity a fresh Claude seat requires; other harnesses mint or pick their own. */
export function freshLaunchSessionId(harness: string): string | null {
  return harness === "claude" ? randomUUID() : null;
}

/**
 * ID-FIRST cursor `--resume` emission (tap-rs1q). Production is true.
 * The G1 mutant sets this false: gate `--resume` on `action=="resume"`,
 * which drops the id on `new` and is the one discriminating cell in the
 * 96-row matrix (`argv:cursor/new/hsid=ghost-id-0000/...`).
 */
export let cursorResumeIdFirst = true;

export function setCursorResumeIdFirst(value: boolean): void {
  cursorResumeIdFirst = value;
}

/**
 * Authorized explicit-worktree `--trust` (tap-nxvht addendum). Production
 * is true. The G1 mutant drops it: a selected `--workspace` path then
 * stalls on Cursor's trust dialog. Never emitted without a selected cwd.
 */
export let cursorTrustAuthorizedWorktree = true;

export function setCursorTrustAuthorizedWorktree(value: boolean): void {
  cursorTrustAuthorizedWorktree = value;
}

export function argvCellId(input: {
  harness: string;
  action: string;
  hsid: string | null;
  model: string | null;
  prompt: string | null;
}): string {
  return (
    `argv:${input.harness}/${input.action}` +
    `/hsid=${input.hsid ?? "null"}` +
    `/model=${input.model ?? "null"}` +
    `/prompt=${input.prompt ?? "null"}`
  );
}

/** The conversation a fork copies; a fork without one would silently start fresh. */
function forkSource(record: SessionRecord): string {
  if (!FORKABLE_HARNESSES.includes(record.harness)) {
    throw new LauncherError(`${record.harness} has no CLI fork; run /fork inside the seat instead`);
  }
  if (!record.fork_source_session_id) throw new LauncherError(`fork of ${record.name} has no source session id`);
  return record.fork_source_session_id;
}

function boundResume(
  action: string,
  record: SessionRecord,
  resumeIdentity: ResumeIdentity,
  environ: NodeJS.ProcessEnv,
  receipts?: (line: string) => void,
): string | null | undefined {
  if (resumeIdentity !== UNBOUND_RESUME_IDENTITY) return resumeIdentity;
  if (action !== "resume") return null;
  return resolvedResumeIdentity(record, environ, receipts);
}

export function buildHarnessInvocation(
  action: string,
  record: SessionRecord,
  initialPrompt: string | null = null,
  resumeIdentity: ResumeIdentity = UNBOUND_RESUME_IDENTITY,
  environ: NodeJS.ProcessEnv = process.env,
  permissions?: PermissionMode,
  // The resume-target receipts, DEFAULTING TO STDERR because the incumbent's
  // builder does not make this optional: when `build_harness_invocation` resolves
  // an unbound identity itself it calls
  // `resolved_resume_identity(record, emit_receipts=True)` unconditionally
  // (launcher.py:2371-2376). The flag's `False` default lives one level down, on
  // `resolved_resume_identity`, because that function has TWO readers -- this
  // builder and `tap session relaunch`'s semantic gate -- and "the gate must not
  // print a second set of resume-target receipts for one launch" (launcher.py:2297).
  //
  // Defaulting this to silent instead would have been the defect the oracle
  // cannot see: the builder would be ABLE to speak while no command did, and the
  // five picker rows would go green because the DRIVER passed a sink that
  // production does not. A caller that genuinely must not report passes `() => {}`.
  //
  // Plain, unsuppressed, un-deduped -- see `emitResumeTargetReceipts`. Not the
  // `Notices` generation: these are bare `print(file=sys.stderr)` in the
  // incumbent. One launch says each once because a validation-only build passes
  // `discardReceipts` (tap-2qrt); the real invocation build is the one speaker.
  receipts: (line: string) => void = line => { process.stderr.write(`${line}\n`); },
): Invocation {
  const source = action === "fork" ? forkSource(record) : null;
  const resumed = boundResume(action, record, resumeIdentity, environ, receipts);
  const env: Record<string, string> = {};

  if (record.harness === "claude") {
    const argv = ["claude", ...permissionArgv("claude", permissions ?? resolveCatalog(undefined, "claude", environ, () => {}).permissions)];
    argv.push(...modelArgv(record.harness, record.model));
    if (record.name) argv.push("--name", record.name);
    if (action === "new") {
      if (record.harness_session_id) {
        argv.push("--session-id", record.harness_session_id);
      }
    } else if (source) {
      // The launcher mints the fork's own id, so registration can expect it.
      argv.push("--resume", source, "--fork-session");
      if (record.harness_session_id) argv.push("--session-id", record.harness_session_id);
    } else {
      argv.push("--resume");
      if (resumed) argv.push(resumed);
    }
    if (initialPrompt) argv.push(initialPrompt);
    return { argv, env };
  }

  if (record.harness === "codex") {
    const argv = ["codex", ...permissionArgv("codex", permissions ?? resolveCatalog(undefined, "codex", environ, () => {}).permissions)];
    if (action === "resume") argv.push("resume");
    else if (source) argv.push("fork");
    argv.push(...modelArgv(record.harness, record.model));
    if (action === "resume" && resumed) argv.push(resumed);
    else if (source) argv.push(source);
    if (initialPrompt) argv.push(initialPrompt);
    return { argv, env };
  }

  if (record.harness === "opencode") {
    const argv = ["opencode"];
    argv.push(...modelArgv(record.harness, record.model));
    // Mirror Python build_harness_invocation (launcher.py restored exact
    // OpenCode resume in 4b075d370): emit --session whenever the stored id is
    // truthy, for both new and resume; id-less rows stay bare. Model argv
    // precedes --session, matching the Python order.
    if (source) argv.push("--session", source, "--fork");
    else if (record.harness_session_id) {
      argv.push("--session", record.harness_session_id);
    }
    return { argv, env };
  }

  if (record.harness === "cursor") {
    const argv = [
      "cursor-agent",
      ...permissionArgv("cursor", permissions ?? resolveCatalog(undefined, "cursor", environ, () => {}).permissions),
      "--workspace",
      launchWorkdir(record),
    ];
    if (cursorTrustAuthorizedWorktree && record.cwd) {
      argv.push("--trust");
    }
    argv.push(...modelArgv(record.harness, record.model));
    // tap-we6b rework: the resume action honors the RESOLVED identity, and a
    // null resolution emits NO --resume at all — the bare-`--resume` picker
    // emission is gone. A resume whose stored identity is stale is refused
    // upstream (no_exact_resume_identity); nothing here may silently open a
    // picker or start a different conversation. Every other action id-first-
    // mints from the record. G1 cells stay byte-identical because planArgv
    // binds the identity on resume only.
    const target = action === "resume" ? resumed : record.harness_session_id;
    if (cursorResumeIdFirst) {
      if (target) argv.push("--resume", target);
    } else if (action === "resume" && target) {
      argv.push("--resume", target);
    }
    if (initialPrompt) argv.push(initialPrompt);
    return { argv, env };
  }

  if (record.harness === "agy") {
    const argv = ["agy", ...permissionArgv("agy", permissions ?? resolveCatalog(undefined, "agy", environ, () => {}).permissions)];
    argv.push(...modelArgv(record.harness, record.model));
    if (action === "resume") {
      if (record.harness_session_id) {
        argv.push("--conversation", record.harness_session_id);
      } else {
        argv.push("--continue");
      }
    }
    if (initialPrompt) argv.push("--prompt-interactive", initialPrompt);
    return { argv, env };
  }

  if (record.harness === "hermes") {
    const argv = [HERMES_BIN, ...modelArgv(record.harness, record.model)];
    return { argv, env };
  }

  throw new LauncherError(`unknown harness: ${record.harness}`);
}

export function planArgv(input: {
  harness: string;
  action: string;
  model: string | null;
  hsid: string | null;
  prompt: string | null;
  name?: string;
  cwd?: string;
}): { argv?: string[]; refusal?: string } {
  const record: SessionRecord = {
    name: input.name ?? "seat",
    harness: input.harness,
    cwd: input.cwd ?? "/tmp/wt",
    base: "team",
    model: input.model,
    harness_session_id: input.hsid,
  };
  try {
    const inv = buildHarnessInvocation(
      input.action,
      record,
      input.prompt,
      input.action === "resume" ? input.hsid : null,
    );
    return { argv: inv.argv };
  } catch (err) {
    if (err instanceof LauncherError) {
      return { refusal: `LauncherError: ${err.message}` };
    }
    throw err;
  }
}

/** Enumerating pin: every AGENT_FAMILIES member has a builder above. */
export const ADAPTER_HARNESSES = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "agy",
  "hermes",
] as const;
