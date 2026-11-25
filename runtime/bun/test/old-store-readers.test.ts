// C4a-1: every registry reader refuses an old-format team registry as
// old_store. The shared predicate owns the shape matrix; each boundary gets a
// representative old file beside a current control, plus the absent and `{}`
// controls that keep "missing" and "empty document" apart (plan §9 B2/B3).
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalRegistryPath } from "../src/index-home";
import { isOldStoreRefusal, OldStoreError, teamRegistryDefect, teamRegistryFileRefusal, teamRegistryRefusal } from "../src/register-authority";
import { loadCurrentRegistry } from "../src/registry";
import { loads } from "../src/watch-detect";
import { cmdSessionComplete, completionHandles } from "../src/launcher/complete";
import { duplicateRegistrySessionOwner } from "../src/launcher/identity-owner";
import { LauncherError } from "../src/launcher/types";
import { duplicateIdentityOwner } from "../src/session-identity-owner";
import { TapError } from "../src/context";
import { census } from "../src/launcher/relaunch";
import { pickerModel } from "../src/attach-picker";
import { render } from "../src/launcher/resume-prelude";
import { recordedPermissions } from "../src/delivery-permissions";
import { recipientInstance } from "../src/recipient-instance";
import { addresseeGrant } from "../src/addressee-grant";
import { boundPaneIdentityState } from "../src/observe-gather";
import { recipientIsPresent } from "../src/spool-deadline";
import { paneReady } from "../src/spool-readiness";
import { TransactionError } from "../src/launcher/transaction";
import { SelectorError } from "../src/selector";
import { removeScratchTree } from "./support/scratch";

const scratch: string[] = [];
const savedIndex = process.env.TAP_INDEX_HOME;
afterEach(() => {
  if (savedIndex === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = savedIndex;
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

function work(): string {
  const dir = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-old-store.")));
  scratch.push(dir);
  return dir;
}

const CURRENT = { schema: "0.20", team: { name: "t" }, seats: {} };
const PANE = { status: "active", delivery: "pane", session: "t/h", harness: "claude", harness_session_id: "sid-1", pane: "t/h:0.0", pane_id: "%1" };

function file(dir: string, name: string, doc: unknown): string {
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc));
  return path;
}

test("the predicate names every old shape and passes the current ones, object or Map", () => {
  const cases: Array<[unknown, string | null]> = [
    [{}, "no schema"],
    [{ seats: {} }, "no schema"],
    [{ schema: "0.19", seats: {} }, 'schema "0.19"'],
    [{ schema: 20, seats: {} }, "schema 20"],
    [{ schema: null, seats: {} }, "schema null"],
    [{ schema: "0.20", agents: {} }, '"agents" map'],
    [{ schema: "0.20", seats: {}, agents: null }, '"agents" map'],
    [{ schema: "0.20", seats: {}, agents: [] }, '"agents" map'],
    [{ schema: "0.20" }, "seats not an object"],
    [{ schema: "0.20", seats: [] }, "seats not an object"],
    [{ schema: "0.20", seats: {}, team: "t" }, "team not an object"],
    [{ schema: "0.20", seats: {}, team: null }, "team not an object"],
    [[], "not a JSON object"],
    [null, "not a JSON object"],
    ["{}", "not a JSON object"],
    [{ schema: "0.20", seats: {} }, null],
    [{ ...CURRENT, schema: "0.21" }, null],
    [{ ...CURRENT, schema: "0.21", agents: {} }, '"agents" map'],
    [{ ...CURRENT, schema: "0.22" }, 'schema "0.22"'],
    [CURRENT, null],
  ];
  for (const [doc, reason] of cases) {
    expect(teamRegistryDefect(doc)).toBe(reason);
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) expect(teamRegistryDefect(loads(JSON.stringify(doc)))).toBe(reason);
  }
  // A non-object document is malformed, not old: no old_store refusal, the reader's own class applies.
  for (const doc of [[], null, 3, "{}"]) expect(teamRegistryRefusal("/x", doc)).toBeNull();
  const refusal = teamRegistryRefusal("/x/team-registry.json", { schema: "0.20", agents: {} })!;
  expect(refusal.errorClass).toBe("old_store");
  expect(refusal.detail).toContain("/x/team-registry.json");
  expect(refusal.detail).toContain("never converts");
  expect(refusal.action).not.toBe("");
});

test("file refusal: an existing {} refuses; absent, unreadable and non-regular files are not old", () => {
  const dir = work();
  expect(teamRegistryFileRefusal(join(dir, "absent.json"))).toBeNull();
  expect(teamRegistryFileRefusal(file(dir, "empty-doc.json", {}))?.detail).toContain("no schema");
  expect(teamRegistryFileRefusal(file(dir, "current-empty.json", { schema: "0.20", seats: {} }))).toBeNull();
  expect(teamRegistryFileRefusal(file(dir, "torn.json", "{"))).toBeNull();
  mkdirSync(join(dir, "dir.json"));
  expect(teamRegistryFileRefusal(join(dir, "dir.json"))).toBeNull();
  // A FIFO is inspected, never opened: opening it would block this test.
  expect(spawnSync("mkfifo", [join(dir, "fifo.json")]).status).toBe(0);
  expect(teamRegistryFileRefusal(join(dir, "fifo.json"))).toBeNull();
});

test("loadCurrentRegistry throws old_store for a present old file and keeps absence absent", () => {
  const dir = work();
  expect(loadCurrentRegistry(join(dir, "absent.json"))).toEqual({});
  expect(loadCurrentRegistry(file(dir, "ok.json", CURRENT))).toEqual(CURRENT);
  const old = file(dir, "old.json", { agents: { h: PANE } });
  let caught: unknown;
  try { loadCurrentRegistry(old); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(OldStoreError);
  expect(isOldStoreRefusal(caught)).toBe(true);
  expect((caught as Error).message).toStartWith("old_store: ");
});

test("isOldStoreRefusal recognizes each typed carrier and nothing else", () => {
  expect(isOldStoreRefusal(new TapError(1, "old_store", "a", "d"))).toBe(true);
  expect(isOldStoreRefusal(new LauncherError("d", "old_store", "a", "d"))).toBe(true);
  expect(isOldStoreRefusal(new OldStoreError("a", "d"))).toBe(true);
  expect(isOldStoreRefusal(new TapError(1, "registry_invalid", "a", "d"))).toBe(false);
  expect(isOldStoreRefusal(new Error("old_store: d"))).toBe(false);
});

test("completion refuses an old registry non-zero and silent; a current one completes", () => {
  const dir = work();
  const current = file(dir, "current.json", { schema: "0.20", team: { name: "t" }, seats: { h: PANE } });
  expect(completionHandles(current)).toEqual(["h"]);
  const old = file(dir, "old.json", { agents: { h: PANE } });
  expect(() => completionHandles(old)).toThrow(LauncherError);
  const writes: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  let code: number;
  try { code = cmdSessionComplete(["handles", "--registry", old]); } finally { process.stdout.write = write; }
  expect(code).toBe(1);
  expect(writes.join("")).toBe("");
});

function enrollIndex(dir: string, teams: Record<string, string>): string {
  const index = join(dir, "index");
  mkdirSync(index, { recursive: true });
  const doc = { schema: "0.20", teams: Object.fromEntries(Object.entries(teams).map(([name, loc]) =>
    [name, { root: join(dir, name), registry_location: loc, state: "registered" }])) };
  writeFileSync(globalRegistryPath(index), JSON.stringify(doc));
  return index;
}

test("an old populated registry never licenses a duplicate resume (launcher identity owner)", () => {
  const dir = work();
  const target = { name: "t/h", harness: "claude", cwd: join(dir, "elsewhere"), base: "t", harness_session_id: "sid-1" };
  mkdirSync(target.cwd, { recursive: true });
  const other = file(join(dir, "other", ".tap"), "team-registry.json", { schema: "0.20", team: { name: "other" }, seats: { h: PANE } });
  process.env.TAP_INDEX_HOME = enrollIndex(dir, { other });
  // Control: a current registry holding the id names its owner.
  expect(duplicateRegistrySessionOwner(target)).toBe("other/h");
  const indexed = JSON.parse(readFileSync(globalRegistryPath(process.env.TAP_INDEX_HOME), "utf8"));
  delete indexed.teams.other.root;
  writeFileSync(globalRegistryPath(process.env.TAP_INDEX_HOME), JSON.stringify(indexed));
  expect(duplicateRegistrySessionOwner(target)).toBe("other/h");
  // The same row in an old file refuses; it never reads as "no owner".
  writeFileSync(other, JSON.stringify({ agents: { h: PANE } }));
  let caught: unknown;
  try { duplicateRegistrySessionOwner(target); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LauncherError);
  expect((caught as LauncherError).errorClass).toBe("old_store");
});

test("register's identity owner refuses a foreign old registry instead of finding no owner", () => {
  const dir = work();
  const acting = file(join(dir, "mine", ".tap"), "team-registry.json", { schema: "0.20", team: { name: "mine" }, seats: {} });
  const other = file(join(dir, "other", ".tap"), "team-registry.json", { schema: "0.20", team: { name: "other" }, seats: { h: PANE } });
  const index = enrollIndex(dir, { mine: acting, other });
  const doc = loads(JSON.stringify({ schema: "0.20", team: { name: "mine" }, seats: {} })) as Map<string, never>;
  expect(duplicateIdentityOwner("sid-1", "h", "claude", acting, doc, index)).toBe("other/h");
  writeFileSync(other, JSON.stringify({ schema: "0.20", team: { name: "other" }, agents: { h: PANE } }));
  let caught: unknown;
  try { duplicateIdentityOwner("sid-1", "h", "claude", acting, doc, index); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TapError);
  expect((caught as TapError).errorClass).toBe("old_store");
});

test("scanners keep an old team visible in its own row: relaunch census and attach picker", () => {
  const dir = work();
  const docs: Record<string, unknown> = {
    "/cur": { schema: "0.20", team: { name: "cur" }, seats: { h: { ...PANE, harness: "claude" } } },
    "/old": { team: { name: "old" }, agents: { h: { ...PANE, harness: "claude" } } },
  };
  const teams = { cur: { root: "/r1", registry_location: "/cur" }, old: { root: "/r2", registry_location: "/old" } };
  const view = census({ json: true, dryRun: true }, "*", teams, path => docs[path]);
  expect(view.members.map(m => `${m.team}/${m.handle}`)).toEqual(["cur/h"]);
  expect(view.skipped_teams.map(s => s.team)).toEqual(["old"]);
  expect(view.skipped_teams[0]!.reason).toStartWith("old_store: ");

  const index = join(dir, "index"), repo = join(dir, "repo"), bin = join(dir, "bin");
  for (const d of [index, join(repo, ".tap/bus"), bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "t/h\\n"\n', { mode: 0o755 });
  const env = { ...process.env, TAP_INDEX_HOME: index, PATH: `${bin}:${process.env.PATH}` };
  const reg = join(repo, ".tap/bus/registry.json");
  writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", teams: { t: { root: repo, registry_location: reg, state: "registered" } } }));
  writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: { h: PANE } }));
  expect(pickerModel(env).teams[0]!.state).toBe("ok");
  writeFileSync(reg, JSON.stringify({ team: { name: "t" }, agents: { h: PANE } }));
  const row = pickerModel(env).teams[0]!;
  expect(row.state).toBe("old_store");
  expect(row.seats).toEqual([]);
  expect(row.detail).toContain(reg);
});

test("session resume renders every old_store carrier as old_store with exit 1", () => {
  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  const savedJson = process.env.TAP_JSON;
  process.env.TAP_JSON = "1";
  let codes: number[];
  try {
    codes = [
      render(new LauncherError("old", "old_store", "rename agents", "/r is old"), true),
      render(new TransactionError("/r is old", undefined, "old_store"), true),
      render(new SelectorError(1, "old_store", "rename agents", "/r is old"), true),
      // Control: an unclassed launcher refusal keeps the generic session_error arm.
      render(new LauncherError("plain refusal"), true),
    ];
  } finally {
    process.stdout.write = realWrite;
    if (savedJson === undefined) delete process.env.TAP_JSON; else process.env.TAP_JSON = savedJson;
  }
  expect(codes).toEqual([1, 1, 1, 2]);
  const classes = writes.map((line) => (JSON.parse(line) as { error_class: string }).error_class);
  expect(classes).toEqual(["old_store", "old_store", "old_store", "session_error"]);
});

test("request-path readers that never passed selection fail closed on an old store", () => {
  const dir = work();
  const row = { status: "active", instance: "w-1", permissions: "auto" };
  const current = file(dir, "current.json", { ...CURRENT, seats: { worker: row } });
  const old = file(dir, "old.json", { team: { name: "t" }, agents: { worker: row } });
  // Delivery permissions hold ("unknown") rather than reading the agents row's policy.
  expect(recordedPermissions(current, "worker")).toBe("auto");
  expect(recordedPermissions(old, "worker")).toBe("unknown");
  // Recipient instance evidence is unresolved, never a match drawn from agents.
  expect(recipientInstance(current, "worker", "w-1").state).toBe("match");
  expect(recipientInstance(old, "worker", "w-1").state).toBe("unresolved");
  // The addressee grant refuses old_store before any grant, on either registry path, and never as
  // the not_addressee class that read --force may override.
  const grant = (registryPath: string, adoptionRegistryPath: string, to: string) => addresseeGrant({
    registryPath, adoptionRegistryPath, marker: "live", team: "t", historyDir: join(dir, "history"),
    id: "t-1", from: "sender", actor: "worker", to, adoptedFrom: "", recipientInstance: "w-1",
  });
  expect(grant(current, current, "worker").ok).toBe(true);
  for (const [reg, adopt, to] of [[old, old, "worker"], [current, old, "worker"], [old, current, "fork"]] as const) {
    const refused = grant(reg, adopt, to);
    expect(refused.ok).toBe(false);
    expect(refused.errorClass).toBe("old_store");
    expect(refused.detail).toContain("is an old TAP registry format");
  }
  // The bound-pane identity gate (spool readiness, the Bash submit door) names the old store before
  // any row is read, and readiness holds on it instead of reading the recipient as gone.
  const boundRow = { ...row, pane: "s:0.0", pane_id: "%9", delivery: "pane" };
  const oldBound = file(dir, "old-bound.json", { team: { name: "t" }, agents: { worker: boundRow } });
  const currentBound = file(dir, "current-bound.json", { ...CURRENT, seats: {} });
  expect(boundPaneIdentityState(oldBound, "worker", "s:0.0", "%9")).toBe("old_store");
  expect(boundPaneIdentityState(currentBound, "worker", "s:0.0", "%9")).toBe("handle_missing_or_inactive");
  const ready = paneReady({ pane: "s:0.0", paneId: "%9", handle: "worker", toTeam: "t", targetRegistry: oldBound, policy: "",
    identity: "old_store", harnessCmd: "claude", paneInMode: "0", blockedMap: "{}", blockedExempt: "[]", frame: "",
    pending: { kind: "empty" }, band: null }, { registryMatchesTeam: () => true, recoveryAllowed: () => true,
    clearFenceState: () => "absent", blockedOrExempt: () => false, env: {} as NodeJS.ProcessEnv });
  expect(ready).toBe("busy:decision-unavailable");
  expect(recipientIsPresent(ready)).toBe(true);
});
