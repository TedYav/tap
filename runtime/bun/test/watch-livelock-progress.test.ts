// Port of watch-livelock-progress.test.sh's wiring arms. The detector RULES
// are certified by the frozen-capture replay (watch-detectors.test.ts); this
// file certifies the WIRING — payload and receipt files read by the native
// inbound-age walk and latest-outbound reader, the live lease record holding
// the sample maps across ticks, the evaluator's completion pre-check, and the
// real sender's NOTE selection — with only the world's edges shimmed by PATH
// (tmux for the frame and pane liveness, bash running the TAP_COURIER_SCRIPT
// stand-in for the transport). The shell file played the tick through each
// module's `import.meta.main` CLI, doors no production caller uses since
// the Bash bridge was retired; this port enters the same main(argv, env)
// doors in-process, the way watch-tick-run.ts's seams do.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as detectorMain } from "../src/watch-detectors";
import { main as evaluatorMain } from "../src/watch-evaluator";
import { main as noticeMain } from "../src/watch-notice";

const savedEnv: Array<[string, string | undefined]> = [];
const work = { current: "" };
let shimDir = "";

const bus = () => join(work.current, "bus");
const index = () => join(work.current, "index");
const reg = () => join(bus(), "registry.json");
const file = (name: string) => join(work.current, name);
const payloads = () => join(bus(), "payloads");
const receipts = () => join(bus(), "receipts");
const spool = () => join(bus(), "spool");

function fixture(): void {
  if (work.current) return;
  for (const key of ["PATH", "TAP_HOME", "TAP_INDEX_HOME", "TAP_COURIER_SCRIPT", "TAP_WATCH_IDENTITY",
    "TAP_WATCH_TICK_ACTIVE", "TAP_WATCH_TICK_ROSTER_HANDLES", "TAP_WATCH_TICK_PANE_RECORDS",
    "TAP_TMUX_SOCKET", "TAP_TMUX_SOCKET_PATH",
    // the detector prefers these over the fixture bus paths when set
    "TAP_PAYLOADS", "TAP_RECEIPTS", "TAP_SPOOL"]) {
    savedEnv.push([key, process.env[key]]);
  }
  work.current = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "watch-live-"));
  process.env.TAP_HOME = bus();
  process.env.TAP_INDEX_HOME = index();
  // pin the payload-path overrides to the fixture bus, as the shell rebound them
  process.env.TAP_PAYLOADS = payloads();
  process.env.TAP_RECEIPTS = receipts();
  process.env.TAP_SPOOL = spool();
  for (const dir of [payloads(), receipts(), spool(), join(bus(), "watch"), index()]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(index(), "global-registry.json"), '{"schema":"0.20","teams":{}}\n'); // born live (F1)
  shimDir = file("shim");
  mkdirSync(shimDir, { recursive: true });
  // The transport shim classifies by body: a livelock wake records a wake line
  // and its body; everything else is a progress/notice note. The tmux edge
  // answers the pane-liveness display-message read (dead when $work/pane-dead
  // exists) and hands every capture the same frame.
  writeFileSync(join(shimDir, "bash"), `#!/bin/bash
case "\$1" in
  */courier) kind=""; wake=0; for a in "\$@"; do case "\$a" in --kind) kind=next ;; notice|progress) [ "\$kind" != next ] || kind="\$a" ;; --wake) wake=1 ;; esac; done
    body="\$(cat "\$3")"; case "\$body" in *codex-livelock*) printf 'wake\\n' >> ${file("wakes")}; printf '%s\\n' "\$body" > ${file("wake-body")} ;; *) printf '%s\\n' "\$kind" >> ${file("notes")}; printf '%s\\n' "\$body" > ${file("note-body")} ;; esac; exit 0 ;;
  *) exec /bin/bash "\$@" ;;
esac
`);
  writeFileSync(join(shimDir, "tmux"), `#!/bin/bash
case "\$1" in
  display-message)
    [ ! -e ${file("pane-dead")} ] || exit 7
    printf '%%1\\n' ;;
  *) cat ${file("pane")} ;;
esac
`);
  chmodSync(join(shimDir, "bash"), 0o755);
  chmodSync(join(shimDir, "tmux"), 0o755);
  process.env.PATH = shimDir + ":" + process.env.PATH;
  // The shim keys its display-message branch on $1; a runner socket pin would
  // put `-L`/`-S` first and every call would fall through to the frame branch,
  // so the fixture drops the pins (the shell original ran under smoke-all.sh,
  // which pins nothing). Every tmux call is the shim's.
  delete process.env.TAP_TMUX_SOCKET;
  delete process.env.TAP_TMUX_SOCKET_PATH;
  process.env.TAP_COURIER_SCRIPT = join(shimDir, "courier");
  process.env.TAP_WATCH_IDENTITY = "watcher";
  process.env.TAP_WATCH_TICK_ACTIVE = "1";
  writeFileSync(file("pane"), "");
}

afterAll(() => {
  if (work.current) rmSync(work.current, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** One seat row plus the tick's roster cache, as the tick hands them over. */
function registry(handle: string): void {
  writeFileSync(reg(), `{"schema": "0.20", "team":{"name":"team"},"seats":{"${handle}":{"harness":"codex","pane":"%1","status":"active"}}}\n`);
  process.env.TAP_WATCH_TICK_PANE_RECORDS = `${handle}\x1f%1\x1f%1`;
  process.env.TAP_WATCH_TICK_ROSTER_HANDLES = handle;
}

/** Born live: the bus root is enrolled as `team` at the registry the tick resolves. */
function enrollTeam(): void {
  writeFileSync(join(index(), "global-registry.json"),
    JSON.stringify({ schema: "0.20", teams: { team: { root: work.current, state: "registered", registry_location: reg() } } }));
}

function lease(): void {
  writeFileSync(join(bus(), "watch/arm.json"), '{"armed_by":"leader","armed_at":1,"done_when":"x"}\n');
}

const field = (key: string): string => {
  const row = JSON.parse(require("node:fs").readFileSync(join(bus(), "watch/arm.json"), "utf8")) as Record<string, string>;
  return row[key] ?? "";
};

/** The detector's own door, in-process, on the tick-bridged facts. */
function tick(now: string): number {
  return detectorMain(["codex-livelock", "1", now, "100", "leader"], { ...process.env, TAP_WATCH_DETECT_BUS: bus(), TAP_WATCH_DETECT_REGISTRY: reg() });
}

function frame(first: string, minutes: string, seconds: string): void {
  writeFileSync(file("pane"), `${first}\nWorking (${minutes}m ${seconds}s • esc to interrupt)\n`);
}

const count = (name: string): number => {
  try { return require("node:fs").readFileSync(file(name), "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
};

function writePayload(path: string, body: { id: string; from: string; fromTeam?: string; to: string; reply?: string; kind: string; text: string }): void {
  writeFileSync(path, `---\nid: ${body.id}\nfrom: ${body.from}\n${body.fromTeam ? `from_team: ${body.fromTeam}\n` : ""}to: ${body.to}\n${body.reply ? `reply: ${body.reply}\n` : ""}kind: ${body.kind}\n---\n${body.text}\n`);
  utimesSync(path, 1900, 1900);
}

function resetCase(): void {
  lease();
  for (const name of ["wakes", "notes", "wake-body", "note-body", "pane-dead"]) {
    try { rmSync(file(name), { force: true }); } catch { /* absent */ }
  }
  for (const path of [join(payloads(), "progress.md"), join(spool(), "progress.md"), join(receipts(), "ask.done")]) {
    try { rmSync(path, { force: true }); } catch { /* absent */ }
  }
}

const seat = "astra-a";

/** The stalled seat's open work ask, stamped old as the loop's last iteration left it. */
function writeAsk(): void {
  writePayload(join(payloads(), "ask.md"), { id: "ask", from: "leader", to: seat, reply: "expected", kind: "order", text: "Work order" });
  utimesSync(join(payloads(), "ask.md"), 100, 100);
}

test("working seats with outbound progress note instead of waking, sample in the live lease", () => {
  fixture();
  enrollTeam();
  for (const current of ["astra-b", "astra-c", "astra-a"]) {
    resetCase();
    registry(current);
    writePayload(join(payloads(), "ask.md"), { id: "ask", from: "leader", to: current, reply: "expected", kind: "order", text: "Work order" });
    writePayload(join(payloads(), "progress.md"), { id: "progress", from: current, fromTeam: "team", to: "leader", reply: "settle-only", kind: "discuss", text: "Pushed correction; checking CI" });
    utimesSync(join(payloads(), "ask.md"), 100, 100);
    if (current !== "astra-b") {
      renameSync(join(payloads(), "progress.md"), join(spool(), "progress.md"));
    }
    writeFileSync(file("pane"), "Pushed correction\nWorking (40m 0s • esc to interrupt)\n");
    expect(tick("2000")).toBe(0);
    expect(count("wakes")).toBe(0); // progress caused no livelock wake
    expect(require("node:fs").readFileSync(file("notes"), "utf8").split("\n").filter(Boolean)).toContain("progress");
    expect(require("node:fs").readFileSync(file("note-body"), "utf8"))
      .toContain(`codex-progress: '${current}' has sent progress while inbound 'ask' remains open`);
    // the progress mark landed in the LIVE lease record
    expect(field("livelock_alerts")).toBe(`{"${current}:ask:progress":2000}`);
  }
});

test("a stalled seat wakes once per episode; progress, settlement, idle and dead panes re-baseline", () => {
  fixture();
  enrollTeam();
  registry(seat);
  writeAsk();

  resetCase();
  frame("Waiting on work", "40", "0"); tick("2000");
  expect(count("wakes")).toBe(0);
  frame("Waiting on work", "41", "40"); tick("2100");
  expect(count("wakes")).toBe(1);
  expect(require("node:fs").readFileSync(file("wake-body"), "utf8"))
    .toContain(`codex-livelock: '${seat}' has been Working for 2500s while inbound 'ask' is unsettled for 2000s`);
  frame("Waiting on work", "43", "20"); tick("2200");
  expect(count("wakes")).toBe(1); // same episode: no second wake
  lease(); tick("2200");
  expect(count("wakes")).toBe(1); // a fresh lease starts a new one, not a second wake
  frame("Waiting on work", "45", "0"); tick("2300");
  expect(count("wakes")).toBe(2);

  // Pane progress (a changed frame) re-baselines; the next stall wakes again.
  resetCase();
  frame("Old output", "40", "0"); tick("2000");
  frame("New output", "41", "40"); tick("2100");
  expect(count("wakes")).toBe(0);
  frame("New output", "43", "20"); tick("2200");
  expect(count("wakes")).toBe(1);

  // Outbound progress from the seat (a payload on disk) is a NOTE, not a wake,
  // and a new outbound changes the sample so the freeze clock restarts.
  resetCase();
  frame("Waiting on work", "40", "0"); tick("2000");
  writePayload(join(payloads(), "progress.md"), { id: "progress", from: seat, fromTeam: "team", to: "leader", kind: "discuss", reply: "settle-only", text: "Progress" });
  utimesSync(join(payloads(), "progress.md"), 2099, 2099);
  frame("Waiting on work", "41", "40"); tick("2100");
  expect(count("wakes")).toBe(0);
  expect(count("notes")).toBeGreaterThan(0);
  frame("Waiting on work", "43", "20"); tick("2200");
  expect(count("wakes")).toBe(1);

  // Settling the ask clears the inbox: no wake.
  resetCase();
  frame("Waiting on work", "40", "0"); tick("2000");
  writeFileSync(join(receipts(), "ask.done"), "");
  frame("Waiting on work", "45", "0"); tick("2300");
  expect(count("wakes")).toBe(0);

  // An idle frame between two stalls forgets the baseline.
  resetCase();
  frame("Waiting on work", "40", "0"); tick("2000");
  writeFileSync(file("pane"), "Ready for input\n"); tick("2050");
  frame("Waiting on work", "41", "40"); tick("2100");
  expect(count("wakes")).toBe(0);
  frame("Waiting on work", "43", "20"); tick("2200");
  expect(count("wakes")).toBe(1);

  // A same-handle sender on a FOREIGN team is not this seat's progress.
  resetCase();
  frame("Waiting on work", "40", "0"); tick("2000");
  writePayload(join(payloads(), "progress.md"), { id: "progress", from: seat, fromTeam: "foreign", to: "leader", kind: "discuss", text: "Foreign same handle" });
  utimesSync(join(payloads(), "progress.md"), 2099, 2099);
  frame("Waiting on work", "41", "40"); tick("2100");
  expect(count("wakes")).toBe(1);
  expect(count("notes")).toBe(0);

  // A dead pane between samples forgets the baseline.
  resetCase();
  frame("Waiting on work", "40", "0"); tick("2000");
  writeFileSync(file("pane-dead"), ""); tick("2050"); unlinkSync(file("pane-dead"));
  frame("Waiting on work", "41", "40"); tick("2100");
  expect(count("wakes")).toBe(0);
  frame("Waiting on work", "43", "20"); tick("2200");
  expect(count("wakes")).toBe(1);
});

test("an authority the tick cannot read does not silence the alarm", () => {
  fixture();
  enrollTeam();
  registry(seat);
  writeAsk();
  resetCase();
  frame("Waiting on work", "100", "0");
  writePayload(join(spool(), "progress.md"), { id: "progress", from: seat, fromTeam: "team", to: "leader", reply: "settle-only", kind: "discuss", text: "Pushed correction" });
  expect(tick("2000")).toBe(0);
  expect(count("wakes")).toBe(0); // readable authority qualified the outbound progress
  // An unreadable machine index fails closed: the team is unknown, progress
  // can never qualify again, and the stalled seat wakes once the freeze
  // window elapses over the unqualifiable outbound.
  writeFileSync(join(index(), "global-registry.json"), "unreadable JSON");
  frame("Waiting on work", "101", "0"); tick("2100");
  frame("Waiting on work", "102", "0"); tick("2200");
  expect(count("wakes")).toBe(1);
  writeFileSync(join(index(), "global-registry.json"), '{"schema":"0.20","teams":{}}\n'); // restore the born-live marker
});

test("the supervisor's own NOTE must not block the evaluator's completion pre-check", () => {
  fixture();
  enrollTeam();
  registry(seat);
  const supervisionPayloads = file("supervision-payloads");
  const supervisionReceipts = file("supervision-receipts");
  mkdirSync(supervisionPayloads, { recursive: true });
  mkdirSync(supervisionReceipts, { recursive: true });
  writePayload(join(supervisionPayloads, "note.md"), { id: "note", from: "watcher", to: seat, kind: "progress", reply: "settle-only", text: "Progress observed" });
  const rc = evaluatorMain(["has-unsettled"], {
    ...process.env,
    TAP_WATCH_DETECT_BUS: bus(),
    TAP_WATCH_DETECT_REGISTRY: reg(),
    TAP_PAYLOADS: supervisionPayloads,
    TAP_RECEIPTS: supervisionReceipts,
  });
  expect(rc).not.toBe(0); // a supervisor NOTE is not unsettled work
});

test("the real sender's NOTE selection reaches the transport as progress, never a wake", () => {
  fixture();
  // the transport shim, intercepting only the courier
  writeFileSync(join(shimDir, "bash"), `#!/bin/bash
case "\$1" in
  */courier) printf '%s\\n' "\$@" > ${file("send-argv")}; cat "\$3" > ${file("send-body")}; exit 0 ;;
  *) exec /bin/bash "\$@" ;;
esac
`);
  chmodSync(join(shimDir, "bash"), 0o755);
  expect(noticeMain(["send", bus(), join(import.meta.dir, "../../../skills/tap/scripts"), "leader",
    "codex-progress: open ask with progress", "outbound=progress", "progress"])).toBe(0);
  const argv = require("node:fs").readFileSync(file("send-argv"), "utf8").split("\n").filter(Boolean);
  expect(argv).toContain("progress");
  expect(argv).not.toContain("--wake");
  expect(require("node:fs").readFileSync(file("send-body"), "utf8")).not.toContain("Quick spot-check");
});
