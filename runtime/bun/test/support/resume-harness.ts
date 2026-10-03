// An enrolled worktree for launcher/resume.ts: a temp root holding an acting
// registry (written as literal text, so file order is the fixture's), an index
// home that enrolls the root at that registry once one is written (F2c: with no
// machine index resume refuses), a scripted fake tmux that logs every call, and
// recording seams for the effects resume.ts delegates (transaction, register,
// attach, prompt).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resumeOne, type Options, type Outcome, type ResumeDeps } from "../../src/launcher/resume";
import type { LaunchRecord } from "../../src/launcher/transaction";

/** One scripted tmux answer: `match` is a shell glob over the whole argument string;
 * `run` is raw shell executed first, for a side effect mid-command. */
export interface TmuxRule { match: string; stdout?: string; code?: number; run?: string }

export interface Fixture {
  root: string;
  /** The fixture's own fake tmux executable. */
  tmux: string;
  /** The tmux argument strings resume.ts issued, in order. */
  tmuxCalls(): string[];
  writeRegistry(registry: string | object): void;
  writeHistory(name: string, tombstone: object): void;
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export function fixture(options: { registry?: string | object; tmux?: TmuxRule[]; env?: Record<string, string | undefined> } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resume-root-")));
  const bin = mkdtempSync(join(tmpdir(), "resume-bin-"));
  const index = realpathSync(mkdtempSync(join(tmpdir(), "resume-index-")));
  const log = join(bin, "calls");
  writeFileSync(log, "");
  const rules = (options.tmux ?? []).map(rule =>
    `  ${rule.match.replaceAll(" ", "\\ ")}) ${rule.run ? `${rule.run}; ` : ""}printf '%s' ${quote(rule.stdout ?? "")}; exit ${rule.code ?? 0};;`).join("\n");
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\ncase "$*" in\n${rules}\nesac\nexit 1\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, TAP_INDEX_HOME: index, TAP_BOOT_ID: "boot-test", TAP_SERVER_EPOCH: "srv:1:1" });
  for (const key of ["TAP_HOME", "TMUX", "TMUX_PANE", "TAP_JSON", "TAP_STARTUP_TRACE_CONTEXT"]) delete process.env[key];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  restores.push(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const made: Fixture = {
    root,
    tmux: join(bin, "tmux"),
    tmuxCalls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    writeRegistry(registry) {
      const path = join(root, ".tap", "bus", "registry.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof registry === "string" ? registry : `${JSON.stringify(registry)}\n`);
      enroll(index, root, path, registry);
    },
    writeHistory(name, tombstone) {
      const dir = join(root, ".tap", "team-history");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), `${JSON.stringify(tombstone)}\n`);
    },
  };
  if (options.registry !== undefined) made.writeRegistry(options.registry);
  return made;
}

/** Enroll `root` at `path` in the fixture's machine index, keyed by the registry's team name. */
function enroll(index: string, root: string, path: string, registry: string | object): void {
  let team: unknown;
  try { team = (typeof registry === "string" ? JSON.parse(registry) : registry)?.team?.name; } catch { team = undefined; }
  const name = typeof team === "string" && team ? team : "fixture";
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20",
    teams: { [name]: { root, registry_location: path, state: "registered" } } }));
}

const restores: (() => void)[] = [];
/** Call from afterEach: restores process.env from every fixture made since. */
export function restoreEnvironment(): void { while (restores.length) restores.pop()!(); }

export type Event =
  | ["run", string, string, LaunchRecord]
  | ["register", string, string]
  | ["attach", string, string]
  | ["choose", string, string[]];

/** Recording effects. Override any seam; each still records its call. */
export function recorder(over: { run?: (kind: string, record: LaunchRecord) => Outcome; register?: boolean; hasTty?: boolean; choice?: string } = {}) {
  const events: Event[] = [];
  const deps: ResumeDeps = {
    run: async (kind, record) => { events.push(["run", kind, record.name, structuredClone(record)]); return over.run?.(kind, record) ?? { code: 0, adopted_shell: false }; },
    register: async record => { events.push(["register", record.name, record.harness]); return over.register ?? true; },
    attach: async (tail, record) => { events.push(["attach", tail, record.name]); return 0; },
    hasTty: () => over.hasTty ?? false,
    choose: (verb, question, choices) => { events.push(["choose", question, choices.map(([key]) => key)]); return over.choice ?? "q"; },
  };
  return { events, deps };
}

export const options = (over: Partial<Options> = {}): Options =>
  ({ dryRun: false, json: false, model: null, teams: false, key: null, legacyName: null, ...over });

/** Run one resume, capturing its two streams and either its code or its error. */
export async function resume(root: string, opts: Options, deps: ResumeDeps):
  Promise<{ code: number | null; error: Error | null; out: string; err: string }> {
  let out = "", err = "";
  const writeOut = process.stdout.write.bind(process.stdout), writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { code: await resumeOne(opts, root, deps), error: null, out, err }; }
  catch (error) { return { code: null, error: error as Error, out, err }; }
  finally { process.stdout.write = writeOut; process.stderr.write = writeErr; }
}

/** The PANE_FACTS_FORMAT line tmux would print for one pane. */
export const paneLine = (pane: string, paneId: string, command: string, pid = 100, path = "/fixture") =>
  `${pane}\t${paneId}\t${command}\t1:1\t0\t${pid}\t${path}\n`;
