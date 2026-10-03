import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, releaseScratch } from "./support/send-delivery-fixture";
import { sentinelRecipientState } from "../src/existing-sentinel";
import { loadGlobalRegistry, resolveTeamMarkerAware, resolveTeamMarkerAwareWithEvidence } from "../src/index-home";

afterAll(releaseScratch, 40_000);
const REPO = resolve(import.meta.dir, "../../..");
const wire = (id: string) => `[[TAP v0.23 note ${id}]]`;

// The native courier's staged-sentinel-first submit over its production draft
// effects and the fixture's PATH tmux; exit codes keep the retired Bash door's
// numbering (0 submitted, 5 unverified, 6 identity/recipient refusal).
const SUBMIT = `
const e = process.env, src = e.C1_REPO + "/runtime/bun/src";
const {submitVerify} = await import(src + "/courier.ts");
const {DARK_EFFECTS} = await import(src + "/deliver.ts");
const {draftEffects} = await import(src + "/spool-drain-effects.ts");
const row = JSON.parse(await Bun.file(e.C1_REGISTRY).text()).seats.rb;
const r = submitVerify("rb:0.0", e.C1_NEW_ID, e.C1_NEW_WIRE, { paneId: row.pane_id, harness: "codex", handle: "rb", instance: row.instance, serverEpoch: row.server_epoch },
  { scriptsDir: e.C1_REPO + "/skills/tap/scripts", agentFamilies: new Set(["codex"]), busHome: e.TAP_HOME, recipient: "rb", registryPath: e.C1_REGISTRY,
    preserveDraft: false, eventContext: { actor: "courier", log: e.C1_EVENT_LOG || e.TAP_HOME + "/registry-events.log", team: "alpha", verb: "tap" } },
  draftEffects(DARK_EFFECTS));
if ("detail" in r) console.error(r.status + ": " + r.detail);
const rc = { injected: 0, harness_queued: 7, pane_gone: 3, unverified: 5, attempt_evidence_unwritable: 5,
  identity_mismatch: 6, team_reset_fenced: 6, clearing: 6 }[r.status];
process.exit(rc ?? 4);
`;

function setup(oldWire = wire("old"), recipient: string | null = "rb") {
  const f = fixture({ draft: oldWire, harness: "codex" });
  // This fixture's generic rule is input to Codex, not recognized footer chrome.
  const tmux = join(f.root, "bin/tmux");
  writeFileSync(tmux, readFileSync(tmux, "utf8").replaceAll("──────────────────────────────────────────", "gpt-6-astra high · Context 90% left · /tmp"));
  const rows = JSON.parse(readFileSync(f.registry, "utf8"));
  rows.seats.rb.harness = "codex";
  writeFileSync(f.registry, JSON.stringify(rows));
  if (recipient !== null) writeFileSync(join(f.bus, "payloads/old.md"), `---\nid: old\nto: ${recipient}\n---\nold body\n`);
  return { ...f, bus: realpathSync(f.bus) };
}

function submit(f: ReturnType<typeof setup>, id = "new", env: NodeJS.ProcessEnv = {}) {
  const preload = env.C1_FAULT_OWNER ? ["--preload", env.C1_FAULT_OWNER] : [];
  const p = spawnSync(process.execPath, [...preload, "-e", SUBMIT], {
    cwd: f.wt, encoding: "utf8", timeout: 40_000,
    env: { ...f.env, TAP_HOME: f.bus, TAP_TUI_SETTLE_SCALE: "0", C1_REPO: REPO,
      C1_REGISTRY: f.registry, C1_NEW_ID: id, C1_NEW_WIRE: wire(id), C1_EVENT_LOG: "", ...env },
  });
  const text = (name: string) => existsSync(name) ? readFileSync(name, "utf8") : "";
  return { code: p.status, error: p.error, stderr: p.stderr,
    keys: text(f.keys), events: text(join(f.bus, "registry-events.log")), band: text(join(f.root, "band")) };
}

test("agrees: existing sentinel is submitted before the new payload", () => {
  const f = setup();
  const r = submit(f);
  expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 });
  // The staged wire's Enter, then the new wire's submit and completion Enters.
  expect(r.keys.match(/Enter/g)).toHaveLength(3);
  expect(r.events).not.toContain("stuck_submit_uncorroborated");
});

test("same existing id is submitted without reinjection", () => {
  const f = setup();
  const r = submit(f, "old");
  expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 });
  expect(r.keys).not.toContain(" -l ");
});

for (const recipient of ["other", "wrong/rb", "alpha/", "alpha/rb:extra"]) {
  test(`disagrees: ${recipient} refuses without Enter or injection`, () => {
    const f = setup(wire("old"), recipient);
    const r = submit(f);
    expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 6 });
    expect(r.keys).toBe("");
    expect(r.band).toBe(wire("old"));
  });
}

for (const recipient of [null, ""]) {
  test(`unavailable payload (${String(recipient)}) submits with a durable event`, () => {
    const f = setup(wire("old"), recipient);
    const r = submit(f, "old");
    expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 });
    expect(r.stderr).toContain("submitting it uncorroborated");
    expect(r.events).toContain("action=stuck_submit_uncorroborated handle=rb pane=rb:0.0 detail=id=old team=alpha");
    expect(r.keys).toContain("Enter");
  });
}

test("recipient oracle keeps all five states and full token/whitespace semantics", () => {
  const f = setup();
  for (const [recipient, state] of [
    ["rb", "match"], ["alpha/rb", "match"], ["alpha:rb", "match"],
    ["other", "recipient_mismatch"], ["other/rb", "recipient_mismatch"],
    ["alpha/", "recipient_malformed"], ["alpha/rb:extra", "recipient_malformed"],
    ["alpha/rb\n", "recipient_malformed"], ["rb\r", "recipient_malformed"], ["alpha/rb/extra", "recipient_malformed"],
  ] as const) expect(sentinelRecipientState(f.registry, "rb", recipient)).toBe(state);
  writeFileSync(f.registry, '{"team":{"name":""}}');
  expect(sentinelRecipientState(f.registry, "rb", "rb")).toBe("match");
  expect(sentinelRecipientState(f.registry, "rb", "alpha/rb")).toBe("team_missing");
  writeFileSync(f.registry, JSON.stringify({ team: { name: "\u0085alpha\u001f" } }));
  expect(sentinelRecipientState(f.registry, "rb", "alpha/rb")).toBe("match");
  for (const malformed of ["broken", "null", "[]", '{"team":true}', '{"team":{"name":true}}']) {
    writeFileSync(f.registry, malformed);
    expect(sentinelRecipientState(f.registry, "rb", "rb")).toBe("registry_missing");
  }
});

test("pre-0.23 colon-qualified agreement reaches the retained legacy verifier", () => {
  const f = setup("[[TAP v=0.22 to=alpha:rb id=old kind=note reply=settle-only]]", null);
  const r = submit(f, "old");
  expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 });
  expect(r.keys).toContain("Enter");
  expect(r.events).not.toContain("stuck_submit_uncorroborated");
});

test("to_team with an empty to is malformed evidence, not absence", () => {
  const f = setup(wire("old"), "");
  writeFileSync(join(f.bus, "payloads/old.md"), "---\nto: \nto_team: alpha\n---\n");
  const r = submit(f, "old");
  expect(r.code).toBe(6);
  expect(r.stderr).toContain("recipient_malformed");
  expect(r.keys).toBe("");
});

for (const state of ["registered", "historical"]) {
  test(`${state} foreign root corroborates even when its acting registry is unreachable`, () => {
    const f = setup(wire("src/old"), null);
    const root = join(f.root, "foreign"), oldBus = join(root, ".tap/bus");
    mkdirSync(join(oldBus, "payloads"), { recursive: true });
    writeFileSync(join(oldBus, "payloads/old.md"), "---\nto: other\nto_team: alpha\n---\n");
    writeFileSync(join(f.root, "index/global-registry.json"), JSON.stringify({ schema: "0.20",
      teams: { src: { root, registry_location: join(root, "absent-registry"), state } } }));
    const denied = submit(f, "old");
    expect(denied.code).toBe(6);
    expect(denied.stderr).toContain("recipient_mismatch");
    expect(denied.keys).toBe("");
    writeFileSync(join(oldBus, "payloads/old.md"), "---\nto: rb\nto_team: alpha\n---\n");
    const submitted = submit(f, "new");
    expect({ code: submitted.code, stderr: submitted.stderr }).toMatchObject({ code: 0 });
    // The staged wire's submit evidence lands on its own (foreign) bus.
    expect(existsSync(join(oldBus, "receipts/old.submit-phases.jsonl"))).toBe(true);
  });
}

for (const entry of [null, [], "bad", { root: false }]) {
  test(`live malformed entry ${JSON.stringify(entry)} refuses`, () => {
    const f = setup(wire("src/old"), null);
    writeFileSync(join(f.root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { src: entry } }));
    const r = submit(f, "old");
    expect(r.code).toBe(5);
    expect(r.keys).toBe("");
  });
}

test("live bare entry preserves missing even with a readable payload under its root", () => {
  const f = setup(wire("src/old"));
  writeFileSync(join(f.root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { src: { root: f.wt } } }));
  const r = submit(f, "old");
  expect(r.code).toBe(0);
  expect(r.events).toContain("stuck_submit_uncorroborated");
});

for (const fault of ["exception"]) {
  test(`owner ${fault} refuses at the real submit boundary without Enter`, () => {
    const f = setup(wire("src/old"), null);
    const preload = join(f.root, "fault.ts");
    writeFileSync(preload, `import { mock } from "bun:test";\nconst path=${JSON.stringify(join(REPO, "runtime/bun/src/index-home.ts"))};\nconst real=await import(path);\nmock.module(path,()=>({...real,resolveTeamMarkerAwareWithEvidence(){throw new Error("injected resolver exception");}}));\n`);
    const r = submit(f, "old", { C1_FAULT_OWNER: preload });
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("injected resolver exception");
    expect(r.keys).toBe("");
    expect(r.events).not.toContain("stuck_submit_uncorroborated");
  });
}

test("uncorroborated event failure warns without changing submission", () => {
  const f = setup(wire("old"), null);
  const directory = join(f.root, "event-directory");
  mkdirSync(directory);
  const r = submit(f, "old", { C1_EVENT_LOG: directory });
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("warning: registry event log append failed action=stuck_submit_uncorroborated");
  expect(r.keys).toContain("Enter");
});

test("an incomplete opening marker is preserved without corroboration or Enter", () => {
  const draft = "[[TAP v0.23 note truncated";
  const f = setup(draft, null);
  const r = submit(f);
  // Native parks an unparseable TAP band as band_busy (the Bash door answered 6); no key either way.
  expect(r.code).toBe(4);
  expect(r.keys).toBe("");
  expect(r.band).toBe(draft);
  expect(r.events).toBe("");
});

for (const teams of [[], null, "bad"]) {
  test(`malformed global teams ${JSON.stringify(teams)} never reaches live resolution`, () => {
    const f = setup(wire("src/old"), null);
    const home = join(f.root, "index");
    writeFileSync(join(home, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
    expect(loadGlobalRegistry(home).marker).toBe("invalid");
    const r = submit(f, "old");
    expect(r.code).toBe(5);
    expect(r.keys).toBe("");
    expect(r.events).not.toContain("stuck_submit_uncorroborated");
  });
}

for (const location of ["root", ".tap"]) {
  test(`late review: live ${location} non-directory remains unavailable`, () => {
    const f = setup(wire("src/old"), null);
    const root = join(f.root, "foreign");
    if (location === "root") writeFileSync(root, "not a directory");
    else { mkdirSync(root); writeFileSync(join(root, ".tap"), "not a directory"); }
    writeFileSync(join(f.root, "index/global-registry.json"), JSON.stringify({ schema: "0.20",
      teams: { src: { root, registry_location: f.registry } } }));
    const r = submit(f, "old");
    expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 });
    expect(r.keys).toContain("Enter");
    expect(r.events).toContain("stuck_submit_uncorroborated");
  });
}

test("late review: unrelated Python JSON constants preserve recipient agreement", () => {
  const f = setup();
  for (const value of ["NaN", "Infinity", "-Infinity"]) {
    writeFileSync(f.registry, `{"team":{"name":"alpha"},"opaque":${value}}`);
    expect(sentinelRecipientState(f.registry, "rb", "alpha/rb")).toBe("match");
  }
});

test("late review: corroboration stops reading at the frontmatter fence", () => {
  const f = setup();
  const payload = join(f.bus, "payloads/old.md"), bytes = join(f.root, "bytes"), preload = join(f.root, "header-only.ts");
  const header = `---\nmetadata: ${"é".repeat(2100)}\nto: rb\nto_team: alpha\n---\n`;
  writeFileSync(payload, header + "body".repeat(262_144));
  writeFileSync(preload, `import { mock } from "bun:test";
const real={...await import("node:fs")}, target=${JSON.stringify(payload)}, log=${JSON.stringify(bytes)};
let fd=-1,total=0;
mock.module("node:fs",()=>({...real,
  readFileSync(path,...args){if(path===target)throw new Error("whole payload read forbidden");return real.readFileSync(path,...args);},
  openSync(path,...args){const n=real.openSync(path,...args);if(path===target)fd=n;return n;},
  readSync(n,...args){const read=real.readSync(n,...args);if(n===fd){total+=read;real.writeFileSync(log,String(total));}return read;}
}));\n`);
  const r = submit(f, "old", { C1_FAULT_OWNER: preload });
  expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 });
  expect(r.events).not.toContain("stuck_submit_uncorroborated");
  expect(Number(readFileSync(bytes, "utf8"))).toBeLessThanOrEqual(Buffer.byteLength(header) + 4096);
});

test("frontmatter EOF preserves an observed disagreeing recipient", () => {
  const f = setup();
  writeFileSync(join(f.bus, "payloads/old.md"), "---\nto: other\n");
  const r = submit(f, "old");
  expect(r.code).toBe(6);
  expect(r.stderr).toContain("recipient_mismatch");
  expect(r.keys).toBe("");
  expect(r.events).not.toContain("stuck_submit_uncorroborated");
});

test("live genuinely missing team remains unavailable", () => {
  const f = setup(wire("missing/old"), null);
  const r = submit(f, "old");
  expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 });
  expect(r.events).toContain("action=stuck_submit_uncorroborated");
});

for (const badIndex of ["invalid-global", "absent-global"]) {
  test(`${badIndex} is failed evidence, never unavailable`, () => {
    const f = setup(wire("missing/old"), null);
    const home = join(f.root, "index"), global = join(home, "global-registry.json");
    if (badIndex === "invalid-global") writeFileSync(global, "broken");
    else {
      // No machine index: a legacy store that once answered "genuinely missing"
      // is never read, so the evidence fails and nothing is submitted (F2b).
      rmSync(global);
      writeFileSync(join(home, "teams.json"), '{"teams":{}}');
      expect(resolveTeamMarkerAware("missing", home)).toEqual({ status: "missing", root: "", registryLocation: "", marker: "absent" });
      expect(resolveTeamMarkerAwareWithEvidence("missing", home).failure).toBe("no machine index (global-registry.json)");
    }
    const r = submit(f, "old");
    expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 5 });
    expect(r.keys).toBe("");
    expect(r.events).not.toContain("stuck_submit_uncorroborated");
  });
}
