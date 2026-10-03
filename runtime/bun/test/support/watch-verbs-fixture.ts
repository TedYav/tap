// Shared watch-verbs oracle and replay fixture. Each component releases its
// scratch after use; a later file in the same Bun process creates a fresh root.
// Keep the path if cleanup refuses so the process-exit backstop can retry it.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeScratchTree } from "./scratch";

export interface OracleCase {
  case: string;
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  modes?: Record<string, number>;
  rc: number;
  stdout: string;
  stderr: string;
  post: Record<string, string>;
  tmux_log: string;
  /** Test-only: replaces the oracle's `ps` shim for this case (e.g. a `ps` that cannot run). */
  ps_shim?: string;
  /** Test-only override of the replay's `tmux` shim (the oracle rows never set it). */
  tmux_shim?: string;
}
export interface Oracle {
  shims: { ps: string; tmux: string };
  registry: Record<string, unknown>;
  captured_from: { head: string; blobs: Record<string, string>; bash: string; python: string; platform: string };
  cases: OracleCase[];
}

export const repo = join(import.meta.dir, "../../../..");
export const oracle = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/watch-verbs-oracle.json"), "utf8")) as Oracle;

let scratchRoot: string | null = null;
function ensureScratchRoot(): string {
  if (!scratchRoot) scratchRoot = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "watch-verbs."));
  return scratchRoot;
}
process.on("exit", () => { if (scratchRoot) removeScratchTree(scratchRoot); });
/** Remove this process's watch-verbs scratch tree; the next stage() recreates it. */
export function releaseScratch(): void {
  if (!scratchRoot) return;
  const root = scratchRoot;
  removeScratchTree(root);
  scratchRoot = null;
}

// --- ratified deviations ------------------------------------------------------------
//
// R1. `${2:?<flag> needs a value}` refusals. Bash printed its own
//     `<script>: line N: 2: <message>` and exited 1; the native verb refuses through
//     the error table: `tap watch: <message>; next: tap help watch`, exit 1.
// R2. Adapter noise. `tap watch off` reached remind.ts through `tap_bun_call`, whose
//     wrapper appended `tap: slice_failed id=… slice=remind: classification failed`
//     after every refusal remind.ts had already printed; in-process there is no
//     wrapper, so that line is gone. The refusal line itself is byte-identical.
// R3. The bus-authority stamp (`.tap-bus-authority`) carries wall-clock time and is
//     excluded from the post-state on both sides by the capture.
// R4. `--for <N><unit>`: N is DECIMAL and the product is exact. The incumbent's Bash
//     arithmetic read `010m` as octal (8 min), died silently on `08m`, and wrapped
//     `9223372036854775808s` to a negative paused_until; native pauses 10 min, 8 min,
//     and clamps to 7 d with the warning. Ratified by the leader (rule 18).
// R5. A lease write that fails for an INFRASTRUCTURE reason (the lock cannot be
//     opened: watch/ read-only) surfaces as its own error; the incumbent mapped every
//     `tap_watch_set` failure to `watch_changed` with a "retry" remedy (rule 19).
const BASH_VALUE_REFUSAL = /^<BASE>\/skills\/tap\/scripts\/tap-watch\.sh: line \d+: 2: (.*)\n$/;
const ADAPTER_NOISE = /^tap: slice_failed id=\S+ slice=remind: classification failed\n/m;
// R6. `on` over a FIFO named arm.json: the incumbent's tint clear opened it and hung
//     (captured as a 20 s timeout, rc 124); native reads "not a regular file" as
//     absent without opening, then refuses the arming publish loudly (rule 19;
//     liveness first). Found by the partner reviewer (F1) after glm's dirent read.
const R6_FIFO_ON = "tap watch: <WORK>/.tap/bus/watch/arm.json is not a regular file; refusing to read or publish it; next: tap health\n";
// R7. The sidecar the arm spawns is the Bun loop (slice W3): the record's
//     `watcher_command` is `watch-run.ts run` where the incumbent wrote `tap-watch.sh
//     run`; every reader accepts both until W4 retires the old signature. Ratified
//     (leader ruling, (d)). The spawn rows are the only ones that
//     write the field.
const R7_SIGNATURE = /"watcher_command":"tap-watch\.sh run"/;
// R12. A respawn stamps `heartbeat_at` with the spawn time (tap-zpmvx review): the record's previous heartbeat
//     and `armed_at` described the loop being replaced and would otherwise read as the new pid's silence, so the
//     verb that writes `watcher_pid` also writes `heartbeat_at` (the replay clock, 2000). The incumbent left the old
//     heartbeat (or none). Only the spawn rows write it, the same rows as R7; the loop overwrites it on its first tick.
const REPLAY_CLOCK = 2000;
function r12Stamp(arm: string): string {
  return /"heartbeat_at":[^,}]*/.test(arm) ? arm.replace(/"heartbeat_at":[^,}]*/, `"heartbeat_at":${REPLAY_CLOCK}`) : arm.replace(/\}(\s*)$/, `,"heartbeat_at":${REPLAY_CLOCK}}$1`);
}
// R8. R2's observation ruling keeps the oracle's unavailable tmux identity
// distinct from pane death or an observed unsupported harness. Notice refusal
// still has rc 1 and no effect; only this nested send diagnostic changes.
const R8_OLD = "tap send: reason=unsupported; pane 'sess:0.0' runs unsupported harness ''; next: escalate";
const R8_NEW = "tap send: tmux server identity is unavailable; next: restore tmux observation, then retry";

// R9. `off` takes its actor from the calling pane, never `--by` or TAP_SELF (tap-calo). The
//     `already_armed` doors no longer tell a caller to pass a handle (`off --by <h>` claimed
//     another seat's identity), and the help page says who the armer is.
const R9_DOOR_FORCE = /tap watch off --by \S+ --force   # or ask/g;
const R9_DOOR_REARM = /tap watch off --by \S+   # or re-run/g;

// R10. `status` on an armed lease also reports whether the dispatcher the lease names is
// running (tap-zpmvx): a `dispatcher:` line right after the header, plus a `next:` line
// when it is dead or unknown, and a dead dispatcher exits 2 (attention). No oracle lease
// records a watcher, so those rows read "dead (no watcher recorded)" and exit 2; a lease
// that cannot be parsed reads "unknown" and exits 1 (unsafe to check, CLI-EXIT-1).
const R10_DEAD = ["  dispatcher: dead (no watcher recorded)", "  next: re-run the `tap watch on` that armed this (or any `tap remind me`) to respawn the sidecar"];
const R10_UNKNOWN = ["  dispatcher: unknown (the lease cannot be read)", "  next: tap health"];
// A lease that is valid JSON but not an object (the `[1,2]` row) has no fields to read either: unknown, exit 1.
const R10_NOT_OBJECT = ["  dispatcher: unknown (the lease is not a JSON object)", "  next: tap health"];
const R10_UNKNOWN_CASES: Record<string, string[]> = { "status-corrupt": R10_UNKNOWN, "status-list": R10_NOT_OBJECT };
function r10Status(c: OracleCase, stdout: string): string | undefined {
  if (c.argv[0] !== "status" || !stdout.startsWith("tap watch: armed\n")) return undefined;
  const [dispatcher, next] = R10_UNKNOWN_CASES[c.case] ?? R10_DEAD;
  const [head, ...rest] = stdout.replace(/\n$/, "").split("\n");
  return [head, dispatcher, ...rest, next].join("\n") + "\n";
}

// R11 (the help sentence) retired: the rewritten `watch` help page is out of the replay; help.test.ts pins
// status's exit contract on it directly.

const EXPLICIT: Record<string, { rule: "R4" | "R5" | "R6"; rc: number; stdout: string; stderr: string; post?: (post: Record<string, string>) => Record<string, string> }> = {
  "on-arm-fifo": { rule: "R6", rc: 1, stdout: "", stderr: R6_FIFO_ON,
    post: post => ({ ...post, "watch/arm.json.lock": "<lock>" }) },
  "pause-for-arith-010m": { rule: "R4", rc: 0, stdout: "tap watch: paused by 'owner' until 2600; reason: reason\n", stderr: "",
    post: post => ({ ...post, "watch/arm.json": post["watch/arm.json"]!.replace('"paused_until":2480', '"paused_until":2600') }) },
  // the incumbent died before touching the lease on an invalid-octal count; native pauses, so the lock file appears
  ...Object.fromEntries(([["08m", 2480], ["08h", 30800], ["09m", 2540], ["018s", 2018]] as Array<[string, number]>).map(([d, until]) => [`pause-for-arith-${d}`, {
    rule: "R4" as const, rc: 0, stdout: `tap watch: paused by 'owner' until ${until}; reason: reason\n`, stderr: "",
    post: (post: Record<string, string>) => ({ ...post, "watch/arm.json.lock": "<lock>", "watch/arm.json": post["watch/arm.json"]!.replace('"paused_by":"","paused_at":0,"paused_until":0,"pause_reason":""', `"paused_by":"owner","paused_at":2000,"paused_until":${until},"pause_reason":"reason"`) }),
  }])),
  "pause-for-arith-017h": { rule: "R4", rc: 0, stdout: "tap watch: paused by 'owner' until 63200; reason: reason\n", stderr: "",
    post: post => ({ ...post, "watch/arm.json": post["watch/arm.json"]!.replace('"paused_until":56000', '"paused_until":63200') }) },
  "pause-for-arith-9223372036854775808s": { rule: "R4", rc: 0, stdout: "tap watch: paused by 'owner' until 606800; reason: reason\n",
    stderr: "tap watch: --for '9223372036854775808s' exceeds 7d; clamping to 7d\n",
    post: post => ({ ...post, "watch/arm.json": post["watch/arm.json"]!.replace('"paused_until":-9223372036854773808', '"paused_until":606800') }) },
  "pause-notice-io-failure": { rule: "R5", rc: 1, stdout: "", stderr: "tap watch: EACCES: permission denied, open '<WORK>/.tap/bus/watch/arm.json.lock'; next: tap health\n" },
  // the arming publish cannot rename over a directory: the incumbent printed the lease module's
  // EISDIR line (with its per-process temp name), then the adapter's slice_failed, and died
  // under set -e; native refuses the non-regular path BEFORE writing a temp, with the remedy
  "on-arm-dir": { rule: "R5", rc: 1, stdout: "", stderr: R6_FIFO_ON },
};

/**
 * A publish's temp name is per-process and random; it never carries meaning. Since the
 * non-regular-path refusal no native line carries one; the incumbent's `on-arm-dir` line
 * still does (scrubbed to `.lease-*` by the generator), so the normaliser stays on both sides.
 */
export const normaliseTemp = (s: string) => s.replace(/\.lease-[a-z0-9]+/g, ".lease-*");

export function expected(c: OracleCase): { rc: number; stdout: string; stderr: string; post: Record<string, string>; ratified: string[] } {
  const ratified: string[] = [];
  const explicit = EXPLICIT[c.case];
  if (explicit) {
    ratified.push(explicit.rule);
    return { rc: explicit.rc, stdout: explicit.stdout, stderr: explicit.stderr, post: explicit.post ? explicit.post(c.post) : c.post, ratified };
  }
  let text = c.stderr;
  const m = BASH_VALUE_REFUSAL.exec(text);
  if (m) { text = `tap watch: ${m[1]}; next: tap help watch\n`; ratified.push("R1"); }
  if (ADAPTER_NOISE.test(text)) { text = text.replace(ADAPTER_NOISE, ""); ratified.push("R2"); }
  if (text.includes(R8_OLD)) { text = text.replace(R8_OLD, R8_NEW); ratified.push("R8"); }
  const beforeR9 = text;
  text = text.replace(R9_DOOR_FORCE, "tap watch off --force   # or ask").replace(R9_DOOR_REARM, "tap watch off   # or re-run");
  if (text !== beforeR9) ratified.push("R9");
  let stdout = c.stdout;
  let post = c.post;
  if (ratified.includes("R8")) {
    // Send stages the body in memory. An early refusal never reaches the
    // short registry validation/publication span, so it creates no sidecar.
    post = { ...post };
    if (post.tmp === "<dir>") delete post.tmp;
  }
  const arm = post["watch/arm.json"];
  // R7 applies only where the verb WROTE the signature (a spawn: the pid changed or the
  // record is new); a record the verb left alone keeps whatever signature it carried.
  const pidOf = (text: string | undefined): unknown => { try { return text === undefined ? undefined : (JSON.parse(text) as { watcher_pid?: unknown }).watcher_pid; } catch { return undefined; } };
  if (arm !== undefined && R7_SIGNATURE.test(arm) && pidOf(arm) !== pidOf(c.files["watch/arm.json"])) {
    post = { ...post, "watch/arm.json": r12Stamp(arm.replace(R7_SIGNATURE, '"watcher_command":"watch-run.ts run"')) };
    ratified.push("R7", "R12");
  }
  const statusOut = r10Status(c, stdout);
  if (statusOut !== undefined) { stdout = statusOut; ratified.push("R10"); }
  return { rc: ratified.includes("R10") ? (c.case in R10_UNKNOWN_CASES ? 1 : 2) : c.rc, stdout, stderr: text, post, ratified };
}

// --- the replay harness -----------------------------------------------------------------

function snapshot(bus: string, work: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(bus)) return out;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = p.slice(bus.length + 1);
      if (["registry.json", "payloads", "receipts", ".tap-bus-authority"].includes(rel)) continue;
      const st = statSync(p);
      if (st.isDirectory()) { out[rel] = "<dir>"; walk(p); continue; }
      if (st.isFIFO()) { out[rel] = "<fifo>"; continue; }
      if (name.endsWith(".lock")) { out[rel] = "<lock>"; continue; }
      out[rel] = readFileSync(p, "utf8").replaceAll(realpathSync(work), "<WORK>").replaceAll(work, "<WORK>");
    }
  };
  walk(bus);
  return out;
}

export function stage(c: OracleCase, door: string): { work: string; bus: string; env: Record<string, string> } {
  const work = join(ensureScratchRoot(), `${c.case.replace(/[^A-Za-z0-9._-]/g, "_")}-${door}`);
  const legacy = c.env.LEGACY_HOME === "1";
  const bus = join(work, legacy ? "tmp/tap" : ".tap/bus");
  const index = join(work, "index"), home = join(work, "home"), shim = join(work, "shim"), tmuxDir = join(work, "tmux");
  for (const d of [join(bus, "payloads"), join(bus, "receipts"), index, home, shim, tmuxDir]) mkdirSync(d, { recursive: true });
  // tap-calo: `off` takes its authority from the calling pane and ignores `--by`
  // (a peer naming the armer must not disarm as the armer). The captured rows
  // still pass `--by <who>` -- keeping it proves the flag is inert -- so each is
  // replayed from the pane that OWNS that handle: the shim's pane is the owner's
  // (%5); a `peer` row runs from a second pane (%6) registered to the peer seat.
  // `SHIM_ACT_AS` decouples the pane from the flag for the controls ("none" = no pane at all).
  // An `on` row whose captured door was the armer's bare `off --by <armer>` was run BY the armer, and
  // the door now offers bare `off` only to the armer's own pane, so it replays from that pane too.
  const doorArmer = c.argv[0] === "on" ? /tap watch off --by (\S+)   # or re-run/.exec(c.stderr)?.[1] : undefined;
  const flagged = c.argv[0] === "off" && c.argv.includes("--by") ? c.argv[c.argv.indexOf("--by") + 1] : undefined;
  const offBy = c.env.SHIM_ACT_AS === "none" ? undefined : (c.env.SHIM_ACT_AS ?? flagged ?? doorArmer);
  const fromPeerPane = offBy === "peer";
  let psShim = oracle.shims.ps, tmuxShim = oracle.shims.tmux;
  const registry = JSON.parse(JSON.stringify(oracle.registry)) as { seats: Record<string, Record<string, unknown>> };
  if (fromPeerPane) {
    psShim = psShim.replaceAll("ttys001", "ttys002");
    tmuxShim = tmuxShim.replaceAll("%%5", "%%6").replaceAll("/dev/ttys001", "/dev/ttys002");
    registry.seats.peer = { ...registry.seats.owner!, pane: "sess:0.1", pane_id: "%6" };
  }
  writeFileSync(join(shim, "ps"), c.ps_shim ?? psShim); chmodSync(join(shim, "ps"), 0o755);
  writeFileSync(join(shim, "tmux"), c.tmux_shim ?? tmuxShim); chmodSync(join(shim, "tmux"), 0o755);
  writeFileSync(join(bus, "registry.json"), JSON.stringify(registry).replaceAll("<WORK>", work));
  // Born live (F1): an unenrolled TAP_HOME bus under an empty machine index.
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  for (const [rel, content] of Object.entries(c.files)) {
    const target = join(rel.startsWith("watch/") ? bus : work, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    if (content === "<dir>") mkdirSync(target, { recursive: true });
    else if (content === "<fifo>") spawnSync("mkfifo", [target]);
    else writeFileSync(target, content);
  }
  for (const [rel, mode] of Object.entries(c.modes ?? {})) chmodSync(join(rel.startsWith("watch") ? bus : work, rel), mode);
  const env: Record<string, string> = {
    PATH: `${shim}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home, TERM: "dumb", LANG: "C", LC_CTYPE: "en_US.UTF-8", TZ: "UTC",
    TAP_HOME: bus, TAP_INDEX_HOME: index, TMUX_TMPDIR: tmuxDir,
    TAP_SESSION_MANIFEST: join(work, "sessions.json"), OPENCODE_DB_PATH: join(work, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(work, "version-seen.json"),
    TAP_WATCH_NOW: "2000", TAP_WATCH_NO_SPAWN: "1", SHIM_LOG: join(work, "tmux.log"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  if (offBy !== undefined) Object.assign(env, { SHIM_PANE_MODE: "pane", TAP_SERVER_EPOCH: "srv:4242:100", TAP_BOOT_ID: "boot:1" });
  for (const [k, v] of Object.entries(c.env)) if (k !== "LEGACY_HOME" && k !== "SHIM_ACT_AS") env[k] = v;
  return { work, bus, env };
}

export type Door = "bin/tap" | "router";
export function replay(c: OracleCase, door: Door) {
  const { work, bus, env } = stage(c, door === "bin/tap" ? "sh" : "rt");
  const argv = door === "bin/tap"
    ? ["bash", join(repo, "bin/tap"), "watch", ...c.argv]
    : [process.execPath, join(repo, "runtime/bun/main.ts"), "watch", ...c.argv];
  // bounded: a verb that blocks on a fifo is the defect the dirent rows exist to catch, not a hang of the suite
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: work, env, encoding: "utf8", timeout: 20_000 });
  for (const rel of Object.keys(c.modes ?? {})) chmodSync(join(rel.startsWith("watch") ? bus : work, rel), 0o700);
  const realWork = realpathSync(work);
  const scrub = (s: string) => s.replaceAll(realWork, "<WORK>").replaceAll(work, "<WORK>").replaceAll(realpathSync(repo), "<BASE>").replaceAll(repo, "<BASE>");
  return {
    rc: r.status,
    stdout: scrub(r.stdout ?? ""),
    stderr: scrub(r.stderr ?? ""),
    post: snapshot(bus, work),
    tmux_log: existsSync(join(work, "tmux.log")) ? scrub(readFileSync(join(work, "tmux.log"), "utf8")) : "",
  };
}

/**
 * The archived `usage-help` case recorded the incumbent's one-paragraph help. A deliberate rewrite changed the page
 * (NAME / USAGE / DESCRIPTION), so byte parity with the archive stopped being a contract for this one case: it asserts
 * the exit, the empty stderr, the unchanged effects, that the page still names the verb and every operation, and (R9)
 * that the `off` entry still says it authenticates the calling pane and ignores --by and TAP_SELF.
 */
export const HELP_CASE = "usage-help";
export function watchHelpOk(c: OracleCase, got: ReturnType<typeof replay>): { rc: number | null; stderr: string; post: Record<string, string>; tmux_log: string; named: string[]; heading: boolean; offActor: boolean } {
  const operations = ["on", "pause", "resume", "off", "status", "ack"];
  return { rc: got.rc, stderr: got.stderr, post: got.post, tmux_log: got.tmux_log,
    named: operations.filter(op => got.stdout.includes(`  tap watch ${op}`)), heading: got.stdout.startsWith("NAME\n  tap watch — "),
    offActor: /^  off +[^\n]*authenticates the calling pane as the actor[^\n]*--by and TAP_SELF are ignored/m.test(got.stdout) };
}
