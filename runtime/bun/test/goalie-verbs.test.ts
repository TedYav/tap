// R6 U3 review pins: public-door bytes and resolution behavior that source
// greps cannot carry. The door is the repo's own `bash tap.sh goalie ...`.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "../../..");
const TAPSH = path.join(REPO, "bin/tap");

interface Run { status: number | null; stdout: string; stderr: string }

function world(): { root: string; bus: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-verbs-"));
  const bus = path.join(root, ".tap", "bus");
  fs.mkdirSync(bus, { recursive: true });
  fs.mkdirSync(path.join(root, "idx"), { recursive: true });
  fs.writeFileSync(path.join(root, "idx", "global-registry.json"), JSON.stringify(
    { schema: "0.20", teams: { tap: { root: fs.realpathSync(root),
      registry_location: path.join(bus, "registry.json") } } }));
  fs.writeFileSync(path.join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "tap", worktree_root: root }, seats: {
    lead: { status: "active", delivery: "pane", pane: "%0" },
  } }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TAP_HOME: bus,
    TAP_INDEX_HOME: path.join(root, "idx"),
    XDG_CONFIG_HOME: path.join(root, "cfg"),
    PATH: process.env.PATH ?? "",
  };
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_SELF;
  // This suite's seat runs inside a TAP-managed tmux; its socket pins would
  // redirect the fake tmux's argv and silence every pane probe.
  delete env.TAP_TMUX_SOCKET; delete env.TAP_TMUX_SOCKET_PATH;
  // A fake tmux so the armer's lead-pane liveness probe answers: display-message
  // success IS the pane-alive door.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "tmux"),
    "#!/bin/sh\n[ \"$1\" = display-message ] && [ \"$3\" = -t ] && [ \"$4\" = %5 ] && exit 0\n[ \"$1\" = display-message ] && [ \"$3\" = -t ] && printf '%s\\n' \"$4\"\nexit 0\n");
  fs.chmodSync(path.join(bin, "tmux"), 0o755);
  env.PATH = bin + ":" + env.PATH;
  return { root, bus, env };
}

function goalie(env: NodeJS.ProcessEnv, args: string[]): Run {
  const child = spawnSync("bash", [TAPSH, "goalie", ...args], { encoding: "utf8", env });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function registry(bus: string, agents: Record<string, unknown>): void {
  // The armer's lead is part of every world: registry() merges it in so a
  // test's own seats never evict it.
  fs.writeFileSync(path.join(bus, "registry.json"),
    JSON.stringify({ schema: "0.20", team: { name: "tap" }, seats: {
      lead: { status: "active", delivery: "pane", pane: "%0" },
      ...agents } }));
}

const CATALOG_TOML = `[harness.claude]
enabled = true

[roles.goalie]
description = "runs the supervision loop"
[roles.driver]
description = "drives a lane"

[presets.sonnet]
description = "test preset for the goalie role resolution pin"
harness = "claude"
params.model = "sonnet"
metadata.primary_roles = [ "goalie", "driver" ]
`

const CATALOG_TOML_UNUSED = `version = 3

[presets.claude]
metadata.primary_roles = [ "goalie", "driver" ]
`;

describe("goalie public door", () => {
  test("same-second rearm mints a new alarm generation; idempotent on preserves it", () => {
    const w = world();
    try {
      registry(w.bus, { goalie: { status: "active", delivery: "pane", pane: "%9" } });
      w.env.TAP_GOALIE_NOW = "5000";
      const args = ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "60", "--interval", "60", "--no-spawn"];
      const arm = () => JSON.parse(fs.readFileSync(path.join(w.bus, "goalie/arm.json"), "utf8"));
      expect(goalie(w.env, args).status).toBe(0);
      const first = arm();
      expect(first.alarm_generation).toMatch(/^[0-9a-f-]{36}$/);
      expect(goalie(w.env, args).status).toBe(0);
      expect(arm().alarm_generation).toBe(first.alarm_generation);
      expect(goalie(w.env, [...args, "--rearm"]).status).toBe(0);
      expect(arm().armed_at).toBe(first.armed_at);
      expect(arm().alarm_generation).not.toBe(first.alarm_generation);
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("a failed forced-notice courier exits 1 (goalie_owner_notify_failed) with the takeover still applied", () => {
    const w = world();
    try {
      const courier = path.join(w.root, "courier");
      fs.writeFileSync(courier, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      w.env.TAP_COURIER_SCRIPT = courier;
      const seed = () => {
        fs.mkdirSync(path.join(w.bus, "goalie"), { recursive: true });
        fs.writeFileSync(path.join(w.bus, "goalie", "arm.json"), JSON.stringify({
          armed_by: "armer", armed_at: "1000", threshold_seconds: "60", tick_interval_seconds: "60",
          watcher_pid: "0", seats: {}, goalie_handle: "goalie",
        }));
      };
      registry(w.bus, { goalie: { status: "active", delivery: "pane", pane: "%9" } });
      const args = ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "90", "--interval", "60", "--rearm", "--force", "--no-spawn"];
      // JSON door: the error object IS the whole output — stdout parses, stderr
      // is empty, and the detail carries the applied effect.
      seed();
      w.env.TAP_JSON = "1";
      const j = goalie(w.env, args);
      delete w.env.TAP_JSON;
      expect(j.status).toBe(1);
      expect(j.stderr).toBe("");
      const parsed = JSON.parse(j.stdout);
      expect(parsed.error_class).toBe("goalie_owner_notify_failed");
      expect(parsed.detail).toContain("force re-arm done (lease now armed by 'lead')");
      expect(parsed.detail).toContain("was NOT notified (send failed:");
      // The takeover landed under JSON mode too: the lease carries the new
      // owner and cadence.
      const leaseJ = JSON.parse(fs.readFileSync(path.join(w.bus, "goalie", "arm.json"), "utf8"));
      expect(leaseJ.armed_by).toBe("lead");
      expect(String(leaseJ.threshold_seconds)).toBe("90");
      // Plain door: ONE human line (CLI-ERR-1) — sendDurable stays quiet, the
      // typed failure folds the courier detail in, and the recovery action
      // carries a runnable body source.
      seed();
      const r = goalie(w.env, args);
      expect(r.status).toBe(1);
      expect(r.stderr).not.toContain("send to 'armer' failed");
      expect(r.stderr.split("was NOT notified").length - 1).toBe(1);
      expect(r.stderr).toContain("was NOT notified (send failed:");
      expect(r.stderr).toContain("-m 'GOALIE: forced re-arm happened; inspect the team'");
      // Exactly one stderr line: the consent and watch diagnostics yield to it.
      expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(r.stdout).toContain("armed by 'lead'");
      const lease = JSON.parse(fs.readFileSync(path.join(w.bus, "goalie", "arm.json"), "utf8"));
      expect(lease.armed_by).toBe("lead");
      expect(String(lease.threshold_seconds)).toBe("90");
      // Twin, plain door: a forced disarm reports the same way and still disarms.
      const d = goalie(w.env, ["off", "--by", "someone-else", "--force"]);
      expect(d.status).toBe(1);
      expect(d.stderr).not.toContain("send to 'armer' failed");
      expect(d.stderr.split("was NOT notified").length - 1).toBe(1);
      expect(d.stderr).toContain("-m 'GOALIE: forced disarm happened");
      expect(fs.existsSync(path.join(w.bus, "goalie", "arm.json"))).toBe(false);
      // Twin, JSON door: same parseability contract, disarm detail.
      seed();
      w.env.TAP_JSON = "1";
      const dj = goalie(w.env, ["off", "--by", "someone-else", "--force"]);
      delete w.env.TAP_JSON;
      expect(dj.status).toBe(1);
      expect(dj.stderr).toBe("");
      const dparsed = JSON.parse(dj.stdout);
      expect(dparsed.error_class).toBe("goalie_owner_notify_failed");
      expect(dparsed.detail).toContain("force disarm done (lease removed)");
      expect(dparsed.detail).toContain("was NOT notified (send failed:");
      expect(fs.existsSync(path.join(w.bus, "goalie", "arm.json"))).toBe(false);
      // The file's direct entrypoint honors TAP_JSON too:
      // one parseable error object, empty stderr.
      seed();
      const direct = spawnSync(process.execPath, [path.join(REPO, "runtime/bun/src/verbs/goalie.ts"), "off", "--by", "someone-else", "--force"],
        { encoding: "utf8", env: { ...w.env, TAP_JSON: "1" } });
      expect(direct.status).toBe(1);
      expect(direct.stderr ?? "").toBe("");
      const directParsed = JSON.parse(direct.stdout ?? "");
      expect(directParsed.error_class).toBe("goalie_owner_notify_failed");
      expect(directParsed.detail).toContain("force disarm done (lease removed)");
      expect(fs.existsSync(path.join(w.bus, "goalie", "arm.json"))).toBe(false);
      // Both failures at once: with the sidecar spawn allowed,
      // the fake tmux's new-window yields no pane pid, so the sidecar fails
      // while the notice courier refuses — the typed failure must name BOTH
      // facts instead of the notice failure hiding the sidecar's.
      seed();
      const side = goalie(w.env, ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "90", "--interval", "60", "--rearm", "--force"]);
      expect(side.status).toBe(1);
      expect(side.stderr).toContain("sidecar was not started; lease remains armed");
      expect(side.stderr).toContain("was NOT notified (send failed:");
      expect(side.stderr).not.toContain("send to 'armer' failed");
      const leaseSide = JSON.parse(fs.readFileSync(path.join(w.bus, "goalie", "arm.json"), "utf8"));
      expect(leaseSide.armed_by).toBe("lead");
    } finally {
      delete w.env.TAP_COURIER_SCRIPT;
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  });

  test("no_goalie_seat keeps the incumbent quoted-handle bytes", () => {
    const w = world();
    try {
      const r = goalie(w.env, ["on", "--by", "lead", "--threshold", "60", "--interval", "60", "--no-spawn"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no active seat carries the goalie role and none is named 'goalie'");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("an unrecorded duty-suffixed handle resolves through the longest preset prefix", () => {
    const w = world();
    try {
      fs.mkdirSync(path.join(w.env.XDG_CONFIG_HOME as string, "tap"), { recursive: true });
      fs.writeFileSync(path.join(w.env.XDG_CONFIG_HOME as string, "tap", "config.toml"), CATALOG_TOML);
      registry(w.bus, {
        "sonnet-keeper-night": { status: "active", delivery: "pane", pane: "%9" },
      });
      const r = goalie(w.env, ["on", "--by", "lead", "--threshold", "60", "--interval", "60", "--no-spawn"]);
      expect(r.status === 0 ? "ok" : "got: " + r.stderr).toBe("ok");
      expect(r.stdout).toContain("armed by 'lead'");
      // The chain warning is the incumbent's exact bytes (fix 5).
      expect(r.stderr).toContain(
        "tap goalie: warning: tap watch is not armed; the full goalie-to-lead-to-machine escalation chain is incomplete");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("two prefix-resolved goalie seats are AMBIGUOUS, not silently first-wins", () => {
    const w = world();
    try {
      fs.mkdirSync(path.join(w.env.XDG_CONFIG_HOME as string, "tap"), { recursive: true });
      fs.writeFileSync(path.join(w.env.XDG_CONFIG_HOME as string, "tap", "config.toml"), CATALOG_TOML);
      registry(w.bus, {
        "sonnet-a": { status: "active", delivery: "pane", pane: "sess:a.0" },
        "sonnet-b": { status: "active", delivery: "pane", pane: "sess:b.0" },
      });
      const r = goalie(w.env, ["on", "--by", "lead", "--threshold", "60", "--interval", "60", "--no-spawn"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("more than one active seat carries the goalie role");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("goalie_pane_gone keeps the incumbent quoted-handle action", () => {
    const w = world();
    try {
      registry(w.bus, { goalie: { status: "active", delivery: "pane", pane: "%5" } });
      const r = goalie(w.env, ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "60", "--interval", "60", "--no-spawn"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("restart the 'goalie' seat, run tap in goalie, then retry");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  // The shared activePane keeps the incumbent's launching refusal;
  // each goalie.ts caller that consults it refuses a mid-launch seat.
  const launching = { status: "active", delivery: "pane", pane: "%5", status_reason: "launching" };
  const arm = ["--threshold", "60", "--interval", "60", "--no-spawn"];
  test("a launching lead is not an active pane-backed seat", () => {
    const w = world();
    try {
      registry(w.bus, { lead: launching, goalie: { status: "active", delivery: "pane", pane: "%5" } });
      const r = goalie(w.env, ["on", "--by", "lead", "--goalie", "goalie", ...arm]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("lead 'lead' is not an active pane-backed seat");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });
  test("a launching named goalie refuses before arming", () => {
    const w = world();
    try {
      registry(w.bus, { goalie: launching });
      const r = goalie(w.env, ["on", "--by", "lead", "--goalie", "goalie", ...arm]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("the team goalie 'goalie' must be an active pane-backed seat before arming");
      expect(fs.existsSync(path.join(w.bus, "goalie", "arm.json"))).toBe(false);
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });
  test("a launching literal goalie seat is not resolved as the active goalie", () => {
    const w = world();
    try {
      registry(w.bus, { goalie: launching });
      const r = goalie(w.env, ["on", "--by", "lead", ...arm]);
      expect(r.status).toBe(1);
      expect(fs.existsSync(path.join(w.bus, "goalie", "arm.json"))).toBe(false);
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("status --json uses the exact codec: bigints preserved, ASCII-escaped", () => {
    const w = world();
    try {
      fs.mkdirSync(path.join(w.bus, "goalie"), { recursive: true });
      fs.writeFileSync(path.join(w.bus, "goalie", "arm.json"),
        '{"armed_by":"lead","armed_at":9007199254740993,"note":"caf\\u00e9","seats":{"f":{"episode_started_at":1}},"watcher_pid":"0"}');
      const r = goalie(w.env, ["status", "--json"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("9007199254740993");
      expect(r.stdout).toContain("caf\\u00e9");
      expect(r.stdout).not.toMatch(/caf\u00e9/);
      expect(JSON.parse(r.stdout).armed).toBe(true);
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("malformed non-object seats fault instead of printing healthy zeros", () => {
    const w = world();
    try {
      fs.mkdirSync(path.join(w.bus, "goalie"), { recursive: true });
      fs.writeFileSync(path.join(w.bus, "goalie", "arm.json"),
        '{"armed_by":"lead","armed_at":17,"seats":[1,2],"watcher_pid":"0"}');
      const r = goalie(w.env, ["status"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("tap goalie: armed");
      expect(r.stdout).not.toContain("tracked: 0");
      expect(r.stderr).toContain("malformed seats");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("the sidecar spawn command quotes an apostrophe TAP_HOME intact", () => {
    const w = world();
    try {
      const aposRoot = path.join(w.root, "apos'trophe");
      const bus = path.join(aposRoot, ".tap", "bus");
      (w.env as Record<string, string>).TAP_HOME = bus;
      fs.mkdirSync(bus, { recursive: true });
      fs.writeFileSync(path.join(w.env.TAP_INDEX_HOME as string, "global-registry.json"), JSON.stringify(
        { schema: "0.20", teams: {
          tap: { root: fs.realpathSync(w.root), registry_location: path.join(w.root, ".tap", "bus", "registry.json") },
          tap2: { root: fs.realpathSync(aposRoot), registry_location: path.join(bus, "registry.json") },
        } }));
      const fake = path.join(w.root, "bin", "tmux");
      fs.writeFileSync(fake,
        "#!/bin/sh\ncase \"$1\" in\n  has-session) exit 1 ;;\n  new-window) printf '%s\\n' \"$*\" >> \"$RECORD\" ;;\n  display-message) [ \"$4\" = %5 ] && exit 0; [ -z \"$4\" ] && exit 0; printf '%s\\n' \"$4\" ;;\n  *) exit 0 ;;\nesac\n");
      fs.chmodSync(fake, 0o755);
      w.env.PATH = path.join(w.root, "bin") + ":" + w.env.PATH;
      // The sidecar gate wants a tmux context (world() deleted it for isolation).
      w.env.TMUX = "/fake";
      (w.env as Record<string, string | undefined>).RECORD = path.join(w.root, "tmux.log");
      registry(bus, { goalie: { status: "active", delivery: "pane", pane: "%9" } });
      // The CONTROL is the command BYTES: the quoting must carry the apostrophe
      // through (the regression collapsed `\'` and silently lost it). A no-op
      // fake tmux cannot complete a real sidecar startup, so the rc is not the
      // assertion — the recorded command line is.
      const r = goalie(w.env, ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "60", "--interval", "60"]);
      const log = path.join(w.root, "tmux.log");
      if (!fs.existsSync(log)) {
        throw new Error("no tmux log; rc=" + r.status + " out=[" + r.stdout + "] err=[" + r.stderr + "]");
      }
      const line = fs.readFileSync(log, "utf8");
      expect(line).toContain("apos'\\''trophe");
      expect(line).toContain("TAP_HOME='");
      expect(line).toContain("goaie-run".replace("goaie", "goalie") + ".ts' run");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });
});

// R6 U3 final review: the NATIVE router must resolve the public context itself.
// Every spawn below runs with NO TAP_HOME and NO TAP_REGISTRY: the enrollment
// (index -> relocated acting registry) and the cwd are the only context.
describe("goalie native router context", () => {
  const RELOCATED_ROSTER = (root: string, store: string) => JSON.stringify({
    schema: "0.20",
    team: { name: "tap", worktree_root: root },
    seats: {
      lead: { status: "active", delivery: "pane", pane: "%0" },
      goalie: { status: "active", delivery: "pane", pane: "%9" },
      "feeder-seat": { status: "active", delivery: "pane", pane: "%9", harness: "claude",
        session_store_kind: "file", session_store_path: store },
    },
  });

  function enrolledWorld(): {
    root: string; bus: string; relocated: string; store: string; env: NodeJS.ProcessEnv; courier: string;
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-router-"));
    const bus = path.join(root, ".tap", "bus");
    fs.mkdirSync(path.join(bus, "goalie"), { recursive: true });
    const store = path.join(root, "stores", "feeder.jsonl");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ type: "assistant", timestamp: "1970-01-01T00:16:40Z" }) + "\n");
    const relocated = path.join(root, "relocated-registry.json");
    fs.writeFileSync(relocated, RELOCATED_ROSTER(fs.realpathSync(root), store));
    const idx = path.join(root, "idx");
    fs.mkdirSync(idx, { recursive: true });
    fs.writeFileSync(path.join(idx, "global-registry.json"), JSON.stringify(
      { schema: "0.20", teams: { tap: { root: fs.realpathSync(root), registry_location: relocated } } }));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tmux"),
      "#!/bin/sh\ncase \"$1\" in\n  display-message) [ \"$3\" = -t ] && [ \"$4\" = %5 ] && exit 0; [ \"$3\" = -t ] && printf '%s\\n' \"$4\" ;;\n  capture-pane) printf 'transcript\\n\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\n\\342\\235\\257 \\n\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\n' ;;\n  *) exit 0 ;;\nesac\n");
    fs.chmodSync(path.join(bin, "tmux"), 0o755);
    const courier = path.join(root, "fake-courier.sh");
    fs.writeFileSync(courier, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(courier, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TAP_INDEX_HOME: idx,
      PATH: bin + ":" + (process.env.PATH ?? ""),
    };
    delete env.TAP_HOME; delete env.TAP_REGISTRY;
    delete env.TMUX; delete env.TMUX_PANE;
    delete env.TAP_TMUX_SOCKET; delete env.TAP_TMUX_SOCKET_PATH;
    return { root, bus, relocated, store, env, courier };
  }

  function router(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Run {
    const child = spawnSync(process.execPath, [path.join(REPO, "runtime/bun/main.ts"), "goalie", ...args],
      { encoding: "utf8", env, cwd });
    return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
  }

  test("tick/on/run resolve bus, acting registry, and watch state without env pins", () => {
    const w = enrolledWorld();
    try {
      // ARM through the router: enrollment picks the RELOCATED acting registry
      // (the lead/goalie seats live only there), and the bus is the cwd's dotdir.
      const arm1 = router(w.root, w.env,
        ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "60", "--interval", "60", "--no-spawn"]);
      expect(arm1.status === 0 ? "ok" : "got: " + arm1.stderr).toBe("ok");
      expect(fs.existsSync(path.join(w.bus, "goalie", "arm.json"))).toBe(true);
      // The watch warning reads the RESOLVED bus: disarmed -> incumbent bytes.
      expect(arm1.stderr).toContain("tap goalie: warning: tap watch is not armed;");

      // Sibling: watch armed AT THE BUS mutes the warning on the next fresh arm.
      fs.mkdirSync(path.join(w.bus, "watch"), { recursive: true });
      fs.writeFileSync(path.join(w.bus, "watch", "arm.json"), "{}");
      router(w.root, w.env, ["off", "--by", "lead"]);
      const arm2 = router(w.root, w.env,
        ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "60", "--interval", "60", "--no-spawn"]);
      expect(arm2.status === 0 ? "ok" : "got: " + arm2.stderr).toBe("ok");
      expect(arm2.stderr).not.toContain("tap goalie: warning: tap watch is not armed;");

      // TICK through the router with a failing courier: the roster came from the
      // relocated acting registry (feeder stale), so the ladder runs (rung3 — the
      // pane lookup cannot place the feeder; escalate-to-human is the incumbent
      // disposition), and the courier's failure diagnostic is forwarded.
      w.env.TAP_GOALIE_NOW = "5000";
      w.env.TAP_GOALIE_QUORUM_MIN_SEATS = "1";
      w.env.TAP_GOALIE_READY_CMD = "printf '[]'";
      w.env.TAP_COURIER_SCRIPT = w.courier;
      const tick = router(w.root, w.env, ["tick"]);
      expect(tick.stdout).toContain("verdict=rung3");

      // Sibling: a stand-in courier (unlike the native send) cannot
      // rediscover context, so the door must HAND it the selected facts. The
      // recorder captures its own TAP_HOME/TAP_REGISTRY; both ambient pins are
      // absent from the router env.
      const record = path.join(w.root, "send-env.txt");
      fs.writeFileSync(path.join(w.root, "recording-courier.sh"),
        "#!/bin/sh\nprintf 'TAP_HOME=%s\\nTAP_REGISTRY=%s\\n' \"$TAP_HOME\" \"$TAP_REGISTRY\" >> \"" + record + "\"\nexit 1\n");
      fs.chmodSync(path.join(w.root, "recording-courier.sh"), 0o755);
      w.env.TAP_COURIER_SCRIPT = path.join(w.root, "recording-courier.sh");
      router(w.root, w.env, ["tick"]);
      const seen = fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "";
      expect(seen).toContain("TAP_HOME=" + fs.realpathSync(w.bus));
      expect(seen).toContain("TAP_REGISTRY=" + w.relocated);
      w.env.TAP_COURIER_SCRIPT = w.courier;

      // Causal sibling: an ambient TAP_REGISTRY pin points at a STALE bus
      // registry while the live index selects the relocated roster. Selection
      // already happened; the pin must not override it. The router tick must
      // take the real-roster disposition AND hand the courier the RELOCATED
      // selected path — red on `env.TAP_REGISTRY ||` (the empty stale roster
      // scores no fire and the recorder sees the bus path), green on the
      // unconditional selected registry.
      w.env.TAP_REGISTRY = path.join(w.bus, "registry.json");
      fs.writeFileSync(w.env.TAP_REGISTRY, "{}\n");
      w.env.TAP_COURIER_SCRIPT = path.join(w.root, "recording-courier.sh");
      const staleTick = router(w.root, w.env, ["tick"]);
      expect(staleTick.stdout).toContain("verdict=rung3");
      const seen2 = fs.readFileSync(record, "utf8");
      expect(seen2).toContain("TAP_REGISTRY=" + w.relocated);
      delete w.env.TAP_REGISTRY;
      w.env.TAP_COURIER_SCRIPT = w.courier;

      // Sibling: a RESOLVED legacy bus (cwd legacy layout, env pins absent)
      // refuses old_store before arming.
      const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-legacy-"));
      try {
        fs.mkdirSync(path.join(legacyRoot, "tmp", "tap"), { recursive: true });
        fs.writeFileSync(path.join(legacyRoot, "tmp", "tap", "registry.json"),
          JSON.stringify({ schema: "0.20", team: { name: "tap" }, seats: {
            lead: { status: "active", delivery: "pane", pane: "%0" } } }));
        const legacy = router(legacyRoot, { ...w.env },
          ["on", "--by", "lead", "--goalie", "goalie", "--threshold", "60", "--interval", "60", "--no-spawn"]);
        expect(legacy.status).toBe(1);
        expect(legacy.stderr).toContain("old TAP bus location");
      } finally {
        fs.rmSync(legacyRoot, { recursive: true, force: true });
      }

      // DIRECT run: the sidecar loop uses the selected bus without env pins.
      // The loop must forward BOTH tick byte streams (rc ignored, incumbent
      // `tick || true`): the normal verdict line on stdout and the
      // failing-courier diagnostic on stderr. The source-stamp is the causal
      // post-reexec marker.
      const armPath2 = path.join(w.bus, "goalie", "arm.json");
      const lease = JSON.parse(fs.readFileSync(armPath2, "utf8")) as Record<string, unknown>;
      lease["tick_interval_seconds"] = "1";
      // A fresh armed_at re-arms the per-seat episode clock (the bus floor):
      // activity = armed_at, so now - activity = 50 crosses the shrunk
      // threshold and the judge probe mints against the failing courier.
      lease["armed_at"] = "4950";
      lease["threshold_seconds"] = "10";
      // Clear the per-seat records the earlier board fire wrote at the OLD arm
      // epoch (wall-clock floor): a mismatched floor refuses to mint, and the
      // judge probe would never run against the failing courier.
      lease["seats"] = {};
      // Quiet the census (freshen the store) so the board does not fire and
      // the per-seat pass runs; the cleared seats record lets this tick mint a
      // FRESH episode against the failing courier — the diagnostic is the
      // loop's forwarded stderr.
      fs.writeFileSync(armPath2, JSON.stringify(lease));
      // Freshen the store: the census goes quiet while the feeder's open
      // episode keeps the per-seat judge probe running.
      fs.writeFileSync(w.store,
        JSON.stringify({ type: "assistant", timestamp: "1970-01-01T01:23:20Z" }) + "\n");
      const run = spawnSync(process.execPath, [path.join(REPO, "runtime/bun/src/goalie-run.ts"), "run"],
        { encoding: "utf8", env: w.env, cwd: w.root, timeout: 15000, killSignal: "SIGTERM" });
      // The judge probe now fires for real: effectEnv() injects the selected
      // TAP_HOME/TAP_REGISTRY into the lib doors, so tap_seat_state classifies
      // the feeder through the production doors and the failing courier turns
      // the minted episode into the loop's forwarded stderr diagnostic.
      expect(run.stdout).toContain("verdict=quiet");
      expect(run.stderr).toContain("failed (rc=1)");
      expect(fs.existsSync(path.join(w.bus, "goalie", "source-stamp"))).toBe(true);
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  });
});

test("verdict human fallback names the recorded armer, with no missing-armer substitution", () => {
  const w = world(), bin = path.join(w.root, "bin"), notifyLog = path.join(w.root, "notify.json");
  try {
    // Real actor authentication: one tty, one pane, one atomic identity record.
    fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nprintf "123 faketty\\n"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "tmux"), '#!/bin/sh\ncase "$1" in list-panes) printf "%%7\\t/dev/faketty\\n";; display-message) for a in "$@"; do case "$a" in *pane_tty*) printf "%%7\\t/dev/faketty\\ttap/observer\\t123:456\\n"; exit;; *pid*start_time*) printf "123:456\\n"; exit;; esac; done;; esac\n', { mode: 0o700 });
    const courier = path.join(w.root, "courier"), notifier = path.join(w.root, "notifier");
    fs.writeFileSync(courier, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    fs.writeFileSync(notifier, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(notifyLog)},JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const env = { ...w.env, TAP_COURIER_SCRIPT: courier, TAP_NOTIFY_USER_BIN: notifier, TAP_GOALIE_NOW: "5000" };
    fs.mkdirSync(path.join(w.bus, "goalie"));
    registry(w.bus, {
      observer: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456" },
      armer: { status: "suspended", status_reason: "pane_gone" },
      feeder: { status: "active", delivery: "poll" },
    });
    for (const armer of ["armer", "observer", "", "missing"]) {
      fs.rmSync(notifyLog, { force: true });
      fs.writeFileSync(path.join(w.bus, "goalie/arm.json"), JSON.stringify({
        armed_by: armer, armed_at: "1000", goalie_handle: "observer", feeder: "feeder",
        seats: { candidate: { episode_started_at: 4242, episode_token: "tok4242", verdict_at: 0 } },
      }));
      const r = goalie(env, ["verdict", "--seat", "candidate", "--episode", "4242", "--token", "tok4242", "--action", "wake-lead", "--reason", "unsure"]);
      expect(r.status, r.stderr).toBe(1); expect(r.stdout).not.toContain("sent wake-lead verdict");
      if (armer === "armer" || armer === "observer") {
        const args = JSON.parse(fs.readFileSync(notifyLog, "utf8"));
        expect(args.slice(0, 3)).toEqual(["--template", "question", "--"]);
        expect(args[3]).toEndWith(` — tap/${armer}`);
        expect(args[3]).not.toContain("tap/feeder");
      } else {
        expect(fs.existsSync(notifyLog)).toBe(false);
        expect(r.stderr).toContain(armer ? "human notification unconfirmed" : "human notification not attempted");
      }
    }
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test("the public verdict notice accepts the courier's harness-queue tuple and refuses near misses", () => {
  const w = world(), bin = path.join(w.root, "bin");
  try {
    fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nprintf "123 faketty\\n"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "tmux"), '#!/bin/sh\ncase "$1" in list-panes) printf "%%7\\t/dev/faketty\\n";; display-message) for a in "$@"; do case "$a" in *pane_tty*) printf "%%7\\t/dev/faketty\\ttap/observer\\t123:456\\n"; exit;; *pid*start_time*) printf "123:456\\n"; exit;; esac; done;; esac\n', { mode: 0o700 });
    const courier = path.join(w.root, "courier"), out = path.join(w.root, "courier.out");
    fs.writeFileSync(courier, `#!/bin/sh\ncat ${JSON.stringify(out)}\nexit 0\n`, { mode: 0o700 });
    const env = { ...w.env, TAP_COURIER_SCRIPT: courier, TAP_NOTIFY_USER_BIN: "/usr/bin/true", TAP_GOALIE_NOW: "5000" };
    fs.mkdirSync(path.join(w.bus, "goalie"));
    registry(w.bus, { observer: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456" } });
    const cases: Array<[string, Record<string, unknown> | string, boolean]> = [
      ["harness-queue, turn unconfirmed", { id: "x", status: "queued", delivery: "harness-queue", turn: "unconfirmed" }, true],
      ["harness-queue without its turn", { id: "x", status: "queued", delivery: "harness-queue" }, false],
      ["harness-queue claiming injection", { id: "x", status: "injected", delivery: "harness-queue", turn: "unconfirmed" }, false],
      ["unknown delivery", { id: "x", status: "queued", delivery: "mystery", turn: "unconfirmed" }, false],
      ["malformed", "not-json", false],
    ];
    for (const [label, stdout, accepted] of cases) {
      fs.writeFileSync(out, typeof stdout === "string" ? stdout : JSON.stringify(stdout));
      fs.writeFileSync(path.join(w.bus, "goalie/arm.json"), JSON.stringify({
        armed_by: "observer", armed_at: "1000", goalie_handle: "observer",
        seats: { candidate: { episode_started_at: 4242, episode_token: "tok4242", verdict_at: 0 } },
      }));
      const r = goalie(env, ["verdict", "--seat", "candidate", "--episode", "4242", "--token", "tok4242", "--action", "wake-lead", "--reason", "unsure"]);
      expect([label, r.status], r.stderr).toEqual([label, accepted ? 0 : 1]);
      if (accepted) expect(r.stdout).toContain("sent wake-lead verdict to 'observer'");
      else expect(r.stderr).toContain("tap goalie: send to 'observer' failed (rc=0)");
    }
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

// tap-calo: disarm authority is the calling pane, never `--by`. The pane is
// faked the way the verdict test above does it: one tty, one pane, one atomic
// identity record, and the seat whose pane_id matches is who is "at the pane".
describe("goalie off authority is the calling pane, never --by (tap-calo)", () => {
  function actAs(w: ReturnType<typeof world>, handle: string): NodeJS.ProcessEnv {
    const bin = path.join(w.root, "bin");
    fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nprintf "123 faketty\\n"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "tmux"), '#!/bin/sh\ncase "$1" in list-panes) printf "%%7\\t/dev/faketty\\n";; display-message) for a in "$@"; do case "$a" in *pane_tty*) printf "%%7\\t/dev/faketty\\ttap/' + handle + '\\t123:456\\n"; exit;; *pane_id*session_name*) printf "%%7\\ttap/' + handle + '\\t123:456\\n"; exit;; *pid*start_time*) printf "123:456\\n"; exit;; esac; done; printf "%%7\\n";; esac\n', { mode: 0o700 });
    const courier = path.join(w.root, "courier");
    fs.writeFileSync(courier, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(w.root, "courier.argv"))}\nexit 1\n`, { mode: 0o700 });
    return { ...w.env, TAP_COURIER_SCRIPT: courier };
  }
  function armedBy(w: ReturnType<typeof world>, seats: Record<string, unknown>): void {
    registry(w.bus, seats);
    fs.mkdirSync(path.join(w.bus, "goalie"), { recursive: true });
    fs.writeFileSync(path.join(w.bus, "goalie", "arm.json"), JSON.stringify({
      armed_by: "lead", armed_at: "1000", threshold_seconds: "60", tick_interval_seconds: "60",
      watcher_pid: "0", seats: {}, goalie_handle: "goalie",
    }));
  }
  const armPath = (w: ReturnType<typeof world>) => path.join(w.bus, "goalie", "arm.json");

  test("a peer running `off --by <owner>` is refused and offered `off --force`, not the owner's handle", () => {
    const w = world();
    try {
      const env = actAs(w, "peer");
      armedBy(w, { peer: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456" } });
      const r = goalie(env, ["off", "--by", "lead"]);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stderr).toContain("only the goalie armer may disarm by default");
      expect(r.stderr).toContain("tap goalie off --force");
      expect(r.stderr).not.toContain("--by");
      expect(fs.existsSync(armPath(w))).toBe(true);
      expect(fs.existsSync(path.join(w.root, "courier.argv"))).toBe(false);
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("the owner's own bare `off` disarms with no notice; `--by` naming someone else changes nothing for the owner", () => {
    const w = world();
    try {
      const env = actAs(w, "lead");
      armedBy(w, { lead: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456" } });
      const r = goalie(env, ["off", "--by", "someone-else"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("disarmed by 'lead'");
      expect(fs.existsSync(armPath(w))).toBe(false);
      expect(fs.existsSync(path.join(w.root, "courier.argv"))).toBe(false);
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("a peer's `off --force` is loud: attributed to the true pane and the owner is noticed", () => {
    const w = world();
    try {
      const env = actAs(w, "peer");
      armedBy(w, { peer: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456" } });
      // --by names the owner: the notice must still name the pane's handle.
      const r = goalie(env, ["off", "--by", "lead", "--force"]);
      expect(r.status).toBe(1); // the stub courier refuses: goalie_owner_notify_failed, mutation done
      expect(r.stderr).toContain("was NOT notified");
      expect(fs.existsSync(armPath(w))).toBe(false);
      const argv = fs.readFileSync(path.join(w.root, "courier.argv"), "utf8");
      expect(argv).toContain("force-disarmed by 'peer'");
      expect(argv).not.toContain("force-disarmed by 'lead'");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  // The door must not send a caller to a refusal: `off` is pane-only, so bare `off` is offered only
  // when the PANE is the owner, not when `on --by <owner>` merely names the owner.
  const doorFor = (w: ReturnType<typeof world>, env: NodeJS.ProcessEnv) => goalie(env, ["on", "--by", "lead", "--goalie", "goalie",
    "--threshold", "90", "--interval", "60", "--no-spawn"]);
  // The faked pane is always %7; whichever seat `actor` names owns it, the others sit elsewhere.
  const seatsFor = (actor: string) => {
    const at = (h: string, other: string) => ({ status: "active", pane: actor === h ? "%7" : other, pane_id: actor === h ? "%7" : other, server_epoch: "srv:123:456" });
    return { lead: at("lead", "%8"), peer: at("peer", "%9"), goalie: { status: "active", delivery: "pane", pane: "%10", pane_id: "%10", server_epoch: "srv:123:456" } };
  };

  test("already-armed door: the owner's own pane is offered bare `off`", () => {
    const w = world();
    try {
      const env = actAs(w, "lead");
      armedBy(w, seatsFor("lead"));
      const r = doorFor(w, env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("next: tap goalie off   # or pass --rearm");
      expect(r.stderr).not.toContain("--force");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("already-armed door: a peer pane naming the owner with --by is offered `off --force`", () => {
    const w = world();
    try {
      const env = actAs(w, "peer");
      armedBy(w, seatsFor("peer"));
      const r = doorFor(w, env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("next: tap goalie off --force   # or ask 'lead' to re-arm");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("already-armed door: a pane-less caller naming the owner with --by is offered `off --force`", () => {
    const w = world();
    try {
      armedBy(w, seatsFor("nobody"));
      const r = doorFor(w, w.env); // world(): no ps shim and a bare tmux, so no calling pane resolves
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("next: tap goalie off --force   # or ask 'lead' to re-arm");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });

  test("the already-armed door never tells anyone to pass --by", () => {
    const w = world();
    try {
      const env = actAs(w, "peer");
      armedBy(w, { peer: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456" }, goalie: { status: "active", delivery: "pane", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456" } });
      const r = goalie(env, ["on", "--by", "peer", "--goalie", "goalie", "--threshold", "90", "--interval", "60", "--no-spawn"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("tap goalie off --force");
      expect(r.stderr).toContain("ask 'lead' to re-arm");
      expect(r.stderr).not.toContain("--by");
    } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
  });
});
