// A resume dry run asks the question the real run asks (tap-8my96 c, tap-i1n):
// a live seat reattaches, so the preview names the register-and-attach path
// instead of refusing on a store the live seat does not need, or planning a
// native recreate. Each dry-run arm is paired with its live specimen and
// asserts no effect: no seam call, no tmux write verb, an untouched registry.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherError } from "../src/config-error";
import { fixture, options, paneLine, recorder, restoreEnvironment, resume } from "./support/resume-harness";

afterEach(restoreEnvironment);

const registryBytes = (root: string) => readFileSync(join(root, ".tap", "bus", "registry.json"));
const TMUX_WRITES = /(?:^|\s)(?:new-session|kill-session|kill-server|kill-pane|send-keys|respawn-pane|set-option|attach|attach-session|switch-client)(?:\s|$)/;
const CURSOR_ID = "019a1111-2222-7333-8444-555555555555";

function liveSeat(harness: string, command: string, extra: Record<string, unknown> = {}) {
  return fixture({
    registry: { schema: "0.20", team: { name: "repo" },
      seats: { seat: { status: "active", delivery: "pane", session: "repo/seat", harness, pane: "repo/seat:0.0", pane_id: "%42", tag: "seat", index: 1, ...extra } } },
    tmux: [
      { match: "*has-session -t =repo/seat" },
      { match: "*display-message -p -t =repo/seat *", stdout: paneLine("repo/seat:0.0", "%42", command) },
    ],
  });
}

test("a live non-cursor seat: the dry run previews the reattach the real run takes (tap-i1n)", async () => {
  const world = liveSeat("codex", "codex", { harness_session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  const before = registryBytes(world.root);
  const live = recorder({ hasTty: true });
  const real = await resume(world.root, options({ key: "seat" }), live.deps);
  expect(real.error).toBeNull();
  expect(live.events).toEqual([["register", "repo/seat", "codex"], ["attach", "resume", "repo/seat"]]);

  const dry = recorder({ hasTty: true });
  const preview = await resume(world.root, options({ key: "seat", dryRun: true }), dry.deps);
  expect(preview.error).toBeNull();
  expect(preview.code).toBe(0);
  expect(preview.out).toContain("would reattach live session repo/seat");
  expect(preview.out).toContain("register seat via tap in, then attach");
  // Not a native recreate plan, and no effect at all.
  expect(dry.events).toEqual([]);
  expect(world.tmuxCalls().filter(call => TMUX_WRITES.test(call))).toEqual([]);
  expect(registryBytes(world.root)).toEqual(before);
});

test("a live cursor seat before its first turn: the dry run previews the reattach, not the store refusal (tap-8my96 c)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tap-resume-dry-cursor-"));
  try {
    // The stored chat id has no store.db: the seat has not taken its first turn.
    const world = liveSeat("cursor", "cursor-agent", { harness_session_id: CURSOR_ID });
    process.env.TAP_CURSOR_HOME = scratch;
    const live = recorder({ hasTty: true });
    const real = await resume(world.root, options({ key: "seat" }), live.deps);
    expect(real.error).toBeNull();
    expect(live.events).toEqual([["register", "repo/seat", "cursor"], ["attach", "resume", "repo/seat"]]);

    const dry = recorder({ hasTty: true });
    const preview = await resume(world.root, options({ key: "seat", dryRun: true }), dry.deps);
    expect(preview.error).toBeNull();
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("would reattach live session repo/seat");
    expect(dry.events).toEqual([]);
    expect(world.tmuxCalls().filter(call => TMUX_WRITES.test(call))).toEqual([]);
  } finally {
    restoreEnvironment();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a live seat whose retained row is suspended/pane_gone (identity unverified): the dry run refuses as the real run does, writing nothing", async () => {
  const world = liveSeat("codex", "codex", { status: "suspended", status_reason: "pane_gone",
    harness_session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  const before = registryBytes(world.root);
  const refusals: (string | undefined)[] = [];
  for (const dryRun of [false, true]) {
    const { events, deps } = recorder({ hasTty: true });
    const result = await resume(world.root, options({ key: "seat", dryRun }), deps);
    refusals.push(result.error?.message);
    expect(events).toEqual([]);
  }
  expect(refusals[1]).toBeDefined();
  expect(refusals[1]).toBe(refusals[0]);
  expect(registryBytes(world.root)).toEqual(before);
});

test("a stale stopped cursor seat is refused identically by the dry run and the real run", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tap-resume-dry-stale-"));
  try {
    const world = fixture({ registry: { schema: "0.20", team: { name: "repo" },
      seats: { seat: { status: "suspended", status_reason: "session_stopped", harness: "cursor", delivery: "pane", session: "repo/seat",
        pane: "", pane_id: "", harness_session_id: CURSOR_ID, tag: "seat", index: 1 } } } });
    process.env.TAP_CURSOR_HOME = scratch;
    const before = registryBytes(world.root);
    const seen: (string | undefined)[] = [];
    for (const dryRun of [false, true]) {
      const { events, deps } = recorder();
      const result = await resume(world.root, options({ key: "seat", dryRun }), deps);
      seen.push((result.error as { errorClass?: string } | null)?.errorClass);
      expect(events.filter(event => event[0] === "run" || event[0] === "register")).toEqual([]);
    }
    expect(seen).toEqual(["no_exact_resume_identity", "no_exact_resume_identity"]);
    expect(registryBytes(world.root)).toEqual(before);
  } finally {
    restoreEnvironment();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the live reattach preview honors --json and TAP_JSON with one structured receipt", async () => {
  const world = liveSeat("codex", "codex", { harness_session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  for (const spelling of ["flag", "env"] as const) {
    if (spelling === "env") process.env.TAP_JSON = "1";
    const { events, deps } = recorder({ hasTty: true });
    const preview = await resume(world.root, options({ key: "seat", dryRun: true, json: spelling === "flag" }), deps);
    expect(preview.error).toBeNull();
    expect(JSON.parse(preview.out)).toEqual({ ok: true, outcome: "would_reattach", name: "repo/seat", harness: "codex",
      handle: "seat", pane: "repo/seat:0.0", steps: ["register", "attach"] });
    expect(events).toEqual([]);
  }
});

test("a live pane running another harness: the dry run refuses with a typed class, writing nothing", async () => {
  const world = liveSeat("cursor", "codex", { harness_session_id: CURSOR_ID });
  const before = registryBytes(world.root);
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "seat", dryRun: true, json: true }), deps);
  expect(result.out).toBe("");
  expect((result.error as LauncherError | null)?.errorClass).toBe("live_session_unmatched");
  expect(result.error?.message).toContain("active pane is codex, not cursor");
  expect(events).toEqual([]);
  expect(registryBytes(world.root)).toEqual(before);
});
