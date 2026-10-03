import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { attachSelected, cmdAttach } from "../src/verbs/attach";
import { TapError } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const scripts = join(root, "skills/tap/scripts");
const scratch: string[] = [];
const savedEnv: Array<[string, string | undefined]> = [];
afterEach(() => {
  for (const [key, value] of savedEnv.splice(0).reverse()) {
    if (key === "@CWD") process.chdir(value!);
    else if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const dir of scratch.splice(0)) removeScratchTree(dir);
});

// The acting-registry fixture: an enrolled team whose registry lives at
// <dir>/.tap/team-registry.json. attach derives the acting team name from the
// cwd basename, so the index entry and registry doc both name it so. The tmux
// shim only has to keep the observation engine answerable; every refusal under
// test fires before any pane read.
function fixture(seats: Record<string, unknown>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tap-attach-refuse.")));
  scratch.push(dir);
  const team = basename(dir);
  const bus = join(dir, ".tap", "bus"), bin = join(dir, "bin"), index = join(dir, "index");
  for (const path of [bus, bin, index]) mkdirSync(path, { recursive: true });
  const registry = join(dir, ".tap", "team-registry.json");
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    [team]: { root: dir, registry_location: registry, state: "registered" },
  } }));
  writeFileSync(registry, seatJson(seats, dir, team));
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
case "\$1" in -L|-S) shift 2 ;; esac
case "\$1" in
  list-sessions) printf 'fixture/a\\t4242:100\\n' ;;
  list-panes) printf 'fixture/a\\tfixture/a:0.0\\t%%1\\tclaude\\t999\\t4242:100\\t0\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  for (const [key, value] of Object.entries({
    PATH: `${bin}:${process.env.PATH}`, HOME: dir, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_BOOT_ID: "boot:1", TAP_SERVER_EPOCH: "srv:4242:100",
    TAP_ONBOARDING_CHECKED: "1", TAP_INTERNAL_OVERDUE_CHECKED: "1",
  })) { savedEnv.push([key, process.env[key]]); process.env[key] = value; }
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF"]) {
    savedEnv.push([key, process.env[key]]); delete process.env[key];
  }
  savedEnv.push(["@CWD", process.cwd()]);
  process.chdir(dir);
  const run = (args: string[]): TapError => {
    try { void cmdAttach(args, scripts); } catch (error) {
      if (error instanceof TapError) return error;
      throw error;
    }
    throw new Error(`cmdAttach(${JSON.stringify(args)}) did not refuse`);
  };
  return { dir, registry, save: (bytes: string) => writeFileSync(registry, bytes), run };
}

function seatJson(seats: Record<string, unknown>, worktreeRoot: string, team: string): string {
  return JSON.stringify({ schema: "0.20", team: { name: team, worktree_root: worktreeRoot }, seats });
}

test("attach with a corrupt acting registry refuses registry_invalid; a missing one is unreachable_team", () => {
  const f = fixture({ a: paneRow() });
  f.save('{"team":');
  const corrupt = f.run(["a"]);
  expect(corrupt.errorClass).toBe("registry_invalid");
  expect(corrupt.action).toBe("tap doctor");
  expect(corrupt.detail).toContain(f.registry);
  // tap-urpxv decision, pinned while THIS fixture is still the active env
  // (a later fixture() rewrites process.env, so the missing case must run
  // before the control below — grok review round 2): delete the indexed
  // registry. The actual contract is resolution's own verdict — the local
  // arm maps a missing registry file to unreachable_team ("no usable stored
  // registry_location post-flip"), not "no seat".
  unlinkSync(f.registry);
  expect(existsSync(f.registry)).toBe(false);
  const missing = f.run(["a"]);
  expect(missing.errorClass).toBe("unreachable_team");
  expect(missing.detail).toContain("has no usable stored registry_location post-flip");
  // Positive control: readable bytes with a different roster answer the seat
  // question — the mutant this test catches is the old `rows ?? []` swallow,
  // which read the corrupt file as "no seat 'a'" (not_found).
  const control = fixture({ b: paneRow("b") });
  const noSeat = control.run(["a"]);
  expect(noSeat.errorClass).toBe("not_found");
  expect(noSeat.detail).toContain("no seat 'a'");
});

test("attach --next with a corrupt acting registry refuses registry_invalid", () => {
  const f = fixture({ a: paneRow() });
  f.save("not json at all");
  const corrupt = f.run(["--next"]);
  expect(corrupt.errorClass).toBe("registry_invalid");
  expect(corrupt.action).toBe("tap doctor");
  expect(corrupt.detail).toContain(f.registry);
  // Positive control: readable bytes reach the eligibility answer (a poll-only
  // roster has nothing to hop to) instead of the refusal.
  const control = fixture({ poller: { status: "active", delivery: "poll", session: "fixture/poller" } });
  const notAttachable = control.run(["--next"]);
  expect(notAttachable.errorClass).toBe("not_attachable");
  // Presence is already pinned by the --next isFile arm: a missing registry
  // keeps its own registry_unreachable refusal.
  const missing = fixture({});
  unlinkSync(missing.registry);
  const gone = missing.run(["--next"]);
  expect(gone.errorClass).toBe("registry_unreachable");
});

test("invalid UTF-8 in the acting registry refuses registry_invalid on every path", () => {
  const byHandle = fixture({ a: paneRow() });
  writeFileSync(byHandle.registry, Buffer.from([0x7b, 0x22, 0xe9]));
  expect(byHandle.run(["a"]).errorClass).toBe("registry_invalid");
  const next = fixture({ a: paneRow() });
  writeFileSync(next.registry, Buffer.from([0x7b, 0x22, 0xe9]));
  expect(next.run(["--next"]).errorClass).toBe("registry_invalid");
});

test("machine attach retains explicit misses and rejects malformed syntax before discovery", async () => {
  const f = fixture({ a: paneRow() });
  expect(f.run(["missing"]).errorClass).toBe("not_found");
  expect(f.run(["missing/team/extra"]).errorClass).toBe("usage_error");
  expect(f.run(["bad!"]).errorClass).toBe("usage_error");
  await expect(Promise.resolve(cmdAttach([], scripts))).rejects.toMatchObject({ errorClass: "no_terminal" });
});

test("picker-selected same-name replacement refuses before any tmux attach", () => {
  const f = fixture({ a: { ...paneRow(), instance: "replacement" } });
  const selection = { target: `${basename(f.dir)}/a`, team: basename(f.dir), handle: "a", root: f.dir,
    registry: f.registry, identity: { instance: "original", pane: "fixture/a:0.0", paneId: "%1",
      session: "fixture/a", serverEpoch: "", serverSocket: "", bootId: "", registeredAt: "2026-09-01T00:00:00Z",
      observedPane: "fixture/a:0.0", observedPaneId: "%1" } };
  expect(() => attachSelected(selection, scripts)).toThrowError(TapError);
  try { attachSelected(selection, scripts); } catch (error) {
    expect(error).toMatchObject({ errorClass: "selection_changed" });
  }
  expect(() => attachSelected({ ...selection, identity: { ...selection.identity, serverSocket: "/foreign/tmux/socket" } }, scripts))
    .toThrowError(TapError);
  try { attachSelected({ ...selection, identity: { ...selection.identity, serverSocket: "/foreign/tmux/socket" } }, scripts); }
  catch (error) { expect(error).toMatchObject({ errorClass: "socket_mismatch" }); }
  writeFileSync(f.registry, seatJson({ a: { ...paneRow(), instance: "original" } }, f.dir, basename(f.dir)));
  writeFileSync(join(f.dir, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    [basename(f.dir)]: { root: join(f.dir, "replacement"), registry_location: f.registry, state: "registered" },
  } }));
  expect(() => attachSelected(selection, scripts)).toThrowError(TapError);
  try { attachSelected(selection, scripts); } catch (error) {
    expect(error).toMatchObject({ errorClass: "selection_changed" });
  }
});

test("an unchanged picker choice uses the native attach classifier and moves its exact pane", () => {
  const row = { ...paneRow("sol"), instance: "sol|A" };
  const f = fixture({ sol: row });
  const effect = join(f.dir, "attached");
  writeFileSync(join(f.dir, "bin/tmux"), `#!/usr/bin/env bash
case "$1" in -L|-S) shift 2 ;; esac
case "$1" in
  list-sessions)
    if [[ "$*" == *session_attached* ]]; then printf 'fixture/sol\\t4242:100\\t0\\n';
    else printf 'fixture/sol\\t4242:100\\n'; fi ;;
  list-panes) printf 'fixture/sol\\tfixture/sol:0.0\\t%%1\\tclaude\\t999\\t4242:100\\t0\\n' ;;
  display-message) printf '%%1\\n' ;;
  attach-session) printf 'attached\\n' > '${effect}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const selected = { target: `${basename(f.dir)}/sol`, team: basename(f.dir), handle: "sol", root: f.dir,
    registry: f.registry, identity: { instance: "sol|A", pane: "fixture/sol:0.0", paneId: "%1", session: "fixture/sol",
      serverEpoch: "", serverSocket: "", bootId: "", registeredAt: "2026-09-01T00:00:00Z",
      observedPane: "fixture/sol:0.0", observedPaneId: "%1" } };
  expect(attachSelected(selected, scripts)).toBe(0);
  expect(existsSync(effect)).toBe(true);
});

function paneRow(handle = "a"): Record<string, unknown> {
  return { status: "active", delivery: "pane", pane: `fixture/${handle}:0.0`, pane_id: "%1",
    session: `fixture/${handle}`, registered_at: "2026-09-01T00:00:00Z", harness: "claude" };
}
