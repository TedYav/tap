// Team-qualified addressing on the native door (D2, member 2 of the `reply`
// stack): `tap send <team>/<handle>` and `<team>:<handle>` run natively, and
// every verdict the incumbent's remote route produces is asserted through the
// installed `bin/tap` with a live marker, over one two-team fixture.
//
// These bodies used to also run a Bash-door vehicle (TAP_INTERNAL_OVERDUE_CHECKED=1
// straight into the retained tap.sh adapter) as a parity comparison. The
// rollback selector that used to force this arm through route() is gone
// (5de960f46), and the Bash bodies retire in the next lanes, so that arm is
// deleted rather than kept as a placebo. Every literal below is native's own,
// already fully spelled out in the loop body it came from — not derived from
// the retired comparison.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME / TAP_HOME / TAP_LOCK_DIR and a
// fake tmux on PATH. No real server is started.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envelopeField } from "../src/envelope";
import { bindExplicitRemoteRegistry, bindRemoteTeam, remoteRecipientRow, senderIndexEvidence, splitSendTarget, spoolRecipientBusHome } from "../src/remote-target";
import { TapError } from "../src/context";
import { acquirePaneLock } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";
import { writeLiveFence } from "./support/live-fence";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-send-remote."));
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(scratchRoot); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}, 40_000);

// The fake tmux: two sessions, `ua` (%6, team alpha's sender) and `rb` (%7, team
// beta's recipient), both running claude. FAKE_GONE makes rb's pane vanish.
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
      *) if [ -f "$FAKE_GONE" ]; then exit 0; fi; printf '%%7\\trb\\t4242\\tclaude\\t0\\n' ;;
    esac ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    case " $* " in
      *" rb:"*|*"=rb"*|*" %7 "*) printf 'rb\\t123:456\\n' ;;
      *) printf 'ua\\t123:456\\n' ;;
    esac ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_current_command}"*) printf 'claude\\n' ;;
  *"#{pane_in_mode}"*) if [ -n "$FAKE_COPY_GONE" ]; then [ "$FAKE_COPY_GONE" != "gone" ] || : > "$FAKE_GONE"; exit 0; fi; printf '0\\n' ;;
  *"#{pane_pid}"*) printf '4242\\n' ;;
  *"#{pane_dead}"*) printf '0\\n' ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" %6 "*) printf '%%6\\n' ;;
      *) if [ -f "$FAKE_GONE" ]; then exit 1; fi; printf '%%7\\n' ;;
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

function team(root: string, name: string, seats: Record<string, unknown>, extra: Record<string, unknown> = {}): Team {
  const wt = join(root, name);
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", wt], { stdout: "pipe", stderr: "pipe" });
  expect(git.exitCode).toBe(0);
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name, worktree_root: wt }, seats, ...extra })}\n`);
  return { name, wt, bus, registry };
}

interface FixtureOpts {
  betaSeats?: Record<string, unknown>;
  betaExtra?: Record<string, unknown>;
  /** Overrides for the index entries (a historical or unreachable beta). */
  index?: Record<string, Record<string, unknown>>;
  betaResetFence?: boolean;
  betaClearFence?: boolean;
  /** Raw bytes for beta's registry (a torn file), written over the fixture's own. */
  betaRawRegistry?: string;
  /** Enrol beta's registry_location at `<beta>/relocated/acting.json` (a copy) while its bus stays under `<beta>/.tap`. */
  betaRelocated?: boolean;
  /** The SENDER team's enrolment key and directory (its registry carries no `team.name`, as an unnamed enrolment). */
  alphaName?: string;
}

function fixture(opts: FixtureOpts = {}) {
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  mkdirSync(index); mkdirSync(bin);
  const alphaName = opts.alphaName ?? "alpha";
  const alpha = team(root, alphaName, {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
    ua2: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua2|A", harness: "claude" },
  });
  if (opts.alphaName) {
    const doc = JSON.parse(readFileSync(alpha.registry, "utf8")) as Record<string, unknown>;
    doc.team = { worktree_root: alpha.wt };
    writeFileSync(alpha.registry, `${JSON.stringify(doc)}\n`);
  }
  const beta = team(root, "beta", opts.betaSeats ?? {
    rb: { status: "active", pane: "rb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rb|B", harness: "claude" },
  }, opts.betaExtra);
  let betaLocation = beta.registry;
  if (opts.betaRelocated) {
    mkdirSync(join(beta.wt, "relocated"));
    betaLocation = join(beta.wt, "relocated", "acting.json");
    writeFileSync(betaLocation, readFileSync(beta.registry));
  }
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20",
    teams: {
      [alphaName]: { root: alpha.wt, registry_location: alpha.registry, state: "registered" },
      beta: { root: beta.wt, registry_location: betaLocation, state: "registered" },
      ...opts.index,
    },
  })}\n`);
  if (opts.betaRawRegistry !== undefined) writeFileSync(beta.registry, opts.betaRawRegistry);
  if (opts.betaResetFence) writeLiveFence(join(beta.bus, "reset.fence.json"));
  if (opts.betaClearFence) {
    mkdirSync(join(beta.bus, "clear-fence"), { recursive: true });
    writeFileSync(join(beta.bus, "clear-fence", "rb.json"), `${JSON.stringify({ nonce: "rb", pid: process.pid, since_epoch: Math.floor(Date.now() / 1000), ceiling_seconds: 90 })}\n`);
  }
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
    FAKE_GONE: join(root, "pane-gone"),
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  return { root, index, alpha, beta, env, keys: join(root, "keys"), gone: join(root, "pane-gone") };
}

type Fx = ReturnType<typeof fixture>;

interface View {
  code: number;
  /** The route observed: `native <verb>`, from the trace file route() writes. */
  route: string;
  /** `tap: error_class=<c> next=<a>` is JSON-shaped through --json; the human line carries the same three. */
  errorClass: string;
  action: string;
  detail: string;
  stdout: string;
  stderr: string;
}

/** Run the installed native door from the sender's worktree with `--json`. */
function run(fx: Fx, args: string[], opts: { cwd?: string; self?: string; json?: boolean } = {}): View {
  const json = opts.json !== false;
  const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
  const r = Bun.spawnSync([TAP, ...args, ...(json ? ["--json"] : [])], {
    cwd: opts.cwd ?? fx.alpha.wt,
    env: { ...fx.env, TAP_SELF: opts.self ?? "ua", TAP_BUN_ROUTE_TRACE: trace },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  let errorClass = "", action = "", detail = "";
  const lines = [...out.split("\n"), ...err.split("\n")].filter(l => l.startsWith("{"));
  for (const line of lines) {
    try {
      const doc = JSON.parse(line) as Record<string, string>;
      if (doc.status === "error" || doc.error_class) { errorClass = doc.error_class ?? ""; action = doc.next ?? doc.action ?? ""; detail = doc.detail ?? ""; }
    } catch { /* not a JSON line */ }
  }
  const route = existsSync(trace) ? readFileSync(trace, "utf8").trim() : "";
  return { code: r.exitCode, route, errorClass, action, detail, stdout: out, stderr: err };
}

function payloads(bus: string): string[] {
  const dir = join(bus, "payloads");
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")).sort() : [];
}

function frontmatter(path: string): Record<string, string> {
  const body = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const key of ["id", "from", "to", "kind", "reply", "cross_worktree", "from_team", "to_team", "recipient_instance", "sender_instance", "to_adopted_from", "original_recipient_instance", "urgency"]) {
    const v = envelopeField(body, key);
    if (v) out[key] = v;
  }
  return out;
}

function injected(fx: Fx): string[] {
  if (!existsSync(fx.keys)) return [];
  return readFileSync(fx.keys, "utf8").split("\n").filter(l => l.includes(" -l -- ")).map(l => l.slice(l.indexOf(" -l -- ") + " -l -- ".length));
}

const FALLBACK = "tap send rb <payload> --cross-worktree --pane <tmux-target>";

for (const reader of ["send", "spool"]) test(`${reader} refuses an enrolled root that disagrees with acting registry`, () => {
  const fx = fixture({ betaClearFence: true }), marker = join(fx.index, "global-registry.json");
  const doc = JSON.parse(readFileSync(marker, "utf8"));
  doc.teams.beta.root = fx.alpha.wt;
  writeFileSync(marker, JSON.stringify(doc));
  if (reader === "send") expect(() => bindRemoteTeam("beta", "rb", fx.index)).toThrow("worktree_root");
  else expect(spoolRecipientBusHome(fx.alpha.bus, fx.beta.registry, "beta", fx.index)).toBeNull();
});

test("fence authority preserves physical bindings, unindexed files, and the direct manual door", () => {
  const fx = fixture(), marker = join(fx.index, "global-registry.json");
  const alias = join(fx.root, "registry-link"); symlinkSync(fx.beta.registry, alias);
  expect(spoolRecipientBusHome(fx.alpha.bus, alias, "beta", fx.index)).toBe(realpathSync(fx.beta.bus));
  for (const root of [null, {}, "", "relative", join(fx.root, "missing-root")]) {
    const doc = JSON.parse(readFileSync(marker, "utf8")); doc.teams.beta.root = root;
    writeFileSync(marker, JSON.stringify(doc));
    expect(spoolRecipientBusHome(fx.alpha.bus, fx.beta.registry, "beta", fx.index)).toBeNull();
    expect(() => bindRemoteTeam("beta", "rb", fx.index)).toThrow("cannot resolve enrolled root");
  }
  writeFileSync(marker, JSON.stringify({ schema: "0.20" }));
  expect(spoolRecipientBusHome(fx.alpha.bus, fx.beta.registry, "beta", fx.index)).toBe(realpathSync(fx.beta.bus));
  const customBus = join(fx.root, "file-pinned"); mkdirSync(customBus);
  const custom = join(customBus, "foreign-registry.json");
  writeFileSync(custom, readFileSync(fx.beta.registry));
  const customAlias = join(fx.root, "custom-registry-link"); symlinkSync(custom, customAlias);
  for (const registry of [custom, customAlias]) {
    expect(spoolRecipientBusHome(fx.alpha.bus, registry, "beta", fx.index)).toBe(realpathSync(customBus));
  }
  writeFileSync(marker, "{invalid");
  expect(spoolRecipientBusHome(fx.alpha.bus, custom, "beta", fx.index)).toBeNull();
  expect(spoolRecipientBusHome(fx.alpha.bus, fx.beta.registry, "", fx.index)).toBe(fx.alpha.bus);
  const directory = join(fx.beta.wt, ".tap", "elsewhere"); mkdirSync(directory);
  const manual = join(directory, "registry.json"); writeFileSync(manual, readFileSync(fx.beta.registry));
  expect(bindExplicitRemoteRegistry("beta", "rb", manual).busHome).toBe(directory);
});

for (const layout of ["standard", "relocated", "off-layout", "legacy"]) test(`remote send honors the enrolled root clear fence with a ${layout} registry`, () => {
  const fx = fixture({ betaClearFence: true, betaRelocated: layout === "off-layout" });
  if (layout === "relocated") {
    const directory = join(fx.beta.wt, ".tap", "elsewhere"); mkdirSync(directory);
    const registry = join(directory, "registry.json"); renameSync(fx.beta.registry, registry);
    const path = join(fx.index, "global-registry.json"), index = JSON.parse(readFileSync(path, "utf8"));
    index.teams.beta.registry_location = registry;
    writeFileSync(path, JSON.stringify(index));
  }
  if (layout === "legacy") {
    mkdirSync(join(fx.beta.wt, "tmp"));
    renameSync(fx.beta.bus, join(fx.beta.wt, "tmp", "tap"));
    writeFileSync(join(fx.beta.wt, "tmp", "tap", "registry.json"), '{"schema":"0.20","seats":{}}');
  }
  const result = run(fx, ["send", "beta/rb", "-m", "held during clear"]);
  if (layout === "legacy") {
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error_class: "old_store", detail: expect.stringContaining("old TAP bus location") });
    expect(existsSync(fx.beta.bus)).toBe(false);
    expect(injected(fx)).toEqual([]);
    return;
  }
  expect(result.code, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ status: receipt.status, delivery: receipt.delivery, reason: receipt.reason })
    .toEqual({ status: "queued", delivery: "spool", reason: "clearing" });
  expect(injected(fx)).toEqual([]);
});

for (const mode of ["gone", "unknown"]) for (const namesake of [false, true]) test(`copy-mode remote ${mode} preserves both registries, local namesake=${namesake}`, () => {
  const fx = fixture();
  if (namesake) {
    const doc = JSON.parse(readFileSync(fx.alpha.registry, "utf8"));
    doc.seats.rb = { ...doc.seats.ua, instance: "rb|local" };
    writeFileSync(fx.alpha.registry, JSON.stringify(doc));
  }
  const localBefore = readFileSync(fx.alpha.registry, "utf8");
  const remoteBefore = readFileSync(fx.beta.registry, "utf8");
  fx.env.FAKE_COPY_GONE = mode;
  const v = run(fx, ["send", "beta/rb", "-m", "pane loss"]);
  expect(readFileSync(fx.alpha.registry, "utf8")).toBe(localBefore);
  expect(readFileSync(fx.beta.registry, "utf8")).toBe(remoteBefore);
  expect({ code: v.code, cls: v.errorClass, route: v.route })
    .toEqual({ code: 1, cls: mode === "gone" ? "pane_gone" : "tmux_unreachable", route: "native send" });
  expect(payloads(fx.alpha.bus)).toEqual([]);
  expect(payloads(fx.beta.bus)).toEqual([]);
  expect(existsSync(fx.keys)).toBe(false);
}, 120_000);

describe("module rows: the split, the binding, the remote row", () => {
  test("splitSendTarget normalizes the colon form and refuses malformed addresses with the incumbent's bytes", () => {
    expect(splitSendTarget("beta:rb")).toEqual({ original: "beta/rb", team: "beta", handle: "rb", qualified: true });
    expect(splitSendTarget("beta/rb")).toEqual({ original: "beta/rb", team: "beta", handle: "rb", qualified: true });
    expect(splitSendTarget("rb")).toEqual({ original: "rb", team: "", handle: "rb", qualified: false });
    const refusal = (raw: string) => { try { splitSendTarget(raw); return null; } catch (e) { const t = e as TapError; return [t.errorClass, t.action, t.detail]; } };
    expect(refusal("a:b:c")).toEqual(["usage_error", "tap help send", "address 'a:b:c' is not a valid <team>:<handle> token (^[A-Za-z0-9][A-Za-z0-9._-]*$)"]);
    expect(refusal("beta/rb/x")).toEqual(["usage_error", "tap help", "address 'beta/rb/x' must be <team>/<handle> with one slash"]);
    expect(refusal("/rb")).toEqual(["usage_error", "tap help", "address '/rb' must be <team>/<handle> with one slash"]);
    expect(refusal("-beta/rb")).toEqual(["usage_error", "tap help", "team '-beta' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)"]);
    expect(refusal("beta/r b")).toEqual(["usage_error", "tap help", "handle 'r b' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)"]);
  });

  test("bindRemoteTeam answers with the index entry and refuses the incumbent's scopes", () => {
    const fx = fixture({ index: {
      hist: { root: "/nowhere", registry_location: "/nowhere/.tap/team-registry.json", state: "historical" },
      lost: { root: "/nowhere", registry_location: "/nowhere/.tap/team-registry.json", state: "registered" },
      dirloc: { root: "/nowhere", registry_location: "/", state: "registered" },
      objloc: { root: "/nowhere", registry_location: { path: "/nowhere/x.json" }, state: "registered" },
      bare: { root: "/nowhere", registry_location: "", state: "registered" },
    } });
    const bound = bindRemoteTeam("beta", "rb", fx.index);
    expect(bound).toEqual({ team: "beta", handle: "rb", rootReal: bound.rootReal, registryPath: fx.beta.registry, busHome: bound.busHome });
    expect(statSync(bound.busHome).isDirectory()).toBe(true);
    expect(bound.busHome.endsWith("/beta/.tap/bus")).toBe(true);
    const refusal = (t: string) => { try { bindRemoteTeam(t, "rb", fx.index); return null; } catch (e) { const x = e as TapError; return [x.errorClass, x.action, x.detail]; } };
    expect(refusal("gamma")).toEqual(["unknown_team", FALLBACK, `unknown team 'gamma' (not in the machine index; known sibling worktrees: <none>). Fallback: ${FALLBACK}`]);
    expect(refusal("hist")).toEqual(["historical_team", "tap doctor", "team 'hist' is historical — not delivery-addressable (team 'hist' is historical (not delivery-addressable))"]);
    // A positively absent location is a stale enrollment (tap-xbpuc); one that exists but is not a file stays unreachable.
    expect(refusal("lost")).toEqual(["stale_enrollment", "tap admin refresh   (purges enrolled teams whose acting registry file is gone)", "team 'lost' is enrolled but its acting registry file is gone (/nowhere/.tap/team-registry.json); the worktree was likely removed before de-enrollment"]);
    // A malformed (non-string) location is never "gone": String() coercion must not read as stale.
    expect(refusal("objloc")?.[0]).toBe("unreachable_team");
    expect(refusal("dirloc")).toEqual(["unreachable_team", "tap doctor", "team 'dirloc' registry_location is unreachable (registry_location unreachable for 'dirloc' (/); tap doctor)"]);
    // registry_v20.resolve_team_from_global: no stored location is `missing`.
    expect(refusal("bare")).toEqual(["unknown_team", FALLBACK, `unknown team 'bare' (not in the machine index; known sibling worktrees: <none>). Fallback: ${FALLBACK}`]);
    // The invalid arm: reachable only when the index turns invalid between the
    // caller's own resolution and this binding — unreadable, or a valid document
    // with the wrong schema (the marker-aware loader's answer, as Bash's
    // tap_registry_v20_state); the bytes are lib.sh:7285's fixed sentence.
    const INVALID = ["invalid_flip", "tap doctor", "registry flip marker is present but invalid — refusing legacy delivery (global-registry.json is present but unreadable or wrong schema; repair migration (tap doctor) — refusing legacy fallback)"];
    writeFileSync(join(fx.index, "global-registry.json"), "{ not json");
    expect(refusal("beta")).toEqual(INVALID);
    writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({ schema: "0.19", teams: { beta: { root: fx.beta.wt, registry_location: fx.beta.registry, state: "registered" } } })}\n`);
    expect(refusal("beta")).toEqual(INVALID);
    // An invalid index at the sentinel render is the constructor's refusal, never
    // a `path=` pointer (partner review's C1 at ef3798581).
    const render = (() => { try { senderIndexEvidence("alpha", fx.index); return null; } catch (e) { const x = e as TapError; return [x.errorClass, x.action, x.detail]; } })();
    expect(render).toEqual(["error", "fix_command", "sentinel_render: registry marker is invalid_flip; refusing to render rather than guess whether team 'alpha' is reachable"]);
    writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({ schema: "0.20", teams: { alpha: { root: fx.alpha.wt, registry_location: fx.alpha.registry, state: "registered" } } })}\n`);
    expect(senderIndexEvidence("alpha", fx.index)).toBe("reachable");
    expect(senderIndexEvidence("gamma", fx.index)).toBe("unreachable");
    expect(senderIndexEvidence("lost", fx.index)).toBe("unreachable");
  });

  test("remoteRecipientRow refuses each row shape in the incumbent's order", () => {
    const row = (seats: Record<string, unknown>) => {
      try { return remoteRecipientRow({ seats }, "beta", "rb", "alpha"); }
      catch (e) { const x = e as TapError; return [x.errorClass, x.action, x.detail]; }
    };
    const ok = { status: "active", pane: "rb:0.0", pane_id: "%7" };
    expect(row({ rb: ok, ra: {} })).toEqual({ seat: ok, pane: "rb:0.0", paneId: "%7" });
    expect(row({ zz: ok, aa: ok })).toEqual(["not_found", FALLBACK, `unknown handle 'rb' in team 'beta' (registered handles: aa, zz). Fallback: ${FALLBACK}`]);
    expect(row({})).toEqual(["not_found", FALLBACK, `unknown handle 'rb' in team 'beta' (registered handles: <none>). Fallback: ${FALLBACK}`]);
    // Python's `if not entry`: a null or empty row is missing, and it still counts among the names.
    expect(row({ rb: null })).toEqual(["not_found", FALLBACK, `unknown handle 'rb' in team 'beta' (registered handles: rb). Fallback: ${FALLBACK}`]);
    expect(row({ rb: {} })).toEqual(["not_found", FALLBACK, `unknown handle 'rb' in team 'beta' (registered handles: rb). Fallback: ${FALLBACK}`]);
    expect(row({ rb: { ...ok, status: "pending" } })).toEqual(["seat_pending", "run 'tap register rb --pane <new-tmux-target>' from team 'beta'", "'rb' in team 'beta' is still launching; wait for it to register"]);
    expect(row({ rb: { ...ok, status_reason: "launching" } })).toEqual(["seat_launching", "tap team", "'rb' in team 'beta' is bound but still launching"]);
    expect(row({ rb: { ...ok, status: "suspended", status_reason: "pane_gone" } })).toEqual(["suspended", FALLBACK, `handle 'rb' in team 'beta' is suspended (pane_gone). Fallback: ${FALLBACK}`]);
    expect(row({ rb: { ...ok, status: "suspended" } })).toEqual(["suspended", FALLBACK, `handle 'rb' in team 'beta' is suspended (no reason). Fallback: ${FALLBACK}`]);
    // The incapable reason is the operator's own mark: the advice points at
    // re-registration in the mark's home team, never at the manual relay.
    expect(row({ rb: { ...ok, status: "suspended", status_reason: "incapable" } })).toEqual(["suspended", `have 'rb' re-register from its pane in team 'beta': 'tap in' there, or 'tap register rb --pane <tmux-target>' from team 'beta'`, `handle 'rb' in team 'beta' is suspended (incapable)`]);
    expect(row({ rb: { ...ok, delivery: "poll" } })).toEqual(["poll_member_remote", "register 'rb' as a poll member on this (alpha) team instead", "'rb' in team 'beta' is delivery:poll — cross-worktree relay delivers by injection, which a poll member never receives"]);
    expect(row({ rb: { status: "active" } })).toEqual(["not_found", FALLBACK, `handle 'rb' in team 'beta' has no pane. Fallback: ${FALLBACK}`]);
    expect(row({ rb: { status: "active", pane: "rb:0.0" } })).toEqual(["identity_unverified", "run 'tap register rb --pane <tmux-target>' from team 'beta', then retry", "registry row for 'beta/rb' has no pane_id; refusing unbound delivery"]);
    expect(row({ rb: { status: "active", pane: "rb:0.0", pane_id: "seven" } })).toEqual(["identity_unverified", "target seat 'rb' must run 'tap in' from team 'beta'", "registry row for 'beta/rb' has invalid pane_id 'seven'; refusing delivery without changing seat status"]);
    // The poll refusal precedes the pane questions, the pane_id absence its shape.
    expect((row({ rb: { status: "active", delivery: "poll" } }) as string[])[0]).toBe("poll_member_remote");
  });
});

describe("native routing over the installed bin/tap", () => {
  const RB = { status: "active", pane: "rb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rb|B", harness: "claude" };

  const refusals: Array<{ name: string; fx: FixtureOpts; args: string[]; expect: { code: number; errorClass: string; action: string; detail: string } }> = [
    { name: "unknown team", fx: {}, args: ["send", "gamma/rb", "-m", "hi"], expect: { code: 1, errorClass: "unknown_team", action: FALLBACK, detail: `unknown team 'gamma' (not in the machine index; known sibling worktrees: <none>). Fallback: ${FALLBACK}` } },
    { name: "historical team", fx: { index: { beta: { root: "/nowhere", registry_location: "/nowhere/.tap/team-registry.json", state: "historical" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "historical_team", action: "tap doctor", detail: "team 'beta' is historical — not delivery-addressable (team 'beta' is historical (not delivery-addressable))" } },
    { name: "stale enrollment (registry_location gone)", fx: { index: { beta: { root: "/nowhere", registry_location: "/nowhere/.tap/team-registry.json", state: "registered" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "stale_enrollment", action: "tap admin refresh   (purges enrolled teams whose acting registry file is gone)", detail: "team 'beta' is enrolled but its acting registry file is gone (/nowhere/.tap/team-registry.json); the worktree was likely removed before de-enrollment" } },
    { name: "unreachable registry_location", fx: { index: { beta: { root: "/nowhere", registry_location: "/", state: "registered" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "unreachable_team", action: "tap doctor", detail: "team 'beta' registry_location is unreachable (registry_location unreachable for 'beta' (/); tap doctor)" } },
    { name: "empty registry_location", fx: { index: { beta: { root: "/nowhere", registry_location: "", state: "registered" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "unknown_team", action: FALLBACK, detail: `unknown team 'beta' (not in the machine index; known sibling worktrees: <none>). Fallback: ${FALLBACK}` } },
    { name: "two slashes", fx: {}, args: ["send", "beta/rb/x", "-m", "hi"], expect: { code: 1, errorClass: "usage_error", action: "tap help", detail: "address 'beta/rb/x' must be <team>/<handle> with one slash" } },
    { name: "bad team token", fx: {}, args: ["send", "-beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "usage_error", action: "tap help", detail: "team '-beta' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)" } },
    { name: "bad colon form", fx: {}, args: ["send", "a:b:c", "-m", "hi"], expect: { code: 1, errorClass: "usage_error", action: "tap help send", detail: "address 'a:b:c' is not a valid <team>:<handle> token (^[A-Za-z0-9][A-Za-z0-9._-]*$)" } },
    { name: "unknown remote handle", fx: { betaSeats: { rz: RB, ra: RB } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "not_found", action: FALLBACK, detail: `unknown handle 'rb' in team 'beta' (registered handles: ra, rz). Fallback: ${FALLBACK}` } },
    { name: "pending remote seat", fx: { betaSeats: { rb: { ...RB, status: "pending" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "seat_pending", action: "run 'tap register rb --pane <new-tmux-target>' from team 'beta'", detail: "'rb' in team 'beta' is still launching; wait for it to register" } },
    { name: "launching remote seat", fx: { betaSeats: { rb: { ...RB, status_reason: "launching" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "seat_launching", action: "tap team", detail: "'rb' in team 'beta' is bound but still launching" } },
    { name: "suspended remote seat", fx: { betaSeats: { rb: { ...RB, status: "suspended", status_reason: "pane_gone" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "suspended", action: FALLBACK, detail: `handle 'rb' in team 'beta' is suspended (pane_gone). Fallback: ${FALLBACK}` } },
    { name: "suspended incapable remote seat", fx: { betaSeats: { rb: { ...RB, status: "suspended", status_reason: "incapable" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "suspended", action: `have 'rb' re-register from its pane in team 'beta': 'tap in' there, or 'tap register rb --pane <tmux-target>' from team 'beta'`, detail: `handle 'rb' in team 'beta' is suspended (incapable)` } },
    { name: "poll remote seat", fx: { betaSeats: { rb: { ...RB, delivery: "poll" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "poll_member_remote", action: "register 'rb' as a poll member on this (alpha) team instead", detail: "'rb' in team 'beta' is delivery:poll — cross-worktree relay delivers by injection, which a poll member never receives" } },
    { name: "remote seat without a pane", fx: { betaSeats: { rb: { status: "active", instance: "rb|B" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "not_found", action: FALLBACK, detail: `handle 'rb' in team 'beta' has no pane. Fallback: ${FALLBACK}` } },
    { name: "remote seat without a pane_id", fx: { betaSeats: { rb: { status: "active", pane: "rb:0.0", instance: "rb|B" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "identity_unverified", action: "run 'tap register rb --pane <tmux-target>' from team 'beta', then retry", detail: "registry row for 'beta/rb' has no pane_id; refusing unbound delivery" } },
    { name: "remote seat with a malformed pane_id", fx: { betaSeats: { rb: { ...RB, pane_id: "seven" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "identity_unverified", action: "target seat 'rb' must run 'tap in' from team 'beta'", detail: "registry row for 'beta/rb' has invalid pane_id 'seven'; refusing delivery without changing seat status" } },
    { name: "recipient bus mid-reset", fx: { betaResetFence: true }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "team_reset_fenced", action: "wait for the reset owner (or until identity is readable)", detail: "refusing tap send (recipient bus) — team bus is mid-reset (fence at " } },
    // Round 2 (partner review / a reviewer reads at ef3798581).
    // FROZEN: native's own detail sentence for the pre-placement drift (D1) —
    // this used to be pinned against the Bash door's differently-worded detail;
    // that comparison is retired with the door.
    { name: "bound pane_id drifted before placement", fx: { betaSeats: { rb: { ...RB, pane_id: "%8" } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "identity_mismatch", action: "target seat 'rb' must run 'tap in' from team 'beta'", detail: "'rb' is bound to pane id %8, but 'rb:0.0' is now %7 — refusing to deliver to a pane that is not the addressed seat" } },
    { name: "torn remote registry", fx: { betaRawRegistry: "{" }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "forwarding_unavailable", action: "tap team; retry with a current recipient", detail: "cannot resolve pinned forwarding for 'beta/rb'; no payload was placed" } },
    { name: "remote registry value outside the number domain", fx: { betaExtra: { observer_metadata: 0.5 } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "forwarding_unavailable", action: "tap team; retry with a current recipient", detail: "cannot resolve pinned forwarding for 'beta/rb'; no payload was placed" } },
    { name: "remote registry integer outside the safe range", fx: { betaExtra: { observer_metadata: 9007199254740993 } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "forwarding_unavailable", action: "tap team; retry with a current recipient", detail: "cannot resolve pinned forwarding for 'beta/rb'; no payload was placed" } },
    { name: "remote seat with an array pane_id", fx: { betaSeats: { rb: { ...RB, pane_id: [] } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "identity_unverified", action: "target seat 'rb' must run 'tap in' from team 'beta'", detail: "registry row for 'beta/rb' has invalid pane_id '[]'; refusing delivery without changing seat status" } },
    // FROZEN: native's own rendering of a non-string pane_id (JSON's `true`,
    // where the retired Bash door rendered Python's repr `True`).
    { name: "remote seat with a boolean pane_id", fx: { betaSeats: { rb: { ...RB, pane_id: true } } }, args: ["send", "beta/rb", "-m", "hi"], expect: { code: 1, errorClass: "identity_unverified", action: "target seat 'rb' must run 'tap in' from team 'beta'", detail: "registry row for 'beta/rb' has invalid pane_id 'true'; refusing delivery without changing seat status" } },
  ];

  for (const row of refusals) {
    test(`refusal: ${row.name} — nothing placed on either bus`, () => {
      const fx = fixture(row.fx);
      const v = run(fx, row.args);
      expect({ code: v.code, errorClass: v.errorClass, action: v.action, detail: v.detail.slice(0, row.expect.detail.length), route: v.route })
        .toEqual({ ...row.expect, route: "native send" });
      expect({ alpha: payloads(fx.alpha.bus), beta: payloads(fx.beta.bus) }).toEqual({ alpha: [], beta: [] });
    }, 120_000);
  }

  test("refusal: the remote pane is gone — exit 1 with the relay fallback (tap-send.sh:735)", () => {
    const fx = fixture();
    writeFileSync(fx.gone, "");
    const v = run(fx, ["send", "beta/rb", "-m", "hi"]);
    expect({ code: v.code, errorClass: v.errorClass, action: v.action, detail: v.detail, route: v.route })
      .toEqual({ code: 1, errorClass: "pane_gone", action: FALLBACK, detail: `pane 'rb:0.0' for beta/rb is not alive. Fallback: ${FALLBACK}`, route: "native send" });
    expect(payloads(fx.alpha.bus)).toEqual([]);
  }, 120_000);

  for (const [name, args, obligation] of [
    ["a plain note to beta/rb", ["send", "beta/rb", "-m", "cross-team note"], "note"],
    ["an ask to beta:rb", ["send", "beta:rb", "-m", "cross-team ask", "--ask"], "ask"],
    ["an assign to beta/rb", ["assign", "beta/rb", "-m", "NEXT ITEM: tap-x — do it"], "ask"],
  ] as const) {
    test(`delivery: ${name} lands on the sender's bus, injects a qualified sentinel, stamps beta's clock`, () => {
      const fx = fixture();
      const v = run(fx, [...args]);
      expect({ code: v.code, route: v.route, err: v.errorClass }).toEqual({ code: 0, route: `native ${args[0]}`, err: "" });
      const receipt = JSON.parse(v.stdout.split("\n").find(l => l.startsWith("{"))!) as Record<string, string>;
      expect({ status: receipt.status, delivery: receipt.delivery, to: receipt.to, from: receipt.from, turn: receipt.turn })
        .toEqual({ status: "injected", delivery: "pane", to: "rb", from: "ua", turn: "unconfirmed" });
      // The canonical lives on the SENDER's bus only, with the cross-team stamps.
      const alphaMail = payloads(fx.alpha.bus);
      expect({ alpha: alphaMail.length, beta: payloads(fx.beta.bus) }).toEqual({ alpha: 1, beta: [] });
      const fm = frontmatter(join(fx.alpha.bus, "payloads", alphaMail[0]!));
      const id = fm.id!;
      delete fm.id;
      const want: Record<string, string> = { from: "ua", to: "rb", kind: args[0] === "assign" ? "order" : "discuss", reply: obligation === "ask" ? "expected" : "settle-only", cross_worktree: "true", from_team: "alpha", to_team: "beta", recipient_instance: "rb|B", sender_instance: "ua|A" };
      expect(fm).toEqual(want);
      expect(existsSync(join(fx.alpha.bus, "receipts", `${id}.placed`))).toBe(true);
      expect(existsSync(join(fx.alpha.bus, "receipts", `${id}.sent`))).toBe(true);
      // The sentinel names the sender's team as the bus locator, the recipient's
      // team is known, and alpha is enrolled: no path= pointer.
      const lines = injected(fx);
      expect(lines).toEqual([`[[TAP v0.23 ${obligation} alpha/${id}]]`]);
      expect(readFileSync(fx.keys, "utf8")).toMatch(/send-keys -t (%7|rb:0\.0) -l -- /);
      // Delivery clock: the RECIPIENT's bus sidecar (tap-send.sh:1989 stamps
      // TARGET_REGISTRY), never one on the sender's.
      expect({ beta: existsSync(join(fx.beta.bus, "delivery", "rb.json")), alpha: existsSync(join(fx.alpha.bus, "delivery")) })
        .toEqual({ beta: true, alpha: false });
    }, 120_000);
  }

  test("delivery: a qualified address on the caller's own team is a local send", () => {
    const fx = fixture();
    const v = run(fx, ["send", "alpha/ua2", "-m", "same team"]);
    expect({ code: v.code, route: v.route }).toEqual({ code: 0, route: "native send" });
    const mail = payloads(fx.alpha.bus);
    expect(mail).toHaveLength(1);
    const fm = frontmatter(join(fx.alpha.bus, "payloads", mail[0]!));
    expect({ to: fm.to, cross: fm.cross_worktree, fromTeam: fm.from_team, toTeam: fm.to_team }).toEqual({ to: "ua2", cross: undefined, fromTeam: undefined, toTeam: undefined });
    expect(injected(fx)).toEqual([`[[TAP v0.23 note ${fm.id}]]`]);
  }, 120_000);

  test("delivery: forwarding is resolved on the REMOTE registry", () => {
    const fx = fixture({
      betaSeats: { rc: { ...RB, instance: "rc|B" } },
      betaExtra: { seat_forwardings: [{ source: "rb", source_instance: "rb|B", destination: "rc", destination_instance: "rc|B", at: "2026-09-16T00:00:00Z", address_active: true }] },
    });
    const v = run(fx, ["send", "beta/rb", "-m", "forwarded"]);
    expect({ code: v.code, route: v.route, err: v.errorClass, detail: v.detail }).toEqual({ code: 0, route: "native send", err: "", detail: "" });
    const mail = payloads(fx.alpha.bus);
    const fm = frontmatter(join(fx.alpha.bus, "payloads", mail[0]!));
    expect({ to: fm.to, adopted: fm.to_adopted_from, original: fm.original_recipient_instance, inst: fm.recipient_instance, toTeam: fm.to_team })
      .toEqual({ to: "rc", adopted: "rb", original: "rb|B", inst: "rc|B", toTeam: "beta" });
  }, 120_000);

  test("park: a live clear fence on the RECIPIENT's bus parks on the sender's spool", () => {
    const fx = fixture({ betaClearFence: true });
    const v = run(fx, ["send", "beta/rb", "-m", "fenced"]);
    expect({ code: v.code, route: v.route, err: v.errorClass }).toEqual({ code: 0, route: "native send", err: "" });
    const receipt = JSON.parse(v.stdout.split("\n").find(l => l.startsWith("{"))!) as Record<string, string>;
    expect({ status: receipt.status, delivery: receipt.delivery, reason: receipt.reason }).toEqual({ status: "queued", delivery: "spool", reason: "clearing" });
    const spool = join(fx.alpha.bus, "spool");
    const entries = readdirSync(spool).filter(f => f.endsWith(".meta.json"));
    expect({ entries: entries.length, betaSpool: existsSync(join(fx.beta.bus, "spool")) }).toEqual({ entries: 1, betaSpool: false });
    const meta = JSON.parse(readFileSync(join(spool, entries[0]!), "utf8")) as Record<string, unknown>;
    expect({ toTeam: meta.to_team, registry: meta.target_registry, pane: meta.pane }).toEqual({ toTeam: "beta", registry: fx.beta.registry, pane: "rb:0.0" });
    expect(injected(fx)).toEqual([]);
  }, 120_000);

  test("locks: opposite-direction cross-team sends complete concurrently (tap-send.sh:1030-1036 order)", async () => {
    const fx = fixture();
    // beta's rb also sends to alpha/ua; both hold both registries' locks.
    const spawn = (cwd: string, self: string, to: string) => Bun.spawn(
      [TAP, "send", to, "-m", `from ${self}`, "--json"],
      { cwd, env: { ...fx.env, TAP_SELF: self }, stdout: "pipe", stderr: "pipe" },
    );
    const a = spawn(fx.alpha.wt, "ua", "beta/rb");
    const b = spawn(fx.beta.wt, "rb", "alpha/ua");
    const [ca, cb] = await Promise.all([a.exited, b.exited]);
    const ea = await new Response(a.stderr).text();
    const eb = await new Response(b.stderr).text();
    const oa = await new Response(a.stdout).text();
    const ob = await new Response(b.stdout).text();
    // THE CLAIM IS THE LOCK DISCIPLINE: neither side refuses `registry_lock_busy`,
    // neither waits on the other, each canonical lands exactly once on its own
    // bus. The pane outcome is the courier's under a tmux client budget whose
    // sidecar handshake (panelock.ts:187-190, 100 ms) starves under machine
    // load — measured 2/8 and 2/10 at load 15-20: a `rate_limited` step before
    // the inject parks `no-input-prompt` (CONTRACT §native parks; the fake
    // logged the pane_in_mode peek and then no send-keys), after the inject it
    // is submit-unverified (exit 5), before placement it is the `rate_limited`
    // refusal. Those are tolerated BY NAME; anything else is red.
    const receipt = (out: string): Record<string, string> => JSON.parse(out.split("\n").find(l => l.startsWith("{")) ?? "{}") as Record<string, string>;
    const spoolMetas = (bus: string): number => existsSync(join(bus, "spool")) ? readdirSync(join(bus, "spool")).filter(f => f.endsWith(".meta.json")).length : 0;
    const outcome = (code: number, r: Record<string, string>, bus: string): string => {
      const placed = payloads(bus).length + spoolMetas(bus);
      if (code === 0 && r.status === "injected" && placed === 1) return "injected";
      if (code === 0 && r.status === "queued" && r.reason === "no-input-prompt" && placed === 1) return "parked:no-input-prompt (tolerated: tmux client budget)";
      if (code === 5 && r.status === "pending" && placed === 1) return "unverified (tolerated: tmux client budget after inject)";
      if (code === 1 && r.error_class === "rate_limited" && placed === 0) return "refused:rate_limited (tolerated: tmux client budget before placement)";
      return `UNEXPECTED code=${code} receipt=${JSON.stringify(r)} placed=${placed}`;
    };
    const tolerated = expect.stringMatching(/^(injected|parked:no-input-prompt|unverified|refused:rate_limited)/);
    expect({ a: outcome(ca, receipt(oa), fx.alpha.bus), b: outcome(cb, receipt(ob), fx.beta.bus), lockBusy: `${oa}${ob}${ea}${eb}`.includes("registry_lock_busy") })
      .toEqual({ a: tolerated, b: tolerated, lockBusy: false });
  }, 120_000);

  test("refusal: the index turns invalid after the binding — the sentinel constructor refuses (lib.sh:822-838)", () => {
    const fx = fixture();
    // The partner reviewer's control: the first observation of beta's pane — after
    // the door has bound the remote team — corrupts the machine index.
    const tmux = join(fx.root, "bin", "tmux");
    const real = join(fx.root, "bin", "tmux.real");
    renameSync(tmux, real);
    writeFileSync(tmux, `#!/bin/sh
case " $* " in
  *" rb:"*|*"=rb"*|*" %7 "*)
    if [ ! -e "$TAP_INDEX_HOME/.corrupted" ]; then
      printf '{ invalid' > "$TAP_INDEX_HOME/global-registry.json"
      : > "$TAP_INDEX_HOME/.corrupted"
    fi
    ;;
esac
exec "$FAKE_TMUX_REAL" "$@"
`, { mode: 0o755 });
    (fx.env as Record<string, string>).FAKE_TMUX_REAL = real;
    const v = run(fx, ["send", "beta/rb", "-m", "index race"]);
    const placedIds = payloads(fx.alpha.bus).map(f => f.replace(/\.md$/, ""));
    const view = { code: v.code, err: v.errorClass, action: v.action, detail: v.detail, stderr: v.stderr, stdout: v.stdout, alpha: placedIds.length, beta: payloads(fx.beta.bus).length, injected: injected(fx),
      // The canonical that stays is a TRACKED obligation: its `.placed` receipt exists (tap show / outstanding see it).
      placed: placedIds.map(id => existsSync(join(fx.alpha.bus, "receipts", `${id}.placed`))) };
    // exit 1 after placement, the canonical stays, nothing injected. Native
    // prints the constructor's refusal (`die`'s class and sentence, lib.sh:548/:835).
    expect(view).toEqual({ code: 1, err: "error", action: "fix_command",
      detail: "sentinel_render: registry marker is invalid_flip; refusing to render rather than guess whether team 'alpha' is reachable",
      stderr: "", stdout: expect.stringContaining('"error_class":"error"'), alpha: 1, beta: 0, injected: [], placed: [true] });
  }, 120_000);

  test("refusal: the index is rewritten with the wrong schema after the binding — the marker-aware loader refuses at the render", () => {
    const fx = fixture();
    // A VALID document that is not a live marker: `resolveTeamFromDoc` alone
    // would still find beta in it; `tap_registry_v20_state` calls it invalid.
    const tmux = join(fx.root, "bin", "tmux");
    const real = join(fx.root, "bin", "tmux.real");
    renameSync(tmux, real);
    const wrongSchema = JSON.stringify({ schema: "0.19", teams: { alpha: { root: fx.alpha.wt, registry_location: fx.alpha.registry, state: "registered" }, beta: { root: fx.beta.wt, registry_location: fx.beta.registry, state: "registered" } } });
    writeFileSync(join(fx.root, "wrong-schema.json"), `${wrongSchema}\n`);
    writeFileSync(tmux, `#!/bin/sh
case " $* " in
  *" rb:"*|*"=rb"*|*" %7 "*)
    if [ ! -e "$TAP_INDEX_HOME/.rewritten" ]; then
      cat "$FAKE_WRONG_SCHEMA" > "$TAP_INDEX_HOME/global-registry.json"
      : > "$TAP_INDEX_HOME/.rewritten"
    fi
    ;;
esac
exec "$FAKE_TMUX_REAL" "$@"
`, { mode: 0o755 });
    (fx.env as Record<string, string>).FAKE_TMUX_REAL = real;
    (fx.env as Record<string, string>).FAKE_WRONG_SCHEMA = join(fx.root, "wrong-schema.json");
    const v = run(fx, ["send", "beta/rb", "-m", "schema race"]);
    const placedIds = payloads(fx.alpha.bus).map(f => f.replace(/\.md$/, ""));
    const view = { code: v.code, err: v.errorClass, action: v.action, detail: v.detail, stderr: v.stderr, stdout: v.stdout, alpha: placedIds.length, beta: payloads(fx.beta.bus).length, injected: injected(fx),
      placed: placedIds.map(id => existsSync(join(fx.alpha.bus, "receipts", `${id}.placed`))) };
    expect(view).toEqual({ code: 1, err: "error", action: "fix_command",
      detail: "sentinel_render: registry marker is invalid_flip; refusing to render rather than guess whether team 'alpha' is reachable",
      stderr: "", stdout: expect.stringContaining('"error_class":"error"'), alpha: 1, beta: 0, injected: [], placed: [true] });
  }, 120_000);

  // tap-fyttg: the corrupt-index refusal at the verb seam. The raw byte sits in
  // an UNRELATED team's name, so a lossy decode would still leave deliverable
  // JSON — exactly what the completion-only guard used to catch too late. The
  // same bytes the marker-kind arms pin, at the door a caller actually presses.
  test("refusal: an index with a raw 0xe9 in an unrelated team name refuses send on the native route — invalid_flip, nothing placed; the same document in valid UTF-8 delivers", () => {
    const fx = fixture();
    const marker = join(fx.index, "global-registry.json");
    const corrupt = Buffer.concat([
      Buffer.from(`{"schema":"0.20","teams":{"oth`),
      Buffer.from([0xe9]),
      Buffer.from(`er":{"root":"/nowhere","registry_location":"/nowhere/r.json"},` +
        `"alpha":{"root":${JSON.stringify(fx.alpha.wt)},"registry_location":${JSON.stringify(fx.alpha.registry)},"state":"registered"},` +
        `"beta":{"root":${JSON.stringify(fx.beta.wt)},"registry_location":${JSON.stringify(fx.beta.registry)},"state":"registered"}}}`),
    ]);
    writeFileSync(marker, corrupt);
    const v = run(fx, ["send", "beta/rb", "-m", "bad bytes"]);
    expect({ code: v.code, errorClass: v.errorClass, action: v.action, detail: v.detail, route: v.route })
      .toEqual({ code: 1, errorClass: "invalid_flip", action: "tap doctor",
        detail: "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation",
        route: "native send" });
    expect({ alpha: payloads(fx.alpha.bus), beta: payloads(fx.beta.bus), keys: existsSync(fx.keys) })
      .toEqual({ alpha: [], beta: [], keys: false });
    // Rewritten as valid UTF-8, the same document delivers: the refusal is about
    // the bytes, not the fixture's shape.
    writeFileSync(marker, JSON.stringify({
      schema: "0.20",
      teams: {
        other: { root: "/nowhere", registry_location: "/nowhere/r.json", state: "registered" },
        alpha: { root: fx.alpha.wt, registry_location: fx.alpha.registry, state: "registered" },
        beta: { root: fx.beta.wt, registry_location: fx.beta.registry, state: "registered" },
      },
    }));
    const ok = run(fx, ["send", "beta/rb", "-m", "good bytes"]);
    expect({ code: ok.code, route: ok.route, err: ok.errorClass }).toEqual({ code: 0, route: "native send", err: "" });
    expect(payloads(fx.alpha.bus)).toHaveLength(1);
  }, 120_000);

  test("refusal: the caller's own team is not a token — refused before anything is staged (lib.sh:7265)", () => {
    const fx = fixture({ alphaName: "al pha" });
    const v = run(fx, ["send", "beta/rb", "-m", "hi"], { cwd: fx.alpha.wt });
    expect({ code: v.code, err: v.errorClass, action: v.action, detail: v.detail, route: v.route, alpha: payloads(fx.alpha.bus), beta: payloads(fx.beta.bus) })
      .toEqual({ code: 1, err: "usage_error", action: "tap help", detail: "local team 'al pha' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)", route: "native send", alpha: [], beta: [] });
  }, 120_000);

  /** Hold beta/rb's submit lock until the canonical is placed, mutate, release: the post-placement window. */
  async function postPlacement(fx: Fx, args: string[], mutate: () => void) {
    const paneLock = acquirePaneLock("%7", 5000, fx.env);
    expect(paneLock).not.toBeNull();
    const child = Bun.spawn([TAP, ...args, "--json"], {
      cwd: fx.alpha.wt,
      env: { ...fx.env, TAP_SELF: "ua" },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 30_000;
      while (payloads(fx.alpha.bus).length === 0 && Date.now() < deadline) await Bun.sleep(20);
      expect(payloads(fx.alpha.bus)).toHaveLength(1);
      mutate();
    } finally {
      paneLock?.release();
    }
    const code = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const docs = [...stdout.split("\n"), ...stderr.split("\n")].filter(l => l.startsWith("{")).map(l => JSON.parse(l) as Record<string, string>);
    const last = docs[docs.length - 1] ?? {};
    return { code, status: last.status ?? "", err: last.error_class ?? "", reason: last.reason ?? "", action: last.next ?? last.action ?? "", detail: (last.detail ?? "").split(fx.root).join("<root>"),
      alpha: payloads(fx.alpha.bus).length, beta: payloads(fx.beta.bus).length, injected: injected(fx).length };
  }

  test("post-placement: beta/rb's pane_id drifts under the submit lock — native keeps its queued/poll carve-out", async () => {
    const fx = fixture();
    const seen = await postPlacement(fx, ["send", "beta/rb", "-m", "pane race"], () => {
      const reg = JSON.parse(readFileSync(fx.beta.registry, "utf8")) as { seats: Record<string, Record<string, unknown>> };
      reg.seats.rb!.pane_id = "%8";
      writeFileSync(fx.beta.registry, `${JSON.stringify(reg)}\n`);
    });
    // native's certified pre-effect carve-out (CONTRACT §exit 3) keeps the
    // canonical for a poller rather than retracting it.
    expect(seen).toEqual({ code: 0, status: "queued", err: "", reason: "identity_mismatch", action: "target seat 'rb' must run 'tap in' from team 'beta'",
      detail: expect.stringContaining("%8"), alpha: 1, beta: 0, injected: 0 });
  }, 120_000);

  test("post-placement: beta/rb's instance is replaced under the submit lock — native's point-of-effect reauthorizer parks", async () => {
    const fx = fixture();
    const seen = await postPlacement(fx, ["send", "beta/rb", "-m", "identity race"], () => {
      const reg = JSON.parse(readFileSync(fx.beta.registry, "utf8")) as { seats: Record<string, Record<string, unknown>> };
      reg.seats.rb!.instance = "rb|REPLACED";
      writeFileSync(fx.beta.registry, `${JSON.stringify(reg)}\n`);
    });
    expect(seen).toEqual({ code: 0, status: "queued", err: "", reason: "identity_mismatch", action: "target seat 'rb' must run 'tap in' from team 'beta'",
      detail: expect.any(String), alpha: 1, beta: 0, injected: 0 });
  }, 120_000);

  test("router: the manual relay and the registry override trace native; the qualified positional traces native", () => {
    const fx = fixture();
    expect(run(fx, ["send", "rb", "-m", "relay", "--cross-worktree", "--pane", "rb:0.0"]).route).toBe("native send");
    expect(run(fx, ["send", "beta/rb", "-m", "override", "--remote-registry", fx.beta.registry]).route).toBe("native send");
    expect(run(fx, ["send", "beta/rb", "-m", "native"]).route).toBe("native send");
    expect(run(fx, ["assign", "beta:rb", "-m", "NEXT ITEM: tap-x — go"]).route).toBe("native assign");
  }, 120_000);
});

describe("the explicit --remote-registry override (checkpoint A, U2)", () => {
  test("beta/rb via an explicit registry path routes native, cross-worktree stamps and injects into rb", () => {
    const fx = fixture();
    const v = run(fx, ["send", "beta/rb", "-m", "override", "--id", "ua-20260920T040100Z-aabbccddeeff", "--remote-registry", fx.beta.registry]);
    const canonical = join(fx.alpha.bus, "payloads", "ua-20260920T040100Z-aabbccddeeff.md");
    expect({ code: v.code, route: v.route, stderr: v.stderr, exists: existsSync(canonical) }).toEqual({
      code: 0, route: "native send", stderr: "", exists: true,
    });
    const raw = readFileSync(canonical, "utf8");
    expect({ cw: envelopeField(raw, "cross_worktree"), from: envelopeField(raw, "from_team"), to: envelopeField(raw, "to_team"), inst: envelopeField(raw, "recipient_instance") })
      .toEqual({ cw: "true", from: "alpha", to: "beta", inst: "rb|B" });
    expect(injected(fx).length).toBe(1);
  }, 120_000);

  test("a missing override path refuses with the incumbent's not_found bytes", () => {
    const fx = fixture();
    const v = run(fx, ["send", "beta/rb", "-m", "override", "--remote-registry", join(fx.root, "nope", "acting.json")]);
    expect({ code: v.code, errorClass: v.errorClass, detail: v.detail }).toEqual({
      code: 1, errorClass: "not_found", detail: `--remote-registry path not found: ${join(fx.root, "nope", "acting.json")}`,
    });
  }, 90_000);

  test("an old-format override registry refuses old_store with no payload, receipt or pane effect", () => {
    const fx = fixture();
    const current = JSON.parse(readFileSync(fx.beta.registry, "utf8"));
    const old = join(fx.root, "old-beta", "acting.json");
    mkdirSync(join(fx.root, "old-beta"), { recursive: true });
    writeFileSync(old, JSON.stringify({ team: current.team, agents: current.seats }));
    const v = run(fx, ["send", "beta/rb", "-m", "override", "--remote-registry", old]);
    expect({ code: v.code, errorClass: v.errorClass }).toEqual({ code: 1, errorClass: "old_store" });
    expect(v.detail).toContain(old);
    const receipts = (bus: string) => existsSync(join(bus, "receipts")) ? readdirSync(join(bus, "receipts")) : [];
    expect({ alpha: payloads(fx.alpha.bus), beta: payloads(fx.beta.bus), alphaReceipts: receipts(fx.alpha.bus), betaReceipts: receipts(fx.beta.bus), injected: injected(fx) })
      .toEqual({ alpha: [], beta: [], alphaReceipts: [], betaReceipts: [], injected: [] });
  }, 90_000);

  test("an unqualified destination refuses with the incumbent's usage bytes", () => {
    const fx = fixture();
    const v = run(fx, ["send", "rb", "-m", "override", "--remote-registry", fx.beta.registry]);
    expect({ code: v.code, errorClass: v.errorClass, detail: v.detail }).toEqual({
      code: 1, errorClass: "usage_error", detail: "--remote-registry requires a <team>/<handle> destination",
    });
  }, 90_000);
});
