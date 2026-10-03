import { afterEach, expect, mock, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterSend, delay, duration, humanLine, main, OUTAGE_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS, retrySchedule, type ReminderRow, type Rows } from "../src/remind";
import { KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { acquireNoFollowLock } from "../src/remind-lock";
import { removeScratchTree } from "./support/scratch";
import { BUN_FLOOR, SIDECAR_SOURCES } from "../src/watch-run";
import { GOALIE_SIDECAR_SOURCES } from "../src/goalie-run";

const REMIND = join(import.meta.dir, "../src/remind.ts");
const TAP = join(import.meta.dir, "../../../bin/tap");
const LEASE_TS = join(import.meta.dir, "../src/watch-lease.ts");
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) removeScratchTree(path); });

function scratch(): string {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "remind-unit."));
  roots.push(root);
  return root;
}

function row(over: Partial<ReminderRow> = {}): ReminderRow {
  return { owner: "owner", to: "peer", body: "Check CI", due_at: 110, every_seconds: 0, status: "scheduled", ...over };
}

// --- pure decisions -----------------------------------------------------------

test("duration accepts the four units and refuses everything the incumbent refused", () => {
  expect(duration("10s")).toBe(10);
  expect(duration("8m")).toBe(480);
  expect(duration("2h")).toBe(7200);
  expect(duration("1d")).toBe(86400);
  expect(duration("007s")).toBe(7);
  for (const bad of ["", "s", "10", "10x", "-1s", "1.5m", "1_0s", " 5s", "٣s"]) {
    expect(() => duration(bad)).toThrow("duration must be a positive integer followed by s, m, h, or d");
  }
  for (const out of ["0s", "00m", "2147483648s", "24856d", "99999999999999999999s"]) {
    expect(() => duration(out)).toThrow("duration is out of range");
  }
  expect(duration("2147483647s")).toBe(2147483647);
});

test("delay is the tick interval or the nearest scheduled deadline, never below one second", () => {
  const rows: Rows = {
    a: row({ due_at: 150 }),
    b: row({ due_at: 105 }),                       // 5s out -> the nearest deadline
    c: row({ due_at: 90, status: "dispatching" }), // overdue but claimed -> ignored
    d: row({ due_at: 95, status: "unresolved" }),  // overdue but failed -> ignored
  };
  expect(delay(rows, 60, 100)).toBe(5);
  // An overdue SCHEDULED row clamps to one second rather than a zero or negative sleep.
  expect(delay({ ...rows, e: row({ due_at: 40 }) }, 60, 100)).toBe(1);
  expect(delay({ a: row({ due_at: 150 }) }, 60, 100)).toBe(50);
  expect(delay({ a: row({ due_at: 500 }) }, 60, 100)).toBe(60);
  expect(delay({}, 60, 100)).toBe(60);
  expect(delay({ c: row({ status: "accepted" }) }, 45, 100)).toBe(45);
});

test("afterSend: 0 and 5 are handed off; a repeat reschedules from the dispatch tick; anything else is unresolved", () => {
  const once = row({ status: "dispatching" });
  afterSend(once, 0, '{"status":"injected"}', 130);
  expect(once).toMatchObject({ status: "accepted", exit_code: 0, result: '{"status":"injected"}', due_at: 110 });

  const parked = row({ status: "dispatching" });
  afterSend(parked, 5, "parked", 130);
  expect(parked.status).toBe("accepted");

  const repeat = row({ status: "dispatching", every_seconds: 5 });
  afterSend(repeat, 0, "", 130);
  expect(repeat).toMatchObject({ status: "scheduled", due_at: 135 });

  for (const rc of [1, 2, 4, 7, 124]) {
    const failed = row({ status: "dispatching", every_seconds: 5 });
    afterSend(failed, rc, "boom", 130);
    expect(failed).toMatchObject({ status: "unresolved", exit_code: rc, due_at: 110 });
  }
});

const CUSTODY_BUSY = JSON.stringify({
  ok: false, error_class: "reset_custody_busy",
  action: "retry this command; another TAP mutation (such as a send still delivering) holds the reset sidecar",
  detail: "refusing tap send — could not obtain reset mutation custody (lock at /bus/reset.fence.json.lock)",
});

test("afterSend reschedules a declared-retry refusal on the backoff, then leaves it unresolved (tap-o31y6)", () => {
  const busy = row({ status: "dispatching", every_seconds: 600 });
  let now = 130;
  for (const [i, wait] of RETRY_BACKOFF_SECONDS.entries()) {
    afterSend(busy, 1, CUSTODY_BUSY, now);
    expect(busy).toMatchObject({ status: "scheduled", due_at: now + wait, retry_attempts: i + 1, exit_code: 1 });
    now += wait;
  }
  afterSend(busy, 1, CUSTODY_BUSY, now);
  expect(busy).toMatchObject({ status: "unresolved", retry_attempts: RETRY_BACKOFF_SECONDS.length });

  // A success after a retry clears the counter and reschedules a repeat from that tick.
  const recovered = row({ status: "dispatching", every_seconds: 600 });
  afterSend(recovered, 1, CUSTODY_BUSY, 130);
  afterSend(recovered, 0, '{"status":"injected"}', 135);
  expect(recovered).toMatchObject({ status: "scheduled", due_at: 735 });
  expect(recovered).not.toHaveProperty("retry_attempts");
});

test("only exit 1 with the declared action 'retry this command' is retryable", () => {
  expect(retrySchedule(1, CUSTODY_BUSY)).toBe(RETRY_BACKOFF_SECONDS);
  // Actions that name a change before any retry are not a blind-repeat contract.
  expect(retrySchedule(1, JSON.stringify({ ok: false, error_class: "forwarding_unavailable", action: "tap team; retry with a current recipient" }))).toBeNull();
  expect(retrySchedule(1, JSON.stringify({ ok: false, error_class: "identity_mismatch", action: "verify the exact tmux session and pane, then retry" }))).toBeNull();
  // A possible-effect exit never retries, whatever its text says.
  for (const rc of [0, 2, 3, 5, 124]) expect(retrySchedule(rc, CUSTODY_BUSY)).toBeNull();
  for (const output of ["", "retry this command", "null", "[]", '{"action":7}']) expect(retrySchedule(1, output)).toBeNull();

  const forwarding = row({ status: "dispatching" });
  afterSend(forwarding, 1, JSON.stringify({ ok: false, error_class: "forwarding_unavailable", action: "tap team; retry with a current recipient" }), 130);
  expect(forwarding.status).toBe("unresolved");
});

// The refusal `tap send` prints when the tmux server stopped answering before it
// placed anything or touched the pane (tap-yk8it), and the one it prints after.
const OUTAGE_NO_EFFECT = JSON.stringify({
  ok: false, error_class: "server_unresponsive",
  action: "wait for the tmux server to answer, then repeat this command",
  detail: "server_unresponsive socket=/tmp/tmux-1/default server_pid=unknown; tmux client deadline expired; refused before placement or any pane effect",
  effect: "none",
});
const OUTAGE_UNKNOWN = JSON.stringify({
  ok: false, error_class: "server_unresponsive", action: "inspect the server; do not retry a possible effect",
  detail: "server_unresponsive socket=/tmp/tmux-1/default server_pid=unknown; tmux client deadline expired; outcome unknown",
});

test("a server_unresponsive refusal is re-attempted only on its typed no-effect field, never on its text (tap-yk8it)", () => {
  expect(retrySchedule(1, OUTAGE_NO_EFFECT)).toBe(OUTAGE_BACKOFF_SECONDS);
  const parsed = JSON.parse(OUTAGE_NO_EFFECT);
  // The class without the field, or with any other value, is an unknown outcome.
  expect(retrySchedule(1, OUTAGE_UNKNOWN)).toBeNull();
  for (const effect of ["possible", "None", true, 0, null]) {
    expect(retrySchedule(1, JSON.stringify({ ...parsed, effect }))).toBeNull();
  }
  // Retry-shaped action text does not rescue a refusal that states no effect point.
  expect(retrySchedule(1, JSON.stringify({ ...JSON.parse(OUTAGE_UNKNOWN), action: "retry this command" }))).toBeNull();
  expect(retrySchedule(1, JSON.stringify({ ...parsed, effect: "possible", action: "retry this command" }))).toBeNull();
  // The field alone is not the proof: another class carrying it keeps its own rule.
  expect(retrySchedule(1, JSON.stringify({ ok: false, error_class: "identity_mismatch", action: "tap team", effect: "none" }))).toBeNull();
  for (const rc of [0, 2, 5, 124]) expect(retrySchedule(rc, OUTAGE_NO_EFFECT)).toBeNull();
});

test("afterSend waits out an outage on its own longer schedule, and a recovery clears the count (tap-yk8it)", () => {
  const out = row({ status: "dispatching" });
  let now = 130;
  for (const [i, wait] of OUTAGE_BACKOFF_SECONDS.entries()) {
    afterSend(out, 1, OUTAGE_NO_EFFECT, now);
    expect(out).toMatchObject({ status: "scheduled", due_at: now + wait, retry_attempts: i + 1 });
    now += wait;
  }
  afterSend(out, 1, OUTAGE_NO_EFFECT, now);
  expect(out).toMatchObject({ status: "unresolved", retry_attempts: OUTAGE_BACKOFF_SECONDS.length });

  // Mid-schedule recovery: delivered once, counter gone, a repeat resumes its cadence.
  const recovered = row({ status: "dispatching", every_seconds: 600 });
  afterSend(recovered, 1, OUTAGE_NO_EFFECT, 130);
  afterSend(recovered, 1, OUTAGE_NO_EFFECT, 160);
  expect(recovered).toMatchObject({ status: "scheduled", due_at: 280, retry_attempts: 2 });
  afterSend(recovered, 5, '{"status":"queued"}', 280);
  expect(recovered).toMatchObject({ status: "scheduled", due_at: 880 });
  expect(recovered).not.toHaveProperty("retry_attempts");

  // A timeout after a possible effect is terminal on its first attempt.
  const possible = row({ status: "dispatching" });
  afterSend(possible, 1, OUTAGE_UNKNOWN, 130);
  expect(possible.status).toBe("unresolved");
  expect(possible).not.toHaveProperty("retry_attempts");
});

test("humanLine preserves the scheduled and accepted output", () => {
  // The retired inline Python:
  //   "{id}  {owner}->{to}  {status}  due={due_at}  every={every_seconds}s  message={message_id}"
  // with message_id defaulting to "-". Extra keys (body, exit_code, result) were ignored.
  expect(humanLine("remind-ab", row())).toBe("remind-ab  owner->peer  scheduled  due=110  every=0s  message=-");
  expect(humanLine("remind-cd", row({ status: "accepted", every_seconds: 5, message_id: "watcher-20260915T000000Z-0a0b0c0d0e0f", exit_code: 0, result: "x" })))
    .toBe("remind-cd  owner->peer  accepted  due=110  every=5s  message=watcher-20260915T000000Z-0a0b0c0d0e0f");
});

test("humanLine shows bounded refusal reasons without changing rows or implying a dispatching result", () => {
  const cases: Array<{ input: ReminderRow; suffix: string }> = [
    {
      input: row({ status: "unresolved", exit_code: 1, result: JSON.stringify({
        ok: false, error_class: "reset_custody_busy", action: "retry this command",
        detail: "could not obtain reset mutation custody\n(lock at /bus/reset.fence.json.lock)",
      }) }),
      suffix: "  exit=1  failure=reset_custody_busy: could not obtain reset mutation custody (lock at /bus/reset.fence.json.lock)  full result: tap remind list --json",
    },
    {
      input: row({ status: "unresolved", exit_code: 1, result: JSON.stringify({
        ok: false, error_class: "forwarding_unavailable", action: "tap team; retry with a current recipient",
        detail: "cannot resolve pinned forwarding for 'fable-guide'; no payload was placed",
      }) }),
      suffix: "  exit=1  failure=forwarding_unavailable: cannot resolve pinned forwarding for 'fable-guide'; no payload was placed  full result: tap remind list --json",
    },
    {
      input: row({ status: "unresolved", exit_code: 124, result: `sender\tfailed\r\n${"x".repeat(180)}` }),
      suffix: `  exit=124  failure=sender failed ${"x".repeat(146)}  full result: tap remind list --json`,
    },
    {
      input: row({ status: "dispatching", exit_code: 0, result: '{"status":"injected"}' }),
      suffix: "",
    },
  ];
  for (const { input, suffix } of cases) {
    const before = JSON.stringify(input);
    expect(humanLine("remind-case", input)).toBe(`remind-case  owner->peer  ${input.status}  due=110  every=0s  message=-${suffix}`);
    expect(JSON.stringify(input)).toBe(before);
  }
});

test("human list shows the failed terminal delivery even when the fallback succeeds", () => {
  const input = row({ status: "unresolved", exit_code: 0, result: "{}", job: {
    command: "true", cwd: "/scratch", fallback: "leader", circle_seconds: 60,
    started_at: 100, heartbeat_at: 100, phase: "done", tail: "", pending: [],
    terminal_deliveries: [
      { to: "peer", id: "failed", exit_code: 3, result: "recipient-gone" },
      { to: "leader", id: "accepted", exit_code: 0, result: "{}" },
    ],
  } });
  const before = JSON.stringify(input);
  expect(humanLine("batch", input)).toContain("exit=3  failure=recipient-gone");
  expect(JSON.stringify(input)).toBe(before);
  for (const accepted of [0, 5]) {
    input.job!.terminal_deliveries!.unshift({ to: "other", id: "parked", exit_code: accepted, result: "accepted" });
    expect(humanLine("batch", input)).toContain("exit=3  failure=recipient-gone");
  }
  input.job!.terminal_deliveries = [
    { to: "peer", id: "sent", exit_code: 0, result: "{}" },
    { to: "leader", id: "unsent" },
  ];
  input.result = "arm changed during terminal delivery batch";
  expect(humanLine("batch", input)).toContain("exit=0  failure=arm changed during terminal delivery batch");
});

test("human list tolerates non-string persisted results and keeps the following row", () => {
  const state = join(scratch(), "reminders.json");
  for (const result of [42, false, ["bad", "row"], { error_class: "bad_row" }]) {
    const rows = { malformed: { ...row({ status: "unresolved", exit_code: 1 }), result }, next: row() };
    const before = JSON.stringify(rows);
    writeFileSync(state, before);
    const listed = cli({}, state, "list");
    expect(listed.rc).toBe(0);
    expect(listed.out).toContain(`failure=${String(result)}  full result: tap remind list --json`);
    expect(listed.out).toContain("next  owner->peer  scheduled");
    expect(JSON.parse(cli({}, state, "list", "--json").out)).toEqual(Object.entries(rows).map(([id, row]) => ({ id, ...row })));
    expect(readFileSync(state, "utf8")).toBe(before);
  }
});

// --- the CLI on a scratch queue -------------------------------------------------

function cli(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [REMIND, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { rc: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

test("fire's post-body lease check refuses a re-arm that lands between the claim and the send", async () => {
  // Both lease checks are existsSync + readFileSync on arm.json. Making the lease a FIFO
  // lets a writer hand each read a different generation, so ONLY the second read sees the
  // re-arm (`tap watch on` stamps a fresh armed_at under a lock fire never holds). The
  // pre-claim check reads generation 140 and passes; removing the post-body check sends.
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  const fake = join(root, "scripts");
  const sent = join(root, "sent");
  const gens = join(root, "generations");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "courier"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$REMIND_SENT"\nprintf \'{"status":"injected"}\\n\'\n');
  chmodSync(join(fake, "courier"), 0o755);
  const body = join(root, "body");
  writeFileSync(body, "Check the CI result.");
  const env = { TAP_WATCH_NOW: "100", REMIND_SENT: sent, TAP_COURIER_SCRIPT: join(fake, "courier") };

  const added = cli(env, state, "add", "owner", "peer", body, "--in", "10s");
  expect(added.rc).toBe(0);
  unlinkSync(arm);
  expect(spawnSync("mkfifo", [arm]).status).toBe(0);
  // Generation 141 is gated on an observable event, so the two generations can never
  // both reach the first read: the writer opens the FIFO the second time only after
  // fire's dispatching claim is visible on disk (published after the pre-claim read).
  const writer = spawn(process.execPath, ["-e", `
    const { openSync, writeSync, closeSync, appendFileSync, readFileSync } = require("node:fs");
    const put = (generation) => {
      const fd = openSync(${JSON.stringify(arm)}, "w");
      writeSync(fd, JSON.stringify({ armed_at: generation }));
      closeSync(fd);
      appendFileSync(${JSON.stringify(gens)}, generation + "\\n");
    };
    const claimed = () => {
      try { return Object.values(JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"))).some((row) => row.status === "dispatching"); }
      catch { return false; }
    };
    put(140);
    const deadline = Date.now() + 10000;
    while (!claimed()) {
      if (Date.now() > deadline) process.exit(2);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    put(141);`], { stdio: "ignore" });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => writer.once("exit", (code, signal) => resolve({ code, signal })));
  const bounded = async <T>(work: Promise<T>, ms: number): Promise<T | "timeout"> =>
    Promise.race([work, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
  try {
    // fire itself is bounded: a reader stuck on the FIFO must fail the test, not hang it.
    const fired = spawnSync(process.execPath, [REMIND, state, "fire", fake, "140"], {
      env: { ...process.env, ...env, TAP_WATCH_NOW: "110" }, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL",
    });
    expect(fired.error, "fire timed out").toBeUndefined();
    expect(fired.status, fired.stderr).toBe(0);
    // Vacuity guard: the writer confirmed BOTH writes (it exits 0 only after the second),
    // so the two reads saw two different generations, one per open.
    expect(await bounded(exited, 10_000)).toEqual({ code: 0, signal: null });
    expect(readFileSync(gens, "utf8")).toBe("140\n141\n");
    // Refused at the post-body check: nothing was sent, and the row rolled back to
    // scheduled with the claim's message_id left behind (the pre-claim refusal leaves none).
    expect(existsSync(sent)).toBe(false);
    expect((JSON.parse(readFileSync(state, "utf8")) as Rows)[added.out]).toMatchObject({ status: "scheduled", message_id: expect.stringMatching(/^watcher-/) });
  } finally {
    // Reap the writer we started (its recorded handle, never a pattern), then remove the FIFO.
    if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    await bounded(exited, 5_000);
    if (existsSync(arm)) unlinkSync(arm);
  }
});

test("add mints the minimal lease, fire claims before the sole attempt and re-checks the lease, finish drops an idle lease", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  const fake = join(root, "scripts");
  const sent = join(root, "sent");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "courier"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$REMIND_SENT"\ncat "$2" >> "$REMIND_SENT.bodies"\nprintf \'{"status":"injected"}\\n\'\nexit "${REMIND_EXIT:-0}"\n');
  chmodSync(join(fake, "courier"), 0o755);
  const body = join(root, "body");
  writeFileSync(body, "Check the CI result. Literal $(not-a-command).");
  const env = { TAP_WATCH_NOW: "100", REMIND_SENT: sent, TAP_COURIER_SCRIPT: join(fake, "courier") };

  const added = cli(env, state, "add", "owner", "peer", body, "--in", "10s");
  expect(added.rc).toBe(0);
  const ident = added.out;
  expect(ident).toMatch(/^remind-[0-9a-f]{16}$/);
  expect(JSON.parse(readFileSync(arm, "utf8"))).toEqual({ mode: "reminders-only", armed_by: "owner", armed_at: 100, evaluator: "none", tick_interval_seconds: 60 });

  // Not due yet: no attempt.
  expect(cli(env, state, "fire", fake, "100").rc).toBe(0);
  expect(existsSync(sent)).toBe(false);

  // Due, lease current: exactly one attempt, claim persisted with a message id, body framed.
  expect(cli({ ...env, TAP_WATCH_NOW: "110" }, state, "fire", fake, "100").rc).toBe(0);
  const lines = readFileSync(sent, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(new RegExp(`^peer \\S+/\\.remind-body-[0-9a-f]{12}\\.md --from watcher --id watcher-19700101T000150Z-[0-9a-f]{12} --kind notice --fyi --wake --json$`));
  expect(readFileSync(`${sent}.bodies`, "utf8")).toBe(`Reminder ${ident}, scheduled by owner.\n\nCheck the CI result. Literal $(not-a-command).\n`);
  const rows = JSON.parse(readFileSync(state, "utf8")) as Rows;
  expect(rows[ident]).toMatchObject({ status: "accepted", exit_code: 0, result: '{"status":"injected"}' });
  expect(rows[ident]!.message_id).toMatch(/^watcher-19700101T000150Z-[0-9a-f]{12}$/);
  // The temp body never outlives the attempt.
  expect(existsSync(lines[0]!.split(" ")[1]!)).toBe(false);

  // A stale lease identity dispatches nothing and does not disarm.
  const again = cli({ ...env, TAP_WATCH_NOW: "300" }, state, "add", "owner", "peer", body, "--at", "300");
  expect(again.rc).toBe(0);
  expect(cli({ ...env, TAP_WATCH_NOW: "300" }, state, "fire", fake, "999").rc).toBe(0);
  expect(readFileSync(sent, "utf8").trim().split("\n")).toHaveLength(1);
  expect(cli({ ...env, TAP_WATCH_NOW: "300" }, state, "finish", "999").rc).toBe(0);
  expect(existsSync(arm)).toBe(true);
  // The PRE-CLAIM lease check, individually. Both checks refuse a stale tick, but
  // they leave different state: the pre-claim one refuses before the claim is
  // minted, so no message_id exists. The post-body one rolls status back to
  // `scheduled` and LEAVES the message_id (faithful to reminders.py:84). Asserting
  // the absence is what distinguishes them -- without it, removing either check is
  // invisible because the other catches the same arm.
  expect((JSON.parse(readFileSync(state, "utf8")) as Rows)[again.out]).not.toHaveProperty("message_id");

  // Cancel is owner-gated; list carries every field; finish on an idle queue drops the lease.
  expect(cli(env, state, "cancel", "other", again.out)).toMatchObject({ rc: 1, err: "tap remind: only the scheduling seat can cancel this reminder" });
  expect(cli(env, state, "cancel", "owner", "remind-nope")).toMatchObject({ rc: 1, err: "tap remind: unknown reminder" });
  expect(cli(env, state, "cancel", "owner", again.out).rc).toBe(0);
  const listed = JSON.parse(cli(env, state, "list", "--json").out) as Array<{ id: string; status: string }>;
  expect(listed.map(r => [r.id, r.status])).toEqual([[ident, "accepted"]]);
  expect(cli(env, state, "list").out).toBe(humanLine(ident, rows[ident]!));
  expect(cli(env, state, "delay", "60").out).toBe("60");
  expect(cli(env, state, "finish", "100").rc).toBe(0);
  expect(existsSync(arm)).toBe(false);
});

test("fire retries a custody-busy send on later ticks, then notifies the owner once when it gives up (tap-o31y6)", () => {
  const root = scratch();
  const state = join(root, "bus", "watch", "reminders.json");
  const fake = join(root, "scripts");
  const sent = join(root, "sent");
  mkdirSync(fake, { recursive: true });
  // Refuses every send to `peer` while $REMIND_BUSY_LEFT counts down; the owner's notice is accepted.
  writeFileSync(join(fake, "courier"), `#!/bin/bash
printf "%s\\n" "$*" >> "$REMIND_SENT"
cat "$2" >> "$REMIND_SENT.bodies"
left="$(cat "$REMIND_BUSY_LEFT")"
if [ "$1" = peer ] && [ "$left" -gt 0 ]; then
  printf '%s\\n' "$((left - 1))" > "$REMIND_BUSY_LEFT"
  printf '%s\\n' '${CUSTODY_BUSY}'
  exit 1
fi
printf '{"status":"injected"}\\n'
`);
  chmodSync(join(fake, "courier"), 0o755);
  const body = join(root, "body");
  writeFileSync(body, "Sweep the lanes.");
  const busyLeft = join(root, "busy-left");
  const env = { TAP_WATCH_NOW: "100", REMIND_SENT: sent, REMIND_BUSY_LEFT: busyLeft, TAP_COURIER_SCRIPT: join(fake, "courier") };
  const fireAt = (at: number) => expect(cli({ ...env, TAP_WATCH_NOW: String(at) }, state, "fire", fake, "100").rc).toBe(0);
  const sentTo = () => readFileSync(sent, "utf8").trim().split("\n").map(line => line.split(" ")[0]);

  // Two refusals, then delivery: three attempts on three ticks, accepted.
  writeFileSync(busyLeft, "2\n");
  const recovers = cli(env, state, "add", "owner", "peer", body, "--in", "10s").out;
  fireAt(110);
  expect((JSON.parse(readFileSync(state, "utf8")) as Rows)[recovers]).toMatchObject({ status: "scheduled", due_at: 115, retry_attempts: 1 });
  fireAt(112); // not yet due: no attempt
  expect(sentTo()).toEqual(["peer"]);
  fireAt(115);
  fireAt(130);
  expect(sentTo()).toEqual(["peer", "peer", "peer"]);
  const accepted = (JSON.parse(readFileSync(state, "utf8")) as Rows)[recovers]!;
  expect(accepted).toMatchObject({ status: "accepted", exit_code: 0 });
  expect(accepted).not.toHaveProperty("retry_attempts");
  expect(accepted).not.toHaveProperty("notice");

  // Refused on every attempt: 1 + backoff-length attempts, then unresolved with one owner notice.
  writeFileSync(busyLeft, "99\n");
  writeFileSync(sent, "");
  const exhausted = cli({ ...env, TAP_WATCH_NOW: "200" }, state, "add", "owner", "peer", body, "--in", "10s").out;
  let at = 210;
  fireAt(at);
  for (const wait of RETRY_BACKOFF_SECONDS) { at += wait; fireAt(at); }
  fireAt(at + 600); // nothing further fires
  expect(sentTo()).toEqual([...Array(1 + RETRY_BACKOFF_SECONDS.length).fill("peer"), "owner"]);
  const given = (JSON.parse(readFileSync(state, "utf8")) as Rows)[exhausted]!;
  expect(given).toMatchObject({ status: "unresolved", exit_code: 1, result: CUSTODY_BUSY });
  expect(given.notice).toMatchObject({ exit_code: 0, result: '{"status":"injected"}' });
  expect(given.notice!.id).toMatch(/^watcher-\d{8}T\d{6}Z-[0-9a-f]{12}$/);
  const bodies = readFileSync(`${sent}.bodies`, "utf8");
  expect(bodies).toContain(`Your reminder ${exhausted} to peer went unresolved after ${1 + RETRY_BACKOFF_SECONDS.length} attempts and will not fire again.`);
  expect(bodies).toContain("failure=reset_custody_busy: refusing tap send");
  // Neither temp body outlives its attempt.
  expect(readdirSync(join(root, "bus", "watch")).filter(name => name.startsWith(".remind-"))).toEqual([]);
});

for (const [label, refusal, schedule] of [
  ["no-effect outage", OUTAGE_NO_EFFECT, OUTAGE_BACKOFF_SECONDS],
  ["possible-effect timeout", OUTAGE_UNKNOWN, [] as readonly number[]],
] as const) test(`fire on a ${label}: ${schedule.length} re-attempts, then one owner notice (tap-yk8it)`, () => {
  const root = scratch();
  const state = join(root, "bus", "watch", "reminders.json");
  const fake = join(root, "scripts");
  const sent = join(root, "sent");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "refusal"), `${refusal}\n`);
  // Every send to `peer` refuses with the recorded refusal; the owner's notice is accepted.
  writeFileSync(join(fake, "courier"), `#!/bin/bash
printf "%s\\n" "$*" >> "$REMIND_SENT"
cat "$2" >> "$REMIND_SENT.bodies"
if [ "$1" = peer ]; then cat "$REMIND_REFUSAL"; exit 1; fi
printf '{"status":"injected"}\\n'
`);
  chmodSync(join(fake, "courier"), 0o755);
  const body = join(root, "body");
  writeFileSync(body, "Sweep the lanes.");
  const env = { TAP_WATCH_NOW: "100", REMIND_SENT: sent, REMIND_REFUSAL: join(fake, "refusal"), TAP_COURIER_SCRIPT: join(fake, "courier") };
  const fireAt = (at: number) => expect(cli({ ...env, TAP_WATCH_NOW: String(at) }, state, "fire", fake, "100").rc).toBe(0);
  const sentTo = () => readFileSync(sent, "utf8").trim().split("\n").map(line => line.split(" ")[0]);
  const id = cli(env, state, "add", "owner", "peer", body, "--in", "10s").out;
  let at = 110;
  fireAt(at);
  for (const wait of schedule) {
    fireAt(at + wait - 1); // not yet due: no attempt
    at += wait;
    fireAt(at);
  }
  fireAt(at + 7200); // nothing further fires
  expect(sentTo()).toEqual([...Array(1 + schedule.length).fill("peer"), "owner"]);
  const given = (JSON.parse(readFileSync(state, "utf8")) as Rows)[id]!;
  expect(given).toMatchObject({ status: "unresolved", exit_code: 1, result: refusal });
  expect(given.notice).toMatchObject({ exit_code: 0 });
  expect(readFileSync(`${sent}.bodies`, "utf8")).toContain(`went unresolved after ${1 + schedule.length} attempt`);
});

test("add refuses an empty body, a bad epoch and a malformed schedule without writing anything", () => {
  const root = scratch();
  const state = join(root, "bus", "watch", "reminders.json");
  const empty = join(root, "empty");
  writeFileSync(empty, " \n\t");
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  expect(cli(env, state, "add", "owner", "peer", empty, "--in", "1s")).toMatchObject({ rc: 1, err: "tap remind: reminder body must not be empty" });
  expect(cli(env, state, "add", "owner", "peer", body, "--at", "253402300800")).toMatchObject({ rc: 1, err: "tap remind: epoch is out of range" });
  expect(cli(env, state, "add", "owner", "peer", body, "--at", "-1")).toMatchObject({ rc: 1, err: "tap remind: epoch is out of range" });
  expect(cli(env, state, "add", "owner", "peer", body, "--in", "5x")).toMatchObject({ rc: 1, err: "tap remind: duration must be a positive integer followed by s, m, h, or d" });
  expect(cli(env, state, "add", "owner", "peer", body).rc).toBe(1);
  expect(cli(env, state, "add", "owner", "peer", body, "--in", "1s", "--at", "5").rc).toBe(1);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(join(root, "bus", "watch", "arm.json"))).toBe(false);
});

// --- the sidecar fingerprint must cover the whole import closure ----------------
//
// watch-run.ts (the loop's entry, slice W3) stamps the Bun modules the sidecar
// executes -- the loop's own closure, the tick's (`watch-tick-run.ts`, a child
// launched by pathname: not a static import, so it is a ROOT here), the reminder
// door's -- plus everything they import, so a source change forces the sidecar to
// re-exec. That list is only as good as its completeness: an import added to any
// entry and absent from the stamp means the running sidecar keeps executing the old
// behavior with no re-exec and no signal. So the list is CHECKED here rather than
// asserted in a comment -- adding an import reds this test.
const SIDECAR_ENTRIES = ["verbs/escalate.ts", "watch-run.ts", "watch-tick-run.ts", "remind.ts", "watch-lease.ts", "watch-notice.ts", "watch-registry.ts", "watch-detect.ts", "watch-detectors.ts", "watch-evaluate.ts", "watch-evaluator.ts", "watch-tick.ts", "watch-blocked.ts"];
test("watch-run.ts stamps exactly the sidecar entries' transitive src closure", () => {
  const repo = join(import.meta.dir, "../../..");
  const src = join(repo, "runtime/bun/src");

  const closure = new Set<string>();
  for (const stack = [...SIDECAR_ENTRIES]; stack.length; ) {
    const rel = stack.pop()!;
    if (closure.has(rel)) continue;
    closure.add(rel);
    // scanImports, not a regex: a bare `import "./x"` has no `from` clause, and a
    // lazy pattern anchored on `from` walks straight past it to the next statement --
    // silently dropping the one import shape this check exists to catch.
    const text = readFileSync(join(src, rel), "utf8");
    for (const { path: spec } of new Bun.Transpiler({ loader: "ts" }).scanImports(text)) {
      if (!spec.startsWith(".")) continue; // node:* and packages ship with the runtime
      const target = join(src, rel, "..", spec);
      const resolved = [`${target}.ts`, join(target, "index.ts"), target].find(existsSync);
      expect(resolved, `unresolved import ${spec} from ${rel}`).toBeDefined();
      stack.push(resolved!.slice(src.length + 1));
    }
  }

  // Only the stamp list counts: the forward `exec bun`s verbs/watch.ts, and that
  // module is deliberately NOT stamped -- the loop never calls the verb layer.
  expect(SIDECAR_SOURCES.length).toBeGreaterThan(0);
  expect([...closure].filter(rel => rel.startsWith("launcher/"))).toEqual([]);
  expect([...SIDECAR_SOURCES].sort()).toEqual([...closure].sort());
});

test("the loop's Bun floor is the one runtime/bun/package.json declares (the loop never reads package.json)", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { engines?: { bun?: string } };
  expect(pkg.engines?.bun).toBe(`>=${BUN_FLOOR}`);
});

test("the other-seat off refusal returns through the lock instead of exiting under it", () => {
  const root = scratch();
  const state = join(root, "bus", "watch", "reminders.json");
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  expect(cli(env, state, "add", "owner", "peer", body, "--in", "1m").rc).toBe(0);

  // The refusal has to run IN THIS PROCESS. Two earlier versions of this assertion
  // could not fail: the first looked for a stranded `.held.` marker the in-process
  // holder never mints, and the second reacquired after cli()'s CHILD had exited --
  // and the kernel closes a dead child's descriptors whether or not `finally` ran.
  // Both passed for reasons that had nothing to do with release. (partner review
  // caught each in turn; the second was mine, written while fixing the first.)
  //
  // flock(2) binds to the open file description, so a second open in this same
  // process is excluded by the first (measured) -- which makes reacquisition here a
  // real test of whether `withLock`'s finally ran.
  const rc = main([state, "off", join(root, "bus"), join(root, "no-scripts"), join(root, "no-registry.json"), "owner", "0"]);
  expect(rc).toBe(1);
  const after = acquireNoFollowLock(`${state}.lock`, 500);
  expect(after).not.toBeNull();
  after!.release();
});

test("a disarm whose locked delete fails is a failure, not a silent success", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  const scripts = join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  expect(cli(env, state, "add", "owner", "owner", body, "--in", "1m").rc).toBe(0);
  expect(existsSync(arm)).toBe(true);

  // The disarm used to run in a spawned bash helper, where a signal death arrived
  // as `status: null` and a bare `if (result.status)` read it as success. In-process
  // (slice W1) that class is unreachable; the failure that remains is the locked
  // delete itself refusing -- here the lease lock path is a symlink, which
  // acquireNoFollowLock refuses. `off` must report it and leave the lease.
  const unrelated = join(root, "unrelated");
  writeFileSync(unrelated, "do not touch");
  unlinkSync(`${arm}.lock`); // `add` minted the real lock file; swap the symlink in
  symlinkSync(unrelated, `${arm}.lock`);
  const failed = cli(env, state, "off", bus, scripts, join(root, "no-registry.json"), "owner", "0");
  expect(failed.rc).not.toBe(0);
  expect(failed.err).toContain("lease KEPT");
  expect(existsSync(arm)).toBe(true);
  expect(readFileSync(unrelated, "utf8")).toBe("do not touch");
});

test("delay sees a schedule that is admitted but not yet published", () => {
  const root = scratch();
  const watch = join(root, "bus", "watch");
  const state = join(watch, "reminders.json");
  mkdirSync(watch, { recursive: true });

  // Reproduce an `add` that HOLDS the queue lock and has not published yet: the
  // state file does not exist while the lock is held, and appears before release.
  // An unlocked reader answers from that empty snapshot and returns the full tick
  // interval, sleeping straight past a deadline one second away. Atomic rename
  // makes the read untorn; it does not make it current.
  const staged = join(root, "staged.json");
  writeFileSync(staged, JSON.stringify({
    "remind-pending": { owner: "owner", to: "peer", body: "x", due_at: 101, every_seconds: 0, status: "scheduled" },
  }));
  const held = join(root, "held.marker");
  const holder = spawn(KERNEL_LOCK, kernelLockArgs(`${state}.lock`, 30_000,
    ["sh", "-c", `: > "$0"; sleep 1; mv "$1" "$2"`, held, staged, state]), { stdio: "ignore" });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(held) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    expect(existsSync(held)).toBe(true);
    expect(existsSync(state)).toBe(false);
    expect(cli({ TAP_WATCH_NOW: "100" }, state, "delay", "60").out).toBe("1");
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a symlinked lock path is refused before any queue or lease mutation", () => {
  const root = scratch();
  const watch = join(root, "bus", "watch");
  const state = join(watch, "reminders.json");
  mkdirSync(watch, { recursive: true });
  const body = join(root, "body");
  writeFileSync(body, "x");

  // The incumbent locked with O_NOFOLLOW, so a lock path symlinked at an unrelated
  // file was refused before it wrote anything. lockf/flock take a path and expose no
  // such flag, so this is the guard the port had to reconstruct, not shared-infra
  // hardening. Reproduction supplied by the partner reviewer.
  const unrelated = join(root, "unrelated");
  writeFileSync(unrelated, "do not touch");
  symlinkSync(unrelated, `${state}.lock`);

  const refused = cli({ TAP_WATCH_NOW: "100" }, state, "add", "owner", "peer", body, "--in", "1s");
  expect(refused.rc).not.toBe(0);
  expect(refused.err).toContain("refusing a symlinked lock path");
  expect(existsSync(state)).toBe(false);
  expect(existsSync(join(watch, "arm.json"))).toBe(false);
  expect(readFileSync(unrelated, "utf8")).toBe("do not touch");

  // The reporting reads refuse too: a symlinked lock is a state the incumbent never
  // operated in, not the lock-acquisition failure they are allowed to shrug off.
  expect(cli({ TAP_WATCH_NOW: "100" }, state, "delay", "60").rc).not.toBe(0);
});

test("a symlink at the lock path is refused even while the real lock is held elsewhere", () => {
  const root = scratch();
  const watch = join(root, "bus", "watch");
  const state = join(watch, "reminders.json");
  const lockPath = `${state}.lock`;
  mkdirSync(watch, { recursive: true });

  // NOT a reproduction of the partner reviewer's ABA interleaving, and deliberately not
  // named as one. That interleaving needs the swap to land BETWEEN the O_NOFOLLOW
  // open and a second open of the same pathname, and `acquireNoFollowLock` has no
  // such second open -- the descriptor it locks is the one it opened. The window is
  // gone by construction, so it cannot be exercised from outside without mocking
  // the acquire, which is what his instrument does and this one does not.
  //
  // Measured, not assumed: a mutant that closes the O_NOFOLLOW fd and locks the
  // pathname again -- i.e. the design he defeated -- leaves this test GREEN. What
  // this test does cover is the static symlink and holder exclusion; the
  // interleaving proof has to come from his probe re-run at the new head.
  const unrelated = join(root, "unrelated");
  writeFileSync(unrelated, "do not touch");
  const saved = join(root, "saved.lock");

  // Establish the real lock file, then hold it from outside.
  const outside = acquireNoFollowLock(lockPath, 1000);
  expect(outside).not.toBeNull();
  renameSync(lockPath, saved);
  symlinkSync(unrelated, lockPath);
  try {
    // With the path now a symlink, an acquire must REFUSE rather than follow it.
    expect(() => acquireNoFollowLock(lockPath, 200)).toThrow("refusing a symlinked lock path");
  } finally {
    unlinkSync(lockPath);
    renameSync(saved, lockPath);
  }

  // The legitimate holder still owns it: a fresh acquire is refused, not granted.
  expect(acquireNoFollowLock(lockPath, 200)).toBeNull();
  outside!.release();
  const after = acquireNoFollowLock(lockPath, 1000);
  expect(after).not.toBeNull();
  after!.release();
  expect(readFileSync(unrelated, "utf8")).toBe("do not touch");
});

test("the reminder lock excludes an independent kernel-lock holder of the same file", () => {
  const root = scratch();
  const state = join(root, "bus", "watch", "reminders.json");
  mkdirSync(join(root, "bus", "watch"), { recursive: true });
  const lockPath = `${state}.lock`;

  // Interop is the whole reason this is flock(2) and not a private scheme: Bash and
  // Python writers lock this same sidecar. If the two implementations did not
  // exclude each other, the lock would be decorative.
  const held = acquireNoFollowLock(lockPath, 1000);
  expect(held).not.toBeNull();
  const contended = spawnSync(KERNEL_LOCK, kernelLockArgs(lockPath, 0, ["true"]), { stdio: "ignore" });
  expect(contended.status).not.toBe(0);
  held!.release();
  const free = spawnSync(KERNEL_LOCK, kernelLockArgs(lockPath, 1000, ["true"]), { stdio: "ignore" });
  expect(free.status).toBe(0);
});

// Contributed by the partner reviewer, adapted to this fixture's paths. The ONLY injected
// thing is the scheduling of the swap: it happens after a REAL O_NOFOLLOW open
// returns a REAL fd, and the acquire body, the descriptors and the kernel flock are
// untouched. That is what lets it distinguish locking-the-descriptor from
// locking-the-pathname, which my own symlink controls could not -- they stayed green
// against a mutant that reproduced the defeated design.
test("the lock binds to the nofollow descriptor, not to the pathname it was opened by", async () => {
  const root = scratch();
  const path = join(root, "queue.lock"), saved = join(root, "saved.lock"), decoy = join(root, "decoy");
  const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const owner = openSync(path, "w+");
  expect(lib.symbols.flock(owner, 2 | 4)).toBe(0); // a real, independent hold on the real inode
  writeFileSync(decoy, "untouched");

  let swapped = false;
  let contender: { release(): void } | null = null;
  const realFs = { openSync, renameSync, symlinkSync, constants };
  // `mock.module` is process-wide and `mock.restore()` does not undo it (measured on
  // Bun 1.4.0, tap-zq33r / rule 41): the real exports are captured whole and re-mocked
  // back in `finally`, so the wrapper never outlives this test into the one-process
  // suite run (bun-router.test.sh).
  const realModule = { ...require("node:fs") };
  try {
    mock.module("node:fs", () => ({
      ...realModule,
      openSync(p: string, flags: string | number, mode?: number) {
        const fd = realFs.openSync(p, flags as never, mode);
        if (p === path && typeof flags === "number" && (flags & realFs.constants.O_NOFOLLOW) && !swapped) {
          realFs.renameSync(path, saved);
          realFs.symlinkSync(decoy, path);
          swapped = true;
        }
        return fd;
      },
    }));
    const { acquireNoFollowLock: fresh } = await import(`${join(import.meta.dir, "../src/remind-lock.ts")}?swap`);
    contender = fresh(path, 100);
    expect(swapped).toBe(true);
    // Restore before judging: the legitimate owner still holds the original inode,
    // so a pathname reopen must not have licensed admission.
    unlinkSync(path);
    renameSync(saved, path);
    expect(contender).toBeNull();
    expect(readFileSync(decoy, "utf8")).toBe("untouched");
  } finally {
    contender?.release();
    lib.symbols.flock(owner, 8);
    closeSync(owner);
    lib.close();
    mock.module("node:fs", () => realModule);
  }
  // the restore is itself checked: the module's openSync is the real one again
  expect((await import("node:fs")).openSync).toBe(realModule.openSync);
});

test("with no resolvable flock library: a symlink still refuses, a plain path refuses loudly", () => {
  const root = scratch();
  writeFileSync(join(root, "decoy"), "untouched");

  // Substitute the holder's library candidates with an asserted-unresolvable path,
  // in a runner-owned copy. The previous version of this test imported the real
  // module and disabled nothing, so restoring the old availability-first order left
  // it green -- it never exercised the case it was named for.
  const source = readFileSync(join(import.meta.dir, "../src/remind-lock.ts"), "utf8");
  const candidates = '["libSystem.B.dylib", "libc.so.6", "libc.so"]';
  expect(source).toContain(candidates);
  const nolib = join(root, "holder.ts");
  writeFileSync(nolib, source.replace(candidates, '["/nonexistent/definitely-not-a-library.so"]'));

  const probe = (target: string) => {
    const file = join(root, `probe-${basename(target)}.ts`);
    writeFileSync(file, `
      import { acquireNoFollowLock, SymlinkedLockPath } from ${JSON.stringify(nolib)};
      try { acquireNoFollowLock(${JSON.stringify(target)}, 100); console.log("ADMITTED"); }
      catch (e) { console.log(e instanceof SymlinkedLockPath ? "SYMLINK-REFUSED" : "REFUSED: " + (e as Error).message); }
    `);
    return spawnSync(process.execPath, [file], { encoding: "utf8" }).stdout.trim();
  };

  // Ordinary path, no library: refuse loudly rather than proceed unlocked.
  const plain = probe(join(root, "plain.lock"));
  expect(plain).toStartWith("REFUSED: ");
  expect(plain).toContain("flock(2)");

  // Symlinked path, no library: the symlink is what decides, because the open now
  // precedes the library resolution. Restoring the old order reds THIS assertion.
  const linked = join(root, "linked.lock");
  symlinkSync(join(root, "decoy"), linked);
  expect(probe(linked)).toBe("SYMLINK-REFUSED");
  expect(readFileSync(join(root, "decoy"), "utf8")).toBe("untouched");
});

test("goalie-run.ts stamps at least the loop entry's transitive src closure", () => {
  const repo = join(import.meta.dir, "../../..");
  const src = join(repo, "runtime/bun/src");
  // The loop's dynamic imports are roots: goalie-run statically imports
  // watch-run and lazily pulls goalie-tick, goalie-lease, watch-lease, context.
  const roots = ["goalie-run.ts", "goalie-tick.ts", "goalie-lease.ts", "watch-lease.ts", "context.ts"];
  const closure = new Set<string>();
  for (const stack = [...roots]; stack.length; ) {
    const rel = stack.pop()!;
    if (closure.has(rel)) continue;
    closure.add(rel);
    const text = readFileSync(join(src, rel), "utf8");
    for (const { path: spec } of new Bun.Transpiler({ loader: "ts" }).scanImports(text)) {
      if (!spec.startsWith(".")) continue;
      const target = join(src, rel, "..", spec);
      const resolved = [`${target}.ts`, join(target, "index.ts"), target].find(existsSync);
      stack.push(resolved!.slice(src.length + 1));
    }
  }
  expect([...closure].filter(rel => rel.startsWith("launcher/"))).toEqual([]);
  expect(GOALIE_SIDECAR_SOURCES.filter(rel => rel.startsWith("launcher/"))).toEqual([]);
  const list = new Set(GOALIE_SIDECAR_SOURCES);
  for (const rel of closure) expect(list.has(rel), `${rel} is in the goalie loop's closure but unstamped`).toBe(true);
});

// --- the supervision lease's edges (ported from smoke/remind.test.sh) -------------------------

function leaseSetSupervision(arm: string, doneWhen: string): void {
  const r = spawnSync(process.execPath, [LEASE_TS, arm, "set", "mode", "supervision", "armed_by", "owner", "armed_at", "100", "done_when", doneWhen], { env: { ...process.env, TAP_WATCH_ALLOW_CREATE: "1" }, encoding: "utf8" });
  expect(r.status).toBe(0);
}

test("finish --supervision demotes a busy supervision lease to reminders-only and keeps every pending row", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  mkdirSync(join(bus, "watch"), { recursive: true });
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  // add does NOT arm supervision: the lease record is seeded through the native lease door.
  leaseSetSupervision(arm, "goal");
  const pending = cli(env, state, "add", "owner", "peer", body, "--in", "1m");
  expect(pending.rc).toBe(0);
  expect(JSON.parse(readFileSync(arm, "utf8"))).toMatchObject({ mode: "supervision" });
  // Completing supervision with pending rows demotes, never disarms.
  expect(cli(env, state, "finish", "100", "--supervision").rc).toBe(0);
  expect(JSON.parse(readFileSync(arm, "utf8"))).toMatchObject({ mode: "reminders-only", done_when: "" });
  expect(existsSync(arm)).toBe(true);
  const rows = JSON.parse(readFileSync(state, "utf8")) as Rows;
  expect(rows[pending.out]).toMatchObject({ status: "scheduled" });
});

test("finish's demotion keeps an integer past MAX_SAFE_INTEGER byte-exact (tap-j5pmi)", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  mkdirSync(join(bus, "watch"), { recursive: true });
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  leaseSetSupervision(arm, "goal");
  expect(cli(env, state, "add", "owner", "peer", body, "--in", "1m").rc).toBe(0);
  // A hand-carried field the lease does not interpret: 2^53 + 1 has no exact Number.
  writeFileSync(arm, readFileSync(arm, "utf8").replace(/\}\s*$/, ',"lease_serial":9007199254740993}'));
  expect(readFileSync(arm, "utf8")).toContain('"lease_serial":9007199254740993');
  expect(cli(env, state, "finish", "100", "--supervision").rc).toBe(0);
  const demoted = readFileSync(arm, "utf8");
  expect(demoted).toContain('"mode":"reminders-only"');
  expect(demoted, "the demotion rewrite rounded the integer").toContain('"lease_serial":9007199254740993');
  expect(demoted).not.toContain("9007199254740992");
});

test("finish compares a hand-edited float armed_at by its source spelling instead of throwing (tap-j5pmi)", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  mkdirSync(join(bus, "watch"), { recursive: true });
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  leaseSetSupervision(arm, "goal");
  expect(cli(env, state, "add", "owner", "peer", body, "--in", "1m").rc).toBe(0);
  writeFileSync(arm, readFileSync(arm, "utf8").replace(/"armed_at":\d+/, '"armed_at":100.0'));
  expect(readFileSync(arm, "utf8")).toContain('"armed_at":100.0');
  // No match: the spelling differs, so finish is a no-op and the lease is byte-identical.
  const before = readFileSync(arm, "utf8");
  expect(cli(env, state, "finish", "100", "--supervision").rc).toBe(0);
  expect(readFileSync(arm, "utf8")).toBe(before);
  // Match: the caller's armAt is the record's own spelling, so finish demotes the lease.
  expect(cli(env, state, "finish", "100.0", "--supervision").rc).toBe(0);
  const demoted = readFileSync(arm, "utf8");
  expect(demoted).toContain('"mode":"reminders-only"');
  expect(demoted).toContain('"armed_at":100.0');
});

test("finish treats a non-scalar armed_at as a mismatch and keeps null, int and string spellings (tap-j5pmi)", () => {
  const cases: Array<[literal: string, armAt: string, demotes: boolean]> = [
    ["[100.0]", "100", false], ["[100.0]", "100.0", false], ["[100]", "100", false],
    ['{"a":1}', "100", false], ['{"a":1.0}', "1.0", false],
    ["null", "null", true], ["null", "100", false],
    ["100", "100", true], ['"100"', "100", true], ["100.0", "100.0", true], ["100.0", "100", false],
  ];
  for (const [literal, armAt, demotes] of cases) {
    const root = scratch();
    const bus = join(root, "bus");
    const state = join(bus, "watch", "reminders.json");
    const arm = join(bus, "watch", "arm.json");
    mkdirSync(join(bus, "watch"), { recursive: true });
    const body = join(root, "body");
    writeFileSync(body, "x");
    const env = { TAP_WATCH_NOW: "100" };
    leaseSetSupervision(arm, "goal");
    expect(cli(env, state, "add", "owner", "peer", body, "--in", "1m").rc).toBe(0);
    writeFileSync(arm, readFileSync(arm, "utf8").replace(/"armed_at":\d+/, `"armed_at":${literal}`));
    expect(readFileSync(arm, "utf8"), literal).toContain(`"armed_at":${literal}`);
    const before = readFileSync(arm, "utf8");
    const r = cli(env, state, "finish", armAt, "--supervision");
    expect(r.rc, `finish ${armAt} vs ${literal}: ${r.out}`).toBe(0);
    const after = readFileSync(arm, "utf8");
    if (demotes) expect(after, `${literal} vs ${armAt}`).toContain('"mode":"reminders-only"');
    else expect(after, `${literal} vs ${armAt} must be a no-op`).toBe(before);
  }
});

test("watch off keeps pending rows on disk while it drops only the lease", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  const mine = cli(env, state, "add", "owner", "owner", body, "--in", "1m").out;
  expect(existsSync(arm)).toBe(true);
  expect(cli(env, state, "off", bus, join(root, "no-scripts"), join(root, "no-registry.json"), "owner", "0").rc).toBe(0);
  expect(existsSync(arm)).toBe(false);
  const rows = JSON.parse(readFileSync(state, "utf8")) as Rows;
  expect(rows[mine]).toMatchObject({ status: "scheduled" });
});

test("the off refusal names the stranded seat's reminder id, leaves both files byte-identical, and --force discloses what stops firing", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100" };
  expect(cli(env, state, "add", "owner", "peer", body, "--in", "1m").rc).toBe(0);
  expect(existsSync(arm)).toBe(true);
  const armBytes = readFileSync(arm, "utf8");
  const rowBytes = readFileSync(state, "utf8");
  const pendingId = Object.keys(JSON.parse(rowBytes) as Rows)[0]!;
  const refused = cli(env, state, "off", bus, join(root, "no-scripts"), join(root, "no-registry.json"), "owner", "0");
  expect(refused.rc).toBe(1);
  expect(refused.err).toContain("refusing disarm");
  expect(refused.err).toContain(pendingId);
  expect(refused.err).toContain("to=peer");
  expect(readFileSync(arm, "utf8")).toBe(armBytes);
  expect(readFileSync(state, "utf8")).toBe(rowBytes);
  // Force rides as the door's positional 0|1 (remind.ts:527), not a flag.
  const forced = cli(env, state, "off", bus, join(root, "no-scripts"), join(root, "no-registry.json"), "owner", "1");
  expect(forced.rc).toBe(0);
  expect(forced.err).toContain("will not fire");
  expect(forced.err).toContain(pendingId);
  expect(existsSync(arm)).toBe(false);
  expect(readFileSync(state, "utf8")).toBe(rowBytes);
});

test("a first add demotes an armed supervision lease, and a completion cannot drop the freshly committed queue", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  mkdirSync(join(bus, "watch"), { recursive: true });
  const body = join(root, "body");
  writeFileSync(body, "x");
  // Empty completion disarms (the shell door was finish --supervision; a plain
  // finish refuses a supervision lease).
  leaseSetSupervision(arm, "complete");
  expect(cli({ TAP_WATCH_NOW: "100" }, state, "finish", "100", "--supervision").rc).toBe(0);
  expect(existsSync(arm)).toBe(false);
  // Re-arm; a first add lands while the supervision lease stands (ensureArm only
  // creates an ABSENT lease — the incumbent interposed the add before the finish);
  // the busy completion then demotes and the committed row survives it.
  leaseSetSupervision(arm, "complete");
  expect(cli({ TAP_WATCH_NOW: "100" }, state, "add", "owner", "peer", body, "--in", "1m").rc).toBe(0);
  expect(JSON.parse(readFileSync(arm, "utf8"))).toMatchObject({ mode: "supervision" });
  expect(cli({ TAP_WATCH_NOW: "100" }, state, "finish", "100", "--supervision").rc).toBe(0);
  expect(JSON.parse(readFileSync(arm, "utf8"))).toMatchObject({ mode: "reminders-only", done_when: "" });
  expect(Object.values(JSON.parse(readFileSync(state, "utf8")) as Rows)[0]).toMatchObject({ status: "scheduled" });
});

test("two concurrent fires dispatch a due reminder exactly once", async () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const fake = join(root, "scripts");
  const sent = join(root, "sent");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "courier"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$REMIND_SENT"\nprintf \'{"status":"injected"}\\n\'\n');
  chmodSync(join(fake, "courier"), 0o755);
  const body = join(root, "body");
  writeFileSync(body, "x");
  const env = { TAP_WATCH_NOW: "100", REMIND_SENT: sent, TAP_COURIER_SCRIPT: join(fake, "courier") };
  expect(cli(env, state, "add", "owner", "peer", body, "--in", "10s").rc).toBe(0);
  const due = { ...env, TAP_WATCH_NOW: "110" };
  const procs = [0, 1].map(() => spawn(process.execPath, [REMIND, state, "fire", fake, "100"], { env: { ...process.env, ...due } }));
  const codes = await Promise.all(procs.map(p => new Promise<number | null>(resolve => p.on("exit", resolve))));
  expect(codes).toEqual([0, 0]);
  expect(readFileSync(sent, "utf8").trim().split("\n")).toHaveLength(1);
}, 15_000);

// --- the public door and the admission lock (ported from smoke/remind.test.sh) ---

test("the public `tap remind` door resolves the real caller, stores a stdin body exactly, and refuses bad body files without a traceback", () => {
  const root = scratch();
  const cli = join(root, "cli");
  const cliBus = join(cli, ".tap", "bus");
  mkdirSync(cliBus, { recursive: true });
  const seat = { session: "sess", pane: "sess:0.0", pane_id: "%401", harness: "codex", status: "active", server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: cli };
  writeFileSync(join(cliBus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "test", worktree_root: cli }, seats: { owner: seat, peer: { status: "active", delivery: "poll" } } }));
  const index = join(root, "index");
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), '{"schema":"0.20","teams":{}}\n');
  // Shims for the caller probes: ppid/tty via ps, pane/session via tmux (the same
  // shapes the smoke fed the incumbent).
  const shim = join(root, "bin");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "ps"), '#!/bin/bash\ncase "$*" in *ppid=*tty=*) echo "1 faketty" ;; *) exec /bin/ps "$@" ;; esac\n');
  chmodSync(join(shim, "ps"), 0o755);
  writeFileSync(join(shim, "tmux"), `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
  new-window|list-windows|list-sessions|list-panes|display-message) cmd="$a"; break ;;
  esac
done
case "\$cmd" in
list-sessions) printf 'sess\\t4242:100\\n' ;;
list-panes) printf '%%401\\t/dev/faketty\\n' ;;
display-message)
  case "\${@: -1}" in
  *pane_id*pane_tty*session_name*) printf '%%401\\t/dev/faketty\\tsess\\t4242:100\\n' ;;
  *pane_id*pane_tty*) printf '%%401\\t/dev/faketty\\n' ;;
  *pane_id*session_name*) printf '%%401\\tsess\\t4242:100\\n' ;;
  *pane_id*) printf '%%401\\n' ;;
  *session_name*) printf 'sess\\n' ;;
  esac ;;
*) exit 0 ;;
esac
`);
  chmodSync(join(shim, "tmux"), 0o755);
  const env = {
    TAP_HOME: cliBus, TAP_INDEX_HOME: index, TAP_WATCH_NO_SPAWN: "1",
    TAP_SERVER_EPOCH: "srv:4242:100", TAP_BOOT_ID: "boot:1", TMUX: "/fake/socket",
    PATH: `${shim}:${process.env.PATH ?? ""}`,
  };
  const door = (args: string[]) => spawnSync("/bin/bash", [TAP, ...args], { cwd: cli, env: { ...process.env, ...env }, encoding: "utf8" });
  const body = join(root, "body");
  writeFileSync(body, "Check the CI result. Literal $(not-a-command).");
  const scheduled = door(["remind", "me", "--in", "8m", "-f", body]);
  expect(scheduled.status).toBe(0);
  expect(scheduled.stdout).toContain("scheduled remind-");
  const listed = JSON.parse(door(["remind", "list", "--json"]).stdout) as Array<{ id: string; to: string }>;
  expect(listed[0]!.to).toBe("owner");

  // `-f -` is read in-process once the verb closes: no scratch body under the bus,
  // and the stored row carries the bytes exactly.
  const stdinBody = "Review literal $(not-a-command) and `not-a-command`.\nSecond line stays exact.\n";
  const stdinScript = `/bin/bash "${TAP}" remind me --in 8m -f - <<'EOF'\n${stdinBody}EOF\n`;
  const stdinResult = spawnSync("/bin/bash", ["-c", stdinScript], { cwd: cli, env: { ...process.env, ...env }, encoding: "utf8" });
  expect(stdinResult.status).toBe(0);
  expect(stdinResult.stderr).toBe("");
  const busTmp = join(cliBus, "tmp");
  expect(!existsSync(busTmp) || readdirSync(busTmp).filter(n => n.startsWith("remind-body.")).length === 0).toBe(true);
  const stored = JSON.parse(readFileSync(join(cliBus, "watch", "reminders.json"), "utf8")) as Rows;
  const stdinIdent = Object.entries(stored).find(([, row]) => row.body === stdinBody)![0];
  expect(door(["remind", "cancel", stdinIdent]).status).toBe(0);

  const refused = (path: string, fragment: string) => {
    const r = door(["remind", "me", "--in", "8m", "-f", path]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(fragment);
    expect(r.stderr).not.toContain("Traceback");
  };
  refused(join(root, "missing-body"), "reminder body file not found");
  refused(root, "not a regular file");
  if (process.getuid?.() !== 0) {
    const unreadable = join(root, "unreadable-body");
    writeFileSync(unreadable, "secret");
    chmodSync(unreadable, 0o000);
    refused(unreadable, "not readable");
  }
}, 30_000);

test("a stored reminder whose runner never confirms is reported, never claimed as scheduled", () => {
  const root = scratch();
  const cli = join(root, "cli");
  const cliBus = join(cli, ".tap", "bus");
  mkdirSync(cliBus, { recursive: true });
  const seat = { session: "sess", pane: "sess:0.0", pane_id: "%401", harness: "codex", status: "active", server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: cli };
  writeFileSync(join(cliBus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "test", worktree_root: cli }, seats: { owner: seat, peer: { status: "active", delivery: "poll" } } }));
  const index = join(root, "index");
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), '{"schema":"0.20","teams":{}}\n');
  const shim = join(root, "bin");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "ps"), '#!/bin/bash\ncase "$*" in *ppid=*tty=*) echo "1 faketty" ;; *) exec /bin/ps "$@" ;; esac\n');
  chmodSync(join(shim, "ps"), 0o755);
  // No session is resolvable on any server: the runner ensure cannot confirm.
  // The IDENTITY probe (pane_id+pane_tty+session_name) must still answer, or the
  // caller never resolves and the verb refuses before storing anything -- the
  // refusal under test lives AFTER storage (verbs/remind.ts:266).
  writeFileSync(join(shim, "tmux"), `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
  new-window|list-windows|list-sessions|list-panes|display-message) cmd="$a"; break ;;
  esac
done
case "\$cmd" in
list-sessions) printf 'sess\\t4242:100\\n' ;;
list-panes) printf '%%401\\t/dev/faketty\\n' ;;
display-message)
  case "\${@: -1}" in
  *pane_id*pane_tty*session_name*) printf '%%401\\t/dev/faketty\\tsess\\t4242:100\\n' ;;
  *) exit 1 ;;
  esac ;;
*) exit 1 ;;
esac
`);
  chmodSync(join(shim, "tmux"), 0o755);
  // NO TAP_WATCH_NO_SPAWN: the skip short-circuit must not masquerade as a confirmation.
  const env = {
    TAP_HOME: cliBus, TAP_INDEX_HOME: index,
    TAP_SERVER_EPOCH: "srv:4242:100", TAP_BOOT_ID: "boot:1", TMUX: "/fake/socket",
    PATH: `${shim}:${process.env.PATH ?? ""}`,
  };
  const body = join(root, "body");
  writeFileSync(body, "Check the CI result.");
  const refused = spawnSync("/bin/bash", [TAP, "remind", "me", "--in", "8m", "-f", body], { cwd: cli, env: { ...process.env, ...env }, encoding: "utf8" });
  expect(refused.status).not.toBe(0);
  expect(refused.stdout).not.toContain("tap remind: scheduled");
  expect(refused.stderr, "the stored-but-unconfirmed refusal must name the row").toMatch(/tap remind: remind-[0-9a-f]{16} stored; no live reminder runner confirmed/);
  const ident = refused.stderr.match(/tap remind: (remind-[0-9a-f]{16}) stored/)![1]!;
  // The row is retained: the stored promise stands until a runner is confirmed.
  const stored = JSON.parse(readFileSync(join(cliBus, "watch", "reminders.json"), "utf8")) as Rows;
  expect(Object.keys(stored)).toEqual([ident]);
  expect(stored[ident]!.status).toBe("scheduled");
}, 15_000);

test("reminder admission stays locked until off has finished reaping; the waiting first add then re-arms the lease", async () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  mkdirSync(join(bus, "watch"), { recursive: true });
  const body = join(root, "body");
  writeFileSync(body, "x");
  leaseSetSupervision(arm, "complete");
  const childEnv = { ...process.env, TAP_WATCH_NOW: "100" };

  // Hold the LEASE lock, so `off` -- queue lock already taken -- blocks inside the
  // disarm's locked delete. Prove the queue lock is held meanwhile, start the add
  // against it, then release.
  const armLock = acquireNoFollowLock(`${arm}.lock`, 5000);
  expect(armLock).not.toBeNull();
  const off = spawn(process.execPath, [REMIND, state, "off", bus, join(root, "no-scripts"), join(root, "no-registry.json"), "owner", "0"], { env: childEnv });
  let offErr = "";
  off.stderr!.on("data", c => { offErr += String(c); });
  let add: ReturnType<typeof spawn> | null = null;
  try {
    // The queue lock is off's admission guarantee: nothing new can be admitted
    // while the disarm is still blocked.
    let queueHeld = false;
    for (let waited = 0; waited < 5000; waited += 25) {
      if (off.exitCode !== null) break;
      const probe = acquireNoFollowLock(`${state}.lock`, 0);
      if (probe === null) { queueHeld = true; break; }
      probe.release(); // the lock was free: let go, or the probe itself wedges off
      await Bun.sleep(25);
    }
    expect(queueHeld).toBe(true);
    expect(existsSync(arm)).toBe(true);
    // Only now start the add: off has already read the (empty) queue under its
    // lock, so the waiting add cannot turn the disarm into a refusal.
    add = spawn(process.execPath, [REMIND, state, "add", "owner", "peer", body, "--in", "1m"], { env: childEnv });
  } finally {
    armLock!.release();
  }
  const [offCode, addOut] = await Promise.all([
    new Promise<number | null>(resolve => off.on("exit", resolve)),
    new Promise<string>(resolve => { let out = ""; add.stdout!.on("data", c => { out += String(c); }); add.on("exit", () => resolve(out.trim())); }),
  ]);
  expect(offCode).toBe(0);
  expect(offErr).toBe("");
  expect(add.exitCode).toBe(0);
  expect(addOut).toMatch(/^remind-[0-9a-f]{16}$/);
  // The lease the waiting add mints survives off: reminders-only, row scheduled.
  expect(JSON.parse(readFileSync(arm, "utf8"))).toMatchObject({ mode: "reminders-only", armed_by: "owner" });
  expect((JSON.parse(readFileSync(state, "utf8")) as Rows)[addOut!]).toMatchObject({ status: "scheduled" });
}, 30_000);

test("the watch tick door actually reaches reminder dispatch and disarms the emptied queue", () => {
  const root = scratch();
  const bus = join(root, "bus");
  const state = join(bus, "watch", "reminders.json");
  const arm = join(bus, "watch", "arm.json");
  mkdirSync(join(bus, "watch"), { recursive: true });
  const fake = join(root, "scripts");
  const sent = join(root, "sent");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "courier"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$REMIND_SENT"\nprintf \'{"status":"injected"}\\n\'\n');
  chmodSync(join(fake, "courier"), 0o755);
  const body = join(root, "body");
  writeFileSync(body, "x");
  writeFileSync(arm, JSON.stringify({ mode: "reminders-only", armed_by: "owner", armed_at: 300, evaluator: "none", tick_interval_seconds: 60 }) + "\n");
  const env = { TAP_WATCH_NOW: "300", REMIND_SENT: sent, TAP_COURIER_SCRIPT: join(fake, "courier") };
  expect(cli(env, state, "add", "owner", "peer", body, "--at", "290").rc).toBe(0);
  // The sidecar's own tick: its reminders door is the imported fire/finish, so a
  // due row dispatches and the emptied queue disarms without a second process.
  const tick = spawnSync(process.execPath, [join(import.meta.dir, "../src/verbs/watch.ts"), "tick"], { env: { ...process.env, TAP_HOME: bus, ...env }, encoding: "utf8" });
  expect(tick.status).toBe(0);
  expect(existsSync(sent)).toBe(true);
  expect(readFileSync(sent, "utf8").trim().split("\n")).toHaveLength(1);
  expect(existsSync(arm)).toBe(false);
  expect(Object.values(JSON.parse(readFileSync(state, "utf8")) as Rows)[0]).toMatchObject({ status: "accepted" });
}, 15_000);
