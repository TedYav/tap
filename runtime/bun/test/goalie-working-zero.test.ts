// Port of goalie-working-zero.test.sh's direct-exec arms. The wake-boundary
// probe (the shell generated a throwaway bun script), the exception-form
// matrix asserted through bun -e against parseException, and the receipt
// hashing driven through bun -e against envelopeBodyBytes were the shell
// file's only runtime/bun/src executions; they move here as real Bun tests
// over the same exported seams the shell reached. The shell file keeps the
// public-door arms (`tap goalie on/tick/status` with PATH shims); its fake-ps
// fixture line names the watcher path as fixture data only.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalieTick, parseException } from "../src/goalie-tick";
import { envelopeBodyBytes } from "../src/envelope";

let root: string | null = null;
const bus = () => join(root!, "bus");

function fixture(): string {
  if (root) return root;
  root = mkdtempSync(join(tmpdir(), "wz-wake-"));
  const home = bus();
  mkdirSync(join(home, "goalie"), { recursive: true });
  mkdirSync(join(home, "payloads"), { recursive: true });
  mkdirSync(join(home, "receipts"), { recursive: true });
  mkdirSync(join(home, "stores"), { recursive: true });
  rearm(); // the fresh lease, shared with the per-scenario reset
  // One ageable, LONG-STALE seat (the feeder) plus a 1-seat quorum floor: the
  // board fires on the first wake instead of going quiet.
  writeFileSync(join(home, "stores/feeder.jsonl"),
    JSON.stringify({ type: "assistant", timestamp: "1970-01-01T00:16:40Z" }) + "\n");
  writeFileSync(join(home, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "tap" }, seats: {
    "goalie-seat": { status: "active", delivery: "pane", pane: "sess:goalie.0" },
    "feeder-seat": { status: "active", delivery: "pane", pane: "sess:feeder.0",
      session_store_kind: "file", session_store_path: join(home, "stores/feeder.jsonl") },
  } }));
  return root;
}

afterAll(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

interface TickResult { rc: number; stdout: string; stderr: string; effects: string[][] }

/**
 * One goalie tick at `now` over the shared fixture, doors injected: the
 * goalie's own seat reads ready, the courier writes the wake payload
 * the way the real one publishes an accepted artifact, and the human rung is
 * recorded, never delivered.
 */
function tick(now: number, payload = "---\nid: wake-1\nreply: expected\n---\nbody\n"): TickResult {
  const home = bus();
  const effects: string[][] = [];
  const res = goalieTick({
    home, registry: join(home, "registry.json"), scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts"),
    env: { TAP_GOALIE_NOW: String(now), TAP_GOALIE_QUORUM_MIN_SEATS: "1", TAP_GOALIE_READY_CMD: "printf '[]'" },
    effects,
    doors: {
      lib: (_fn: string, args: string[]) =>
        ({ status: 0, stdout: args[0] === "goalie-seat" ? "idle-at-prompt" : "", stderr: "" }),
      courier: (argv: string[]) => {
        // The refire reminder (--kind notice) must read as DELIVERED for the
        // ladder to price the obligation up; the wake itself (--kind discuss)
        // publishes its artifact and parks as queued.
        if (argv.includes("notice")) {
          return { status: 0, stdout: JSON.stringify({ status: "injected", delivery: "pane" }), stderr: "" };
        }
        writeFileSync(join(home, "payloads", "wake-1.md"), payload);
        return { status: 0, stdout: JSON.stringify({ id: "wake-1", path: join(home, "payloads", "wake-1.md"), status: "queued" }), stderr: "" };
      },
      escalate: () => ({ status: 0, stdout: "", stderr: "" }),
      ready: () => ({ status: 0, stdout: "[]\n", stderr: "" }),
    },
  });
  return { ...res, effects };
}

const wakeId = (): string =>
  (JSON.parse(readFileSync(join(bus(), "goalie/arm.json"), "utf8")) as Record<string, string>).wake_id ?? "";

/** A fresh lease: the shell's arms re-arm before each obligation scenario. */
function rearm(): void {
  const home = bus();
  writeFileSync(join(home, "goalie/arm.json"), JSON.stringify({
    armed_by: "lead", armed_at: 1000, threshold_seconds: 1500, goalie_handle: "goalie-seat",
    feeder: "feeder-seat", board_ledger: "", ageable_samples: [], deadlock_since: 0,
    wake_id: "", wake_at: 0, wake_rung: 0, exception_tag: "", exception_until: 0, exception_refused: "",
  }));
  rmSync(join(home, "payloads/wake-1.md"), { force: true });
  rmSync(join(home, "receipts/wake-1.done"), { force: true });
}

test("a settle-only artifact is accepted but mints no obligation; expected-reply carries it", () => {
  fixture();
  const settle = tick(5000, "---\nid: wake-1\nreply: settle-only\n---\nbody\n");
  expect(wakeId()).toBe(""); // no obligation was minted
  expect(settle.stdout).toContain("verdict=rung3");
  expect(settle.stdout).toContain("wake send failed");
  // The human rung must actually be RECORDED, not merely printed: rung3 text
  // also appears on early returns that push no escalation effect.
  expect(settle.effects.some((e) => e[0] === "escalate")).toBe(true);
  // The expected-reply control: the same accepted shape carries the obligation.
  const good = tick(5100);
  expect(wakeId()).toBe("wake-1");
  expect(good.stdout).toContain("verdict=deadlock woke=feeder-seat id=wake-1");
});

const A = 5000;
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const FUTURE = iso(A + 3600);
const GATED = "tap-20ao -> waiting on the operator to ratify the digest_interval default\ntap-dg8g -> waiting on the operator to rule on reclaim-vs-keep";
const exc = (body: string): string => parseException(body, String(A));
const refused = (body: string): boolean => exc(body).startsWith("REJECT");
const accepted = (body: string): boolean => !refused(body) && exc(body) !== "";

test("the exception form checker accepts exactly the shapes it promises", () => {
  // A well-formed (a): tagged, every row gated, expiry a real time.
  const got = exc(`EXCEPTION (a) backlog-needs-owner\n${GATED}\nVALID-UNTIL ${FUTURE}`);
  expect(got.startsWith("REJECT")).toBe(false);
  expect(got.startsWith("a\t")).toBe(true); // the tag, not misread
  // An UNTAGGED decline is prose, not an exception.
  expect(exc("not right now, we are busy with other things")).toBe("");
  // A tag with NO VALID-UNTIL never expires and so would mute forever.
  expect(refused(`EXCEPTION (a) backlog-needs-owner\n${GATED}`)).toBe(true);
  // (6c) An UNGATED enumeration row malforms (a): the mute button made of a
  // passing form check.
  expect(refused(`EXCEPTION (a) backlog-needs-owner\ntap-20ao -> waiting on the operator to ratify the digest_interval default\ntap-dg8g\nVALID-UNTIL ${FUTURE}`)).toBe(true);
  // The gate is on (a) specifically — (b) and (c) carry their evidence as
  // prose or a receipt ref.
  expect(accepted(`EXCEPTION (b) the tmux server is down, see receipt 4f21\nVALID-UNTIL ${FUTURE}`)).toBe(true);
  // (6d) VALID-UNTIL must be a TIME: a named event cannot expire mechanically.
  expect(refused("EXCEPTION (b) blocking system issue\nVALID-UNTIL when the tmux server comes back")).toBe(true);
});

test("every promised ISO-8601 spelling is accepted, and an offset shifts the instant", () => {
  for (const good of ["2026-08-19T13:00:00Z", "2026-08-19T13:00:00-07:00", "2026-08-19T13:00:00+00:00",
    "2026-08-19T13:00Z", "2026-08-19"]) {
    expect(accepted(`EXCEPTION (b) blocking system issue\nVALID-UNTIL ${good}`)).toBe(true);
  }
  const utc = exc("EXCEPTION (b) x\nVALID-UNTIL 2026-08-19T13:00:00Z");
  const off = exc("EXCEPTION (b) x\nVALID-UNTIL 2026-08-19T13:00:00-07:00");
  const utcUntil = Number(utc.split("\t")[1]);
  const offUntil = Number(off.split("\t")[1]);
  expect(offUntil - utcUntil).toBe(25200); // -07:00 shifted the instant by 7h
});

test("every malformed decline is refused WITH a stated reason, never silently", () => {
  for (const bad of [
    "EXCEPTION (b) blocking system issue\nVALID-UNTIL when the tmux server comes back",
    `EXCEPTION (a) backlog-needs-owner\n${GATED}`,
    `EXCEPTION (a) backlog-needs-owner\ntap-20ao -> waiting on the operator\ntap-dg8g\nVALID-UNTIL ${FUTURE}`,
  ]) {
    expect(exc(bad).startsWith("REJECT\t")).toBe(true);
  }
});

test("the receipt is the primary answer record; a bare settle is not an answer", () => {
  fixture();
  rearm();
  const armed = tick(A + 60);
  expect(wakeId()).toBe("wake-1"); // the wake is a live obligation
  expect(armed.stdout).toContain("verdict=deadlock");

  // A bare settle is not an answer: the obligation stays, the ladder prices up.
  writeFileSync(join(bus(), "receipts/wake-1.done"),
    '{"id":"wake-1","status":"done","at":"x","by":"feeder-seat","via":"done"}');
  const bare = tick(A + 120);
  expect(bare.stdout).toContain("verdict=rung2");

  // A real reply receipt IS an answer, and the body is located by its reply_id;
  // the receipt carries the body's sha256, which the goalie re-derives from
  // the bytes it reads — a receipt naming a body that does not hash to its
  // digest is not an answer.
  writeFileSync(join(bus(), "payloads/rcpt-reply.md"),
    "---\nid: rcpt-reply\nfrom: feeder-seat\nto: goalie-seat\nkind: discuss\nin_reply_to: wake-1\n---\nDispatching tap-20ao to Lane A now.\n");
  writeFileSync(join(bus(), "receipts/wake-1.done"),
    '{"id":"wake-1","status":"done","at":"x","by":"feeder-seat","via":"reply","reply_id":"rcpt-reply","reply_sha256":"deadbeef"}');
  const wrongSha = tick(A + 150);
  // mismatched digest → "reply evidence unavailable or mismatched"
  expect(wrongSha.stdout).toContain("verdict=answered-unreadable");
  const body = envelopeBodyBytes(readFileSync(join(bus(), "payloads/rcpt-reply.md")));
  const replySha = new Bun.CryptoHasher("sha256").update(body!).digest("hex");
  expect(replySha).toHaveLength(64);
  writeFileSync(join(bus(), "receipts/wake-1.done"),
    `{"id":"wake-1","status":"done","at":"x","by":"feeder-seat","via":"reply","reply_id":"rcpt-reply","reply_sha256":"${replySha}"}`);
  const replied = tick(A + 180);
  expect(replied.stdout).toContain("verdict=answered reply=rcpt-reply");
});
