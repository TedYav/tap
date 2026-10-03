import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const main = join(root, "runtime/bun/main.ts");
const bash = join(root, "bin/tap");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tap-hybrid-forms."));
  scratch.push(dir);
  const team = join(dir, "team");
  const elsewhere = join(dir, "elsewhere");
  const index = join(dir, "index");
  const bin = join(dir, "bin");
  const bus = join(team, ".tap", "bus");
  const registry = join(team, ".tap", "team-registry.json");
  for (const path of [elsewhere, index, bin, bus]) mkdirSync(path, { recursive: true });
  // Same format-aware fixture as RedBurn's corrected wrong-cwd differential.
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env python3
import sys
fmt = sys.argv[-1]
values = {"pane_id": "%700", "pane_tty": "/dev/ttyfixture", "session_name": "sandbox",
          "window_index": "0", "pane_index": "0", "pane_current_command": "claude",
          "pane_dead": "0", "pane_pid": "4242", "pid": "123", "start_time": "456"}
if "#{" not in fmt: sys.exit(1)
for key, value in values.items(): fmt = fmt.replace("#{" + key + "}", value)
if "#{" in fmt: sys.exit(1)
print(fmt)
`, { mode: 0o755 });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "sandboxteam", worktree_root: team }, seats: {
    "sandbox-seat": { pane: "sandbox:0.0", pane_id: "%700", session: "sandbox", server_epoch: "srv:123:456", status: "active" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    sandboxteam: { root: team, registry_location: registry, state: "registered" },
  } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`,
    TAP_INDEX_HOME: index, TAP_SESSION_MANIFEST: join(dir, "sessions.json"), OPENCODE_DB_PATH: join(dir, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(dir, "version.json"), TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
  };
  for (const key of ["TAP_HOME", "TAP_SELF", "TMUX", "TMUX_PANE"]) delete env[key];
  return { dir, team, elsewhere, index, bus, registry, env };
}
function run(fx: ReturnType<typeof fixture>, native: boolean, argv: string[], cwd = fx.team) {
  return spawnSync(native ? process.execPath : "bash", [native ? main : bash, ...argv], {
    cwd, env: { ...fx.env, PWD: cwd, TAP_BUN_ROUTE_TRACE: join(fx.dir, "trace") }, encoding: "utf8", timeout: 15000,
  });
}

test("wrong-cwd whoami preserves the registered-pane refusal and working cd remedy", () => {
  const fx = fixture();
  const args = ["whoami", "--pane", "sandbox:0.0"];
  const ref = run(fx, false, args, fx.elsewhere);
  const actual = run(fx, true, args, fx.elsewhere);
  expect({ code: actual.status, stderr: actual.stderr }).toEqual({ code: ref.status, stderr: ref.stderr });
  expect(actual.status).toBe(2);
  expect(actual.stderr).toContain("sandbox-seat");
  expect(actual.stderr).toContain("unanchored cwd");
  const remedy = actual.stderr.split("next:")[1]!.trim();
  expect(remedy.startsWith("cd ")).toBe(true);
  const fixed = run(fx, true, args, remedy.slice(3));
  expect(fixed.status).toBe(0);
  expect(fixed.stdout).toBe("sandbox-seat\n");
  // THREE native traces, not two. These tests were written when `whoami` had two
  // doors: the reference run went to Bash and left no native trace. The verb
  // closure made `tap.sh`'s arm exec main, so the reference, the actual and the
  // remedy run all reach the same engine -- which is exactly the invariant the
  // closure claims, and is why this assertion is re-aimed rather than deleted.
  // The output equality above is now "both public entries are one engine",
  // not "two engines agree".
  expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native whoami\nnative whoami\nnative whoami\n");
  expect(existsSync(join(fx.elsewhere, ".tap"))).toBe(false);
});

for (const scenario of ["success", "wrong-cwd", "unknown", "unknown-before-json"]) {
  test(`whoami JSON parity: ${scenario}`, () => {
    const fx = fixture();
    const args = ["whoami", "--pane", "sandbox:0.0", ...(scenario === "unknown-before-json" ? ["--bogus", "--json"] : ["--json"]),
      ...(scenario === "unknown" ? ["--bogus"] : [])];
    const cwd = scenario === "wrong-cwd" ? fx.elsewhere : fx.team;
    const ref = run(fx, false, args, cwd);
    const actual = run(fx, true, args, cwd);
    expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
      .toEqual({ code: ref.status, stdout: ref.stdout, stderr: ref.stderr });
    // Two, for the reason above: after the closure the reference door is the
    // same engine as the actual one. A single line here would now mean one of
    // the two public entries never ran.
    expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native whoami\nnative whoami\n");
    if (scenario !== "unknown-before-json") expect(() => JSON.parse(actual.stdout)).not.toThrow();
  });
}

for (const scenario of ["empty", "pending", "unattributed", "invalid-reply", "quiet", "malformed"]) {
  test(`poll JSON parity: ${scenario}`, () => {
    const fx = fixture();
    mkdirSync(join(fx.bus, "payloads"), { recursive: true });
    mkdirSync(join(fx.bus, "receipts"), { recursive: true });
    const id = "sender-20260905T000000Z-aabbccddeeff";
    const path = join(fx.bus, "payloads", `${id}.md`);
    const bytes = `---\nid: ${id}\nfrom: sender\nto: sandbox-seat\nkind: discuss\nreply: ${scenario === "invalid-reply" ? "optional" : "expected"}\npath: ${path}\nfrom_team: elsewhere\nreply_to: leader\nepoch: 7\n---\nBody\n`;
    const seed = () => {
      if (scenario !== "empty") writeFileSync(path, scenario === "malformed" ? "broken envelope" : bytes);
      if (scenario !== "unattributed") writeFileSync(join(fx.bus, "receipts", `${id}.placed`), "{}\n");
    };
    seed();
    const args = ["poll", "sandbox-seat", "--json", ...(scenario === "quiet" ? ["--quiet"] : [])];
    const ref = run(fx, false, args);
    seed();
    const actual = run(fx, true, args);
    expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
      .toEqual({ code: ref.status, stdout: ref.stdout, stderr: ref.stderr });
    expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native poll\nnative poll\n");
    expect(JSON.parse(actual.stdout).pending.length).toBe(["empty", "malformed"].includes(scenario) ? 0 : 1);
    expect(actual.status).toBe(["empty", "malformed", "quiet"].includes(scenario) ? 0 : 2);
  });
}

for (const scenario of ["enrolled", "unknown", "invalid", "env-wins", "relocated-registry", "missing-registry"]) {
  test(`poll team authority parity: ${scenario}`, () => {
    const fx = fixture();
    let name = "sandboxteam";
    if (scenario === "unknown") name = "missing";
    if (scenario === "invalid" || scenario === "env-wins") name = "bad/team";
    if (scenario === "env-wins") fx.env.TAP_HOME = fx.bus;
    if (scenario === "relocated-registry") {
      const relocated = join(fx.dir, "registry.json");
      writeFileSync(relocated, readFileSync(fx.registry));
      writeFileSync(join(fx.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
        sandboxteam: { root: fx.team, registry_location: relocated, state: "registered" },
      } }));
    }
    if (scenario === "missing-registry") writeFileSync(join(fx.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      sandboxteam: { root: fx.team, registry_location: join(fx.dir, "missing.json"), state: "registered" },
    } }));
    const args = ["poll", "sandbox-seat", "--json", "--team", name];
    const ref = run(fx, false, args, fx.elsewhere);
    const actual = run(fx, true, args, fx.elsewhere);
    expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
      .toEqual({ code: ref.status, stdout: ref.stdout, stderr: ref.stderr });
    expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native poll\nnative poll\n");
    expect(existsSync(join(fx.elsewhere, ".tap"))).toBe(false);
  });
}

for (const args of [[], ["--json"], ["missing"], ["sandboxteam"]]) {
  test(`team list works outside a team: ${args.join(" ")}`, () => {
    const fx = fixture();
    const argv = ["team", "list", ...args];
    const ref = run(fx, false, argv, fx.elsewhere);
    const actual = run(fx, true, argv, fx.elsewhere);
    expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
      .toEqual({ code: ref.status, stdout: ref.stdout, stderr: ref.stderr });
    // Same closure as whoami above: tap.sh's "team" arm exec the
    // native engine unconditionally, so the reference run (forced bash) now
    // reaches the same engine as the actual run. Two native entries, not a
    // bash/native split — this is "both public entries are one engine".
    expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native team\nnative team\n");
    expect(existsSync(join(fx.elsewhere, ".tap"))).toBe(false);
  });
}

for (const scenario of ["missing-agent", "unknown-option", "wrong-cwd"]) {
  test(`poll refusal parity: ${scenario}`, () => {
    const fx = fixture();
    const args = ["poll", ...(scenario === "missing-agent" ? [] : ["sandbox-seat"]), "--json",
      ...(scenario === "unknown-option" ? ["--bogus"] : [])];
    const cwd = scenario === "wrong-cwd" ? fx.elsewhere : fx.team;
    const ref = run(fx, false, args, cwd);
    const actual = run(fx, true, args, cwd);
    expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
      .toEqual({ code: ref.status, stdout: ref.stdout, stderr: ref.stderr });
    expect(existsSync(join(fx.elsewhere, ".tap"))).toBe(false);
    expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native poll\nnative poll\n");
  });
}


// tap-fyttg: the corrupt-index refusal at the poll and whoami seams. The raw
// 0xe9 sits in an UNRELATED team's name, so a lossy decode would leave the
// sandboxteam enrollment resolvable and both verbs would run; the strict reader
// refuses the document whole. Rewriting the same document in valid UTF-8
// restores each verb's ordinary success, so the arms are about the bytes.
test("whoami refuses on the native route when the index carries a raw 0xe9 in an unrelated team name", () => {
  const fx = fixture();
  const marker = join(fx.index, "global-registry.json");
  writeFileSync(marker, Buffer.concat([
    Buffer.from(`{"schema":"0.20","teams":{"oth`),
    Buffer.from([0xe9]),
    Buffer.from(`er":{"root":"/nowhere","registry_location":"/nowhere/r.json"},` +
      `"sandboxteam":{"root":${JSON.stringify(fx.team)},"registry_location":${JSON.stringify(fx.registry)},"state":"registered"}}}`),
  ]));
  const actual = run(fx, true, ["whoami", "--pane", "sandbox:0.0"]);
  expect(actual.status).not.toBe(0);
  // The literal native trace record: one run, one line — containment would
  // also pass a door that routed elsewhere first.
  expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native whoami\n");
  // The verb's established invalid-marker rendering (probed once, pinned here).
  expect(actual.stderr).toBe("tap whoami: registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation; next: tap doctor\n");
  writeFileSync(marker, JSON.stringify({ schema: "0.20", teams: {
    other: { root: "/nowhere", registry_location: "/nowhere/r.json", state: "registered" },
    sandboxteam: { root: fx.team, registry_location: fx.registry, state: "registered" },
  } }));
  const fixed = run(fx, true, ["whoami", "--pane", "sandbox:0.0"]);
  expect(fixed.status).toBe(0);
  expect(fixed.stdout).toBe("sandbox-seat\n");
});

test("poll refuses on the native route when the index carries a raw 0xe9 in an unrelated team name", () => {
  const fx = fixture();
  mkdirSync(join(fx.bus, "payloads"), { recursive: true });
  mkdirSync(join(fx.bus, "receipts"), { recursive: true });
  const marker = join(fx.index, "global-registry.json");
  writeFileSync(marker, Buffer.concat([
    Buffer.from(`{"schema":"0.20","teams":{"oth`),
    Buffer.from([0xe9]),
    Buffer.from(`er":{"root":"/nowhere","registry_location":"/nowhere/r.json"},` +
      `"sandboxteam":{"root":${JSON.stringify(fx.team)},"registry_location":${JSON.stringify(fx.registry)},"state":"registered"}}}`),
  ]));
  const actual = run(fx, true, ["poll", "sandbox-seat", "--json"]);
  expect(actual.status).not.toBe(0);
  expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native poll\n");
  // The verb's established invalid-marker rendering, on stdout under --json.
  expect(JSON.parse(actual.stdout)).toEqual({
    ok: false, error_class: "invalid_flip", action: "tap doctor",
    detail: "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation",
  });
  writeFileSync(marker, JSON.stringify({ schema: "0.20", teams: {
    other: { root: "/nowhere", registry_location: "/nowhere/r.json", state: "registered" },
    sandboxteam: { root: fx.team, registry_location: fx.registry, state: "registered" },
  } }));
  const fixed = run(fx, true, ["poll", "sandbox-seat", "--json"]);
  expect(fixed.status).toBe(0);
  expect(JSON.parse(fixed.stdout).pending).toEqual([]);
});

test("human poll --team preserves pending-inbox bytes outside its team", () => {
  const fx = fixture();
  // Compare human age bytes at one fixed instant, not across a wall-clock tick.
  fx.env.TAP_SPOOL_NOW = "1788613200";
  const id = "sender-20260905T000000Z-aabbccddeeff";
  const path = join(fx.bus, "payloads", `${id}.md`);
  mkdirSync(join(fx.bus, "payloads"), { recursive: true });
  mkdirSync(join(fx.bus, "receipts"), { recursive: true });
  writeFileSync(path, `---\nid: ${id}\nfrom: sender\nto: sandbox-seat\nkind: discuss\nreply: expected\npath: ${path}\n---\nBody\n`);
  writeFileSync(join(fx.bus, "receipts", `${id}.placed`), "{}\n");
  const argv = ["poll", "sandbox-seat", "--team", "sandboxteam"];
  const ref = run(fx, false, argv, fx.elsewhere);
  const actual = run(fx, true, argv, fx.elsewhere);
  expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
    .toEqual({ code: ref.status, stdout: ref.stdout, stderr: ref.stderr });
  expect(actual.status).toBe(2);
  expect(readFileSync(join(fx.dir, "trace"), "utf8")).toBe("native poll\nnative poll\n");
});

test("explicit poll --team can initialize its enrolled default bus", () => {
  const fx = fixture();
  rmSync(fx.bus, { recursive: true });
  const argv = ["poll", "sandbox-seat", "--json", "--team", "sandboxteam"];
  const ref = run(fx, false, argv, fx.elsewhere);
  rmSync(fx.bus, { recursive: true });
  const actual = run(fx, true, argv, fx.elsewhere);
  expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
    .toEqual({ code: ref.status, stdout: ref.stdout, stderr: ref.stderr });
  expect(actual.status).toBe(0);
  expect(existsSync(fx.bus)).toBe(true);
  expect(existsSync(join(fx.elsewhere, ".tap"))).toBe(false);
});
