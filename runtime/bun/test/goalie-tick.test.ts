#!/usr/bin/env bun
/**
 * R6 U2 differential: the native goalie tick against the pinned Bash incumbent.
 *
 * The fixture (goalie-oracle.json) freezes whole-tick worlds captured from
 * tap-goalie.sh @ 68dcc90: every case materializes a real bus (arm, registry,
 * ledger, session stores, payloads, spool, receipts), runs the SAME doors the
 * capture ran (canned seat_state / courier / escalation, REAL ready command,
 * ported bus-activity / active-pane / teammates / census), and compares rc,
 * stdout, stderr, the ordered door-effect stream and the written file bytes
 * byte-for-byte. True-external doors are doubles; everything the port owns is
 * the real implementation — the differential IS the proof.
 *
 * Ruled divergence (documented in the U2 report): the incumbent's verb entry
 * runs under errexit and its loop entry does not; the port carries the loop's
 * bytes. Cases where the two
 * captured shapes differ compare against the LOOP capture only, plus an
 * explicit assertion that the captured shapes differ.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { goalieTick, realGoalieDoors, tickEntry, type GoalieDoors } from "../src/goalie-tick";
import { ownBunArgv } from "../src/own-bun";
import { envelopeBodyBytes } from "../src/envelope";
import { courierDisposition } from "../src/watch-tick";
import { busActivity } from "../src/watch-detectors";
import { activePane } from "../src/watch-tick";

const REPO = path.resolve(import.meta.dir, "../../..");
// The capture base: the commit the oracle worlds were frozen from. Its only
// sandbox contribution, the judge body, ships as the blob-pinned fixture
// below, so no object from this commit is read at replay time.
const BASE = "68dcc90ac0603b830c0e1f12daa29a768a6709b0";
const ORACLE = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures/goalie-oracle.json"), "utf8"),
) as OracleFixture;

interface ShapeResult {
  rc: number;
  stdout: string;
  stderr: string;
  effects: string[][];
  files: Record<string, string>;
}
interface OracleCase {
  case: string;
  shape: "verb" | "loop";
  env: Record<string, string>;
  world: {
    arm: string | null;
    registry: string;
    ledger: string | null;
    files?: Record<string, string>;
    seats: Record<string, string>;
    ready: { cmd: string };
    send: Record<string, { rc: number; stdout: string }>;
    escalate: { rc: number };
    bus_fail?: number;
    send_script?: string;
  };
  result: ShapeResult;
}
interface OracleFixture {
  captured_from: { base: string; now: string; bash: string; shapes: string[] };
  cases: OracleCase[];
}

const normalize = (s: string, root: string) =>
  s.split(root).join("<WORK>")
    // The minted episode token is a per-run 32-hex nonce (randomBytes at mint
    // time): the capture pinned ITS draw, the replay mints its own. Normalize the
    // nonce on both sides; a divergence in token PLACEMENT or spelling still
    // fails, and the lease module's own tests pin the mint semantics.
    .replace(/[0-9a-f]{32}/g, "<MINT>")
    .replace("/private<WORK>", "<WORK>")
    .replace(/\.escalate\.\d+\.md/g, ".escalate.<PID>.md");

// Ruled divergence (tap-jnoqe): {{TAP_SCRIPT}} renders the public door
// <WORK>/bin/tap; the capture rendered the retired shim path. Applied to the
// captured (expected) side only, so a native rendering of the shim path fails.
const ruledCapture = (s: string) => s.split("<WORK>/skills/tap/scripts/tap.sh").join("<WORK>/bin/tap");

interface Materialized {
  root: string;
  run(): { rc: number; stdout: string; stderr: string; effects: string[][]; courierArgv: () => string[][]; readyEnv: () => string[] };
}

function materialize(c: OracleCase, extraEnv?: Record<string, string | undefined>): Materialized {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-tick-"));
  const w = c.world;
  const sub = (s: string) => s.split("<WORK>").join(root);
  const write = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sub(content));
  };
  for (const [rel, content] of Object.entries(w.files ?? {})) write(rel, content);
  if (w.arm !== null) write("bus/goalie/arm.json", w.arm);
  write("bus/registry.json", w.registry);
  if (w.ledger !== null) write("ledger.md", w.ledger);
  for (const dir of ["bus/payloads", "bus/spool", "bus/receipts", "bus/goalie", "home"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  // The archived capture omitted receipt hashes; today's writer always stamps
  // them. Enrich only the live fixture, leaving the historical evidence intact.
  for (const name of fs.readdirSync(path.join(root, "bus/receipts"))) {
    if (!name.endsWith(".done")) continue;
    const receiptPath = path.join(root, "bus/receipts", name);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (receipt.via !== "reply") continue;
    const reply = fs.readFileSync(path.join(root, "bus/payloads", receipt.reply_id + ".md"));
    receipt.reply_sha256 = createHash("sha256").update(envelopeBodyBytes(reply)!).digest("hex");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  }
  // Replay the historical board contract with an explicitly healthy delivery
  // seat. Degraded-seat outcomes have their own controls in goalie-truth.
  const observer = w.arm ? JSON.parse(w.arm).goalie_handle : "";
  const registryPath = path.join(root, "bus/registry.json");
  const roster = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (observer && roster.seats?.[observer]) {
    roster.seats[observer].session_store_kind = "file";
    roster.seats[observer].session_store_path = path.join(root, "observer.jsonl");
    write("observer.jsonl", JSON.stringify({ type: "assistant", timestamp: new Date(Number(c.env.TAP_GOALIE_NOW) * 1000).toISOString() }) + "\n");
    fs.writeFileSync(registryPath, JSON.stringify(roster));
  }
  // The capture base contributed exactly one file to the sandbox: the judge
  // probe's body, which goalieTick reads at scriptsDir/goalie-templates/judge.md
  // (goalie-tick.ts). Those bytes are identical at 68dcc90 and on main, so they
  // ship as a fixture pinned by their git blob id — R6 U2's "closure pinned at
  // the capture base" semantics with no private history. The unpiped
  // `git archive | tar` this replaces masked a failed extraction as an empty
  // probe body; a missing or edited fixture is now a loud red.
  const JUDGE = path.join(import.meta.dir, "fixtures", "goalie-judge-68dcc90.md");
  const JUDGE_BLOB = "6bcd734ebe25e57e6616920d35cc8fe8f223d018";
  const judge = fs.readFileSync(JUDGE);
  const header = Buffer.from(`blob ${judge.length}\0`);
  if (createHash("sha1").update(header).update(judge).digest("hex") !== JUDGE_BLOB) {
    throw new Error(`goalie-tick: judge fixture ${JUDGE} is not the pinned blob ${JUDGE_BLOB}`);
  }
  const scriptsDir = path.join(root, "skills", "tap", "scripts");
  fs.mkdirSync(path.join(scriptsDir, "goalie-templates"), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "goalie-templates", "judge.md"), judge);
  const courierArgv: string[][] = [];
  const readyEnv: string[] = [];
  const effects: string[][] = [];
  const seats = w.seats ?? {};
  // Doors are PURE executors: the program owns every effect record, mirroring
  // the capture shims (which recorded, then called through).
  const doors: GoalieDoors = {
    lib(fn, args, env) {
      if (fn === "tap_seat_state") {
        return { status: 0, stdout: args[0] === (w.arm ? JSON.parse(w.arm).goalie_handle : "") ? "idle-at-prompt" : seats[args[0] ?? ""] ?? "", stderr: "" };
      }
      if (fn === "tap_supervision_bus_activity") {
        if (w.bus_fail) return { status: w.bus_fail, stdout: "", stderr: "" };
        const out = busActivity(
          path.join(root, "bus/payloads"),
          path.join(root, "bus/receipts"),
          BigInt(args[0] ?? "0"),
          BigInt(args[1] ?? "0"),
          args[2] ?? "",
          "tap",
        );
        return { status: 0, stdout: out, stderr: "" };
      }
      throw new Error("unexpected lib door: " + fn);
    },
    courier(argv) {
      courierArgv.push([...argv]);
      // Default door: `bun <own flags> <main.ts> send <to> ...`; stand-in: `bash <script> <to> ...`.
      const verb = argv[0] === "bun" ? argv.indexOf("send") : -1;
      const to = verb >= 0 ? argv[verb + 1]! : argv[2]!;
      const canned = w.send[to] ?? w.send["default"] ?? { rc: 0, stdout: "" };
      return { status: canned.rc, stdout: sub(canned.stdout), stderr: "" };
    },
    escalate(argv) {
      return { status: w.escalate.rc, stdout: "", stderr: "" };
    },
    ready(argv, env) {
      readyEnv.push(env?.TAP_GOALIE_NOW ?? "");
      const r = Bun.spawnSync([argv[0]!, ...argv.slice(1)], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TAP_GOALIE_NOW: env?.TAP_GOALIE_NOW ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        status: r.exitCode ?? 0,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
      };
    },
  };

  return {
    root,
    run() {
      const res = goalieTick({
        home: path.join(root, "bus"),
        registry: path.join(root, "bus/registry.json"),
        scriptsDir,
        env: { ...c.env, TAP_GOALIE_READY_CMD: w.ready.cmd, ...extraEnv },
        effects,
        doors,
      });
      return { ...res, effects, courierArgv: () => courierArgv, readyEnv: () => readyEnv };
    },
  };
}

const shapeJson = (r: ShapeResult) => JSON.stringify([r.rc, r.stdout, r.stderr, r.effects, r.files]);

describe("goalie tick vs pinned Bash incumbent (R6 U2)", () => {
  const byName = new Map<string, OracleCase[]>();
  for (const c of ORACLE.cases) {
    const list = byName.get(c.case) ?? [];
    list.push(c);
    byName.set(c.case, list);
  }

  for (const [name, shapes] of byName) {
    // Rung 2 now uses a notice; an unreachable observer now reports degraded-delivery.
    // Replacement behavior is exercised by goalie-truth and goalie-delivery tests.
    if (name === "refire-rung2" || name === "fire-observer-unreachable") continue;
    const verb = shapes.find((c) => c.shape === "verb")!;
    const loop = shapes.find((c) => c.shape === "loop")!;
    const divergent = shapeJson(verb.result) !== shapeJson(loop.result);
    test(`${name}: whole-tick differential (${divergent ? "loop-shape ruled" : "both shapes"})`, () => {
      if (divergent) {
        // The port carries the loop's bytes; the captured shapes must differ for
        // the rule to stay honest.
        expect(shapeJson(verb.result)).not.toEqual(shapeJson(loop.result));
      }
      const m = materialize(loop);
      const res = m.run();
      const want = loop.result;
      expect(res.rc).toBe(want.rc);
      expect(normalize(res.stdout, m.root)).toEqual(normalize(ruledCapture(want.stdout.replaceAll("human already woken; wake still unanswered", "human escalation rung; wake still unanswered")), "<WORK>"));
      expect(normalize(res.stderr, m.root)).toEqual(normalize(ruledCapture(want.stderr), "<WORK>"));
      expect(res.effects.filter(e => e[0] !== "delivery_state").map((e) => e.map((f) => normalize(f, m.root)))).toEqual(
        want.effects.map((e) => {
          // Leader's escalation contract correction: the historical capture
          // names the observer; human notifications now name armed_by only.
          const expected = [...e];
          if (expected[0] === "escalate") expected[expected.indexOf("--from") + 1] = JSON.parse(loop.world.arm!).armed_by;
          return expected.map((f) => normalize(ruledCapture(f), "<WORK>"));
        }),
      );
      const expectedFiles = new Set(Object.keys(want.files));
      for (const rel of expectedFiles) {
        const p = path.join(m.root, rel);
        expect(fs.existsSync(p)).toBe(true);
        if (fs.existsSync(p)) {
          expect(normalize(fs.readFileSync(p, "utf8"), m.root)).toEqual(
            normalize(ruledCapture(want.files[rel]!.replaceAll("human already woken; wake still unanswered", "human escalation rung; wake still unanswered")), "<WORK>"),
          );
        }
      }
      for (const rel of ["bus/goalie/tick.log", "bus/goalie/heartbeat"]) {
        if (!expectedFiles.has(rel)) expect(fs.existsSync(path.join(m.root, rel))).toBe(false);
      }
    });
  }

  test("ruled: the default courier door is Bun's own `send` entry; the stand-in gets no verb", () => {
    const loop = byName.get("fire-rung1")!.find((c) => c.shape === "loop")!;
    // Default door: `bun <own flags> <repo>/runtime/bun/main.ts send <to> ...` -- no Bash hop
    const m = materialize(loop);
    const res = m.run();
    expect(res.rc).toBe(loop.result.rc);
    const defArgv = res.courierArgv();
    expect(defArgv.length).toBeGreaterThan(0);
    const head = ownBunArgv("bun");
    expect(head.slice(1)).toEqual([expect.stringMatching(/^--config=.*\/runtime\/bun\/tap-bunfig\.toml$/), "--no-env-file"]);
    expect(defArgv[0]!.slice(0, head.length)).toEqual(head);
    expect(defArgv[0]![head.length]!.endsWith("runtime/bun/main.ts")).toBe(true);
    expect(defArgv[0]![head.length + 1]).toBe("send");
    expect(defArgv[0]![head.length + 2]).toBe("lieutenant-one");
    // Override door: `bash <script> <to> ...` — no `send`, same wire record.
    const m2 = materialize(loop, { TAP_COURIER_SCRIPT: path.join(os.tmpdir(), "goalie-override-send.sh") });
    const res2 = m2.run();
    expect(res2.rc).toBe(res.rc);
    expect(normalize(res2.stdout, m2.root)).toEqual(normalize(res.stdout, m.root));
    const ovrArgv = res2.courierArgv();
    expect(ovrArgv[0]![1]).toBe(path.join(os.tmpdir(), "goalie-override-send.sh"));
    expect(ovrArgv[0]!.includes("send")).toBe(false);
    expect(ovrArgv[0]![2]).toBe("lieutenant-one");
    expect(res.effects.map((e) => e.map((f) => normalize(f, m.root)))).toEqual(
      res2.effects.map((e) => e.map((f) => normalize(f, m2.root))),
    );
  });

  test("ruled: the ready age uses the tick's own clock when TAP_GOALIE_NOW is absent", () => {
    const loop = byName.get("ready-age-from-now")!.find((c) => c.shape === "loop")!;
    const m = materialize(loop, { TAP_GOALIE_NOW: undefined });
    const res = m.run();
    // The probe received the tick's clock exactly once, and the rendered age is
    // arithmetic on THAT value — not a second Date.now() that can straddle a
    // second boundary and move the age by one.
    const received = res.readyEnv();
    expect(received.length).toBeGreaterThan(0);
    const probeNow = Number(received[0]);
    expect(probeNow).toBeGreaterThan(0);
    // The tick-line stamp IS the tick's clock: it must be the SAME second the
    // probe received. A second Date.now() straddling a second boundary would
    // move the ready age (and this stamp) by one.
    const stamp = /tap goalie: (\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})Z/.exec(res.stdout);
    expect(stamp).not.toBeNull();
    const stampEpoch = stamp
      ? Date.UTC(+stamp[1]!.slice(0, 4), +stamp[1]!.slice(5, 7) - 1, +stamp[1]!.slice(8, 10),
        +stamp[2]!, +stamp[3]!, +stamp[4]!) / 1000
      : -1;
    expect(probeNow).toBe(stampEpoch);
    // created_at is pinned at 1787190000 (= captured NOW - 10000): the rendered
    // age is arithmetic on the clock the probe actually received.
    expect(res.stdout).toContain(`QUEUE-AGE ${Math.floor((probeNow - 1787190000) / 60)}m top=tap-x`);
  });
});

// R6 U3 review: the production bus-activity door must take the team from the
// ENROLLMENT key (spoolTeamName), never from registry content, which is
// pre-authority after the flip and may be decoy or relocated.
describe("production doors", () => {
  test("bus activity filters addressed-to-local by the enrollment name, not registry content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-doors-"));
    try {
      const home = path.join(root, "repo/.tap/bus");
      fs.mkdirSync(path.join(home, "payloads"), { recursive: true });
      fs.mkdirSync(path.join(home, "receipts"), { recursive: true });
      // DECOY registry content: a different team name than the enrollment says.
      fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({ team: { name: "decoy-team" } }));
      const idx = path.join(root, "idx");
      fs.mkdirSync(idx, { recursive: true });
      fs.writeFileSync(path.join(idx, "global-registry.json"), JSON.stringify(
        { schema: "0.20", teams: { tap: { root: fs.realpathSync(path.join(root, "repo")),
          registry_location: path.join(home, "registry.json") } } }));
      const now = "5000";
      // Team-QUALIFIED payloads: the tap-addressed one is local under the
      // enrollment name; the decoy-addressed one is local only under the decoy
      // name. Without to_team both would be legacy-local for ANY team and the
      // control would prove nothing.
      fs.writeFileSync(path.join(home, "payloads", "w1.md"),
        "---\nid: w1\nfrom: foreign-seat\nto: lead\nto_team: tap\nkind: discuss\n---\nreal work\n");
      fs.writeFileSync(path.join(home, "payloads", "w2.md"),
        "---\nid: w2\nfrom: foreign-seat\nto: lead\nto_team: decoy-team\nkind: discuss\n---\nother work\n");
      // Distinct ages: whichever payload an authority counts, its answer names
      // that payload's age — the two authorities cannot collide.
      fs.utimesSync(path.join(home, "payloads", "w1.md"), new Date(1000_000), new Date(1000_000));
      fs.utimesSync(path.join(home, "payloads", "w2.md"), new Date(2000_000), new Date(2000_000));
      const env = { TAP_HOME: home, TAP_INDEX_HOME: idx } as unknown as NodeJS.ProcessEnv;
      const doors = realGoalieDoors(REPO + "/skills/tap/scripts", env);
      const out = doors.lib("tap_supervision_bus_activity", [now, "0", "lead"], {});
      const asTap = busActivity(path.join(home, "payloads"), path.join(home, "receipts"),
        BigInt(now), 0n, "lead", "tap");
      const asDecoy = busActivity(path.join(home, "payloads"), path.join(home, "receipts"),
        BigInt(now), 0n, "lead", "decoy-team");
      // The two authorities genuinely disagree about this board.
      expect(asTap).not.toBe(asDecoy);
      expect(asTap).not.toBe("");
      // The door answers with the ENROLLMENT authority: w1 counts, w2 does not.
      expect(out.status).toBe(0);
      expect(out.stdout).toBe(asTap);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// R6 U3 review round 2: the PRODUCTION entry must take the roster from the
// acting TAP_REGISTRY (relocated away from the bus). The observable is the
// WAKE: with the relocated roster the stale feeder fires and the fake courier
// records it; with only the empty bus registry there is no roster and no wake.
describe("production entry (tickEntry)", () => {
  interface FireWorld { root: string; home: string; idx: string; relocated: string; courier: string; tmuxBin: string }
  function fireWorld(): FireWorld {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-entry-"));
    const home = path.join(root, "repo/.tap/bus");
    fs.mkdirSync(path.join(home, "payloads"), { recursive: true });
    fs.mkdirSync(path.join(home, "goalie"), { recursive: true });
    // Bus registry is EMPTY: any roster the tick sees must come from TAP_REGISTRY.
    fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "tap" }, seats: {} }));
    const idx = path.join(root, "idx");
    fs.mkdirSync(idx, { recursive: true });
    fs.writeFileSync(path.join(idx, "global-registry.json"), JSON.stringify(
      { schema: "0.20", teams: { tap: { root: fs.realpathSync(path.join(root, "repo")),
        registry_location: path.join(home, "registry.json") } } }));
    // Relocated roster: one LONG-STALE feeder with an ageable session store.
    const store = path.join(root, "stores", "feeder.jsonl");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ type: "assistant", timestamp: "1970-01-01T00:16:40Z" }) + "\n");
    const relocated = path.join(root, "relocated-registry.json");
    fs.writeFileSync(relocated, JSON.stringify({ schema: "0.20", team: { name: "tap" }, seats: {
      "goalie-seat": { status: "active", delivery: "pane", pane: "%8", harness: "claude" },
      "feeder-seat": { status: "active", delivery: "pane", pane: "%9",
        session_store_kind: "file", session_store_path: store } } }));
    // Fake tmux: every pane alive except %5; fake courier: mints an
    // expected-reply payload, reports the accepted tuple, records the wake.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tmux"),
      "#!/bin/sh\nif [ \"$1\" = capture-pane ]; then printf 'transcript\\n──────────\\n❯ \\n──────────\\n'; exit 0; fi\n[ \"$1\" = display-message ] && [ \"$3\" = -t ] && [ \"$4\" = %5 ] && exit 0\n[ \"$1\" = display-message ] && [ \"$3\" = -t ] && printf '%s\\n' \"$4\"\nexit 0\n");
    fs.chmodSync(path.join(bin, "tmux"), 0o755);
    const courier = path.join(root, "fake-courier.sh");
    fs.writeFileSync(courier, "#!/bin/sh\nto=\"$1\"\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = -m ]; then shift; break; fi; shift; done\nid=\"wake-$(date +%s%N)\"\np=\"$TAP_HOME/payloads/$id.md\"\nprintf -- '---\nid: %s\nfrom: goalie-seat\nto: %s\nto_team: tap\nkind: discuss\nreply: expected\n---\n\nboard\n' \"$id\" \"$to\" > \"$p\"\nprintf '{\"status\":\"injected\",\"delivery\":\"pane\",\"detail\":\"\",\"action\":\"\",\"id\":\"%s\",\"path\":\"%s\"}\n' \"$id\" \"$p\"\nprintf '%s\n' \"$to\" >> \"$TAP_HOME/goalie/wakes.log\"\n");
    fs.chmodSync(courier, 0o755);
    return { root, home, idx, relocated, courier, tmuxBin: bin };
  }

  function armLease(home: string, now: string): void {
    fs.writeFileSync(path.join(home, "goalie", "arm.json"), JSON.stringify({
      armed_by: "lead", armed_at: String(Number(now) - 60),
      threshold_seconds: "60", tick_interval_seconds: "60",
      goalie_handle: "goalie-seat", feeder: "feeder-seat", seats: {},
    }));
  }

  function entryEnv(w: FireWorld, withRoster: boolean): NodeJS.ProcessEnv {
    const env = {
      TAP_HOME: w.home,
      TAP_INDEX_HOME: w.idx,
      TAP_REGISTRY: withRoster ? w.relocated : "",
      TAP_GOALIE_NOW: "5000",
      TAP_GOALIE_QUORUM_MIN_SEATS: "1",
      TAP_GOALIE_READY_CMD: "printf '[]'",
      TAP_COURIER_SCRIPT: w.courier,
      PATH: w.tmuxBin + ":" + (process.env.PATH ?? ""),
    } as unknown as NodeJS.ProcessEnv;
    delete env.TMUX; delete env.TMUX_PANE;
    delete env.TAP_TMUX_SOCKET; delete env.TAP_TMUX_SOCKET_PATH;
    return env;
  }

  test("a relocated acting registry drives the board; the empty bus registry does not", () => {
    const w = fireWorld();
    try {
      // WITHOUT the relocated roster: no seats, no fire, no wakes.
      armLease(w.home, "5000");
      const quiet = tickEntry(entryEnv(w, false));
      // No roster in the acting registry: the board never assembles.
      expect(quiet.stdout).not.toContain("verdict=rung3");

      // WITH the relocated roster: the board FIRES (verdict on stdout) and the
      // WAKE reaches the feeder through the courier door — both artifacts are
      // asserted so neither a silent tick nor a stdout-only echo can pass.
      armLease(w.home, "5000");
      const res = tickEntry(entryEnv(w, true));
      // The relocated roster includes a ready delivery seat, so the stale
      // feeder receives the first wake; the empty registry cannot do this.
      expect(res.stdout).toContain("verdict=deadlock");
      expect(fs.readFileSync(path.join(w.home, "goalie/wakes.log"), "utf8")).toContain("feeder-seat");
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  });
});

// The failed judge probe is the tick's ONLY stderr producer: the durable send
// refuses with `failed (rc=1)` and the loop entry forwards it verbatim (rc
// ignored, incumbent `tick || true`). The board stays quiet so the per-seat
// pass runs; the canned doors make the feeder idle at its prompt and the
// courier fail on every send.
test("a failed durable judge probe surfaces as the tick's stderr diagnostic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-probe-"));
  const bus = path.join(root, "bus");
  fs.mkdirSync(path.join(bus, "goalie"), { recursive: true });
  fs.mkdirSync(path.join(bus, "payloads"), { recursive: true });
  fs.writeFileSync(path.join(bus, "goalie", "arm.json"), JSON.stringify({
    armed_by: "lead", armed_at: "4950", threshold_seconds: "10", interval_seconds: "60",
    goalie_handle: "goalie", feeder: "feeder-seat", seats: {},
  }));
  fs.writeFileSync(path.join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "tap" }, seats: {
    lead: { status: "active", delivery: "pane", pane: "%0" },
    goalie: { status: "active", delivery: "pane", pane: "%8" },
    "feeder-seat": { status: "active", delivery: "pane", pane: "%9" },
  } }));
  const env = {
    TAP_GOALIE_NOW: "5000",
    TAP_GOALIE_QUORUM_MIN_SEATS: "1",
    TAP_GOALIE_READY_CMD: "printf '[]'",
    PATH: process.env.PATH ?? "",
  } as NodeJS.ProcessEnv;
  const libCalls: string[] = [];
  const doors: GoalieDoors = {
    lib: (fn, args) => {
      libCalls.push(fn + ":" + (args[0] ?? ""));
      if (fn === "tap_seat_state") {
        return { status: 0, stdout: ["feeder-seat", "goalie"].includes(args[0] ?? "") ? "idle-at-prompt" : "unknown", stderr: "" };
      }
      if (fn === "tap_supervision_bus_activity") return { status: 0, stdout: "4950", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    courier: () => ({ status: 1, stdout: "", stderr: "" }),
    escalate: () => ({ status: 0, stdout: "", stderr: "" }),
    ready: () => ({ status: 0, stdout: "[]\n", stderr: "" }),
  };
  const res = goalieTick({
    home: bus,
    registry: path.join(bus, "registry.json"),
    scriptsDir: path.join(REPO, "skills/tap/scripts"),
    env,
    doors,
  });
  expect(res.stdout).toContain("verdict=quiet");
  expect(libCalls).toContain("tap_seat_state:feeder-seat");
  expect(res.stderr).toContain("failed (rc=1)");
  fs.rmSync(root, { recursive: true, force: true });
});

test("deadlock human notification uses the armer with observer and feeder kept distinct", () => {
  for (const mode of ["-f", "-m"]) {
  const original = ORACLE.cases.find(c => c.shape === "loop" && c.result.effects.some(e => e[0] === "escalate" && e.includes(mode)))!;
  expect(original).toBeDefined();
  for (const armer of ["run-owner", ""]) {
    const c = structuredClone(original), arm = JSON.parse(c.world.arm!);
    arm.armed_by = armer; arm.goalie_handle = "observer"; arm.feeder = "feeder";
    c.world.arm = JSON.stringify(arm);
    const roster = JSON.parse(c.world.registry);
    roster.seats.observer = { status: "active", pane: "%8" };
    c.world.registry = JSON.stringify(roster);
    // The independent source corpus supplies the trigger; only names differ.
    const m = materialize(c);
    const r = m.run(), notifications = r.effects.filter(e => e[0] === "escalate" && e.includes(mode));
    if (armer) {
      expect(notifications.length).toBeGreaterThan(0);
      for (const args of notifications) expect(args[args.indexOf("--from") + 1]).toBe(armer);
    } else {
      expect(notifications).toEqual([]); expect(r.stderr).toContain("no valid recorded armer");
      expect(r.stdout).not.toContain("human-woken");
    }
  }
  }
});

// Formerly lib.sh `tap_registry_active_pane`: each refusal rung flips one
// field of an otherwise-active row (the goalie.ts twin had dropped `launching`).
describe("activePane", () => {
  const rowOk = { status: "active", delivery: "pane", pane: "%3" };
  const cases: Array<[string, Record<string, unknown> | undefined, boolean]> = [
    ["active pane row", rowOk, true],
    ["status absent reads as active", { delivery: "pane", pane: "%3" }, true],
    ["absent handle", undefined, false],
    ["poll member", { ...rowOk, delivery: "poll" }, false],
    ["suspended", { ...rowOk, status: "suspended" }, false],
    ["null status", { ...rowOk, status: null }, false],
    ["launching", { ...rowOk, status_reason: "launching" }, false],
    ["empty pane", { ...rowOk, pane: "" }, false],
    ["null pane", { ...rowOk, pane: null }, false],
  ];
  for (const [name, row, want] of cases) {
    test(name, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "active-pane-"));
      const reg = path.join(dir, "registry.json");
      fs.writeFileSync(reg, JSON.stringify({ schema: "0.20", seats: row ? { s: row } : {} }));
      expect(activePane(reg, "s")).toBe(want);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  test("unreadable registry is not active", () => {
    expect(activePane(path.join(os.tmpdir(), "no-such-registry-" + process.pid + ".json"), "s")).toBe(false);
  });
});

test("courierDisposition accepts exactly the courier's durable tuples", () => {
  const out = (o: Record<string, unknown>) => JSON.stringify(o);
  const accepted: Array<[number, string, string, string]> = [
    [0, out({ status: "injected", delivery: "pane" }), "injected", "pane"],
    [0, out({ status: "queued", delivery: "spool" }), "queued", "spool"],
    [0, out({ status: "queued", delivery: "poll" }), "queued", "poll"],
    [0, out({ status: "queued", delivery: "harness-queue", turn: "unconfirmed" }), "queued", "harness-queue"],
    [5, out({ status: "pending" }), "pending", ""],
  ];
  for (const [rc, stdout, status, delivery] of accepted) expect(courierDisposition(rc, stdout, "")).toEqual({ accepted: true, status, delivery });
  const refused: Array<[number, string]> = [
    [0, out({ status: "queued", delivery: "harness-queue" })],
    [0, out({ status: "queued", delivery: "harness-queue", turn: "confirmed" })],
    [0, out({ status: "injected", delivery: "harness-queue", turn: "unconfirmed" })],
    [1, out({ status: "queued", delivery: "harness-queue", turn: "unconfirmed" })],
    [0, out({ status: "mystery", delivery: "spool" })],
    [0, "not-json"],
  ];
  for (const [rc, stdout] of refused) expect(courierDisposition(rc, stdout, "boom\nmore").accepted).toBe(false);
  expect(courierDisposition(0, "not-json", "boom\nmore")).toEqual({ accepted: false, detail: "boom", action: "tap doctor" });
});
