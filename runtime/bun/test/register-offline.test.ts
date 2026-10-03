import { expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

const ROOT = join(import.meta.dir, "../../..");
const REGISTER_SH = join(ROOT, "scripts/tap.sh"); const MAIN_TS = join(ROOT, "runtime/bun/main.ts");

function fixture() {
  const root = join(tmpdir(), `tap-register-offline-${Date.now()}-${Math.random().toString(36).slice(2)}`); const wt = join(root, "team"); // enrolled worktree root; the door's cwd
  const bus = join(wt, ".tap", "bus"), index = join(root, "index"), home = join(root, "home"), reg = join(bus, "registry.json");
  for (const dir of [join(wt, ".tap"), join(bus, "payloads"), join(bus, "receipts"), index, home]) mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", wt]);
  const enroll = (loc: string) => writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { team: { enrolled_at: "2026-08-23T00:00:00Z", registry_location: loc, root: wt, state: "registered" } } })); enroll(reg);
  const rawDoc = (doc: unknown) => typeof doc === "string" ? doc : JSON.stringify(doc).replace('"__WIDE__"', "9007199254740993"); // wide int spliced raw: a JS number would lose the lexeme's precision before serialization
  const writeReg = (doc: unknown) => writeFileSync(reg, `${rawDoc(doc)}\n`); const baseDoc = () => ({ schema: "0.20", team: { name: "team", worktree_root: wt }, future_section: { keep: 1 },
    seats: { sol: { instance: "sol|0123456789abcdef", status: "active", pane: "sol:0.0", harness: "claude", delivery: "pane",
      registered_at: "2026-08-23T10:00:00Z", note: "café ☕\u007f", weight: "__WIDE__" }, // DEL rides preserved metadata: json.dump(ensure_ascii) escapes it
      other: { instance: "other|ffffffffffffffff", status: "active" } } }); const env = (extra: NodeJS.ProcessEnv = {}) =>
    ({ ...process.env, HOME: home, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_SELF: "", TMUX: "", TMUX_PANE: "", ...extra });
  return { root, wt, bus, index, home, reg, writeReg, baseDoc, rawDoc, env, enroll };
}

type F = ReturnType<typeof fixture>;

function door(f: F, kind: "default" | "direct", args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const rest = args[0] === "in" || args[0] === "register" ? args.slice(1) : args; // the direct door receives argv without the verb (the root scripts/tap.sh door shifts it)
  const argv = kind === "direct" ? ["bash", REGISTER_SH, "in", ...rest] : [join(ROOT, "bin/tap"), ...args];
  const r = Bun.spawnSync(argv, { cwd: f.wt, env: f.env(extraEnv), stdout: "pipe", stderr: "pipe", timeout: 30000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function slice(f: F, name: string, extraEnv: NodeJS.ProcessEnv = {}) { // the native offline door, exercised directly
  const r = Bun.spawnSync(["bun", MAIN_TS, "in", name, "--offline"], { cwd: f.wt, env: f.env({ ...extraEnv }), stdout: "pipe", stderr: "pipe", timeout: 30000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function oracle(f: F, name: string): string { // incumbent serializer (json.dump indent=2, sort_keys) over the heredoc's mutation — differential, not hand-typed
  const script = ["import json, sys", `doc = json.load(open(${JSON.stringify(f.reg)}))`,
    `key = "seats" if isinstance(doc.get("seats"), dict) else "agents"`, "agents = doc.setdefault(key, {})",
    "if not isinstance(agents, dict): agents = {}", "doc[key] = agents", `ent = agents.get(${JSON.stringify(name)})`,
    "if ent is None: ent = {}", 'ent["status"] = "suspended"; ent["status_reason"] = "user_removed"',
    `agents[${JSON.stringify(name)}] = ent; doc[key] = agents`,
    "sys.stdout.write(json.dumps(doc, indent=2, sort_keys=True) + chr(10))"].join("\n"); const r = Bun.spawnSync(["python3", "-B", "-c", script], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`oracle failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}


const MARKED = (name: string) => `tap register: marked ${name} offline (suspended/user_removed)\n`; const events = (f: F) => readFileSync(join(f.bus, "registry-events.log"), "utf8").split("\n").filter(l => l.includes("action=offline"));
const unmutated = (f: F) => expect(readFileSync(f.reg, "utf8")).toBe(`${f.rawDoc(f.baseDoc())}\n`); // no partial write on refusal

test("offline marks an existing seat losslessly, byte-identically on both doors", () => {
  for (const kind of ["default", "direct"] as const) {
    const f = fixture();
    try {
      f.writeReg(f.baseDoc()); const d = door(f, kind, ["in", "sol", "--offline"]); expect(d.code, d.err).toBe(0);
      expect(d.out).toBe(MARKED("sol"));
      expect(d.err).toBe(""); expect(readFileSync(f.reg, "utf8")).toBe(oracle(f, "sol")); expect(oracle(f, "sol")).toContain("\\u007f"); // wide-int + café ☕ + DEL survive exactly
      expect(JSON.parse(readFileSync(f.reg, "utf8"))).toHaveProperty(["seats", "other", "status"], "active"); writeFileSync(join(f.bus, "reset-generation.json"), '{"state":"pristine"}\n');
      const a = door(f, kind, ["register", "sol", "--remove"]); // register verb + --remove alias, same bytes and status
      expect(a.code, a.err).toBe(0); expect(a.out).toBe(MARKED("sol")); expect(readFileSync(f.reg, "utf8")).toBe(oracle(f, "sol")); const reset = JSON.parse(readFileSync(join(f.bus, "reset-generation.json"), "utf8"));
      expect(reset.state).toBe("reused"); expect(reset.first_mutation).toBe("register");
    } finally { removeScratchTree(f.root); }
  }
}, 60000);

test("missing row: placeholder warning, JSON-mode receipt, prior_existing polarity, event", () => {
  const f = fixture();
  try {
    f.writeReg(f.baseDoc()); const d = door(f, "default", ["in", "ghost", "--offline"]); expect(d.code, d.err).toBe(0);
    expect(d.out).toBe(MARKED("ghost")); expect(d.err).toBe("tap register: warning: no existing entry for 'ghost' — creating offline placeholder\n");
    expect(readFileSync(f.reg, "utf8")).toBe(oracle(f, "ghost")); expect(events(f).length).toBe(1);
    const j = door(f, "default", ["in", "ghost2", "--offline", "--json"]); // text briefing prints nothing extra for offline; JSON emits the receipt object
    expect(j.code, j.err).toBe(0); expect(j.out.startsWith(`{"ok":true,"receipt":`)).toBe(true); expect(j.out).toContain(`"action":"offline"`); expect(j.err).toContain("no existing entry for 'ghost2'");
    const rerun = door(f, "default", ["in", "ghost", "--offline"]); // placeholder row now exists: prior_existing flips
    expect(rerun.code, rerun.err).toBe(0); expect(rerun.out).toBe(MARKED("ghost")); expect(rerun.err).toBe(""); const e = door(f, "default", ["in", "sol", "--offline", "--json"]); // existing row: carrier polarity reaches seat_history
    expect(e.code, e.err).toBe(0); expect(JSON.parse(e.out).seat_history.prior_existing).toBe(true); f.writeReg(f.baseDoc());
    const v = slice(f, "sol", { TAP_VERBOSE: "1" }); expect(v.code).toBe(0); expect(v.err).toContain(`tap verbose: {"event":"state_write"`); expect(v.err).toContain(f.reg); // the incumbent's opt-in state_write diagnostic, before publication
  } finally { removeScratchTree(f.root); }
}, 60000);

test("invalid JSON registry refuses with no partial write; invalid flip marker refuses", () => {
  const f = fixture();
  try {
    f.writeReg("{not json"); const d = door(f, "default", ["in", "sol", "--offline"]); expect(d.code).toBe(1);
    expect(d.err).toBe(`tap register: registry '${realpathSync(f.reg)}' is invalid JSON; refusing to overwrite it (expected a key at 1); next: repair registry\n`); // post-C: the unreadable registry is refused at the mutation gate, physical paths
    expect(readFileSync(f.reg, "utf8")).toBe("{not json\n"); // writeReg's trailing newline is the fixture's
    const s = slice(f, "sol"); expect(s.code).toBe(1); // the door's refusal bytes, unit-level
    expect(s.err.startsWith(`tap register: registry '${realpathSync(f.reg)}' is invalid JSON; refusing to overwrite it (`)).toBe(true); expect(readFileSync(f.reg, "utf8")).toBe("{not json\n");
    writeFileSync(join(f.index, "global-registry.json"), "{invalid"); f.writeReg(f.baseDoc());
    const m = door(f, "default", ["in", "sol", "--offline"]); expect(m.code).toBe(1); // door bytes = incumbent precondition, verified at BASE: it refuses before the slice when the marker itself is the unreadable index
    expect(m.err).toBe("tap register: registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation; next: tap doctor\n"); unmutated(f);
    const w = slice(f, "sol"); expect(w.code).toBe(1); expect(w.err).toContain("registry flip marker is present but invalid"); // post-C: the marker gate classifies and refuses before any authority walk
    unmutated(f);
  } finally { removeScratchTree(f.root); }
}, 60000);
test("authority moved: the 2-attempt rebind lands the suspend on the moved authority (incumbent parity)", async () => {
  const f = fixture();
  try {
    const moved = join(f.root, "moved-registry.json"); // enrollment now names a different acting registry
    writeFileSync(moved, `${f.rawDoc(f.baseDoc())}\n`); f.enroll(moved); f.writeReg(f.baseDoc()); const d = slice(f, "sol"); expect(d.code).toBe(0); // rc17 -> rebind to the enrolled authority -> retry succeeds
    const movedDoc = JSON.parse(readFileSync(moved, "utf8")); expect(movedDoc.seats.sol.status).toBe("suspended"); unmutated(f);
    f.enroll(f.reg); // re-enroll: the rebind half above left the index pointing at `moved`
    // Holder polled to a PROVEN hold (python startup races the slice). The slice waits indefinitely (the incumbent's
    // flock had no ceiling) so contended mutation SUCCEEDS once the holder exits; the door is NOT pinned to respect a
    // pre-existing sidecar flock (preconditions open <registry>.lock "w", tap-register.sh:1078).
    const holder = Bun.spawn(["python3", "-B", "-c",
      `import fcntl,time; f=open(${JSON.stringify(`${f.reg}.lock`)},"w"); fcntl.flock(f, fcntl.LOCK_EX); time.sleep(3)`], { stdout: "ignore", stderr: "ignore" });
    try {
      const nbCheck = `import fcntl,sys\nf=open(${JSON.stringify(`${f.reg}.lock`)},"w")\ntry:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\n    sys.exit(0)\nexcept BlockingIOError:\n    sys.exit(3)`;
      let proven = false;
      for (let i = 0; i < 100 && !proven; i++) { await Bun.sleep(50); proven = spawnSync("python3", ["-B", "-c", nbCheck], { encoding: "utf8" }).status === 3; }
      expect(proven, "holder never proved its hold").toBe(true); const waited = slice(f, "sol"); // contended: waits out the 3s holder, then mutates
      expect(waited.code).toBe(0); expect(waited.out).toBe(MARKED("sol")); expect(readFileSync(f.reg, "utf8")).toBe(oracle(f, "sol"));
    } finally { holder.kill(); }
    // Same usable sidecar, but the grant-marker dir is unwritable: the helper cannot announce its grant, so the
    // gone-file terminal signal must refuse PROMPTLY instead of spinning on a deadline the Infinity arm does not have.
    closeSync(openSync(`${f.reg}.lock`, "w")); f.writeReg(f.baseDoc()); chmodSync(f.bus, 0o555); const t1 = Date.now(); const gone = slice(f, "sol"); expect(gone.code).not.toBe(0);
    expect(Date.now() - t1, "failed grant handshake must refuse promptly").toBeLessThan(10_000); unmutated(f);
  } finally { chmodSync(f.bus, 0o755); removeScratchTree(f.root); }
}, 60000);
test("non-object docs and non-object rows refuse locally with the incumbent's classes", () => {
  const f = fixture();
  try {
    f.writeReg("[1,2]"); const d = slice(f, "sol"); expect(d.code).toBe(1); expect(d.err).toBe(`tap register: registry '${realpathSync(f.reg)}' is invalid JSON; refusing to overwrite it (not an object); next: repair registry\n`); f.writeReg({ schema: "0.20", seats: { sol: 5 } });
    const r = slice(f, "sol"); expect(r.code).toBe(1); expect(r.err).toContain("sol");
  } finally { removeScratchTree(f.root); }
}, 60000);
test("offline composes with --pane as today; --crew stays parser-refused", () => {
  const f = fixture();
  try {
    f.writeReg(f.baseDoc()); const pane = door(f, "default", ["in", "sol", "--offline", "--pane", "x:0"]); expect(pane.code, pane.err).toBe(0); expect(pane.out).toBe(MARKED("sol"));
    expect(readFileSync(f.reg, "utf8")).toBe(oracle(f, "sol")); f.writeReg(f.baseDoc()); const crew = door(f, "default", ["in", "sol", "--offline", "--crew"]); // --crew + --offline is a usage error before any mutation
    expect(crew.code).toBe(1); expect(crew.err).toContain("--crew requires an active pane member and is incompatible with --offline"); unmutated(f);
  } finally { removeScratchTree(f.root); }
}, 60000);
test("an unusable sidecar fails promptly instead of waiting forever", () => {
  const f = fixture();
  try {
    f.writeReg(f.baseDoc());
    mkdirSync(`${f.reg}.lock`); // a directory where the sidecar must be: the incumbent's open("w") failed here, promptly
    const t0 = Date.now(); const held = slice(f, "sol"); expect(held.code).not.toBe(0); expect(Date.now() - t0, "unusable sidecar must fail before any wait ceiling").toBeLessThan(10_000); unmutated(f);
  } finally { removeScratchTree(f.root); }
}, 30000);
test("forwarding supersession projects from current seats", () => {
  const f = fixture();
  try {
    const legacy = { schema: "0.20", team: { name: "team", worktree_root: f.wt }, seats: { sol: { instance: "sol|0123456789abcdef", status: "active" } },
      seat_forwardings: [{ source: "sol", source_instance: "sol|0123456789abcdef", address_active: true }] };
    f.writeReg(legacy); const r = slice(f, "sol"); expect(r.code).toBe(0); expect(r.out).toBe(MARKED("sol"));
    expect(JSON.parse(readFileSync(f.reg, "utf8"))).toEqual({
      ...legacy,
      seats: { sol: { instance: "sol|0123456789abcdef", status: "suspended", status_reason: "user_removed" } },
      seat_forwardings: [{ source: "sol", source_instance: "sol|0123456789abcdef", address_active: false, custody_revoked: true }],
    });
    expect(readFileSync(f.reg, "utf8")).toBe(oracle(f, "sol"));
  } finally { removeScratchTree(f.root); }
}, 60000);
