// Port of watch-context-pressure.test.sh's wiring arms (slice W2a). The
// detector RULES are certified by the frozen-capture replay
// (watch-detectors.test.ts); this file certifies the WIRING — the registry
// file, payload files on disk, the live lease record, the gauge and
// inbox-clear programs, the clear-command authority, and the native notice
// sender — with only the world's edges shimmed by PATH (tmux for the pane
// reads, bash for the courier transport). The shell file played the tick
// through watch-detectors.ts's `import.meta.main` CLI door, a door no
// production caller uses since the Bash bridge was retired; this port
// enters the same `main(argv, env)` the door wraps, in-process, the way the
// tick's seam does.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/watch-detectors";
import { clearCommand } from "../src/clear-command";

const savedEnv: Array<[string, string | undefined]> = [];
const savedCwd = process.cwd();
let work: string | null = null;

const bus = () => join(work!, "bus");
const index = () => join(work!, "index");
const reg = () => join(bus(), "registry.json");
const file = (name: string) => join(work!, name);

function fixture() {
  if (work) return;
  for (const key of ["PATH", "TAP_HOME", "TAP_INDEX_HOME", "TAP_COURIER_SCRIPT", "TAP_WATCH_IDENTITY",
    "TAP_WATCH_TICK_ACTIVE", "TAP_WATCH_TICK_ROSTER_HANDLES", "TAP_WATCH_TICK_PANE_RECORDS",
    "TAP_TMUX_SOCKET", "TAP_TMUX_SOCKET_PATH"]) {
    savedEnv.push([key, process.env[key]]);
  }
  work = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "watch-ctx-"));
  process.env.TAP_HOME = bus();
  process.env.TAP_INDEX_HOME = index();
  mkdirSync(join(bus(), "payloads"), { recursive: true });
  mkdirSync(join(bus(), "receipts"), { recursive: true });
  mkdirSync(join(bus(), "spool"), { recursive: true });
  mkdirSync(join(bus(), "watch"), { recursive: true });
  mkdirSync(index(), { recursive: true });
  writeFileSync(join(index(), "global-registry.json"), '{"schema":"0.20","teams":{}}\n'); // born live (F1)
  // The world's edges, by PATH. Pane liveness is native since M6 U1: the tmux
  // shim answers the display-message read with the cached pane id and records
  // the detector's own capture. Seat state is native too, so every OTHER
  // capture is the seat-state ladder's: an idle band when $work/seat-state
  // says idle-at-prompt, a bare busy frame otherwise.
  const shim = file("shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "bash"), `#!/bin/bash
case "\$1" in
  */courier) printf '%s\\n' "\$@" > ${file("argv")}; cat "\$3" > ${file("body")}; printf 'sent\\n' >> ${file("sends")}; exit 0 ;;
  *) exec /bin/bash "\$@" ;;
esac
`);
  writeFileSync(join(shim, "tmux"), `#!/bin/bash
case "\$1" in
  display-message) printf '%%1' ;;
  *)
    if [ "\$*" = "capture-pane -t %1 -p" ]; then printf '%s\\n' "\$@" > ${file("tmux-argv")}; cat ${file("pane")}
    elif [ "\$(cat ${file("seat-state")})" = idle-at-prompt ]; then cat ${file("idle-band")}
    else printf 'busy\\n'
    fi ;;
esac
`);
  chmodSync(join(shim, "bash"), 0o755);
  chmodSync(join(shim, "tmux"), 0o755);
  process.env.PATH = shim + ":" + process.env.PATH;
  // The shim identifies the detector's raw read by its bare argv
  // (`capture-pane -t %1 -p`); a runner socket pin would prefix `-L`/`-S` and
  // blind that match (the shell original ran under smoke-all.sh, which pins
  // nothing), so the fixture drops the pins — every tmux call is the shim's.
  delete process.env.TAP_TMUX_SOCKET;
  delete process.env.TAP_TMUX_SOCKET_PATH;
  process.env.TAP_COURIER_SCRIPT = join(shim, "courier"); // the transport, intercepted by the bash shim
  process.env.TAP_WATCH_IDENTITY = "watcher";
  // The tick's roster cache and its resolved acting registry, as the tick hands them to the detector.
  process.env.TAP_WATCH_TICK_ACTIVE = "1";
  process.env.TAP_WATCH_TICK_ROSTER_HANDLES = "reviewer";
  process.env.TAP_WATCH_TICK_PANE_RECORDS = "reviewer\x1f%1\x1f%1";
  writeFileSync(file("seat-state"), "idle-at-prompt");
  registry("codex");
}

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(savedCwd);
});

function registry(harness: string): void {
  writeFileSync(reg(), `{"schema": "0.20", "team":{"name":"team"},"seats":{"reviewer":{"harness":"${harness}","pane":"%1","status":"active"}}}\n`);
  // the harness's own empty input band, which the ladder reads as idle-at-prompt
  const root = join(import.meta.dir, "../../..");
  if (harness === "claude") copyFileSync(join(root, "runtime/bun/test/fixtures/agent-state/claude/idle-real.txt"), file("idle-band"));
  else if (harness === "opencode") copyFileSync(join(root, "skills/tap/scripts/smoke/fixtures/opencode-splash/healthy-idle-band.txt"), file("idle-band"));
  else writeFileSync(file("idle-band"), "done.\n\u203a \n");
}

function lease(pressure = ""): void {
  writeFileSync(join(bus(), "watch/arm.json"), `{"armed_by":"lead","armed_at":1,"done_when":"x","context_pressure":"${pressure}"}\n`);
}

const leaseField = (field: string): string =>
  (JSON.parse(require("node:fs").readFileSync(join(bus(), "watch/arm.json"), "utf8")) as Record<string, string>)[field] ?? "";

function resetCase(): void {
  lease();
  for (const name of ["sends", "argv", "body"]) rmSync(file(name), { force: true });
  rmSync(join(bus(), "payloads/ask.md"), { force: true });
  rmSync(join(bus(), "spool/ask.md"), { force: true });
  rmSync(join(bus(), "receipts/ask.done"), { force: true });
}

function ask(toTeam = ""): void {
  writeFileSync(join(bus(), "payloads/ask.md"),
    `---\nid: ask\nfrom: lead\nto: reviewer\n${toTeam ? `to_team: ${toTeam}\n` : ""}reply: expected\nkind: order\n---\nReview\n`);
}

/** The tick: the detector's own door, in-process, on the tick-bridged facts. */
function tick(threshold = "40", exempt = ""): number {
  return main(["context-pressure", "1", "2000", threshold, exempt], {
    ...process.env,
    TAP_WATCH_DETECT_BUS: bus(),
    TAP_WATCH_DETECT_REGISTRY: reg(),
  });
}

const sends = (): number => (require("node:fs").existsSync(file("sends")) ? require("node:fs").readFileSync(file("sends"), "utf8").split("\n").filter(Boolean).length : 0);

/** The shim records one argv word per line; join them the way `tr '\n' ' '` did. */
const rawCaptureArgv = (): string =>
  require("node:fs").readFileSync(file("tmux-argv"), "utf8").trimEnd().split("\n").join(" ");

test("an idle-looking reviewer with a pending qualified ask never clears; done, one wake", () => {
  fixture();
  resetCase();
  writeFileSync(file("pane"), "Context 60% left\n");
  ask();
  tick();
  expect(sends()).toBe(0); // causal guard: pending ask gates the wake
  writeFileSync(join(bus(), "receipts/ask.done"), "");
  tick();
  expect(sends()).toBe(1);
  const argv = require("node:fs").readFileSync(file("argv"), "utf8").split("\n");
  expect(argv).toContain("--wake");
  expect(argv).toContain("progress");
  const body = require("node:fs").readFileSync(file("body"), "utf8");
  expect(body).toContain("context-pressure: 40% context used (threshold 40%)");
  expect(body).toContain("/clear");
  // the capture is the incumbent's raw read — no -J for any harness
    expect(rawCaptureArgv()).toBe("capture-pane -t %1 -p");
  // the sample landed in the LIVE lease record, under the armed_at CAS
  expect(leaseField("context_pressure")).toBe('{"reviewer": {"pane": "%1"}}');
  tick();
  expect(sends()).toBe(1); // same pane: no second notice
});

test("every clearable harness reaches its own clear command from the real authority", () => {
  fixture();
  for (const harness of ["claude", "opencode", "codex"]) {
    resetCase();
    registry(harness);
    writeFileSync(file("pane"), harness === "codex" ? "Context 59% left\n" : "82K (41%)\n");
    tick();
    expect(sends()).toBeGreaterThan(0);
  expect(rawCaptureArgv()).toBe("capture-pane -t %1 -p");
    const body = require("node:fs").readFileSync(file("body"), "utf8");
    expect(body).toContain(`then use ${clearCommand(harness)} to start fresh`);
    // busy seat never wakes; thresholds and exemptions are honored
    resetCase();
    writeFileSync(file("seat-state"), "working");
    tick();
    expect(sends()).toBe(0);
    writeFileSync(file("seat-state"), "idle-at-prompt");
    tick("42");
    expect(sends()).toBe(0);
    tick("40", "reviewer");
    expect(sends()).toBe(0);
  }
  registry("codex");
});

test("parked, malformed, foreign and decoy-gated asks all refuse the wake", () => {
  fixture();
  resetCase();
  ask();
  require("node:fs").renameSync(join(bus(), "payloads/ask.md"), join(bus(), "spool/ask.md"));
  tick();
  expect(sends()).toBe(0); // a parked ask is still pending
  resetCase();
  writeFileSync(join(bus(), "payloads/ask.md"), "---\nid: ask\nfrom: lead\n");
  tick();
  expect(sends()).toBe(0); // a malformed queue record refuses the wake
  resetCase();
  writeFileSync(file("pane"), "unknown footer\n");
  tick();
  expect(sends()).toBe(0);

  // A same-named seat on another team is unrelated; a foreign-bus ask to this
  // qualified recipient is still pending even though local poll cannot see it.
  resetCase();
  writeFileSync(file("pane"), "Context 60% left\n");
  mkdirSync(join(work!, "foreign/.tap/bus/payloads"), { recursive: true });
  mkdirSync(join(work!, "foreign/.tap/bus/receipts"), { recursive: true });
  // Post-flip the authority team is the enrollment key: the bus root itself is
  // enrolled as `team`, and `registry_location` names the acting registry the
  // tick resolved (_tick_reg).
  writeFileSync(join(index(), "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: {
      team: { root: work!, state: "registered", registry_location: reg() },
      foreign: { root: join(work!, "foreign"), state: "registered" },
    },
  }));
  writeFileSync(join(work!, "foreign/.tap/bus/payloads/foreign-ask.md"),
    "---\nid: foreign-ask\nfrom: lead\nto: reviewer\nto_team: team\nreply: expected\n---\nReview\n");
  tick();
  expect(sends()).toBe(0);
  writeFileSync(join(work!, "foreign/.tap/bus/receipts/foreign-ask.done"), "");
  tick();
  expect(sends()).toBeGreaterThan(0);
  resetCase();
  rmSync(join(work!, "foreign/.tap/bus/receipts/foreign-ask.done"));
  const foreignAsk = join(work!, "foreign/.tap/bus/payloads/foreign-ask.md");
  writeFileSync(foreignAsk, require("node:fs").readFileSync(foreignAsk, "utf8").replace("to_team: team", "to_team: foreign"));
  tick();
  expect(sends()).toBeGreaterThan(0); // an ask for the foreign team's seat is not this seat's gate

  // The authority team post-flip is the enrollment key, never the acting
  // file's own claim (the decoy rule): a lying registry name must not ungate
  // a qualified pending ask.
  resetCase();
  writeFileSync(file("pane"), "Context 60% left\n");
  writeFileSync(reg(), '{"schema": "0.20", "team":{"name":"decoy"},"seats":{"reviewer":{"harness":"codex","pane":"%1","status":"active"}}}\n');
  ask("team");
  tick();
  expect(sends()).toBe(0);
  writeFileSync(join(bus(), "receipts/ask.done"), "");
  tick();
  expect(sends()).toBeGreaterThan(0);

  resetCase();
  writeFileSync(join(index(), "global-registry.json"), "unreadable JSON");
  tick();
  expect(sends()).toBe(0);
  writeFileSync(join(index(), "global-registry.json"), '{"schema":"0.20","teams":{}}\n'); // restore born-live
});

test("a lease that moves under the detector withholds the wake; a disarmed team never sends", () => {
  fixture();
  resetCase();
  writeFileSync(join(bus(), "watch/arm.json"), '{"armed_by":"lead","armed_at":2,"done_when":"x"}\n');
  writeFileSync(file("pane"), "Context 60% left\n");
  ask();
  writeFileSync(join(bus(), "receipts/ask.done"), "");
  tick();
  expect(sends()).toBe(0); // re-armed (different armed_at) observed after the inbox read
  resetCase();
  rmSync(join(bus(), "watch/arm.json"));
  tick();
  expect(sends()).toBe(0); // no lease at all, nothing sent
});
