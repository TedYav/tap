import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const shippedEntry = join(root, "bin/tap");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

const LIVE_TMUX = `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
  list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n' ;;
  *) exit 1 ;;
esac
`;
const DEAD_TMUX = `#!/bin/sh
exit 1
`;

// U1 (tap-diagnostics-u1): after a reboot no seat is observable, and `tap
// health` must say so instead of reporting a healthy bus. Both arms run the
// shipped entry end to end, so the route (native health) and the dispatcher's
// read-only skip list are exercised with the census.
function fixture(tmuxSh: string) {
  const dir = mkdtempSync(join(tmpdir(), "tap-bun-health."));
  scratch.push(dir);
  const home = join(dir, "home");
  const index = join(dir, "index");
  const worktree = join(dir, "worktree");
  const bin = join(dir, "bin");
  const tmuxTmp = join(dir, "tmux-tmp");
  const trace = join(dir, "route.trace");
  mkdirSync(home, { recursive: true });
  mkdirSync(index, { recursive: true });
  mkdirSync(join(worktree, ".tap", "bus", "payloads"), { recursive: true });
  mkdirSync(join(worktree, ".tap", "bus", "receipts"), { recursive: true });
  mkdirSync(join(worktree, ".tap", "bus", "watch"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(tmuxTmp, { recursive: true });
  spawnSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, "AGENTS.md"), "<!-- tap:begin -->\nTAP\n<!-- tap:end -->");
  writeFileSync(join(bin, "tmux"), tmuxSh, { mode: 0o755 });
  // Never the machine's compute queue; COMPUTE_QUEUE names a canned doc (tap-i5fzq).
  writeFileSync(join(bin, "compute"), `#!/bin/sh
if [ -n "$COMPUTE_QUEUE" ]; then cat "$COMPUTE_QUEUE"; else printf '{"jobs":[]}\\n'; fi
`, { mode: 0o755 });
  // The selector validates enrollment through the machine index, so a real
  // fixture is enrolled AND indexed (the smoke's write_index shape). Paths are
  // realpaths: on macOS mkdtemp hands out /var/... while the walker compares
  // against /private/var/... and an unnormalized root never matches.
  const real = realpathSync(worktree);
  writeFileSync(join(worktree, ".tap", "team-registry.json"), `${JSON.stringify({
    schema: "0.20",
    team: { name: "u1", worktree_root: real },
    seats: {},
  }, null, 2)}\n`);
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20",
    teams: { u1: { root: real, registry_location: join(real, ".tap", "team-registry.json") } },
  })}\n`);
  return { dir, home, index, worktree, bin, trace };
}

function writeRegistry(worktree: string, seats: Record<string, unknown>) {
  mkdirSync(join(worktree, ".tap"), { recursive: true });
  writeFileSync(
    join(worktree, ".tap", "team-registry.json"),
    `${JSON.stringify({
      schema: "0.20",
      team: { name: "u1", worktree_root: worktree },
      seats,
    }, null, 2)}\n`,
  );
}

function env(fixtureDir: { home: string; index: string; trace: string; bin: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixtureDir.bin ?? ""}:${process.env.PATH}`,
    HOME: fixtureDir.home,
    XDG_CONFIG_HOME: join(fixtureDir.home, ".config"),
    TAP_INDEX_HOME: fixtureDir.index,
    TAP_SESSION_MANIFEST: join(fixtureDir.index, "sessions.json"),
    OPENCODE_DB_PATH: join(fixtureDir.index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(fixtureDir.index, "version-seen.json"),
    TAP_TMUX_SOCKET: basename(fixtureDir.home),
    TAP_SERVER_EPOCH: "srv:1:1",
    TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001",
    TAP_BOOT_ID_LEGACY: "boot:1",
    TAP_WATCH_NOW: "1787790000",
    TAP_BUN_ROUTE_TRACE: fixtureDir.trace,
    COLUMNS: "200",
    NO_COLOR: "1",
  };
  delete env.TAP_HOME;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TAP_SELF;
  return env;
}

/** Whole-call zero-write control: metadata + content over the team root. */
function treeHash(rootDir: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) walk(path);
      else {
        const st = statSync(path);
        parts.push(`${path}:${st.mtimeMs}:${st.size}:${existsSync(path) ? readFileSync(path).length : ""}`);
      }
    }
  };
  walk(rootDir);
  return parts.join("\n");
}

const PANE_SEATS = {
  alpha: { status: "active", pane: "nosuch-a:0.0", harness: "claude", instance: "alpha|a", registered_at: "t" },
  beta: { status: "active", pane: "nosuch-b:0.0", harness: "claude", instance: "beta|b", registered_at: "t" },
};

describe("tap health (native)", () => {
  test("reboot-shaped empty census exits 2 with server-restart first", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, PANE_SEATS);
    const before = treeHash(fx.worktree);
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(2);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      status: string;
      attention: { type: string }[];
      roster: { status: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.status).toBe("attention");
    expect(report.attention[0]?.type).toBe("server-restart");
    expect(report.roster.every((row) => row.status === "active")).toBe(true);
    expect(treeHash(fx.worktree)).toBe(before);
    expect(readFileSync(fx.trace, "utf8")).toContain("native health");
  });

  test("live census keeps the bus healthy with no restart item", () => {
    const fx = fixture(LIVE_TMUX);
    writeRegistry(fx.worktree, {
      live: {
        status: "active",
        pane: "live-session:0.0",
        harness: "codex",
        server_epoch: "srv:1:1",
        boot_id: "bootuuid:00000000-0000-0000-0000-000000000001",
        instance: "live|c",
        registered_at: "t",
      },
    });
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { status: string; attention: unknown[] };
    expect(report.status).toBe("healthy");
    expect(report.attention).toEqual([]);
  });

  test("a live watcher pid with a stale heartbeat is the check verb's dead watcher; a fresh one is healthy", () => {
    const fx = fixture(LIVE_TMUX);
    // A real process whose command line carries the watcher signature; this test stops only its own child.
    const child = spawn("bash", ["-c", "sleep 300; :", "watch-run.ts run"], { stdio: "ignore" });
    try {
      const now = Number(env(fx).TAP_WATCH_NOW);
      const health = (heartbeat: number) => {
        writeFileSync(join(fx.worktree, ".tap", "bus", "watch", "arm.json"), JSON.stringify({
          mode: "supervision", armed_by: "owner", armed_at: now - 20_000, threshold_seconds: 1500, tick_interval_seconds: 60,
          done_when: "ship it", heartbeat_at: heartbeat, watcher_pid: child.pid, watcher_command: "watch-run.ts run",
        }));
        return spawnSync(shippedEntry, ["health", "--json"], { cwd: fx.worktree, env: env(fx), encoding: "utf8" });
      };
      const stale = health(now - 10_000);
      expect(stale.status, stale.stderr).toBe(2);
      expect(stale.stdout).toContain("armed-but-watcher-dead");
      const fresh = health(now - 10);
      expect(fresh.status, fresh.stderr).toBe(0);
      expect(fresh.stdout).not.toContain("armed-but-watcher-dead");
    } finally { child.kill("SIGKILL"); }
  });

  test("health reads the same waiting answer as the roster for a notify-done compute job (tap-i5fzq)", () => {
    const fx = fixture(`#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) printf 'live-session\\t1:1\\t1\\n' ;;
  list-panes) printf 'live-session\\tlive-session:0.0\\t%%7\\tclaude\\t123\\t1:1\\t0\\n' ;;
  capture-pane) printf '%s\\n' '⏺ done' '────────────────────────────── u1/live ─' '❯ ' '──────────────────────────────' '  status' ;;
  display-message) printf '1:1\\n' ;;
  *) exit 1 ;;
esac
`);
    writeRegistry(fx.worktree, {
      live: {
        status: "active", pane: "live-session:0.0", pane_id: "%7", harness: "claude", server_epoch: "srv:1:1",
        boot_id: "bootuuid:00000000-0000-0000-0000-000000000001", instance: "live|c", registered_at: "t",
      },
    });
    const queue = join(fx.dir, "queue.json");
    writeFileSync(queue, JSON.stringify({ jobs: [
      { id: "c1", status: "running", notify_done: "u1/live", released_at: null, identity: JSON.stringify({ pane_id: "%7" }) },
    ] }));
    const roster = (verb: string[]) => {
      const run = spawnSync(shippedEntry, verb, { cwd: fx.worktree, env: { ...env(fx), COMPUTE_QUEUE: queue }, encoding: "utf8" });
      return { run, doc: JSON.parse(run.stdout) };
    };
    const health = roster(["health", "--json"]);
    expect(health.doc.roster.find((row: { handle: string }) => row.handle === "live")?.state, health.run.stderr).toBe("waiting");
    const team = roster(["team", "--json"]);
    expect(team.doc.agents.find((row: { handle: string }) => row.handle === "live")).toMatchObject({
      agent_state: "waiting", agent_state_reason: "compute", waiting_on: [{ kind: "compute", id: "c1" }],
    });
  });

  test("an invalid injection.behavior is named in attention and the human report; a valid one is silent", () => {
    const fx = fixture(LIVE_TMUX);
    writeRegistry(fx.worktree, {});
    const config = join(fx.home, ".config", "tap");
    mkdirSync(config, { recursive: true });
    const healthOf = (args: string[]) => spawnSync(shippedEntry, ["health", ...args], { cwd: fx.worktree, env: env(fx), encoding: "utf8" });

    writeFileSync(join(config, "config.toml"), '[injection]\nbehavior = "clobber"\n');
    const valid = JSON.parse(healthOf(["--json"]).stdout) as { attention: { type: string }[] };
    expect(valid.attention.some((item) => item.type === "injection-behavior-invalid")).toBe(false);

    const bytes = '[injection]\nbehavior = "typo"\n';
    writeFileSync(join(config, "config.toml"), bytes);
    const json = healthOf(["--json"]);
    expect(json.status, json.stderr).toBe(2);
    const report = JSON.parse(json.stdout) as { attention: Record<string, unknown>[] };
    const item = report.attention.find((entry) => entry.type === "injection-behavior-invalid");
    expect(item?.detail).toBe("injection.behavior must be clobber or wait");
    const human = healthOf([]);
    expect(human.status, human.stderr).toBe(2);
    expect(human.stdout).toContain("injection.behavior must be clobber or wait");
    // Read-only: the config bytes are untouched.
    expect(readFileSync(join(config, "config.toml"), "utf8")).toBe(bytes);
  });

  const CONFIG_FAULTS: [string, (file: string) => void][] = [
    ["malformed TOML", (file) => writeFileSync(file, '[injection]\nbehavior = "wait"\n[unrelated\n')],
    ["a FIFO", (file) => expect(spawnSync("mkfifo", [file]).status).toBe(0)],
    ["a directory", (file) => mkdirSync(file)],
    ["an unreadable file", (file) => { writeFileSync(file, '[injection]\nbehavior = "wait"\n'); chmodSync(file, 0o000); }],
  ];
  for (const [label, plant] of CONFIG_FAULTS) {
    for (const mode of [[], ["--json"]]) {
      test(`config.toml as ${label} refuses structurally, never as injection-behavior-invalid or a hang (${mode.length ? "json" : "human"})`, () => {
        if (label === "an unreadable file" && process.getuid?.() === 0) return;
        const fx = fixture(LIVE_TMUX);
        writeRegistry(fx.worktree, {});
        const config = join(fx.home, ".config", "tap");
        mkdirSync(config, { recursive: true });
        const file = join(config, "config.toml");
        plant(file);
        const run = spawnSync(shippedEntry, ["health", ...mode], { cwd: fx.worktree, env: env(fx), encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
        expect(run.signal, `health blocked on ${label}`).toBeNull();
        expect(run.status, run.stderr).toBe(1);
        expect(run.stdout).not.toContain("injection-behavior-invalid");
        const out = run.stderr + run.stdout;
        expect(out).toContain("invalid preset config");
        expect(out).toContain("config.toml");
        if (mode.length) {
          // A failure object, not an unhandled throw.
          const objects = out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(objects.some((object) => object.error_class === "preset_config_invalid")).toBe(true);
        }
        if (label === "malformed TOML") expect(readFileSync(file, "utf8")).toBe('[injection]\nbehavior = "wait"\n[unrelated\n');
      });
    }
  }

  test("a debug capture stopped at its budget is named in attention and the human report", () => {
    const fx = fixture(LIVE_TMUX);
    writeRegistry(fx.worktree, {});
    const capture = join(fx.index, "debug", "20260920T000000Z-0000abcd");
    mkdirSync(capture, { recursive: true });
    const run = { id: "20260920T000000Z-0000abcd", directory: capture, socket: "/nonexistent", config: { max_mb: 1 } };
    writeFileSync(join(fx.index, "debug", "last.json"), JSON.stringify(run));
    writeFileSync(join(capture, "status.json"), JSON.stringify({ recording: false, mode: "off",
      stopped: { reason: "storage_limit", at: "2026-09-20T13:28:47.000000+00:00" } }));
    const json = spawnSync(shippedEntry, ["health", "--json"], { cwd: fx.worktree, env: env(fx), encoding: "utf8" });
    expect(json.status, json.stderr).toBe(2);
    const report = JSON.parse(json.stdout) as { status: string; attention: Record<string, unknown>[] };
    expect(report.status).toBe("attention");
    expect(report.attention).toContainEqual({ type: "debug-stopped", capture_id: run.id, reason: "storage_limit", at: "2026-09-20T13:28:47.000000+00:00" });
    const human = spawnSync(shippedEntry, ["health"], { cwd: fx.worktree, env: env(fx), encoding: "utf8" });
    expect(human.stdout).toContain("debug capture");
    expect(human.stdout).toContain("stopped: reached the storage budget with nothing left to rotate out at 2026-09-20T13:28:47");
  });

  test("poll delivery is not pane-backed: no census, no restart item", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, {
      pollseat: { status: "active", delivery: "poll", harness: "claude", instance: "p|d", registered_at: "t" },
    });
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { status: string; attention: unknown[] };
    expect(report.status).toBe("healthy");
  });

  test("persisted server_restarted row keeps pane-backed evidence after panes cleared", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, {
      parked: {
        status: "suspended",
        pane: "",
        status_reason: "server_restarted",
        harness: "claude",
        instance: "parked|e",
        registered_at: "t",
      },
    });
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(2);
    const report = JSON.parse(run.stdout) as {
      status: string;
      attention: { type: string }[];
      roster: { status: string }[];
    };
    expect(report.status).toBe("attention");
    expect(report.attention[0]?.type).toBe("server-restart");
    expect(report.roster[0]?.status).toBe("suspended");
  });

  test("an incapable mark reads suspended and never fabricates restart evidence", () => {
    const fx = fixture(LIVE_TMUX);
    writeRegistry(fx.worktree, {
      marked: {
        status: "suspended", status_reason: "incapable",
        pane: "live-session:0.0", pane_id: "%7", harness: "codex",
        instance: "m|i", registered_at: "t",
      },
    });
    const before = treeHash(fx.worktree);
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { status: string; attention: unknown[]; roster: { status: string }[] };
    // Even with a live pane that would match, the mark holds: no restart item,
    // no attention, and the roster still says suspended — the reason carries
    // without any health-policy drift.
    expect(report.status).toBe("healthy");
    expect(report.attention).toEqual([]);
    expect(report.roster[0]?.status).toBe("suspended");
    expect(treeHash(fx.worktree)).toBe(before);
  });

  test("usage error on the json route refuses on stdout as unknown_option", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, PANE_SEATS);
    const run = spawnSync(shippedEntry, ["health", "--json", "--bogus"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(1);
    const refusal = JSON.parse(run.stdout) as { ok: boolean; error_class: string; action: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.error_class).toBe("unknown_option");
    expect(refusal.action).toBe("tap help health");
  });

  test("registry-invalid refuses as registry_invalid without rendering a roster", () => {
    const fx = fixture(DEAD_TMUX);
    mkdirSync(join(fx.worktree, ".tap"), { recursive: true });
    writeFileSync(join(fx.worktree, ".tap", "team-registry.json"), "{oops\n");
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(1);
    const refusal = JSON.parse(run.stdout) as { ok: boolean; error_class: string; action: string };
    expect(refusal.error_class).toBe("registry_invalid");
    expect(refusal.action).toBe("repair_registry");
  });
});

// Review-round fixes. Each test
// names the behavior it pins and fails on the pre-fix head by construction.
describe("tap health (review fixes)", () => {
  test("unreadable canonical payload stays in the census as an unsettled obligation (r4046473742)", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, PANE_SEATS);
    // A mode-000 payload file makes readFileSync throw (EACCES) — the
    // unreadable shape the incumbent's frontmatter() fallback survived.
    const broken = join(fx.worktree, ".tap", "bus", "payloads", "broken-001.md");
    writeFileSync(broken, "---\nid: broken-001\n---\nbody\n");
    chmodSync(broken, 0o000);
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(2);
    const report = JSON.parse(run.stdout) as {
      status: string;
      attention: { type: string; id?: string }[];
      unsettled: { id: string }[];
    };
    expect(report.status).toBe("attention");
    expect(report.unsettled.map((entry) => entry.id)).toContain("broken-001");
    expect(report.attention.some((item) => item.type === "unsettled-payload" && item.id === "broken-001")).toBe(true);
  });

  test("non-object notify.json root surfaces invalid notify state instead of disappearing (r4046473748)", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, PANE_SEATS);
    writeFileSync(join(fx.worktree, ".tap", "bus", "watch", "notify.json"), "[]\n");
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(2);
    const report = JSON.parse(run.stdout) as {
      notify: { type: string; reason: string } | null;
      attention: { type: string; reason?: string }[];
    };
    expect(report.notify?.type).toBe("sticky-notify");
    expect(report.notify?.reason).toContain("invalid notify state");
    expect(report.attention.some((item) => item.type === "sticky-notify")).toBe(true);
  });

  test("foreign-socket rows are fenced: their unobservability is not our reboot (r4046473753)", () => {
    // tmux answers only the caller-socket probe; every census command fails.
    // The row's server_socket names ANOTHER namespace, so the roster fence
    // must read it offline/foreign_namespace — restart evidence must NOT fire
    // (pre-fix, the raw session_unobservable verdict produced exit 2).
    const foreignTmux = `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  display-message) case "$*" in *socket_path*) printf '/caller/real.sock\\n' ;; *) exit 1 ;; esac ;;
  *) exit 1 ;;
esac
`;
    const fx = fixture(foreignTmux);
    writeRegistry(fx.worktree, {
      visitor: {
        status: "active",
        pane: "remote-scope:0.0",
        server_socket: "/elsewhere/other.sock",
        harness: "claude",
        instance: "visitor|f",
        registered_at: "t",
      },
    });
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { status: string; attention: { type: string }[] };
    expect(report.status).toBe("healthy");
    expect(report.attention.some((item) => item.type === "server-restart")).toBe(false);
  });

  test("foreign parked evidence stays foreign: persisted server_restarted behind another socket is not our reboot (r4046473753)", () => {
    // A dispatcher-parked row (panes cleared, persisted server_restarted) whose
    // server_socket names ANOTHER namespace carries the other server's restart
    // story. The fence must keep it out of the LOCAL restart population —
    // persisted status_reason included — or the caller's healthy server reads
    // an unhealthy one. Pre-fix this produced exit 2.
    const foreignTmux = `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  display-message) case "$*" in *socket_path*) printf '/caller/real.sock\\n' ;; *) exit 1 ;; esac ;;
  *) exit 1 ;;
esac
`;
    const fx = fixture(foreignTmux);
    writeRegistry(fx.worktree, {
      visitor: {
        status: "suspended",
        pane: "",
        status_reason: "server_restarted",
        server_socket: "/elsewhere/other.sock",
        harness: "claude",
        instance: "visitor|f",
        registered_at: "t",
      },
    });
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { status: string; attention: { type: string }[] };
    expect(report.status).toBe("healthy");
    expect(report.attention.some((item) => item.type === "server-restart")).toBe(false);
  });

  test("style matrix mirrors style.sh: force styles a usable pipe, dumb TERM and empty capabilities stay plain (r4046473759)", () => {
    // Deterministic fake tput: logs every invocation (so arms can assert the
    // probe never ran), returns distinct nonempty tokens per capability, and
    // — under TPUT_EMPTY_CAP — exits 0 with EMPTY output for that one token,
    // exercising style.sh's all-token requirement without the host's tput.
    const fakeTput = (dir: string, script: string) => {
      const bin = join(dir, "fake-tput");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "tput"), script);
      chmodSync(join(bin, "tput"), 0o755);
      return bin;
    };
    const loggingFake = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TPUT_LOG\"\n[ \"$TPUT_EMPTY_CAP\" = \"$*\" ] && exit 0\ncase \"$*\" in\n  \"setaf 1\") printf 'C1' ;;\n  \"setaf 3\") printf 'C3' ;;\n  bold) printf 'B' ;;\n  dim) printf '<<DIM>>' ;;\n  sgr0) printf '[/R]' ;;\n  *) exit 1 ;;\nesac\n";

    // Arm 1: force + usable TERM + a working probe styles a pipe, using the
    // tokens the probe RETURNED (not hard-coded ANSI).
    const styled = fixture(DEAD_TMUX);
    writeRegistry(styled.worktree, PANE_SEATS);
    const styledEnv = env(styled);
    delete styledEnv.NO_COLOR;
    styledEnv.TERM = "xterm-256color";
    styledEnv.CLICOLOR_FORCE = "1";
    styledEnv.TPUT_LOG = join(styled.dir, "tput-calls");
    styledEnv.PATH = `${fakeTput(styled.dir, loggingFake)}:${styledEnv.PATH}`;
    const styledRun = spawnSync(shippedEntry, ["health"], {
      cwd: styled.worktree,
      env: styledEnv,
      encoding: "utf8",
    });
    expect(styledRun.status, styledRun.stderr).toBe(2);
    expect(styledRun.stdout).toContain("<<DIM>>bus[/R]");

    // Arm 2: style.sh rejects an empty or dumb TERM BEFORE force is consulted
    // — and before any capability probe runs. Plain output, and the fake tput
    // must not have been invoked at all.
    const dumb = fixture(DEAD_TMUX);
    writeRegistry(dumb.worktree, PANE_SEATS);
    const dumbEnv = env(dumb);
    delete dumbEnv.NO_COLOR;
    dumbEnv.TERM = "dumb";
    dumbEnv.CLICOLOR_FORCE = "1";
    dumbEnv.TPUT_LOG = join(dumb.dir, "tput-calls");
    dumbEnv.PATH = `${fakeTput(dumb.dir, loggingFake)}:${dumbEnv.PATH}`;
    const dumbRun = spawnSync(shippedEntry, ["health"], {
      cwd: dumb.worktree,
      env: dumbEnv,
      encoding: "utf8",
    });
    expect(dumbRun.status, dumbRun.stderr).toBe(2);
    expect(dumbRun.stdout).not.toContain("\x1b");
    expect(existsSync(dumbEnv.TPUT_LOG), "capability probes ran despite TERM=dumb").toBe(false);

    // Arm 3: the incumbent capability gate is all-token — a probe that exits 0
    // but renders NOTHING for one token (here bold) keeps the output plain
    // even under force.
    const noCap = fixture(DEAD_TMUX);
    writeRegistry(noCap.worktree, PANE_SEATS);
    const noCapEnv = env(noCap);
    delete noCapEnv.NO_COLOR;
    noCapEnv.TERM = "xterm-256color";
    noCapEnv.CLICOLOR_FORCE = "1";
    noCapEnv.TPUT_EMPTY_CAP = "bold";
    noCapEnv.TPUT_LOG = join(noCap.dir, "tput-calls");
    noCapEnv.PATH = `${fakeTput(noCap.dir, loggingFake)}:${noCapEnv.PATH}`;
    const noCapRun = spawnSync(shippedEntry, ["health"], {
      cwd: noCap.worktree,
      env: noCapEnv,
      encoding: "utf8",
    });
    expect(noCapRun.status, noCapRun.stderr).toBe(2);
    expect(noCapRun.stdout).not.toContain("\x1b");
  });

  test("both entry routes pin the Bun transpiler cache off for health (r4046473763)", () => {
    // Entry wiring is the behavior: the zero-write promise covers Bun startup
    // cache, so both doors must export the disable before any Bun work.
    expect(readFileSync(shippedEntry, "utf8")).toContain("provenance|who|health|doctor|show|admin|models|completion)");
    // The root scripts/tap.sh door is a shim into bin/tap, so it inherits that pin.
    expect(readFileSync(join(root, "scripts/tap.sh"), "utf8")).toMatch(/\nexec "[^\n]*\/bin\/tap" "\$@"\n$/);
    // Behavioral half through the direct Bash door: with a cache root staged,
    // health must run without materializing it.
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, PANE_SEATS);
    const runEnv = env(fx);
    const cacheRoot = join(fx.dir, "bun-cache");
    runEnv.BUN_RUNTIME_TRANSPILER_CACHE_PATH = cacheRoot;
    // Skip the dispatcher's own onboarding preflight (a separate, unpinned Bun
    // call before any verb): this isolates the health-door pin, which is what
    // the smoke's zero-write instrument measures too.
    runEnv.TAP_ONBOARDING_CHECKED = "1";
    const run = spawnSync("bash", [join(root, "scripts/tap.sh"), "health", "--json"], {
      cwd: fx.worktree,
      env: runEnv,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(2);
    JSON.parse(run.stdout) as { status: string };
    expect(existsSync(cacheRoot)).toBe(false);
  });

  test("unsettled payloads enumerate lexically regardless of mtime order (r4046473768)", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, PANE_SEATS);
    const payloads = join(fx.worktree, ".tap", "bus", "payloads");
    // Write order c, a, b with distinct mtimes so newest-first would read
    // [c, b, a]; the incumbent's lexical census reads [a, b, c].
    const ids = ["c-003", "a-001", "b-002"];
    ids.forEach((id, index) => {
      const path = join(payloads, `${id}.md`);
      writeFileSync(
        path,
        `---\nid: ${id}\nfrom: peer\nto: alpha\nkind: discuss\nreply: expected\nrecipient_instance: alpha|a\n---\nbody\n`,
      );
      utimesSync(path, new Date(1_787_790_000 + index * 10), new Date(1_787_790_000 + index * 10));
    });
    const run = spawnSync(shippedEntry, ["health", "--json"], {
      cwd: fx.worktree,
      env: env(fx),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(2);
    const report = JSON.parse(run.stdout) as {
      unsettled: { id: string }[];
      attention: { type: string; id?: string }[];
    };
    expect(report.unsettled.map((entry) => entry.id)).toEqual(["a-001", "b-002", "c-003"]);
    expect(report.attention.filter((item) => item.type === "unsettled-payload").map((item) => item.id)).toEqual([
      "a-001",
      "b-002",
      "c-003",
    ]);
  });

  test("recent supervision reports all three supervision kinds, progress included (tap-7rpf0)", () => {
    const fx = fixture(DEAD_TMUX);
    writeRegistry(fx.worktree, PANE_SEATS);
    const bus = join(fx.worktree, ".tap", "bus");
    for (const [id, kind] of [["w-1-probe", "probe"], ["w-2-notice", "notice"], ["w-3-progress", "progress"], ["w-4-discuss", "discuss"]]) {
      writeFileSync(join(bus, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: watcher\nto: alpha\nkind: ${kind}\n---\nbody\n`);
      writeFileSync(join(bus, "receipts", `${id}.done`), "");
    }
    const run = spawnSync(shippedEntry, ["health", "--json"], { cwd: fx.worktree, env: env(fx), encoding: "utf8" });
    const report = JSON.parse(run.stdout) as { supervision: { id: string; kind: string }[] };
    expect(report.supervision.map((entry) => entry.kind).sort()).toEqual(["notice", "probe", "progress"]);
  });
});
