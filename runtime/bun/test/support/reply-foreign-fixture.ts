// Shared fixture for the reply-foreign-payload components (unit 2 split of the
// former reply-foreign-payload.test.ts): two-team cross-bus world (alpha/ua,
// beta/rb), the fake tmux, the fixture factory and the assertion helpers.
//
// Each component registers afterAll(releaseScratch, 40_000). The pool runs one
// file per process; multi-file run.sh calls share this module and run files
// sequentially, so the next fixture recreates the root after cleanup.
import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envelopeField } from "../../src/envelope";
import { removeScratchTree } from "./scratch";
import { writeLiveFence } from "./live-fence";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
export const TAP = join(REPO, "bin", "tap");

let scratchRoot: string | undefined;
/** The component files' afterAll body: remove this process's scratch root. */
export async function releaseScratch() {
  const root = scratchRoot;
  if (root === undefined) return;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(root); scratchRoot = undefined; break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}

// The fake tmux of reply-foreign-route.test.ts: `ua` (%6, alpha) and `rb` (%7,
// beta), both claude. FAKE_BAND is rb's composer; FAKE_KEYS records send-keys.
const FAKE_TMUX = `#!/bin/sh
case " $* " in
  *"list-sessions"*) printf 'ua\\t123:456\\n'; printf 'rb\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n' ;;
  *"list-panes"*)
    case " $* " in
      *"=rb"*|*" rb:"*|*" rb "*) printf 'rb\\trb:0.0\\t%%7\\tclaude\\t4242\\t123:456\\t0\\n' ;;
      *) printf 'ua\\tua:0.0\\t%%6\\tclaude\\t4242\\t123:456\\t0\\n' ;;
    esac ;;
  *"#{pane_id}"*"#{session_name}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*) printf '%%6\\tua\\t4242\\tclaude\\t0\\n' ;;
      *) printf '%%7\\trb\\t4242\\tclaude\\t0\\n' ;;
    esac ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    case " $* " in
      *" rb:"*|*"=rb"*|*" %7 "*) printf 'rb\\t123:456\\n' ;;
      *) printf 'ua\\t123:456\\n' ;;
    esac ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_current_command}"*) printf 'claude\\n' ;;
  *"#{pane_in_mode}"*) printf '0\\n' ;;
  *"#{pane_pid}"*) printf '4242\\n' ;;
  *"#{pane_dead}"*) printf '0\\n' ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" %6 "*) printf '%%6\\n' ;;
      *) printf '%%7\\n' ;;
    esac ;;
  *"capture-pane"*)
    band="$FAKE_BAND"
    case " $* " in *" ua:"*|*"=ua"*|*" %6 "*) band="$FAKE_BAND.ua" ;; esac
    if [ -e "$band.submitted" ]; then printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'
    elif [ -e "$band" ]; then printf '› '; cat "$band"; printf '\\n%s\\n' '──────────────────────────────────────────'
    else printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'; fi ;;
  *"send-keys"*)
    band="$FAKE_BAND"
    case " $* " in *" ua:"*|*"=ua"*|*" %6 "*) band="$FAKE_BAND.ua" ;; esac
    case " $* " in
      *" -l -- "*) rm -f "$band.submitted"; for last do :; done; printf '%s' "$last" > "$band"; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
      *" Enter "*|*" Enter") : > "$band.submitted"; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
    esac ;;
esac
exit 0
`;

interface Team { name: string; wt: string; bus: string; registry: string }

function team(root: string, name: string, seats: Record<string, unknown>): Team {
  const wt = join(root, name);
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", wt], { stdout: "pipe", stderr: "pipe" });
  expect(git.exitCode).toBe(0);
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name, worktree_root: wt }, seats })}\n`);
  return { name, wt, bus, registry };
}

const RB = { status: "active", pane: "rb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rb|B", harness: "claude" };
export const INBOUND_ID = "rb-20260916T120000Z-aabbccddeeff";

export interface FixtureOpts {
  /** The inbound's addressee fields (default: alpha/ua). */
  inbound?: Record<string, string>;
  /** alpha's `ua` carries the adoption of a retired fork `ua-2`. */
  adoption?: boolean;
  /** beta's index entry: absent, or its registry_location pointing nowhere. */
  betaIndex?: "absent" | "unreachable";
  /** Enrol beta's registry_location at `<beta>/relocated/acting.json` (a copy). */
  betaRelocated?: boolean;
  /** A live reset fence on beta's bus. */
  betaResetFence?: boolean;
  /** The machine index is present but not a 0.20 document. */
  invalidIndex?: boolean;
  /** Seed the same id on ALPHA's bus too (an ambiguous bare id). */
  duplicateOnAlpha?: boolean;
  /** A pre-existing `.done` on beta's bus for the inbound. */
  betaDone?: Record<string, unknown>;
  /** Pristine reset-generation records on both buses. */
  generations?: boolean;
}

export function fixture(opts: FixtureOpts = {}) {
  scratchRoot ??= mkdtempSync(join(tmpdir(), "tap-reply-fpayload."));
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  mkdirSync(index); mkdirSync(bin);
  const alpha = team(root, "alpha", {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude",
      ...(opts.adoption ? { adopted_handles: ["ua-2"], adopted_instances: { "ua-2": "ua-2|FORK" } } : {}) },
    ua2: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua2|A", harness: "claude" },
  });
  const beta = team(root, "beta", { rb: RB });
  let betaLocation = beta.registry;
  if (opts.betaRelocated) {
    mkdirSync(join(beta.wt, "relocated"));
    betaLocation = join(beta.wt, "relocated", "acting.json");
    writeFileSync(betaLocation, readFileSync(beta.registry));
  }
  if (opts.betaIndex === "unreachable") betaLocation = join(root, "nowhere", "team-registry.json");
  const teams: Record<string, unknown> = { alpha: { root: alpha.wt, registry_location: alpha.registry, state: "registered" } };
  if (opts.betaIndex !== "absent") teams.beta = { root: beta.wt, registry_location: betaLocation, state: "registered" };
  writeFileSync(join(index, "global-registry.json"), opts.invalidIndex ? "{ invalid" : `${JSON.stringify({ schema: "0.20", teams })}\n`);
  // The inbound on BETA's bus: rb's cross-team ask to ua, as D2's send stamps it.
  // The inbound carries an `epoch:` so a settlement can show it fell back to
  // the FOREIGN envelope, not the local context (partner review, D4d).
  const fields: Record<string, string> = {
    from: "rb", to: "ua", kind: "discuss", reply: "expected", cross_worktree: "true", from_team: "beta", to_team: "alpha",
    sender_instance: "rb|B", recipient_instance: "ua|A", epoch: "3", ...opts.inbound,
  };
  const payload = join(beta.bus, "payloads", `${INBOUND_ID}.md`);
  const envelope = `---\nid: ${INBOUND_ID}\npath: ${payload}\n` + Object.entries(fields).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}\n`).join("") + "---\nquestion?\n";
  writeFileSync(payload, envelope);
  writeFileSync(join(beta.bus, "receipts", `${INBOUND_ID}.placed`), "{}\n");
  writeFileSync(join(beta.bus, "receipts", `${INBOUND_ID}.sent`), "{}\n");
  if (opts.betaDone) writeFileSync(join(beta.bus, "receipts", `${INBOUND_ID}.done`), `${JSON.stringify(opts.betaDone)}\n`);
  if (opts.duplicateOnAlpha) {
    const dup = join(alpha.bus, "payloads", `${INBOUND_ID}.md`);
    writeFileSync(dup, envelope.replace(`path: ${payload}`, `path: ${dup}`));
    writeFileSync(join(alpha.bus, "receipts", `${INBOUND_ID}.placed`), "{}\n");
  }
  if (opts.generations) for (const b of [alpha.bus, beta.bus]) writeFileSync(join(b, "reset-generation.json"), '{"state":"pristine"}\n');
  if (opts.betaResetFence) writeLiveFence(join(beta.bus, "reset.fence.json"), process.env, { team: "beta", since_epoch: Math.floor(Date.now() / 1000) });
  writeFileSync(join(bin, "tmux"), FAKE_TMUX, { mode: 0o755 });
  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  writeFileSync(socketPath, "socket\n");
  const xdgConfig = join(root, "xdg-config");
  mkdirSync(xdgConfig);
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: xdgConfig,
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    OPENCODE_DB_PATH: join(root, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
    TAP_LOCK_DIR: join(root, "locks"),
    TAP_TMUX_SOCKET_PATH: socketPath,
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    FAKE_BAND: join(root, "band"),
    FAKE_KEYS: join(root, "keys"),
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  return { root, index, alpha, beta, env, keys: join(root, "keys"), payload };
}

export type Fx = ReturnType<typeof fixture>;

interface View { code: number; route: string; stdout: string; stderr: string }

/** Run the installed native door as `ua` from alpha's worktree (or `cwd`). */
export function run(fx: Fx, args: string[], opts: { cwd?: string; self?: string } = {}): View {
  const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
  const r = Bun.spawnSync([TAP, ...args], {
    cwd: opts.cwd ?? fx.alpha.wt,
    env: { ...fx.env, TAP_SELF: opts.self ?? "ua", TAP_BUN_ROUTE_TRACE: trace },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  // The resolver realpaths (macOS /tmp → /private/tmp): mask both spellings.
  const mask = (t: string) => t.split(`/private${fx.root}`).join("<root>").split(fx.root).join("<root>");
  return { code: r.exitCode, route: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "", stdout: mask(r.stdout.toString()), stderr: mask(r.stderr.toString()) };
}

export function outbounds(bus: string): string[] {
  const dir = join(bus, "payloads");
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`).sort() : [];
}

export function frontmatter(path: string): Record<string, string> {
  const body = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const key of ["from", "to", "kind", "reply", "cross_worktree", "from_team", "to_team", "recipient_instance", "sender_instance", "to_adopted_from", "in_reply_to", "reply_to"]) {
    const v = envelopeField(body, key);
    if (v) out[key] = v;
  }
  return out;
}

export function injected(fx: Fx): string[] {
  if (!existsSync(fx.keys)) return [];
  return readFileSync(fx.keys, "utf8").split("\n").filter(l => l.includes(" -l -- ")).map(l => l.slice(l.indexOf(" -l -- ") + " -l -- ".length));
}

function receipt(bus: string, name: string): Record<string, unknown> | null {
  const p = join(bus, "receipts", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : null;
}

/** The whole settlement view: where the `.done` landed, and what it says. */
export function settlement(fx: Fx) {
  const beta = receipt(fx.beta.bus, `${INBOUND_ID}.done`);
  const alpha = receipt(fx.alpha.bus, `${INBOUND_ID}.done`);
  return { betaDone: beta ? { via: beta.via, by: beta.by, replyId: beta.reply_id, adoptedFrom: beta.adopted_from, preview: beta.reply_preview, epoch: beta.epoch } : null, alphaDone: alpha !== null };
}

export const NATIVE_ROUTE = "native reply";
