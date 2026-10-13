import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { physicalSocketPath } from "../src/tmux";
import { Bus } from "../src/bus";
import { canonicalPlaceLocked } from "../src/courier";
import { atomicWrite } from "../src/fsatomic";
import { removeScratchTree } from "./support/scratch";
import { writeLiveFence } from "./support/live-fence";

const root = resolve(import.meta.dir, "../../..");
const candidate = join(root, "runtime/bun/main.ts");
const nativeDoneCandidate = join(root, "runtime/bun/test/support/native-done-entry.ts");
const nativeSendCandidate = join(root, "runtime/bun/test/support/native-send-entry.ts");
const shippedEntry = join(root, "bin/tap");
// The same door under its reference-side name in the differentials below.
const incumbent = shippedEntry;
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

function fixture() {
  const tmuxTmp = process.env.TMUX_TMPDIR;
  if (!tmuxTmp) throw new Error("native-router fixture requires runner TMUX_TMPDIR");
  const dir = mkdtempSync(join(tmpdir(), "tap-bun-native-router."));
  scratch.push(dir);
  const index = join(dir, "index");
  const worktree = join(dir, "worktree");
  const bin = join(dir, "bin");
  const tmuxName = basename(dir);
  const tmuxTrace = join(dir, "tmux.argv");
  mkdirSync(index, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // Born live (F1): every fixture machine has an index, enrolled or not.
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  spawnSync("git", ["init", "-q", worktree]);
  const realTmux = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  if (!realTmux) throw new Error("native-router control requires tmux");
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in -L|-S) ;; *) set -- -L ${JSON.stringify(tmuxName)} "$@" ;; esac
printf '%s\t%s\n' "$1" "$2" >> ${JSON.stringify(tmuxTrace)}
exec ${JSON.stringify(realTmux)} "$@"
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(index, "sessions.json"),
    OPENCODE_DB_PATH: join(index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(index, "version-seen.json"),
    TAP_TMUX_SOCKET: tmuxName,
  };
  delete env.TAP_HOME;
  delete env.TAP_TMUX_SOCKET_PATH;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TAP_SELF;
  return { dir, env, worktree, tmuxName, tmuxTrace };
}

function run(bin: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number) {
  return spawnSync(bin, argv, { cwd, encoding: "utf8", env, timeout: timeoutMs, killSignal: "SIGKILL" });
}

function bareIdAfterLocalMiss(hit: "none" | "one" | "many"): "no_local_payload" | "foreign" | "ambiguous" {
  if (hit === "many") return "ambiguous";
  if (hit === "one") return "foreign";
  return "no_local_payload";
}

function fallthroughMutant(hit: "none" | "one" | "many"): "no_local_payload" | "foreign" | "ambiguous" | "settle-local" {
  if (hit === "many") return "ambiguous";
  if (hit === "one") return "foreign";
  return "settle-local";
}

function noneArmAfterById(hit: "none" | "one" | "many", validateActor: boolean): "actor" | "no_local_payload" | "foreign" | "ambiguous" {
  if (hit === "many") return "ambiguous";
  if (hit === "one") return "foreign";
  return validateActor ? "actor" : "no_local_payload";
}

function noneArmReplayThenActor(receiptPresent: boolean, checkReplay: boolean, validateActor: boolean): "already_settled" | "actor" | "no_local_payload" {
  if (checkReplay && receiptPresent) return "already_settled";
  return validateActor ? "actor" : "no_local_payload";
}

function noneArmCancelledReceipt(cancelledOnly: boolean, gateOnDonePath: boolean, actorValid: boolean): "already_settled" | "actor" | "no_local_payload" {
  if (cancelledOnly && !gateOnDonePath) return "already_settled";
  return actorValid ? "no_local_payload" : "actor";
}

/** Overlay fake `ps`/`tmux` so the spawned native-done child observes a registered pane. */
function withFakeCallingPane(dir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = join(dir, "fake-pane-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nprintf '123 faketty\\n'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in
  list-panes) printf '%%7\\t/dev/faketty\\n' ;;
  display-message)
    [ "$3" = "-t" ] && [ "$4" = "%7" ] || exit 1
    printf '%%7\\t/dev/faketty\\talive\\t123:456\\n'
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const next: NodeJS.ProcessEnv = { ...env, PATH: `${bin}:${env.PATH}`, TMUX: "/fake,1,0" };
  delete next.TAP_SELF;
  delete next.TAP_TMUX_SOCKET;
  delete next.TAP_TMUX_SOCKET_PATH;
  return next;
}

function seedLiveTeam(worktree: string, index: string, seats: Record<string, unknown>) {
  const bus = join(worktree, ".tap", "bus");
  const registry = join(worktree, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: { routerteam: { root: worktree, registry_location: registry, state: "registered" } },
  }));
  writeFileSync(registry, JSON.stringify({
    schema: "0.20", team: { name: "routerteam", worktree_root: worktree }, seats,
  }));
  return { bus, registry };
}

function enrollTeam(index: string, name: string, worktree: string, seats: Record<string, unknown>) {
  mkdirSync(worktree, { recursive: true });
  spawnSync("git", ["init", "-q", worktree]);
  const bus = join(worktree, ".tap", "bus");
  const registry = join(worktree, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const gPath = join(index, "global-registry.json");
  const doc = existsSync(gPath)
    ? JSON.parse(readFileSync(gPath, "utf8")) as { schema: string; teams: Record<string, unknown> }
    : { schema: "0.20", teams: {} };
  doc.schema = "0.20";
  doc.teams[name] = { root: worktree, registry_location: registry, state: "registered" };
  writeFileSync(gPath, JSON.stringify(doc));
  writeFileSync(registry, JSON.stringify({
    schema: "0.20", team: { name, worktree_root: worktree }, seats,
  }));
  return { bus, registry };
}

function seedLegacyEnrolledTeam(index: string, name: string, worktree: string, seats: Record<string, unknown>) {
  mkdirSync(worktree, { recursive: true });
  spawnSync("git", ["init", "-q", worktree]);
  const bus = join(worktree, ".tap", "bus");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  writeFileSync(join(bus, "registry.json"), JSON.stringify({
    team: { name, worktree_root: worktree },
    agents: seats,
  }));
  const teamsPath = join(index, "teams.json");
  const doc = existsSync(teamsPath)
    ? JSON.parse(readFileSync(teamsPath, "utf8")) as { teams: Record<string, unknown> }
    : { teams: {} };
  doc.teams[name] = { root: worktree };
  writeFileSync(teamsPath, JSON.stringify(doc));
  return { bus };
}

function seedPayload(
  bus: string,
  id: string,
  recipientInstance?: string,
  fields: Record<string, string> = {},
) {
  const payload = join(bus, "payloads", `${id}.md`);
  writeFileSync(payload,
    `---\nid: ${id}\nfrom: snd\nto: ${fields.to ?? "rcv"}\nkind: discuss\npath: ${payload}\nreply: ${fields.reply ?? "expected"}\n` +
    Object.entries(fields).filter(([key]) => key !== "reply" && key !== "to").map(([key, value]) => `${key}: ${value}\n`).join("") +
    (recipientInstance ? `recipient_instance: ${recipientInstance}\n` : "") +
    "---\nbody\n");
  writeFileSync(join(bus, "receipts", `${id}.placed`), "{}\n");
}

function runRecoverySend(mode: "pre_identity" | "post_identity" | "inject_false") {
  const { dir, env, worktree } = fixture();
  const count = join(dir, "pane-count");
  const band = join(dir, "band");
  const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", harness: "claude", instance: "ua|A" },
    ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", harness: "claude", instance: "ub|A" },
  });
  writeFileSync(join(dir, "bin", "tmux"), `#!/bin/sh
case " $* " in
  *"#{pane_id}"*)
    n=0; [ ! -f "$FAKE_COUNT" ] || n=$(cat "$FAKE_COUNT")
    n=$((n + 1)); printf '%s\\n' "$n" > "$FAKE_COUNT"
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*) printf '%%6\\tua\\t4242\\tclaude\\t0\\n' ;;
      *)
        # post_identity drifts on the first read after the paste. Read 6 is the
        # courier's pre-paste re-authorization (tap-wudl2), which must still see ub.
        if { [ "$FAKE_MODE" = pre_identity ] && [ "$n" -ge 4 ]; } || { [ "$FAKE_MODE" = post_identity ] && [ "$n" -ge 7 ]; }; then
          printf '%%99\\tub\\t4242\\tclaude\\t0\\n'
        else
          printf '%%7\\tub\\t4242\\tclaude\\t0\\n'
        fi
        ;;
    esac
    ;;
  *"#{pane_current_command}"*) printf 'claude\\n' ;;
  *"#{pane_in_mode}"*) printf '0\\n' ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"capture-pane"*)
    if [ -f "$FAKE_BAND" ]; then printf '› '; cat "$FAKE_BAND"; printf '\\n──────────\\n'
    else printf '› \\n──────────\\n'; fi
    ;;
  *"send-keys"*)
    case " $* " in
      *" -l -- "*)
        for last do :; done; printf '%s' "$last" > "$FAKE_BAND"
        [ "$FAKE_MODE" != inject_false ] || exit 1
        ;;
    esac
    ;;
esac
exit 0
`, { mode: 0o755 });
  Object.assign(env, {
    TAP_HOME: bus,
    TAP_LOCK_DIR: join(dir, "locks"),
    TAP_SELF: "ua",
    TAP_SERVER_EPOCH: "srv:123:456",
    FAKE_MODE: mode,
    FAKE_COUNT: count,
    FAKE_BAND: band,
  });
  const result = run("bun", [nativeSendCandidate, "ub", "-m", mode, "--from", "ua", "--ask"], worktree, env);
  const payloads = readdirSync(join(bus, "payloads")).filter((name) => name.endsWith(".md"));
  return { result, bus, band, payloads };
}

describe("native router integration", () => {
  test("fixture refuses to pin a socket when TMUX_TMPDIR is unset", () => {
    const saved = process.env.TMUX_TMPDIR;
    delete process.env.TMUX_TMPDIR;
    try {
      expect(() => fixture()).toThrow(/TMUX_TMPDIR/);
    } finally {
      if (saved === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = saved;
    }
  });

  test("fixture socket resolves inside runner TMUX_TMPDIR under the sun_path cap", () => {
    const { env, tmuxName } = fixture();
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const constructed = join(env.TMUX_TMPDIR!, `tmux-${uid}`, tmuxName);
    const resolved = physicalSocketPath(env);
    expect(env.TAP_TMUX_SOCKET).toBe(tmuxName);
    expect(env.TAP_TMUX_SOCKET_PATH).toBeUndefined();
    expect(constructed.startsWith(`${env.TMUX_TMPDIR}/`)).toBe(true);
    expect(constructed.length).toBeLessThanOrEqual(104);
    expect(resolved.length).toBeLessThanOrEqual(104);
  });

  test("native bus files are owner-only independent of ambient umask", () => {
    const { dir, env, worktree } = fixture();
    const seeded = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    const bus = new Bus(seeded.bus);
    const id = "snd-20260826T200000Z-aaaaaaaaaaaa";
    const control = join(dir, "mode-control");
    const oldUmask = process.umask(0);
    try {
      writeFileSync(control, "control\n", { mode: 0o644 });
      canonicalPlaceLocked(bus, "---\n---\nbody\n", {
        id, from: "snd", to: "rcv", kind: "discuss", path: bus.payloadPath(id),
      });
      atomicWrite(bus.sentPath(id), "{}\n");
      atomicWrite(bus.donePath(id), "{}\n");
    } finally {
      process.umask(oldUmask);
    }

    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(control)).toBe(0o644);
    for (const path of [bus.payloadPath(id), bus.placedPath(id), bus.sentPath(id), bus.donePath(id)]) {
      expect(mode(path)).toBe(0o600);
    }
  });

  // Renamed with the closure, because the old name is now false: there is no
  // Bash door for `whoami` to match. `tap.sh`'s arm execs main, so BOTH public
  // entries are the same engine and the pane-gone contract is preserved by
  // identity rather than by agreement. The stdout/stderr/status assertions below
  // are unchanged and still worth keeping -- they now prove the two entries are
  // one engine rather than that two engines concur.
  test("both public whoami entries reach the native engine and keep the pane-gone contract", () => {
    const { dir, env, worktree, tmuxName, tmuxTrace } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;

    const argv = ["whoami", "--pane", "router-test-no-such-pane"];
    const expected = run("bash", [incumbent, ...argv], worktree, env);
    const actual = run("bun", [candidate, ...argv], worktree, env);

    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(actual.status).toBe(expected.status);
    // Two traces: the reference entry (tap.sh) now reaches main too. A single
    // line here would mean one of the two public entries never ran.
    expect(readFileSync(trace, "utf8")).toBe("native whoami\nnative whoami\n");
    const tmuxCalls = readFileSync(tmuxTrace, "utf8").trim().split("\n");
    expect(tmuxCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of tmuxCalls) expect(call.split("\t", 2)).toEqual(["-L", tmuxName]);
  }, 20_000);

  test("whoami refuses --pane '' natively, even from an observable caller pane", () => {
    const { dir, env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: {
        status: "active", pane: "router-session:0.0", pane_id: "%42",
        server_epoch: "srv:123:456", instance: "rcv|current",
      },
    });
    env.TAP_HOME = bus;
    writeFileSync(join(dir, "bin", "ps"), "#!/bin/sh\nprintf '1 ttys123\\n'\n", { mode: 0o755 });
    writeFileSync(join(dir, "bin", "tmux"), `#!/bin/sh
case " $* " in
  *" list-panes "*) printf '%%42\\t/dev/ttys123\\n' ;;
  *" display-message "*) printf '%%42\\t/dev/ttys123\\trouter-session\\t123:456\\n' ;;
esac
`, { mode: 0o755 });

    const actual = run(shippedEntry, ["whoami", "--pane", ""], worktree, env);

    expect(actual.stdout).toBe("");
    expect(actual.stderr).toBe("tap whoami: --pane needs a value; next: tap help whoami\n");
    expect(actual.status).toBe(1);
  });

  test("retired health reaches the native engine through both entry points", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;

    const expected = run("bash", [incumbent, "health", "--json"], worktree, env);
    const actual = run("bun", [candidate, "health", "--json"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(readFileSync(trace, "utf8")).toBe("native health\nnative health\n");
  });

  test("retired done reaches the native engine through both entry points", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    env.TAP_SELF = "rcv";
    const id = "snd-20260919T000000Z-aaaaaaaaaaaa";
    seedPayload(bus, id);

    const expected = run("bash", [incumbent, "done", id], worktree, env);
    const actual = run("bun", [candidate, "done", id], worktree, env);

    expect(actual.status).toBe(1);
    expect(actual.status).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(actual.stderr).toContain("tap done is retired");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(join(bus, "receipts", "done-alias-hits.jsonl"))).toBe(false);
    expect(readFileSync(trace, "utf8")).toBe("native done\nnative done\n");
  });

  test("retired nudge reaches the native engine through both entry points", () => {    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    env.TAP_HOME = bus;

    // Bare `nudge` is a safe dual-door probe: both entry points must answer the
    // same usage refusal before any pane effect, and both must dispatch natively.
    const expected = run("bash", [incumbent, "nudge"], worktree, env);
    const actual = run("bun", [candidate, "nudge"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.status).toBe(1);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(readFileSync(trace, "utf8")).toBe("native nudge\nnative nudge\n");
  });

  for (const tombstone of [
    {
      verb: "roster",
      stderr: "tap roster: tap roster is now: tap team; next: tap team\n",
      json: '{"ok":false,"error_class":"renamed_verb","action":"tap team","detail":"tap roster is now: tap team"}\n',
      help: "NAME\n  tap roster — renamed to tap team\n\nUSAGE\n  tap roster\n\nDESCRIPTION\n  Renamed: use tap team.\n",
    },
    {
      verb: "reset",
      stderr: "tap reset: tap reset moved to tap team reset (recoverable team reinitialization); next: tap team reset\n",
      json: '{"ok":false,"error_class":"renamed_verb","action":"tap team reset","detail":"tap reset moved to tap team reset (recoverable team reinitialization)"}\n',
      help: "NAME\n  tap reset — renamed to tap team reset\n\nUSAGE\n  tap reset\n\nDESCRIPTION\n  Renamed: use tap team reset [--dry-run] [--yes] [--allow-nonstandard-bus-path] [--kill-self] [--json]. It creates a fenced, complete team checkpoint before reinitializing the acting registry and bus; tap team restore puts that checkpoint back.\n",
    },
  ]) {
    test(`top-level renamed tombstones: ${tombstone.verb} preserves refusals through every entry`, () => {
      const { dir, env, worktree } = fixture();
      const trace = join(dir, "trace");
      Object.assign(env, { TAP_BUN_ROUTE_TRACE: trace, TAP_JSON: "0", TAP_VERBOSE: "0" });
      const entries = [["bun", candidate], ["bash", shippedEntry], ["bash", join(root, "scripts/tap.sh")]];
      const { verb } = tombstone;
      let calls = 0;
      const check = (bin: string, entry: string, args: string[], json: boolean) => {
        const result = run(bin, [entry, verb, ...args], worktree, env, 10000);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe(json ? tombstone.json : "");
        expect(result.stderr).toBe(json ? "" : tombstone.stderr);
        calls++;
      };
      // Literal baseline receipts: comparing the two doors alone would let a
      // shared regression pass after both start calling the same native handler.
      for (const [bin, entry] of entries) {
        check(bin!, entry!, [], false);
        check(bin!, entry!, ["--yes", "ignored", "--unknown", "--", "--json"], true);
      }
      check("bun", candidate, ["--unknown", "ignored", "--json=true", "-json"], false);
      check("bun", candidate, ["--json", "ignored"], true);
      check("bun", candidate, ["-h", "--json"], true);
      check("bun", candidate, ["--json", "--help"], true);
      env.TAP_JSON = "1";
      check("bash", shippedEntry, [], true);
      env.TAP_JSON = "0";

      env.TAP_JSON = "1";
      check("bash", shippedEntry, ["--yes", "ignored"], true);
      expect(readFileSync(trace, "utf8")).toBe(`native ${verb}\n`.repeat(calls));
      expect(existsSync(join(root, `skills/tap/scripts/tap-${verb}.sh`))).toBe(false);
    }, 120000);

    test(`top-level renamed tombstones: ${tombstone.verb} keeps exact help exceptions`, () => {
      const { env, worktree } = fixture();
      Object.assign(env, { TAP_JSON: "1", TAP_VERBOSE: "0" });
      for (const [bin, entry] of [["bun", candidate], ["bash", incumbent]]) {
        for (const args of [["help", tombstone.verb], ...["help", "-h", "--help"].map(flag => [tombstone.verb, flag])]) {
          const result = run(bin!, [entry!, ...args], worktree, env, 10000);
          expect(result.status).toBe(0);
          expect(result.stdout).toBe(tombstone.help);
          expect(result.stderr).toBe("");
        }
      }
    }, 120000);
  }

  test("retired peek reaches its native owner through every entry", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;
    env.TAP_HOME = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {}).bus;
    expect(existsSync(join(root, "skills/tap/scripts/tap-peek.sh"))).toBe(false);
    const entries = [["bun", candidate], ["bash", shippedEntry], ["bash", join(root, "scripts/tap.sh")]];
    for (const [bin, entry] of entries) {
      const r = run(bin!, [entry!, "peek", "--json"], worktree, env, 10000);
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).error_class).toBe("usage_error");
    }
    expect(readFileSync(trace, "utf8")).toBe("native peek\n".repeat(entries.length));
  });

  test("retired worktree reaches the native engine through both entry points", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;

    // Bare `worktree` is a safe dual-door probe: both entry points must answer
    // the same usage refusal before any git effect, and both must dispatch
    // natively.
    const expected = run("bash", [incumbent, "worktree"], worktree, env);
    const actual = run("bun", [candidate, "worktree"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.status).toBe(1);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(readFileSync(trace, "utf8")).toBe("native worktree\nnative worktree\n");
  });

  test("retired attach reaches the native engine through both entry points", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    // The not_found probe needs the local team in the retired bus-side registry.
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "routerteam" }, seats: {} }));
    env.TAP_HOME = bus;

    // Bare unknown handle: both doors must answer the same not_found refusal
    // before any pane effect, and both must dispatch natively.
    const expected = run("bash", [incumbent, "attach", "ghost"], worktree, env);
    const actual = run("bun", [candidate, "attach", "ghost"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.status).toBe(1);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(actual.stderr).toContain("no seat 'ghost' on team 'routerteam'");
    expect(readFileSync(trace, "utf8")).toBe("native attach\nnative attach\n");
  });

  test("retired crew reaches the native engine through both entry points", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    env.TAP_HOME = bus;

    // Bare `crew list` on an empty crew roster: both doors must answer the
    // same empty-list success and both must dispatch natively.
    const expected = run("bash", [incumbent, "crew", "list"], worktree, env);
    const actual = run("bun", [candidate, "crew", "list"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.status).toBe(0);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(readFileSync(trace, "utf8")).toBe("native crew\nnative crew\n");
  });

  test("retired cancel reaches the native engine through both entry points", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    // An invalid id is the safe dual-door probe: both entry points must answer
    // the same usage refusal before any lock or bus effect, and both must
    // dispatch natively.
    const expected = run("bash", [incumbent, "cancel", "bad id"], worktree, env);
    const actual = run("bun", [candidate, "cancel", "bad id"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.status).toBe(1);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(actual.stderr).toContain("invalid id 'bad id'");
    expect(readFileSync(trace, "utf8")).toBe("native cancel\nnative cancel\n");
  });
  test("teamstop cutover: down and shutdown route native through both entry points", () => {
    const { dir, env, worktree } = fixture();
    // An empty bus exercises the zero-row arm: no tmux effects, both doors
    // answer identically, and neither form reaches a Bash stop engine (the
    // Bash engine is deleted; tap-team.sh keeps only the exec bridge).
    env.TAP_HOME = join(dir, "bus");
    mkdirSync(env.TAP_HOME, { recursive: true });

    for (const verb of ["down", "shutdown"]) {
      const expected = run("bash", [incumbent, "team", verb], worktree, env);
      const trace = join(dir, `trace-${verb}`);
      const actual = run("bun", [candidate, "team", verb], worktree, { ...env, TAP_BUN_ROUTE_TRACE: trace });
      expect(actual.status).toBe(0);
      expect(actual.status).toBe(expected.status);
      expect(actual.stdout).toBe(expected.stdout);
      expect(actual.stderr).toBe(expected.stderr);
      expect(actual.stderr).not.toContain("slice_failed");
      expect(readFileSync(trace, "utf8")).toBe("native team\n");
    }
  });

  test("team reset and restore recover a missing acting file", () => {
    const { dir, env, worktree } = fixture();
    const { bus, registry } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      poller: { delivery: "poll", status: "active", pane_id: "%7", pane: "stale" },
    });
    Object.assign(env, { TAP_HOME: bus, TAP_SCRATCH_ONLY: dir, TAP_BOOT_ID: "boot:100" });
    writeFileSync(join(bus, "payloads", "kept.md"), "durable payload");
    const invoke = (verb: string, args: string[] = []) => run("bash", [shippedEntry, "team", verb, "--json", ...args], worktree, env, 15000);
    const first = invoke("reset");
    expect(first.status).toBe(0);
    const receipt = JSON.parse(first.stdout);
    unlinkSync(registry);
    writeFileSync(join(bus, "reset.fence.json"), JSON.stringify({ pid: 2147483647, owner_start: "1", boot_id: "boot:100",
      token: "dead", bundle_id: receipt.bundle_id, op: "team-reset", phase: "cutting" }));
    const resumed = invoke("reset");
    if (resumed.status !== 0) throw new Error(`reset recovery: ${resumed.stdout}\n${resumed.stderr}`);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout).status).toBe("cut_resumed");
    const restored = invoke("restore", ["--archive", receipt.bundle_id]);
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout).restored_agents).toBe(1);
    expect(JSON.parse(readFileSync(registry, "utf8")).seats.poller).toEqual({
      delivery: "poll", status: "suspended", status_reason: "restored_from_archive",
    });
    expect(readFileSync(join(bus, "payloads", "kept.md"), "utf8")).toBe("durable payload");
    expect(readdirSync(join(bus, "archive", "team-reset"))).toHaveLength(1);
  });

  test("team restore consumes an archive operand named like a sibling command", () => {
    const { dir, env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    const trace = join(dir, "reset-route.trace");
    Object.assign(env, { TAP_HOME: bus, TAP_BUN_ROUTE_TRACE: trace });
    const result = run("bun", [candidate, "team", "restore", "--archive", "up", "--json"], worktree, env);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error_class).toBe("archive_not_found");
    expect(readFileSync(trace, "utf8")).toBe("native team\n");
  });

  test("closed team and per-handle recovery routes use native engines", () => {
    const { dir, env, worktree } = fixture();
    const { bus, registry } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      poller: { instance: "same-instance", delivery: "poll", status: "suspended" },
    });
    const trace = join(dir, "closed-team.trace");
    Object.assign(env, { TAP_HOME: bus, TAP_BUN_ROUTE_TRACE: trace });
    const invoke = (args: string[]) => run("bash", [shippedEntry, ...args], worktree, env, 15000);
    for (const args of [["team", "--json"], ["team", "detach"], ["team", "up", "--only"], ["team", "list", "routerteam", "--json"]]) {
      writeFileSync(trace, ""); const result = invoke(args);
      expect(result.status).toBe(args.includes("up") ? 1 : 0);
      expect(readFileSync(trace, "utf8")).toContain("native team\n");
      expect(readFileSync(trace, "utf8")).not.toContain("bash team\n");
    }
    const torn = invoke(["teardown", "poller", "--yes", "--json"]);
    if (torn.status !== 0) throw new Error(torn.stdout + torn.stderr);
    const archive = JSON.parse(torn.stdout).archive;
    expect(JSON.parse(readFileSync(registry, "utf8")).seats).toEqual({});
    const restored = invoke(["restore", "poller", "--archive", archive, "--json"]);
    expect(restored.status).toBe(0);
    expect(JSON.parse(readFileSync(registry, "utf8")).seats.poller.instance).toBe("same-instance");
    expect(readFileSync(trace, "utf8")).toContain("native teardown\n");
    expect(readFileSync(trace, "utf8")).toContain("native restore\n");
  });

  test("team restore renders malformed checkpoint JSON as a refusal", () => {
    const { dir, env, worktree } = fixture();
    const { bus, registry } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    Object.assign(env, { TAP_HOME: bus, TAP_SCRATCH_ONLY: dir, TAP_BOOT_ID: "boot:100" });
    const reset = run("bash", [shippedEntry, "team", "reset", "--json"], worktree, env, 15000);
    expect(reset.status).toBe(0);
    const { archive, bundle_id } = JSON.parse(reset.stdout);
    const before = readFileSync(registry, "utf8");
    for (const [name, bytes, errorClass] of [
      ["meta.json", "{broken", "archive_invalid"], ["meta.json", "[]", "archive_invalid"],
      ["inventory.json", "{broken", "inventory_mismatch"], ["inventory.json", "null", "inventory_mismatch"],
    ]) {
      const path = join(archive, name!), saved = readFileSync(path, "utf8");
      try {
        writeFileSync(path, bytes!);
        const result = run("bash", [shippedEntry, "team", "restore", "--archive", bundle_id, "--json"], worktree, env, 15000);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error_class: errorClass });
        expect(result.stderr).toBe("");
        expect(existsSync(join(bus, "reset.fence.json"))).toBe(false);
        expect(readFileSync(registry, "utf8")).toBe(before);
      } finally { writeFileSync(path, saved); }
    }
  });

  test("teamstop door parity: a fenced mid-reset bus refuses identically through both entry points", () => {
    const { dir, env, worktree } = fixture();
    // A reset fence refuses `team down --json` identically through BOTH doors:
    // runTeamStopDoor sets TAP_JSON from the argv flag itself (team.ts), so the
    // refusal renders as JSON on stdout, not incumbent text on stderr — stderr
    // is empty on both sides.
    const bus = join(dir, "bus");
    mkdirSync(bus, { recursive: true });
    writeLiveFence(join(bus, "reset.fence.json"));
    env.TAP_HOME = bus;

    const expected = run("bash", [incumbent, "team", "down", "--json"], worktree, env);
    const actual = run("bun", [candidate, "team", "down", "--json"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.status).toBe(1);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(actual.stderr).toBe("");
    const body = JSON.parse(actual.stdout) as { ok: boolean; error_class: string; action: string; detail: string };
    expect(body).toMatchObject({ ok: false, error_class: "team_reset_fenced" });
    expect(body.detail).toContain("refusing tap team down — team bus is mid-reset (fence at ");
    expect(body.action).toContain("wait for the reset owner (or until identity is readable), then: tap team reset");
  });

  test("retired done under a live marker and a calling pane resolves no actor and writes no audit row", () => {
    const { dir, env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", pane: "alive:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rcv|current" },
    });
    // Live flip: enrollment lives in the global registry; the acting registry is
    // the enrolled team-registry.json, not a guessed bus-side file.
    writeFileSync(join(env.TAP_INDEX_HOME!, "global-registry.json"), `${JSON.stringify({
      schema: "0.20",
      teams: { routerteam: { root: worktree, registry_location: join(worktree, ".tap", "team-registry.json"), state: "registered" } },
    })}\n`);
    env.TAP_HOME = bus;
    const paneEnv = withFakeCallingPane(dir, env);
    const id = "snd-20260919T010000Z-bbbbbbbbbbbb";
    seedPayload(bus, id);

    const actual = run("bun", [candidate, "done", id], worktree, paneEnv);

    expect(actual.status).toBe(1);
    expect(actual.stderr).toContain("tap done is retired");
    expect(actual.stderr).toContain("tap reply <id> --by <you> -f <file>");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(join(bus, "receipts", "done-alias-hits.jsonl"))).toBe(false);
  });

  test("retired done audits neither an enrolled cwd bus nor a caller-pinned acting bus", () => {
    // Two enrollments under a live marker: cwd is team-a's worktree, TAP_HOME
    // pins team-b's ACTING bus. Actor and instance must come from the PIN.
    const { dir, env, worktree } = fixture();
    const { bus: busA } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", pane: "alive:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rcv|inA" },
    });
    enrollTeam(env.TAP_INDEX_HOME!, "teamb", join(dir, "worktree-b"), {
      sid: { status: "active", pane: "alive:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "sid|current" },
    });
    const busB = join(dir, "worktree-b", ".tap", "bus");
    env.TAP_HOME = busB;
    const paneEnv = withFakeCallingPane(dir, env);
    const id = "snd-20260919T020000Z-cccccccccccc";
    seedPayload(busB, id, undefined, { to: "sid" });

    const actual = run("bun", [candidate, "done", id], worktree, paneEnv);

    expect(actual.status).toBe(1);
    expect(actual.stderr).toContain("tap done is retired");
    expect(actual.stderr).toContain("tap reply <id> --by <you> -f <file>");
    expect(existsSync(join(busA, "receipts", "done-alias-hits.jsonl"))).toBe(false);
    expect(existsSync(join(busB, "receipts", "done-alias-hits.jsonl"))).toBe(false);
  });

  // Renamed with read's closure: there is no Bash engine for `read` to fall
  // back to, and both public entries exec main. The byte-equality assertions
  // still earn their keep — they prove tap.sh's arm reaches the SAME engine
  // with the same argv, so the entry cannot drift from the router.
  test("both public read entries reach the native engine", () => {
    const { dir, env, worktree } = fixture();
    const trace = join(dir, "trace");
    env.TAP_BUN_ROUTE_TRACE = trace;

    const argv = ["read", "msg-1", "--team", "spec"];
    const expected = run("bash", [incumbent, ...argv], worktree, env);
    const actual = run("bun", [candidate, ...argv], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    // Two traces: the reference entry (tap.sh) now reaches main too. A single
    // line here would mean one of the two public entries never ran.
    expect(readFileSync(trace, "utf8")).toBe("native read\nnative read\n");
  });

  test("poll shows current and unbound mail but hides predecessor-bound mail", () => {
    const { env, worktree } = fixture();
    const { bus, registry } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    const current = "snd-20260825T100000Z-aaaaaaaaaaaa";
    const predecessor = "snd-20260825T100000Z-bbbbbbbbbbbb";
    const unbound = "snd-20260825T100000Z-cccccccccccc";
    seedPayload(bus, current, "rcv|current");
    seedPayload(bus, predecessor, "rcv|predecessor");
    seedPayload(bus, unbound);

    const first = run("bun", [candidate, "poll", "rcv"], worktree, env);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(current);
    expect(first.stdout).not.toContain(predecessor);
    expect(first.stdout).toContain(unbound);

    writeFileSync(registry, JSON.stringify({
      schema: "0.20", team: { name: "routerteam", worktree_root: worktree },
      seats: { rcv: { status: "active" } },
    }));
    const instanceLess = run("bun", [candidate, "poll", "rcv"], worktree, env);
    expect(instanceLess.status).toBe(0);
    expect(instanceLess.stdout).not.toContain(current);
    expect(instanceLess.stdout).not.toContain(predecessor);
    expect(instanceLess.stdout).toContain(unbound);
  });

  test("native pre-dispatch matches Bash for aged inbound and does not repeat after fallback", () => {
    const { dir, env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", delivery: "poll", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    env.TAP_SELF = "rcv";
    env.TAP_SPOOL_NOW = "1789722000";
    env.TAP_INTERNAL_OVERDUE_CHECKED = "1"; // public entry must distrust caller state
    writeFileSync(join(dir, "bin", "date"), `#!/bin/sh
if [ "\${1-}" = +%s ]; then printf '1789722000\\n'; else exec /bin/date "$@"; fi
`, { mode: 0o755 });
    seedPayload(bus, "snd-20260918T070000Z-aaaaaaaaaaaa", "rcv|current");
    seedPayload(bus, "snd-20260918T060000Z-bbbbbbbbbbbb", "rcv|predecessor");
    const future = "snd-20260918T090100Z-cccccccccccc";
    seedPayload(bus, future, "rcv|current");

    // The verb closed on native Bun: the advisory fires exactly once per process.
    const actual = run(shippedEntry, ["outstanding", "--team", "routerteam"], worktree, env);
    const warning =
      `tap: warning: payload id '${future}' is future-stamped (60s ahead of now); treating age as 0\n` +
      "tap: warning: rcv has 1 unsettled inbound aged >=3600s (oldest 7200s); run 'tap poll rcv'\n";

    expect(actual.status).toBe(0);
    expect(actual.stdout).toBe("tap outstanding: no outstanding sends for rcv\n");
    expect(actual.stderr).toBe(warning);
  });

  test("poll accepts an explicit bus without an acting registry", () => {
    const { dir, env, worktree } = fixture();
    const bus = join(dir, "pollbus");
    mkdirSync(bus, { recursive: true });
    env.TAP_HOME = bus;
    env.TAP_SELF = "seat";

    const expected = run("bash", [incumbent, "poll", "seat"], worktree, env);
    const actual = run("bun", [candidate, "poll", "seat"], worktree, env);

    expect(actual.status).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(actual.stdout).toBe("tap poll: empty\n");
  });

  test("poll rejects a second positional before inspecting either inbox", () => {
    const shapes: Array<{ args: string[]; inheritedSelf?: string }> = [
      { args: ["alice", "bob"] },
      { args: ["--quiet", "alice", "bob"] },
      { args: ["alice", "--quiet", "bob"] },
      { args: ["", "bob"] },
      { args: ["bob", ""] },
      { args: ["alice", "bob"], inheritedSelf: "self" },
      { args: ["alice", "--quiet", "bob"], inheritedSelf: "self" },
    ];
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    env.TAP_HOME = bus;
    const alice = "snd-20260827T030000Z-aaaaaaaaaaaa";
    const bob = "snd-20260827T030001Z-bbbbbbbbbbbb";
    seedPayload(bus, alice, undefined, { to: "alice" });
    seedPayload(bus, bob, undefined, { to: "bob" });

    for (const { args, inheritedSelf } of shapes) {
      const caseEnv = { ...env, ...(inheritedSelf ? { TAP_SELF: inheritedSelf } : {}) };
      const actual = run(shippedEntry, ["poll", ...args], worktree, caseEnv);

      expect(actual.stdout).toBe("");
      expect(actual.stderr).toBe("tap poll: usage: tap poll [me] [--json] [--quiet] [--team <name>]; next: tap help poll\n");
      expect(actual.status).toBe(1);
    }
  }, 30_000);

  test("poll refuses a cwd-derived bus without a registry before creating it", () => {
    const { env, worktree } = fixture();
    const bus = join(worktree, ".tap", "bus");
    env.TAP_SELF = "seat";

    const actual = run("bun", [candidate, "poll", "seat"], worktree, env);

    expect(actual.status).toBe(4);
    expect(actual.stderr).toContain("Start one: tap session launch <harness|preset> <name>");
    expect(existsSync(bus)).toBe(false);
  });

  test("malformed value options stay Bash-owned before any settlement effect", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    env.TAP_SELF = "rcv";
    const id = "snd-20260827T010000Z-aaaaaaaaaaaa";
    seedPayload(bus, id);

    const expectedDone = run("bash", [incumbent, "done", id, "--by"], worktree, env);
    const actualDone = run("bun", [candidate, "done", id, "--by"], worktree, env);
    expect(actualDone.status).toBe(1);
    expect(actualDone.status).toBe(expectedDone.status);
    expect(actualDone.stdout).toBe(expectedDone.stdout);
    expect(actualDone.stderr).toBe(expectedDone.stderr);
    expect(actualDone.stderr).toContain("tap done is retired");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(join(bus, "receipts", "done-alias-hits.jsonl"))).toBe(false);

    const expectedWho = run("bash", [incumbent, "whoami", "--pane"], worktree, env);
    const actualWho = run("bun", [candidate, "whoami", "--pane"], worktree, env);
    expect(actualWho.status).toBe(expectedWho.status);
    expect(actualWho.stdout).toBe(expectedWho.stdout);
    expect(actualWho.stderr).toBe(expectedWho.stderr);
  }, 15_000);

  test("poll and done refuse a live reset fence before bus effects", () => {
    const pollFixture = fixture();
    const pollBus = join(pollFixture.dir, "fenced-poll-bus");
    mkdirSync(pollBus);
    writeLiveFence(join(pollBus, "reset.fence.json"));
    pollFixture.env.TAP_HOME = pollBus;
    pollFixture.env.TAP_SELF = "rcv";
    const polled = run("bun", [candidate, "poll", "rcv"], pollFixture.worktree, pollFixture.env);
    expect(polled.status).toBe(1);
    expect(polled.stderr).toContain("mid-reset");
    expect(existsSync(join(pollBus, "payloads"))).toBe(false);
    expect(existsSync(join(pollBus, "receipts"))).toBe(false);

    const doneFixture = fixture();
    const { bus } = seedLiveTeam(doneFixture.worktree, doneFixture.env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    doneFixture.env.TAP_HOME = bus;
    const id = "snd-20260827T010100Z-bbbbbbbbbbbb";
    seedPayload(bus, id);
    writeLiveFence(join(bus, "reset.fence.json"));
    const settled = run("bun", [nativeDoneCandidate, id, "--by", "rcv"], doneFixture.worktree, doneFixture.env);
    expect(settled.status).toBe(1);
    expect(settled.stderr).toContain("mid-reset");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done refuses a live reset fence before bootstrapping the bus", () => {
    // Causal for ordering, not just presence: a fence-only TAP_HOME has no
    // payloads/ or receipts/. If assertResetUnfenced moves after ensureDirs,
    // those dirs appear. If it is deleted, bash-vs-native stderr diverges and
    // (on a seeded bus) a .done can land. Unreadable fence `{}` is LIVE, so
    // the next-step is the wait text — the same pin reset-fence-action-text
    // owns for poll, now on tap done via native-done-entry (shipped done
    // stays Bash-owned; this file pins done's fence without flipping it).
    const doneFixture = fixture();
    const doneBus = join(doneFixture.dir, "fenced-done-bus");
    mkdirSync(doneBus);
    const fence = join(doneBus, "reset.fence.json");
    writeLiveFence(fence);
    doneFixture.env.TAP_HOME = doneBus;
    const id = "snd-20260830T000000Z-aaaaaaaaaaaa";
    const native = run("bun", [nativeDoneCandidate, id, "--by", "rcv"], doneFixture.worktree, doneFixture.env);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain("refusing tap done — team bus is mid-reset");
    expect(native.stderr).toContain(`fence at ${realpathSync(fence)}`);
    expect(native.stderr).toContain(
      "wait for the reset owner (or until identity is readable), then: tap team reset",
    );
    expect(existsSync(join(doneBus, "payloads"))).toBe(false);
    expect(existsSync(join(doneBus, "receipts"))).toBe(false);
    expect(native.stdout).toBe("");
  });

  test("native done resolves a unique cross-worktree id onto the sender bus", () => {
    const { dir, env, worktree } = fixture();
    const alpha = enrollTeam(env.TAP_INDEX_HOME!, "alpha", join(dir, "alpha"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {
      fable: { status: "active", delivery: "poll" },
    });
    const id = "fable-20260830T000000Z-bbbbbbbbbbbb";
    seedPayload(beta.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "beta", to_team: "alpha",
      reply: "settle-only", cross_worktree: "true",
    });
    env.TAP_HOME = alpha.bus;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env);
    expect(native.status).toBe(0);
    expect(native.stdout).toContain(`settled ${id}`);
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(true);
    expect(existsSync(join(alpha.bus, "receipts", `${id}.done`))).toBe(false);
    expect(JSON.parse(readFileSync(join(beta.bus, "receipts", `${id}.done`), "utf8")).by).toBe("worker");
  });

  test("native done ignores a non-file local shadow and settles the unique foreign canonical", () => {
    const { dir, env, worktree } = fixture();
    const alpha = enrollTeam(env.TAP_INDEX_HOME!, "alpha", join(dir, "alpha"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {
      fable: { status: "active", delivery: "poll" },
    });
    const id = "fable-20260830T000003Z-eeeeeeeeeeee";
    seedPayload(beta.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "beta", to_team: "alpha",
      reply: "settle-only", cross_worktree: "true",
    });
    mkdirSync(join(alpha.bus, "payloads", `${id}.md`));
    env.TAP_HOME = alpha.bus;

    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env);
    expect(native.status).toBe(0);
    expect(native.stdout).toContain(`settled ${id}`);
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(true);
    expect(existsSync(join(alpha.bus, "receipts", `${id}.done`))).toBe(false);
    const receipt = JSON.parse(readFileSync(join(beta.bus, "receipts", `${id}.done`), "utf8"));
    expect(receipt.by).toBe("worker");
    expect(receipt.status).toBe("done");
  });

  test("native done refuses an ambiguous cross-worktree id without writing a receipt", () => {
    const { dir, env, worktree } = fixture();
    const alpha = enrollTeam(env.TAP_INDEX_HOME!, "alpha", join(dir, "alpha"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {});
    const gamma = enrollTeam(env.TAP_INDEX_HOME!, "gamma", join(dir, "gamma"), {});
    const id = "fable-20260830T000001Z-cccccccccccccccc";
    const fields = {
      to: "worker", from: "fable", from_team: "beta", to_team: "alpha",
      reply: "settle-only", cross_worktree: "true",
    };
    seedPayload(beta.bus, id, undefined, fields);
    seedPayload(gamma.bus, id, undefined, { ...fields, from_team: "gamma" });
    env.TAP_HOME = alpha.bus;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("more than one enrolled team bus");
    expect(existsSync(join(alpha.bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(join(gamma.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done names enrolled buses when a bare id hits none of them", () => {
    const { dir, env, worktree } = fixture();
    const alpha = enrollTeam(env.TAP_INDEX_HOME!, "alpha", join(dir, "alpha"), {
      worker: { status: "active", instance: "worker|current" },
    });
    enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {});
    env.TAP_HOME = alpha.bus;
    const id = "fable-20260830T000002Z-dddddddddddd";
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("no payload 'fable-20260830T000002Z-dddddddddddd' on the local bus or any enrolled team bus");
    expect(existsSync(join(alpha.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done refuses a present --by with no value before TAP_SELF fallback", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    env.TAP_SELF = "rcv";
    const id = "snd-20260830T030000Z-byvalueaaaaaa";
    seedPayload(bus, id);
    const native = run("bun", [nativeDoneCandidate, id, "--by"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("--by needs a value");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done prefers explicit --by over a conflicting TAP_SELF", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
      eve: { status: "active", instance: "eve|current" },
    });
    env.TAP_HOME = bus;
    env.TAP_SELF = "eve";
    const id = "snd-20260830T030001Z-bywinsbbbbbb";
    seedPayload(bus, id);
    const native = run("bun", [nativeDoneCandidate, id, "--by", "rcv"], worktree, env);
    expect(native.status).toBe(0);
    const receipt = JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8"));
    expect(receipt.by).toBe("rcv");
    expect(receipt.id).toBe(id);
    expect(receipt.status).toBe("done");
    expect(receipt.via).toBe("done");
    expect(receipt.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(receipt).not.toHaveProperty("epoch");
  });

  test("native done derives a bare command from TAP_SELF when --by is absent", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    env.TAP_SELF = "rcv";
    const id = "snd-20260830T030002Z-selfwinscccc";
    seedPayload(bus, id);
    const native = run("bun", [nativeDoneCandidate, id], worktree, env);
    expect(native.status).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8")).by).toBe("rcv");
  });

  test("native done refuses when neither --by nor TAP_SELF is set", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    delete env.TAP_SELF;
    const id = "snd-20260830T030003Z-nopanederive";
    seedPayload(bus, id);
    const native = run("bun", [nativeDoneCandidate, id], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("only the addressee settles");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done refuses a wrong actor and a replay without a second receipt", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
      eve: { status: "active", instance: "eve|current" },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030004Z-wrongactorrr";
    seedPayload(bus, id);
    const wrong = run("bun", [nativeDoneCandidate, id, "--by", "eve"], worktree, env);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("addressed to 'rcv', not 'eve'");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);

    const first = run("bun", [nativeDoneCandidate, id, "--by", "rcv"], worktree, env);
    expect(first.status).toBe(0);
    const donePath = join(bus, "receipts", `${id}.done`);
    const firstBytes = readFileSync(donePath, "utf8");
    const replay = run("bun", [nativeDoneCandidate, id, "--by", "rcv"], worktree, env);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain("already settled");
    expect(readFileSync(donePath, "utf8")).toBe(firstBytes);
  });

  test("native done refuses predecessor-bound mail at a fresh current instance", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030005Z-predinstance";
    seedPayload(bus, id, "rcv|predecessor");
    const native = run("bun", [nativeDoneCandidate, id, "--by", "rcv"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain("predecessor-bound mail");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done refuses a released fork handle and names the successor", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
        adopted_instances: { "alice-2": "alice-2|FORK999" },
      },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030006Z-forkadopted";
    seedPayload(bus, id, undefined, { to: "alice", to_adopted_from: "alice-2" });
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice-2"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("no longer a settler");
    expect(native.stderr).toContain("settle as the successor: tap done");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done records adopted_from when the live successor settles rewritten mail", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
        adopted_instances: { "alice-2": "alice-2|FORK999" },
      },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030007Z-succsettleee";
    seedPayload(bus, id, undefined, { to: "alice", to_adopted_from: "alice-2" });
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice"], worktree, env);
    expect(native.status).toBe(0);
    const receipt = JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8"));
    expect(receipt.by).toBe("alice");
    expect(receipt.adopted_from).toBe("alice-2");
    expect(receipt.via).toBe("done");
  });

  test("native done lets a successor settle grant-path foreign mail as the live actor", () => {
    const { dir, env, worktree } = fixture();
    const succ = enrollTeam(env.TAP_INDEX_HOME!, "succ", join(dir, "succ"), {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
        adopted_instances: { "alice-2": "alice-2|FORK999" },
      },
    });
    const sender = enrollTeam(env.TAP_INDEX_HOME!, "sender", join(dir, "sender"), {
      bob: { status: "active", delivery: "poll" },
    });
    const id = "bob-20260830T030008Z-grantokpath";
    seedPayload(sender.bus, id, "alice-2|FORK999", {
      to: "alice-2", from: "bob", from_team: "sender", to_team: "succ",
      reply: "settle-only", cross_worktree: "true",
    });
    env.TAP_HOME = succ.bus;
    const payload = join(sender.bus, "payloads", `${id}.md`);
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice", "--payload", payload], worktree, env);
    expect(native.status).toBe(0);
    const receipt = JSON.parse(readFileSync(join(sender.bus, "receipts", `${id}.done`), "utf8"));
    expect(receipt.by).toBe("alice");
    expect(receipt.adopted_from).toBe("alice-2");
    expect(existsSync(join(succ.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done refuses a grant when the stamp is the successor's current instance", () => {
    const { dir, env, worktree } = fixture();
    const succ = enrollTeam(env.TAP_INDEX_HOME!, "succ", join(dir, "succ"), {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
        adopted_instances: { "alice-2": "alice-2|FORK999" },
      },
    });
    const sender = enrollTeam(env.TAP_INDEX_HOME!, "sender", join(dir, "sender"), {
      bob: { status: "active", delivery: "poll" },
    });
    const id = "bob-20260830T030009Z-grantbadinst";
    seedPayload(sender.bus, id, "alice|SUCC001", {
      to: "alice-2", from: "bob", from_team: "sender", to_team: "succ",
      reply: "settle-only", cross_worktree: "true",
    });
    env.TAP_HOME = succ.bus;
    const payload = join(sender.bus, "payloads", `${id}.md`);
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice", "--payload", payload], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("bound to recipient instance");
    expect(native.stderr).toContain("not the adopted 'alice-2' instance 'alice-2|FORK999'");
    expect(existsSync(join(sender.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done derives a bare command from a registered calling pane", () => {
    const { dir, env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: {
        status: "active",
        instance: "rcv|current",
        pane: "alive:0.0",
        pane_id: "%7",
        server_epoch: "srv:123:456",
      },
    });
    const paneEnv = withFakeCallingPane(dir, env);
    paneEnv.TAP_HOME = bus;
    const id = "snd-20260830T030011Z-panederiveok";
    seedPayload(bus, id);
    const native = run("bun", [nativeDoneCandidate, id], worktree, paneEnv);
    expect(native.status).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8")).by).toBe("rcv");
  });

  test("native done treats a null-status fork row as adopted-away, not live", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
        adopted_instances: { "alice-2": "alice-2|FORK999" },
      },
      "alice-2": { status: null, instance: "alice-2|NULLSTAT" },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030012Z-nullstatusfk";
    seedPayload(bus, id, undefined, { to: "alice", to_adopted_from: "alice-2" });
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice-2"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("no longer a settler");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done treats a non-record fork row as adopted-away", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
      },
      "alice-2": [],
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030013Z-arrayrowfork";
    seedPayload(bus, id, undefined, { to: "alice", to_adopted_from: "alice-2" });
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice-2"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("no longer a settler");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done still treats a missing-status fork row as live", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
        adopted_instances: { "alice-2": "alice-2|FORK999" },
      },
      "alice-2": { instance: "alice-2|FRESH222" },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030014Z-missstatusok";
    seedPayload(bus, id, "alice-2|FRESH222", { to: "alice-2" });
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice-2"], worktree, env);
    expect(native.status).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8")).by).toBe("alice-2");
  });

  test("native done does not treat a live re-registered fork as adopted-away", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      alice: {
        status: "active",
        instance: "alice|SUCC001",
        adopted_handles: ["alice-2"],
        adopted_instances: { "alice-2": "alice-2|FORK999" },
      },
      "alice-2": { status: "active", instance: "alice-2|FRESH222" },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T030010Z-liveforkownn";
    seedPayload(bus, id, "alice-2|FRESH222", { to: "alice-2" });
    const native = run("bun", [nativeDoneCandidate, id, "--by", "alice-2"], worktree, env);
    expect(native.status).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8")).by).toBe("alice-2");
  });

  test("native done marks a pristine reset generation reused", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260827T010200Z-cccccccccccc";
    seedPayload(bus, id);
    const generation = join(bus, "reset-generation.json");
    writeFileSync(generation, JSON.stringify({ bundle_id: "bundle", state: "pristine" }));

    const result = run("bun", [nativeDoneCandidate, id, "--by", "rcv"], worktree, env);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(generation, "utf8"))).toEqual({
      bundle_id: "bundle",
      state: "reused",
      first_mutation: "done",
    });
  });

  test("native done writes --epoch on the receipt and prefers it over TAP_EPOCH", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    const ambient = "snd-20260830T040000Z-epochambient";
    seedPayload(bus, ambient);
    env.TAP_EPOCH = "17";
    const fromEnv = run("bun", [nativeDoneCandidate, ambient, "--by", "rcv"], worktree, env);
    expect(fromEnv.status).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "receipts", `${ambient}.done`), "utf8")).epoch).toBe("17");

    const override = "snd-20260830T040001Z-epochoverride";
    seedPayload(bus, override);
    const fromFlag = run("bun", [nativeDoneCandidate, override, "--by", "rcv", "--epoch", "99"], worktree, env);
    expect(fromFlag.status).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "receipts", `${override}.done`), "utf8")).epoch).toBe("99");

    delete env.TAP_EPOCH;
    const omitted = "snd-20260830T040002Z-epochomitted";
    seedPayload(bus, omitted);
    const noEpoch = run("bun", [nativeDoneCandidate, omitted, "--by", "rcv"], worktree, env);
    expect(noEpoch.status).toBe(0);
    expect(JSON.parse(readFileSync(join(bus, "receipts", `${omitted}.done`), "utf8"))).not.toHaveProperty("epoch");
  });

  test("native done serializes an arbitrary --epoch value as a JSON string field", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    const id = "snd-20260830T040003Z-epochquotesqq";
    seedPayload(bus, id);
    const value = 'say "hi" and \\slash';
    const native = run("bun", [nativeDoneCandidate, id, "--by", "rcv", "--epoch", value], worktree, env);
    expect(native.status).toBe(0);
    const raw = readFileSync(join(bus, "receipts", `${id}.done`), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.epoch).toBe(value);
    expect(raw.startsWith("{")).toBe(true);
  });

  test("native done --team anchors the bus when TAP_HOME is unset", () => {
    const { dir, env, worktree } = fixture();
    const alpha = enrollTeam(env.TAP_INDEX_HOME!, "alpha", join(dir, "alpha"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const id = "fable-20260830T040004Z-teamanchor01";
    seedPayload(alpha.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "alpha", to_team: "alpha", reply: "settle-only",
    });
    seedPayload(beta.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "beta", to_team: "beta", reply: "settle-only",
    });
    delete env.TAP_HOME;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--team", "beta"], worktree, env);
    expect(native.status).toBe(0);
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(true);
    expect(existsSync(join(alpha.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done --team is a no-op when TAP_HOME is already env", () => {
    const { dir, env, worktree } = fixture();
    const alpha = enrollTeam(env.TAP_INDEX_HOME!, "alpha", join(dir, "alpha"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const id = "fable-20260830T040005Z-teamenviro01";
    seedPayload(alpha.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "alpha", to_team: "alpha", reply: "settle-only",
    });
    seedPayload(beta.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "beta", to_team: "beta", reply: "settle-only",
    });
    env.TAP_HOME = alpha.bus;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--team", "beta"], worktree, env);
    expect(native.status).toBe(0);
    expect(existsSync(join(alpha.bus, "receipts", `${id}.done`))).toBe(true);
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done --team refuses an invalid flip marker without reading teams.json", () => {
    const { dir, env, worktree } = fixture();
    const legacy = seedLegacyEnrolledTeam(env.TAP_INDEX_HOME!, "legacyteam", join(dir, "legacy"), {
      worker: { status: "active", instance: "worker|current" },
    });
    writeFileSync(join(env.TAP_INDEX_HOME!, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: [] }));
    const id = "fable-20260830T040009Z-teaminvalid1";
    seedPayload(legacy.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "legacyteam", to_team: "legacyteam", reply: "settle-only",
    });
    delete env.TAP_HOME;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--team", "legacyteam"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain("present but invalid");
    expect(existsSync(join(legacy.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done --team refuses when the live acting registry is missing", () => {
    const { dir, env, worktree } = fixture();
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const id = "fable-20260830T040010Z-teamnoreg01";
    seedPayload(beta.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "beta", to_team: "beta", reply: "settle-only",
    });
    unlinkSync(beta.registry);
    delete env.TAP_HOME;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--team", "beta"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain("acting registry for team 'beta' is unreachable");
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(beta.registry)).toBe(false);
  });

  test("native done --team ignores a teams.json-only root and never creates it", () => {
    const { dir, env, worktree } = fixture();
    const vanished = join(dir, "vanished-root");
    writeFileSync(join(env.TAP_INDEX_HOME!, "teams.json"), JSON.stringify({
      teams: { ghost: { root: vanished } },
    }));
    delete env.TAP_HOME;
    const native = run("bun", [nativeDoneCandidate, "fable-20260830T040012Z-teamstale01", "--by", "worker", "--team", "ghost"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain("is not enrolled in the machine index");
    expect(existsSync(vanished)).toBe(false);
  });

  test("native done --team refuses a historical live enrollment without writing a receipt", () => {
    const { dir, env, worktree } = fixture();
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", join(dir, "beta"), {
      worker: { status: "active", instance: "worker|current" },
    });
    const gPath = join(env.TAP_INDEX_HOME!, "global-registry.json");
    const doc = JSON.parse(readFileSync(gPath, "utf8")) as { teams: Record<string, { state?: string }> };
    doc.teams.beta!.state = "historical";
    writeFileSync(gPath, JSON.stringify(doc));
    const id = "fable-20260830T040013Z-teamhist0001";
    seedPayload(beta.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "beta", to_team: "beta", reply: "settle-only",
    });
    delete env.TAP_HOME;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--team", "beta"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("acting registry for team 'beta' is unreachable");
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done --team refuses a registered vanished root without recreating the bus", () => {
    const { dir, env, worktree } = fixture();
    const betaRoot = join(dir, "beta");
    enrollTeam(env.TAP_INDEX_HOME!, "beta", betaRoot, {
      worker: { status: "active", instance: "worker|current" },
    });
    rmSync(betaRoot, { recursive: true, force: true });
    delete env.TAP_HOME;
    const id = "fable-20260830T040016Z-teamvanish1";
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--team", "beta"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("acting registry for team 'beta' is unreachable");
    expect(existsSync(join(betaRoot, ".tap", "bus"))).toBe(false);
  });

  test("native done --team refuses a relocated registry with no enrolled bus without recreating it", () => {
    const { dir, env, worktree } = fixture();
    const betaRoot = join(dir, "beta");
    const beta = enrollTeam(env.TAP_INDEX_HOME!, "beta", betaRoot, {
      worker: { status: "active", instance: "worker|current" },
    });
    const relocated = join(dir, "offroot", "acting.json");
    mkdirSync(join(dir, "offroot"), { recursive: true });
    copyFileSync(beta.registry, relocated);
    const gPath = join(env.TAP_INDEX_HOME!, "global-registry.json");
    const doc = JSON.parse(readFileSync(gPath, "utf8")) as {
      schema: string;
      teams: Record<string, { root: string; registry_location: string; state: string }>;
    };
    doc.teams.beta!.registry_location = relocated;
    writeFileSync(gPath, JSON.stringify(doc));
    const id = "fable-20260830T040014Z-teamreloc01";
    seedPayload(beta.bus, id, undefined, {
      to: "worker", from: "fable", from_team: "beta", to_team: "beta", reply: "settle-only",
    });
    rmSync(beta.bus, { recursive: true, force: true });
    delete env.TAP_HOME;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--team", "beta"], worktree, env);
    expect(existsSync(beta.bus)).toBe(false);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("acting registry for team 'beta' is unreachable");
    expect(existsSync(join(beta.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done ignores a legacy teams array even when it names a matching payload", () => {
    const { dir, env, worktree } = fixture();
    const betaRoot = join(dir, "beta");
    mkdirSync(join(betaRoot, ".tap", "bus", "payloads"), { recursive: true });
    mkdirSync(join(betaRoot, ".tap", "bus", "receipts"), { recursive: true });
    spawnSync("git", ["init", "-q", betaRoot]);
    const betaBus = join(betaRoot, ".tap", "bus");
    const id = "fable-20260831T013530Z-legacyarray01";
    seedPayload(betaBus, id, undefined, { to: "worker", from: "fable", reply: "settle-only" });
    writeFileSync(join(env.TAP_INDEX_HOME!, "teams.json"), JSON.stringify({ teams: [{ root: betaRoot }] }));
    const bus = join(worktree, ".tap", "bus");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    mkdirSync(join(bus, "receipts"), { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({
      schema: "0.20",
      team: { name: "alpha", worktree_root: worktree },
      seats: { worker: { status: "active", instance: "worker|current" } },
    }));
    env.TAP_HOME = bus;
    const native = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).not.toContain(`settled ${id}`);
    expect(native.stderr).toContain("no payload 'fable-20260831T013530Z-legacyarray01'");
    expect(existsSync(join(betaBus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done --payload refuses a directory or FIFO without writing a receipt", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      worker: { status: "active", instance: "worker|current" },
    });
    env.TAP_HOME = bus;
    const id = "fable-20260830T040015Z-paynonfile1";
    const payload = join(bus, "payloads", `${id}.md`);
    mkdirSync(payload, { recursive: true });
    const asDir = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--payload", payload], worktree, env);
    expect(asDir.status).toBe(1);
    expect(asDir.stdout).toBe("");
    expect(asDir.stderr).toContain("--payload path not found");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    rmSync(payload, { recursive: true, force: true });

    const fifo = spawnSync("mkfifo", [payload]);
    expect(fifo.status).toBe(0);
    const asFifo = run("bun", [nativeDoneCandidate, id, "--by", "worker", "--payload", payload], worktree, env);
    expect(asFifo.status).toBe(1);
    expect(asFifo.stdout).toBe("");
    expect(asFifo.stderr).toContain("--payload path not found");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done bare-id refuses a local directory or FIFO with no foreign hit before reading it", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      worker: { status: "active", instance: "worker|current" },
    });
    env.TAP_HOME = bus;
    const id = "fable-20260831T013530Z-barenonfile1";
    const payload = join(bus, "payloads", `${id}.md`);
    mkdirSync(payload, { recursive: true });
    const asDir = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env, 2000);
    expect(asDir.status).toBe(1);
    expect(asDir.stdout).toBe("");
    expect(asDir.stderr).toContain("no payload");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    rmSync(payload, { recursive: true, force: true });

    const fifo = spawnSync("mkfifo", [payload]);
    expect(fifo.status).toBe(0);
    const asFifo = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env, 2000);
    expect(asFifo.status).toBe(1);
    expect(asFifo.error).toBeUndefined();
    expect(asFifo.stdout).toBe("");
    expect(asFifo.stderr).toContain("no payload");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done refuses an invalid --by before no_local_payload when the bare id misses", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      worker: { status: "active", instance: "worker|current" },
    });
    env.TAP_HOME = bus;
    const id = "fable-20260831T015101Z-badyby000001";
    const native = run("bun", [nativeDoneCandidate, id, "--by", "bad/name"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("not a valid token");
    expect(native.stderr).toContain("tap help done");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("a mutant that skips actor validation before no_local_payload would mis-class an invalid --by", () => {
    expect(noneArmAfterById("none", true)).toBe("actor");
    expect(noneArmAfterById("none", false)).toBe("no_local_payload");
    const src = readFileSync(join(root, "runtime/bun/src/verbs/done.ts"), "utf8");
    const oneArm = src.indexOf("if (hit.kind === \"one\") absPayload = hit.path;");
    const actor = src.indexOf("requireSettlingActor", oneArm);
    const refuse = src.indexOf("no_local_payload", oneArm);
    expect(oneArm).toBeGreaterThan(-1);
    expect(actor).toBeGreaterThan(oneArm);
    expect(refuse).toBeGreaterThan(actor);
  });

  test("native done prefers already_settled over invalid --by when the payload is gone", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      worker: { status: "active", instance: "worker|current" },
    });
    env.TAP_HOME = bus;
    const id = "fable-20260831T022115Z-gcsettle0001";
    const donePath = join(bus, "receipts", `${id}.done`);
    writeFileSync(donePath, JSON.stringify({
      id, status: "done", at: "2026-08-31T022115Z", by: "worker", via: "done",
    }) + "\n");
    const before = readFileSync(donePath, "utf8");
    const native = run("bun", [nativeDoneCandidate, id, "--by", "bad/name"], worktree, env);
    expect(native.status).toBe(1);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("already settled");
    expect(native.stderr).toContain("handle the open obligation(s) listed");
    expect(readFileSync(donePath, "utf8")).toBe(before);
  });

  test("a mutant that skips assertUnsettled before the none-arm actor check would mis-class a GC'd replay", () => {
    expect(noneArmReplayThenActor(true, true, true)).toBe("already_settled");
    expect(noneArmReplayThenActor(true, false, true)).toBe("actor");
    expect(noneArmReplayThenActor(false, true, true)).toBe("actor");
    const src = readFileSync(join(root, "runtime/bun/src/verbs/done.ts"), "utf8");
    const oneArm = src.indexOf("if (hit.kind === \"one\") absPayload = hit.path;");
    const replay = src.indexOf("assertUnsettled", oneArm);
    const actor = src.indexOf("requireSettlingActor", oneArm);
    const refuse = src.indexOf("no_local_payload", oneArm);
    expect(oneArm).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(oneArm);
    expect(actor).toBeGreaterThan(replay);
    expect(refuse).toBeGreaterThan(actor);
  });

  test("native done does not treat a lone .cancelled receipt as already_settled", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      worker: { status: "active", instance: "worker|current" },
    });
    env.TAP_HOME = bus;
    const id = "fable-20260831T024315Z-cancelled001";
    const cancelPath = join(bus, "receipts", `${id}.cancelled`);
    writeFileSync(cancelPath, JSON.stringify({
      id, status: "cancelled", at: "2026-08-31T024315Z", by: "worker",
    }) + "\n");
    const before = readFileSync(cancelPath, "utf8");

    const invalid = run("bun", [nativeDoneCandidate, id, "--by", "bad/name"], worktree, env);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("not a valid token");
    expect(invalid.stderr).toContain("tap help done");
    expect(readFileSync(cancelPath, "utf8")).toBe(before);

    const valid = run("bun", [nativeDoneCandidate, id, "--by", "worker"], worktree, env);
    expect(valid.status).toBe(1);
    expect(valid.stdout).toBe("");
    expect(valid.stderr).toContain("no payload");
    expect(readFileSync(cancelPath, "utf8")).toBe(before);
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("a mutant that calls assertUnsettled without a .done path would mis-class a lone .cancelled", () => {
    expect(noneArmCancelledReceipt(true, true, false)).toBe("actor");
    expect(noneArmCancelledReceipt(true, true, true)).toBe("no_local_payload");
    expect(noneArmCancelledReceipt(true, false, false)).toBe("already_settled");
    const src = readFileSync(join(root, "runtime/bun/src/verbs/done.ts"), "utf8");
    const oneArm = src.indexOf("if (hit.kind === \"one\") absPayload = hit.path;");
    const guard = src.indexOf("existsSync(ctx.bus.donePath(id))", oneArm);
    const replay = src.indexOf("assertUnsettled", oneArm);
    const actor = src.indexOf("requireSettlingActor", oneArm);
    expect(oneArm).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(oneArm);
    expect(replay).toBeGreaterThan(guard);
    expect(actor).toBeGreaterThan(replay);
  });

  test("a fallthrough mutant would settle a bare-id local miss instead of refusing", () => {
    expect(bareIdAfterLocalMiss("none")).toBe("no_local_payload");
    expect(bareIdAfterLocalMiss("one")).toBe("foreign");
    expect(bareIdAfterLocalMiss("many")).toBe("ambiguous");
    expect(fallthroughMutant("none")).toBe("settle-local");
    const src = readFileSync(join(root, "runtime/bun/src/verbs/done.ts"), "utf8");
    const miss = src.indexOf("if (hit.kind === \"one\") absPayload = hit.path;");
    const refuse = src.indexOf("no_local_payload", miss);
    const localSettle = src.indexOf("if (!absPayload) settle(", miss);
    expect(miss).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(miss);
    expect(localSettle).toBeGreaterThan(refuse);
  });

  test("native done refuses an unknown or invalid --team", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    delete env.TAP_HOME;
    const id = "snd-20260830T040006Z-teambadnamee";
    seedPayload(bus, id);
    const unknown = run("bun", [nativeDoneCandidate, id, "--by", "rcv", "--team", "ghostteam"], worktree, env);
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("is not enrolled in the machine index");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);

    const invalid = run("bun", [nativeDoneCandidate, id, "--by", "rcv", "--team", "bad/name"], worktree, env);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("fails charset");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("native done refuses a present --payload/--epoch/--team with no value before any effect", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      rcv: { status: "active", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;
    env.TAP_SELF = "rcv";
    const id = "snd-20260830T040007Z-missingflags";
    seedPayload(bus, id);
    for (const flag of ["--payload", "--epoch", "--team"] as const) {
      const native = run("bun", [nativeDoneCandidate, id, flag], worktree, env);
      expect(native.status).toBe(1);
      expect(native.stdout).toBe("");
      expect(native.stderr).toContain(`${flag} needs a value`);
      expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    }
  });

  test("poll diets rows through the native door and emits an executable read hint", () => {
    const { env, worktree } = fixture();
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
    env.TAP_HOME = bus;
    const id = "snd-20260827T010300Z-dddddddddddd";
    seedPayload(bus, id, undefined, {
      reply: "settle-only",
      epoch: "17",
      reply_to: "routerteam/supervisor",
    });

    const trace = join(worktree, "poll.trace");
    env.TAP_BUN_ROUTE_TRACE = trace;
    const expected = run("bash", [incumbent, "poll", "rcv"], worktree, env);
    const actual = run("bun", [candidate, "poll", "rcv"], worktree, env);
    const normalizeAge = (s: string) => s.replace(/  \d+s/g, "  <age>s");
    expect(readFileSync(trace, "utf8")).toBe("native poll\nnative poll\n");
    expect(actual.status).toBe(0);
    expect(actual.stdout).toContain(`${id}  snd  note  `);
    expect(actual.stdout).not.toContain("path:");
    expect(actual.stdout).toContain("reply_to: routerteam/supervisor");
    expect(normalizeAge(actual.stdout!)).toBe(normalizeAge(expected.stdout!));
    expect(actual.stderr).toBe(expected.stderr);
    const hint = actual.stdout!.split("\n").find(line => line.startsWith("next step: "))!.slice(11);
    expect(hint).toBe(`tap read ${id} --by rcv --epoch 17`);
    const read = run("bash", [incumbent, ...hint.split(" ").slice(1)], worktree, env);
    expect(read.status).toBe(0);
    const receipt = JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8"));
    expect(receipt.via).toBe("read");
    expect(receipt.by).toBe("rcv");
    expect(String(receipt.epoch)).toBe("17");
  });

  test("poll recovery hint follows placed-only evidence through both doors", () => {
    const hint = "unconfirmed to your pane — reading it here counts";
    for (const state of ["placed-only", "sent", "unattributed"] as const) {
      const { env, worktree } = fixture();
      const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
      env.TAP_HOME = bus;
      const id = "snd-20260827T010300Z-cccccccccccc";
      seedPayload(bus, id, undefined, { reply: "settle-only" });
      if (state === "sent") writeFileSync(join(bus, "receipts", `${id}.sent`), "{}\n");
      if (state === "unattributed") unlinkSync(join(bus, "receipts", `${id}.placed`));
      const trace = join(worktree, "poll-recovery.trace");
      env.TAP_BUN_ROUTE_TRACE = trace;
      const expected = run("bash", [incumbent, "poll", "rcv"], worktree, env);
      const actual = run("bun", [candidate, "poll", "rcv"], worktree, env);
      expect(readFileSync(trace, "utf8")).toBe("native poll\nnative poll\n");
      const normalizeAge = (s: string) => s.replace(/  \d+s/g, "  <age>s");
      expect(actual.status).toBe(0);
      expect(actual.stdout).toContain(id);
      expect(normalizeAge(actual.stdout!)).toBe(normalizeAge(expected.stdout!));
      expect(actual.stderr).toBe(expected.stderr);
      expect(actual.stdout!.includes(hint)).toBe(state === "placed-only");
      expect(actual.stdout!.includes("provenance: unattributed")).toBe(state === "unattributed");
      expect(actual.stdout).not.toContain("tap resend");
      expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
      expect(readFileSync(join(bus, "payloads", `${id}.md`), "utf8")).toContain("body");
    }
  });

  test("poll quarantines malformed bytes through both doors and leaves invalid reply visible", () => {
    for (const door of ["bash", "native"]) {
      const { env, worktree, dir } = fixture();
      const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {});
      env.TAP_HOME = bus;
      const id = "snd-20260827T010300Z-eeeeeeeeeeee";
      seedPayload(bus, id, undefined, { reply: "optional" });
      const bytes = Buffer.from([0xff, 0x0d, 0x0a, 0x0a]);
      writeFileSync(join(bus, "payloads", "broken.md"), bytes);
      mkdirSync(join(bus, "payloads", ".quarantine"));
      writeFileSync(join(bus, "payloads", ".quarantine", "broken.md"), "earlier evidence");
      seedPayload(bus, "mismatch");
      const mismatchPath = join(bus, "payloads", "mismatch.md");
      writeFileSync(mismatchPath, readFileSync(mismatchPath, "utf8").replace("id: mismatch", "id: different"));
      writeFileSync(join(bus, "reset-generation.json"), JSON.stringify({state: "pristine"}));
      const trace = join(dir, "poll.trace");
      env.TAP_BUN_ROUTE_TRACE = trace;
      const poll = () => door === "bash"
        ? run("bash", [incumbent, "poll", "rcv"], worktree, env)
        : run(shippedEntry, ["poll", "rcv"], worktree, env);
      const first = poll();
      if (door === "native") expect(readFileSync(trace, "utf8")).toBe("native poll\n");
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("quarantined 2 malformed payload(s)");
      expect(first.stdout).toContain("reply_invalid: optional");
      expect(first.stdout).toContain(`next step: tap show ${id}`);
      expect(first.stdout).not.toContain("next step: tap read");
      expect(existsSync(join(bus, "payloads", `${id}.md`))).toBe(true);
      expect(existsSync(join(bus, "payloads", "broken.md"))).toBe(false);
      expect(existsSync(join(bus, "payloads", "mismatch.md"))).toBe(false);
      expect(readFileSync(join(bus, "payloads", ".quarantine", "broken.md"), "utf8")).toBe("earlier evidence");
      expect(readFileSync(join(bus, "payloads", ".quarantine", "broken.md.1"))).toEqual(bytes);
      expect(JSON.parse(readFileSync(join(bus, "reset-generation.json"), "utf8")).state).toBe("reused");
      expect(poll().stdout).not.toContain("quarantined");
      expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    }
  }, 30_000);

  test("send rejects inherited and scalar roster rows before any tmux effect", () => {
    const { dir, env, worktree } = fixture();
    const bin = join(dir, "bin");
    const marker = join(dir, "tmux-called");
    mkdirSync(bin, { recursive: true });
    // Sender epoch checks may observe tmux; only a mutation violates this guard.
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$1" in -S|-L) shift 2 ;; esac\ncase "$1" in display-message|list-sessions|list-panes) exit 1 ;; esac\nprintf called > ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      good: { status: "active", pane: "private:0.0", pane_id: "%1", server_epoch: "srv:1:1", instance: "good|current" },
      rcv: { status: "active", pane: "private:0.0", pane_id: "%2", server_epoch: "srv:1:1", instance: "rcv|current" },
      scalar: "active",
      bad: "active",
    });
    env.TAP_HOME = bus;

    for (const actor of ["toString", "scalar"]) {
      const result = run("bun", [nativeSendCandidate, "rcv", "-m", "x", "--from", actor], worktree, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`'${actor}' is not an active sender on this team`);
    }
    const badRecipient = run("bun", [nativeSendCandidate, "bad", "-m", "x", "--from", "good"], worktree, env);
    expect(badRecipient.status).toBe(1);
    expect(badRecipient.stderr).toContain("'bad' is not an active seat");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(join(bus, "payloads"))).toEqual([]);
  });

  test("a command-shaped missing path stays out of the copyable action", () => {
    const { dir, env, worktree } = fixture();
    const missing = join(dir, "missing-`tick`-$(echo injected).md");
    const id = "good-20260825T144200Z-aaaaaaaaaaaa";
    const { bus } = seedLiveTeam(worktree, env.TAP_INDEX_HOME!, {
      good: { status: "active", pane: "private:0.0", pane_id: "%1", server_epoch: "srv:1:1", instance: "good|current" },
      rcv: { status: "active", pane: "private:0.0", pane_id: "%2", server_epoch: "srv:1:1", instance: "rcv|current" },
    });
    env.TAP_HOME = bus;

    const result = run("bun", [nativeSendCandidate, "rcv", missing, "--from", "good", "--id", id, "--ask"], worktree, env);
    const action = result.stderr.split("; next: ")[1] ?? "";

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`payload not found: ${missing}`);
    expect(action).not.toContain("-m");
    expect(action).not.toContain(missing);
    // The positive check keeps an EMPTY action (no `; next: ` at all) from
    // passing the negatives above. The wording is the shared construction's
    // (D1): the same fixed action on both doors, with no id in it — a retry
    // does not need one, and the incumbent native door minted one only
    // because it resolved the id before staging.
    expect(action).toContain("check the payload path, then retry");
    expect(action).not.toContain("`");
    expect(action).not.toContain("$(");
  });

  test("post-inject identity drift keeps the canonical and returns submit-unverified", () => {
    const { result, bus, band, payloads } = runRecoverySend("post_identity");
    expect(existsSync(band)).toBe(true);
    expect(result.status).toBe(5);
    expect(payloads).toHaveLength(1);
    expect(existsSync(join(bus, "receipts", `${payloads[0]!.slice(0, -3)}.placed`))).toBe(true);
    expect(result.stderr).toContain("Delivery not confirmed. Inspect with tap show");
    expect(result.stderr).toContain("if it is still unread, tap resend ");
    expect(result.stderr).toContain(" rings it again under the same id.");
    expect(result.stderr).not.toMatch(/tap register|retry|human_relay/);
  });

  test("a failed inject command keeps the canonical and returns submit-unverified", () => {
    const { result, bus, band, payloads } = runRecoverySend("inject_false");
    expect(existsSync(band)).toBe(true);
    expect(result.status).toBe(5);
    expect(payloads).toHaveLength(1);
    expect(existsSync(join(bus, "receipts", `${payloads[0]!.slice(0, -3)}.placed`))).toBe(true);
    expect(result.stderr).toContain("Delivery not confirmed. Inspect with tap show");
    expect(result.stderr).toContain("if it is still unread, tap resend ");
    expect(result.stderr).toContain(" rings it again under the same id.");
    expect(result.stderr).not.toMatch(/tap register|retry|human_relay/);
  });

  test("pre-inject identity drift after placement queues and keeps canonical", () => {
    const { result, bus, band, payloads } = runRecoverySend("pre_identity");
    expect(existsSync(band)).toBe(false);
    expect(result.status).toBe(0);
    expect(payloads).toHaveLength(1);
    expect(existsSync(join(bus, "receipts", `${payloads[0]!.slice(0, -3)}.placed`))).toBe(true);
    const out = `${result.stdout}${result.stderr}`;
    // Human queued line carries the detail clause only; reason/action stay on --json.
    expect(out).toContain("is now pane %99, not the bound %7");
  });
});
