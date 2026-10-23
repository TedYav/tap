// Which tuning a native resume keeps on its own, and how a resume stops overriding it (tap-j5k1b).
// Env is not tuning here: the seat's stored env is re-passed on every resume (plan.ts applyLaunchEnv).
import { basename, join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { readContextTokens } from "../context-tokens";
import { assignments } from "./config-args";
import { claudeHome, reviveTier, transcriptPathSessionId } from "./resume-identity";
import { TUNING_CAPABILITIES } from "./tuning";
import type { SessionRecord } from "./types";

export type TuningAxis = "model" | "effort";

/**
 * Axes the harness restores from its own session on resume, observed live with no tuning flag passed
 * (2026-10-06; isolated tmux servers, launch value differing from the machine default):
 * - claude 2.1.291 `--resume <id>`: model kept; effort fell back to settings (high -> medium).
 * - codex 0.160.1 `resume <id>` (the TUI path TAP launches): model and effort kept. `codex exec resume` keeps neither.
 * - opencode 2.1.2 `--session <id>`: the native session owns model and variant.
 * - cursor 2026.10.01 `--resume <id>`: the machine-global default model (whatever any seat chose last) replaces it.
 * - agy 1.3.0 `--conversation <id>`: effort fell back to its default; model restoration is unconfirmed (the TUI label
 *   did not distinguish the launch model from the default), so it is treated as not restored.
 * - hermes: TAP builds no resume argv.
 * An axis listed here is never re-passed on resume, so an in-session /model or /effort survives. An axis absent
 * here keeps replaying the seat's recorded launch value: an in-session change to it reverts on resume.
 */
export const NATIVE_RESUME_RESTORES: Record<string, readonly TuningAxis[]> = {
  claude: ["model"],
  codex: ["model", "effort"],
  opencode: ["model", "effort"],
  cursor: [],
  agy: [],
  hermes: [],
};

export const restoredAxes = (harness: string): readonly TuningAxis[] => NATIVE_RESUME_RESTORES[harness] ?? [];

/**
 * Whether this resume reopens a native session. A named conversation does; without one, claude and codex open their
 * native picker (the picked session restores its own tuning) while opencode starts a fresh conversation, which keeps
 * the launch tuning (the launcher's "fresh" revive tier).
 */
export const resumeReopensSession = (harness: string, target: string | null | undefined): boolean =>
  !!target || reviveTier(harness, null) !== "fresh";

/** The flag spellings one axis takes on this harness, matching launchTuning's reader. */
function axisFlags(harness: string, axis: TuningAxis): Set<string> {
  const caps = TUNING_CAPABILITIES[harness];
  const flags = new Set<string>();
  if (axis === "model") {
    for (const flag of caps?.model?.argv ?? []) flags.add(flag);
    if (["claude", "codex", "opencode", "hermes"].includes(harness)) flags.add("-m");
  } else if (caps?.effort && !caps.effort.valueTemplate) {
    for (const flag of caps.effort.argv) flags.add(flag);
  }
  return flags;
}

/** Codex carries these axes as config assignments too. */
const CODEX_KEYS: Record<TuningAxis, string> = { model: "model", effort: "model_reasoning_effort" };

/**
 * Remove every token of the named axes, in either `--flag value` or `--flag=value` form and, for Codex,
 * as `-c`/`--config` assignments. Every other token keeps its place; nothing after `--` is touched.
 */
export function stripTuningAxes(harness: string, argv: readonly string[], axes: readonly TuningAxis[]): string[] {
  if (!axes.length) return [...argv];
  const flags = new Set(axes.flatMap(axis => [...axisFlags(harness, axis)]));
  const drop = new Set<number>();
  if (harness === "codex") {
    const keys = new Set(axes.map(axis => CODEX_KEYS[axis]));
    for (const { start, end, key } of assignments(argv)) if (keys.has(key)) for (let i = start; i < end; i++) drop.add(i);
  }
  const end = argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--");
  // Clap also takes a short option's value attached (`-mMODEL`, `-cKEY=VALUE`, `-c=KEY=VALUE`).
  const attached = (token: string, flag: string): string | null =>
    token.length > 2 && token.startsWith(flag) && !token.startsWith("--") ? token.slice(2).replace(/^=/, "") : null;
  const codexKeys = harness === "codex" ? new Set(axes.map(axis => CODEX_KEYS[axis])) : new Set<string>();
  for (let i = 0; i < end; i++) {
    if (drop.has(i)) continue;
    const token = argv[i]!, equal = token.indexOf("=");
    const config = attached(token, "-c");
    if (config !== null && config.indexOf("=") > 0 && codexKeys.has(config.slice(0, config.indexOf("=")).trim())) { drop.add(i); continue; }
    if ([...flags].some(flag => flag.length === 2 && attached(token, flag) !== null)) { drop.add(i); continue; }
    if (!flags.has(equal < 0 ? token : token.slice(0, equal))) continue;
    drop.add(i);
    if (equal < 0 && i + 1 < end && !argv[i + 1]!.startsWith("-")) drop.add(++i);
  }
  return argv.filter((_, i) => !drop.has(i));
}

/** True when argv sets this axis at all, so a caller can tell typed tuning from silence. */
export const setsAxis = (harness: string, argv: readonly string[], axis: TuningAxis): boolean =>
  stripTuningAxes(harness, argv, [axis]).length !== argv.length;

/** The bound Claude transcript for `sessionId`: the recorded path when it names that id, else a project-store hit. */
function claudeTranscript(record: SessionRecord, sessionId: string, env: NodeJS.ProcessEnv): string | null {
  if (record.transcript_path && transcriptPathSessionId(record.transcript_path) === sessionId) {
    try { if (statSync(record.transcript_path).isFile()) return record.transcript_path; } catch { /* moved: search the store */ }
  }
  const projects = join(claudeHome(env), "projects");
  try {
    for (const name of readdirSync(projects)) {
      const path = join(projects, name, `${sessionId}.jsonl`);
      try { if (statSync(path).isFile()) return path; } catch { /* not under this project */ }
    }
  } catch { /* no project store */ }
  return null;
}

/**
 * Claude does not restore effort, so a resume passes the seat's last OBSERVED effort: the newest assistant record's
 * `effort` in the conversation being resumed, the same reading the roster shows. Null when nothing was observed or
 * the value is outside the harness's published domain; the recorded launch effort then replays as before.
 */
export function observedResumeEffort(record: SessionRecord, sessionId: string | null | undefined, env: NodeJS.ProcessEnv): string | null {
  if (record.harness !== "claude" || !sessionId) return null;
  const path = claudeTranscript(record, sessionId, env);
  if (!path || basename(path) !== `${sessionId}.jsonl`) return null;
  const effort = readContextTokens("claude", sessionId, path).tuning?.effort ?? null;
  return effort && TUNING_CAPABILITIES.claude!.effort!.domain!.includes(effort) ? effort : null;
}
