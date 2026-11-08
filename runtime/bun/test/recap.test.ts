import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeScratchTree } from "./support/scratch";

const repo = realpathSync(join(import.meta.dir, "../../.."));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tap-recap.")));
const now = 1800000000;
afterAll(() => removeScratchTree(scratch));

function fixture(instance = "peggy|new") {
  const root = mkdtempSync(join(scratch, "fx.")), index = join(root, "index"), home = join(root, "home");
  mkdirSync(index); mkdirSync(home);
  const teams: Record<string, unknown> = {};
  function enroll(name: string) {
    const worktree = join(root, name), bus = join(worktree, ".tap/bus"), registry = join(worktree, ".tap/team-registry.json");
    mkdirSync(join(bus, "payloads"), { recursive: true }); mkdirSync(join(bus, "receipts"));
    const seats = { peggy: { delivery: "poll", status: "active", instance } };
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name, worktree_root: worktree }, seats }));
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name, worktree_root: worktree }, seats }));
    teams[name] = { root: worktree, registry_location: registry, state: "registered" };
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
    return { worktree, bus, registry };
  }
  const { worktree, bus, registry } = enroll("t");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SELF: undefined, TAP_REGISTRY: undefined, TAP_TEAM_OVERRIDE_BUS: undefined, TAP_JSON: undefined,
    TAP_CLEAR_ID: undefined, TAP_VERBOSE: undefined, TMUX: undefined, TMUX_PANE: undefined,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", TAP_LOCK_DIR: join(root, "locks") };
  function put(path: string, data: string | Buffer, mtime = now - 10) {
    const full = join(bus, path);
    mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, data); utimesSync(full, mtime, mtime);
    return full;
  }
  function payload(id: string, fields: Record<string, string> = {}, body = "body", mtime = now - 10) {
    return put(`payloads/${id}.md`, "---\n" + Object.entries({ id, from: "peer", to: "peggy", kind: "note", ...fields }).map(([k, v]) => `${k}: ${v}\n`).join("") + `---\n${body}\n`, mtime);
  }
  function run(args = ["peggy", "--json"], extraEnv: NodeJS.ProcessEnv = {}, mockContext = "") {
    // Importing main does not run the shared public-entry prelude. This is the reader boundary.
    const script = `${mockContext}\nDate.now = () => ${now * 1000};
      const { cmdRecap } = await import(${JSON.stringify(join(repo, "runtime/bun/src/verbs/recap.ts"))});
      const { runNative } = await import(${JSON.stringify(join(repo, "runtime/bun/main.ts"))});
      process.exitCode = runNative("recap", cmdRecap, ${JSON.stringify(args)});`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { cwd: worktree, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }
  function json(args = ["peggy", "--json"], extraEnv: NodeJS.ProcessEnv = {}) {
    const r = run(args, extraEnv); expect(r.code, r.err).toBe(0); return JSON.parse(r.out);
  }
  return { root, index, home, worktree, bus, registry, env, enroll, put, payload, run, json };
}
const ids = (rows: { id: string }[]) => rows.map(r => r.id);

test("human and JSON output preserve captured shell baseline, including zero-limit and empty output", () => {
  const f = fixture();
  f.payload("a", {}, " inbound "); f.payload("b", { from: "peggy", to: "peer" }, "outbound"); f.payload("c", {}, "settled");
  f.put("receipts/c.done", "");
  const row = (id: string) => ({ id, kind: "note", age_seconds: 10, path: join(f.bus, `payloads/${id}.md`) });
  const expected = { ok: true, handle: "peggy", team: "t", inbox: [{ ...row("a"), from: "peer" }],
    outstanding: [{ ...row("b"), to: "peer" }], history: [
      { id: "c", peer: "peer", direction: "received", kind: "note", age_seconds: 10, first_line: "settled", path: row("c").path },
      { id: "b", peer: "peer", direction: "sent", kind: "note", age_seconds: 10, first_line: "outbound", path: row("b").path },
      { id: "a", peer: "peer", direction: "received", kind: "note", age_seconds: 10, first_line: "inbound", path: row("a").path },
    ] };
  expect(f.run().out).toBe(JSON.stringify(expected) + "\n");
  const prefix = `tap recap: t/peggy\n\nunsettled inbound (1 obligation) — you owe these:\n  a  from peer  note  (10s)\n    ${row("a").path}\n\nyour outstanding send (1) — awaiting someone else's reply:\n  b  to peer  note  (10s)\n`;
  const suffix = "\ntap recap: this is coordination state only — obligations and traffic.\ntap recap: work-state rationale (what you were building and why) lives in beads and PRs, never in this output.\n";
  expect(f.run(["peggy"]).out).toBe(prefix + `\nrecent exchanges (newest first, 3):\n  c  <- peer  (10s ago)\n    settled\n    ${row("c").path}\n  b  -> peer  (10s ago)\n    outbound\n    ${row("b").path}\n  a  <- peer  (10s ago)\n    inbound\n    ${row("a").path}\n` + suffix);
  expect(f.run(["peggy", "--limit", "0"]).out).toBe(prefix + suffix);
  expect(f.json(["peggy", "--limit", "0", "--json"])).toEqual({ ...expected, history: [] });
  const empty = f.run(["nobody"]);
  expect(empty.code).toBe(0); expect(empty.err).toBe("");
  expect(empty.out).toBe("tap recap: t/nobody\n\nunsettled inbound: none\n\nyour outstanding sends: none\n" + suffix);
});

test("present mismatched IDs cannot become obligations or history; missing IDs and valid siblings survive", () => {
  const f = fixture();
  f.payload("valid"); f.payload("bad-in", { id: "other" }); f.payload("bad-out", { id: "other", from: "peggy", to: "peer" });
  f.payload("empty-id", { id: "" });
  f.put("payloads/legacy.md", "---\nfrom: peer\nto: peggy\n---\nlegacy\n");
  const out = f.json();
  expect(ids(out.inbox)).toEqual(["legacy", "valid"]); expect(out.outstanding).toEqual([]);
  expect(ids(out.history)).toEqual(["valid", "legacy"]);
});

test("stamps need a known matching current instance; history remains unfiltered", () => {
  for (const instance of ["", "peggy|new"]) {
    const f = fixture(instance);
    for (const stamp of ["old", "new", "unbound"]) {
      f.payload(`in-${stamp}`, stamp === "unbound" ? {} : { recipient_instance: `peggy|${stamp}` });
      f.payload(`out-${stamp}`, { from: "peggy", to: "peer", ...(stamp === "unbound" ? {} : { sender_instance: `peggy|${stamp}` }) });
    }
    const out = f.json(["peggy", "--json", "--limit", "10"]);
    expect(ids(out.inbox)).toEqual(instance ? ["in-new", "in-unbound"] : ["in-unbound"]);
    expect(ids(out.outstanding)).toEqual(instance ? ["out-new", "out-unbound"] : ["out-unbound"]);
    expect(ids(out.history)).toEqual(["out-unbound", "out-old", "out-new", "in-unbound", "in-old", "in-new"]);
  }
});

test("done, cancellation, and archive independently remove both directions from obligations, never history", () => {
  const f = fixture();
  for (const direction of ["in", "out"]) for (const settlement of ["done", "cancelled", "archive", "open"]) {
    const id = `${direction}-${settlement}`;
    f.payload(id, direction === "out" ? { from: "peggy", to: "peer" } : {});
    if (["done", "cancelled"].includes(settlement)) f.put(`receipts/${id}.${settlement}`, "");
    // An indexed id with an active payload is an interrupted archive cut, which
    // unlinks the payload before its receipts: its `.done` is still active.
    if (settlement === "archive") f.put(`receipts/${id}.done`, "");
  }
  f.put("archive/index.ndjson", ["in-archive", "out-archive"].map(id => JSON.stringify({ id, month: "2026-09", settled_at: "2026-09-20T00:00:00Z", payload_sha256: "a".repeat(64), receipts: [`${id}.done`] })).join("\n") + "\n");
  const out = f.json(["peggy", "--json", "--limit", "10"]);
  expect(ids(out.inbox)).toEqual(["in-open"]); expect(ids(out.outstanding)).toEqual(["out-open"]);
  expect(ids(out.history).sort()).toEqual(["in-archive", "in-cancelled", "in-done", "in-open", "out-archive", "out-cancelled", "out-done", "out-open"]);
});

test("same bare handles across teams cannot turn outbound relay into local inbox or received history", () => {
  const f = fixture();
  f.payload("foreign-out", { from: "peggy", to: "peggy", to_team: "other", from_team: "t" });
  f.payload("foreign-in", { to_team: "other" });
  f.payload("local-in", { to_team: "t", from_team: "other" });
  f.payload("legacy-in", { from_team: "other" });
  f.payload("self", { from: "peggy", to_team: "t" });
  f.payload("bom-team", { to_team: "\ufefft" });
  f.payload("bom-only", { to_team: "\ufeff" });
  f.payload("bom-handle", { to: "\ufeffpeggy" });
  f.payload("python-space", { to_team: "\x85t\x85" });
  const out = f.json(["peggy", "--json", "--limit", "10"]);
  expect(ids(out.inbox)).toEqual(["legacy-in", "local-in", "python-space", "self"]);
  expect(ids(out.outstanding)).toEqual(["foreign-out"]);
  expect(ids(out.history)).toEqual(["self", "python-space", "local-in", "legacy-in", "foreign-out"]);
  expect(out.history.find((r: { id: string }) => r.id === "foreign-out").direction).toBe("sent");
});

test("Python-compatible frontmatter and first-line decoding preserve whitespace, fences, replacement, and code points", () => {
  const f = fixture();
  f.put("payloads/cr.md", "---\rfrom: ignored\rfrom:\tpeer\rto: peggy\r---\r \x85\r --- \r\x85  indented  \x85\r");
  f.put("payloads/utf8.md", Buffer.concat([Buffer.from("---\nfrom: peer\nto: peggy\n---\n"), Buffer.from([0xff, 0x41])]));
  f.payload("emoji", {}, "👍".repeat(130));
  f.payload("bom-body", {}, "\ufeffkept");
  f.put("payloads/unterminated.md", "---\nfrom: peer\nto: peggy\n");
  f.put("payloads/no-space.md", "---\nfrom: peer\nto:peggy\n---\nno\n");
  f.put("payloads/bom.md", "\ufeff---\nfrom: peer\nto: peggy\n---\nno\n");
  f.payload("_draft"); f.payload(".hidden"); f.payload("");
  const out = f.json(["peggy", "--json", "--limit", "20"]);
  expect(ids(out.inbox)).toEqual(["bom-body", "cr", "emoji", "unterminated", "utf8"]);
  const lines = Object.fromEntries(out.history.map((r: { id: string; first_line: string }) => [r.id, r.first_line]));
  expect(lines).toEqual({ "bom-body": "\ufeffkept", cr: "indented", emoji: "👍".repeat(120), unterminated: "", utf8: "�A" });
  expect(f.run(["peggy", "--json", "--limit", "20"]).out).toContain("\\ud83d\\udc4d");
});

test("history limit bounds the newest bus candidates before filtering and breaks mtime ties by descending id", () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) f.payload(`p-${String(i).padStart(2, "0")}`, { to: i === 24 ? "peggy" : "other" }, "body", now - i);
  expect(f.json().history).toEqual([]);
  expect(ids(f.json(["peggy", "--json", "--limit", "7"]).history)).toEqual(["p-24"]);
  expect(ids(f.json(["peggy", "--json", "--limit", "0"]).inbox)).toEqual(["p-24"]);
  const tied = fixture();
  for (const id of ["a", "b", "c"]) tied.payload(id);
  expect(ids(tied.json().history)).toEqual(["c", "b", "a"]);
  expect(ids(tied.json(["peggy", "--json", "--limit", "1"]).history)).toEqual(["c"]);
  expect(tied.json(["peggy", "--json", "--limit", "9".repeat(400)]).history.length).toBe(3);
  tied.payload("future", {}, "body", now + 5); tied.payload("fraction", {}, "body", now - 1.8);
  expect(tied.json().inbox.find((r: { id: string }) => r.id === "future").age_seconds).toBe(0);
  expect(tied.json().inbox.find((r: { id: string }) => r.id === "fraction").age_seconds).toBe(2);
});

test("actor precedence and generation refusal preserve the direct recap interface", () => {
  const f = fixture();
  const contextPath = JSON.stringify(join(repo, "runtime/bun/src/context.ts"));
  const mock = (unverifiable = false) => `import { mock } from "bun:test";
    const ctx = await import(${contextPath}); mock.module(${contextPath}, () => ({ ...ctx,
      callingPane: () => ({ status: ${JSON.stringify(unverifiable ? "unverifiable" : "ok")}, paneId: "%1", session: "t/pane", serverEpoch: "epoch" }),
      resolveSelf: () => ({ handle: "pane-seat" }) }));`;
  for (const [args, env, actor] of [
    [["explicit", "--json"], { TAP_SELF: "self" }, "explicit"],
    [["--json"], { TAP_SELF: "self" }, "self"],
    [["--json"], {}, "pane-seat"],
  ] as const) {
    const r = f.run([...args], env, mock()); expect(r.code, r.err).toBe(0); expect(JSON.parse(r.out).handle).toBe(actor);
  }
  const unknown = f.run(["--json"], {}, mock(true));
  expect(unknown.code).toBe(1); expect(JSON.parse(unknown.out).error_class).toBe("generation_unverifiable");
  const absent = f.run(["--json"]); expect(absent.code).toBe(1); expect(JSON.parse(absent.out).error_class).toBe("unregistered");
  const inherited = f.run(["--bogus"], { TAP_JSON: "1" });
  expect(inherited.code).toBe(1); expect(inherited.out).toBe(""); expect(inherited.err).toContain("unknown option");
  for (const args of [["a", "b"], ["--bogus"], ["bad/handle"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit"], ["--team"]]) {
    const r = f.run(["--json", ...args]); expect(r.code).toBe(1); expect(JSON.parse(r.out).ok).toBe(false);
  }
}, 30_000);

test("caller pin wins over --team; a real override selects bus, registry, and team together", () => {
  const f = fixture(), other = f.enroll("other");
  f.payload("local", { to_team: "t" });
  writeFileSync(join(other.bus, "payloads/remote.md"), "---\nid: remote\nfrom: peer\nto: peggy\nto_team: other\n---\nremote\n");
  expect(ids(f.json(["peggy", "--json", "--team", "other"]).inbox)).toEqual(["local"]);
  const selected = f.json(["peggy", "--json", "--team", "other"], { TAP_HOME: undefined });
  expect(selected.team).toBe("other"); expect(ids(selected.inbox)).toEqual(["remote"]);
  const invalid = f.run(["peggy", "--json", "--team", "bad/team"], { TAP_HOME: undefined });
  expect(invalid.code).toBe(1); expect(JSON.parse(invalid.out).error_class).toBe("usage_error");
  writeFileSync(join(f.index, "global-registry.json"), "broken");
  const broken = f.run(); expect(broken.code).toBe(1); expect(JSON.parse(broken.out).error_class).toBe("invalid_flip");
});

function manifest(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).sort().map(name => {
    const path = join(root, name), stat = statSync(path);
    return `${name}:${stat.mode}:${stat.mtimeMs}:${stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "dir"}`;
  });
}

test("reader success and refusal do not write; malformed rows are not quarantined", () => {
  const f = fixture(); f.payload("valid"); f.payload("bad", { id: "other" });
  const before = manifest(f.root);
  expect(f.run().code).toBe(0); expect(f.run(["--json", "--bogus"]).code).toBe(1);
  expect(manifest(f.root)).toEqual(before);
});

test("all public doors reach native recap after deletion", () => {
  const f = fixture(); f.payload("valid");
  expect(existsSync(join(repo, "skills/tap/scripts/tap-recap.sh"))).toBe(false);
  const trace = join(f.root, "trace");
  // Public commands retain shared onboarding/reconciliation. Only the leaf test above promises no writes.
  for (const entry of ["bin/tap", "scripts/tap.sh"]) {
    writeFileSync(trace, "");
    const r = Bun.spawnSync([Bun.which("bash")!, join(repo, entry), "recap", "peggy", "--json"], { cwd: f.worktree,
      env: { ...f.env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(r.exitCode, r.stderr.toString()).toBe(0); expect(ids(JSON.parse(r.stdout.toString()).inbox)).toEqual(["valid"]);
    expect(readFileSync(trace, "utf8")).toBe("native recap\n");
  }
  const stub = join(f.root, "bin"); mkdirSync(stub);
  writeFileSync(join(stub, "bun"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const missing = Bun.spawnSync([Bun.which("bash")!, join(repo, "bin/tap"), "recap", "peggy"], {
    cwd: f.worktree, env: { ...f.env, PATH: `${stub}:${f.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(missing.exitCode).not.toBe(0); expect(missing.stdout.toString()).not.toContain("tap recap:");
}, 30_000);
