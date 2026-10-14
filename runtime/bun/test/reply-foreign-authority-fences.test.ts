// tap_serial_triggers "bin/" "runtime/bun/main.ts" "runtime/bun/test/support/reply-foreign-fixture.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh"
// AUTHORITY/REFUSAL/FENCES component of the former reply-foreign-payload.test.ts
// (unit 2 split): the adoption grant and the adoption-revocation race (kept
// whole), the refusal rows (not_addressee, already_settled, unreachable and
// absent sender team, invalid index at either sample — including the
// module-boundary pins), the relocated acting registry, and both reset-custody
// fence shapes. Shared world: support/reply-foreign-fixture.ts (this file
// registers its own afterAll(releaseScratch, 40_000)).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envelopeField } from "../src/envelope";
import { TapError } from "../src/context";
import { refuseUnreachableSenderTeam } from "../src/verbs/reply";
import { acquireObligationLock } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";
import { fixture, run, outbounds, injected, settlement, INBOUND_ID, releaseScratch, TAP } from "./support/reply-foreign-fixture";

afterAll(releaseScratch, 40_000);
test("shared fixture creates fresh scratch after another component releases it", async () => {
  const first = fixture();
  await releaseScratch();
  expect(existsSync(first.root)).toBe(false);
  const next = fixture();
  expect(next.root).not.toBe(first.root);
  expect(existsSync(next.root)).toBe(true);
}, 40_000);

describe("the foreign payload file", () => {
  test("adoption: the inbound is addressed to a retired alpha fork; its live successor answers and beta's .done records by=<successor> adopted_from=<fork> (the composed context swaps only the bus)", () => {
    const fx = fixture({ adoption: true, inbound: { to: "ua-2", recipient_instance: "ua-2|FORK" } });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const mail = outbounds(fx.alpha.bus);
    expect({ mail: mail.length, ...settlement(fx) }).toEqual({ mail: 1, betaDone: { via: "reply", by: "ua", replyId: mail[0]!.replace(/\.md$/, ""), adoptedFrom: "ua-2", preview: "answer", epoch: "3" }, alphaDone: false });
  }, 120_000);

  // Point-of-effect authority (partner review F3): the adoption grant is read
  // before the send and revoked before the send's locked placement. The
  // reply is blocked on its stdin body after the authority read (the native
  // send stages `-f -` under its registry lock), the grant is removed from
  // alpha's registry, then stdin is released. Native re-runs the authority
  // predicate under the held lock and refuses with nothing placed.
  test("adoption revoked between reply's authority read and send's locked placement: native places nothing and injects nothing", async () => {
    const fx = fixture({ adoption: true, inbound: { to: "ua-2", recipient_instance: "ua-2|FORK" } });
    const trace = join(fx.root, "race.trace");
    const child = Bun.spawn([TAP, "reply", fx.payload, "-f", "-", "--by", "ua"], {
      cwd: fx.alpha.wt, env: { ...fx.env, TAP_SELF: "ua", TAP_BUN_ROUTE_TRACE: trace }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    // The obligation lock is taken before the authority read; the body read
    // comes after it. Wait for the lock, then a settle window.
    const lock = join(fx.root, "locks", `obligation-${INBOUND_ID}.lock`);
    const deadline = Date.now() + 20_000;
    while (!existsSync(lock) && Date.now() < deadline) await Bun.sleep(20);
    await Bun.sleep(1500);
    const reg = JSON.parse(readFileSync(fx.alpha.registry, "utf8")) as { seats: Record<string, Record<string, unknown>> };
    delete reg.seats.ua!.adopted_handles; delete reg.seats.ua!.adopted_instances;
    writeFileSync(fx.alpha.registry, `${JSON.stringify(reg)}\n`);
    child.stdin.write("late answer\n"); child.stdin.end();
    const code = await child.exited;
    const stderr = (await new Response(child.stderr).text()).split(`/private${fx.root}`).join("<root>").split(fx.root).join("<root>");
    const seen = { code, route: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "", stderr, alpha: outbounds(fx.alpha.bus).length, spool: existsSync(join(fx.alpha.bus, "spool")) ? readdirSync(join(fx.alpha.bus, "spool")).filter(f => f.endsWith(".md")).length : 0, injected: injected(fx).length, ...settlement(fx) };
    expect(seen).toEqual({ code: 1, route: "native reply", stderr: expect.stringContaining("is addressed to 'ua-2', not 'ua'"), alpha: 0, spool: 0, injected: 0, betaDone: null, alphaDone: false });
  }, 120_000);

  test("refusal: the inbound is addressed to another team — not_addressee with the canonical path in hand, nothing sent, nothing settled", () => {
    const fx = fixture({ inbound: { to_team: "gamma" } });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) }).toEqual({
      code: 1, route: "native reply", stdout: "",
      stderr: `tap reply: '${INBOUND_ID}' is addressed to 'gamma/ua', not 'alpha/ua' — reply from the addressed team's seat using the canonical payload path; next: tap reply <root>/beta/.tap/bus/payloads/${INBOUND_ID}.md -f <file>\n`,
      alpha: 0, betaDone: null, alphaDone: false,
    });
  }, 120_000);

  test("refusal: already settled on beta's bus — already_settled with the incumbent's detail and its `tap send` next step, nothing sent", () => {
    const fx = fixture({ betaDone: { id: INBOUND_ID, status: "done", at: "2026-09-16T11:00:00Z", by: "ua", via: "done" } });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length }).toEqual({
      code: 1, route: "native reply", stdout: "",
      stderr: `tap reply: id ${INBOUND_ID} already settled at 2026-09-16T11:00:00Z; you have 0 open: none; next: tap send\n`,
      alpha: 0,
    });
  }, 120_000);

  // A refused reply leaves the sidecar file but never a held lock (reply releases in
  // a finally); the same id is immediately re-acquirable, so the file is litter.
  test("refusal leaves no held lock: after already_settled the same obligation re-acquires at once", () => {
    const fx = fixture({ betaDone: { id: INBOUND_ID, status: "done", at: "2026-09-16T11:00:00Z", by: "ua", via: "done" } });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect(v.code).toBe(1);
    const lock = join(fx.root, "locks", `obligation-${INBOUND_ID}.lock`);
    expect(existsSync(lock)).toBe(true);
    const again = acquireObligationLock(INBOUND_ID, 0, { ...process.env, TAP_LOCK_DIR: join(fx.root, "locks") });
    expect(again).not.toBeNull();
    again!.release();
  }, 120_000);

  // A lock sidecar the caller cannot open (a sandbox denying writes under ~/.tap) is
  // not "another process": the refusal names the lock path and the permission.
  // chmod 000 denies EACCES only to non-root, so this arm skips when the runner is uid 0;
  // the directory-sidecar arm below reaches the same refusal for root too.
  test.skipIf(process.getuid?.() === 0)("refusal: the obligation lock cannot be opened — lock_unwritable names the path and permission, not another process; nothing sent", () => {
    const fx = fixture();
    const locks = join(fx.root, "locks"), lock = join(locks, `obligation-${INBOUND_ID}.lock`);
    mkdirSync(locks, { recursive: true });
    writeFileSync(lock, ""); chmodSync(lock, 0o000);
    try {
      const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
      expect({ code: v.code, route: v.route, stdout: v.stdout, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) })
        .toEqual({ code: 1, route: "native reply", stdout: "", alpha: 0, betaDone: null, alphaDone: false });
      expect(v.stderr).toContain(`cannot open the obligation lock <root>/locks/obligation-${INBOUND_ID}.lock (EACCES: permission denied); nothing was sent`);
      expect(v.stderr).toContain("sandbox escalation");
      expect(v.stderr).not.toContain("another process");
    } finally { chmodSync(lock, 0o600); }
  }, 120_000);

  test("refusal: the obligation sidecar is a directory — lock_unwritable with EISDIR for any uid, not another process; nothing sent", () => {
    const fx = fixture();
    const lock = join(fx.root, "locks", `obligation-${INBOUND_ID}.lock`);
    mkdirSync(lock, { recursive: true });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) })
      .toEqual({ code: 1, route: "native reply", stdout: "", alpha: 0, betaDone: null, alphaDone: false });
    expect(v.stderr).toContain(`cannot open the obligation lock <root>/locks/obligation-${INBOUND_ID}.lock (EISDIR); nothing was sent`);
    expect(v.stderr).not.toContain("another process");
  }, 120_000);

  test("refusal: the sender team's acting registry is unreachable through the index — reply's own unreachable_team sentence, nothing sent, nothing settled", () => {
    const fx = fixture({ betaIndex: "unreachable" });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) }).toEqual({
      code: 1, route: "native reply", stdout: "",
      stderr: "tap reply: sender team 'beta' acting registry unreachable (unreachable) — enroll or repair; will not fall back to the retired bus mirror; next: tap doctor\n",
      alpha: 0, betaDone: null, alphaDone: false,
    });
  }, 120_000);

  test("refusal: the sender team is not in the index at all — the reference itself no longer resolves (not_found); with the path in hand, unreachable_team", () => {
    const fx = fixture({ betaIndex: "absent" });
    const byId = run(fx, ["reply", `beta/${INBOUND_ID}`, "-m", "answer", "--by", "ua"]);
    expect({ code: byId.code, stdout: byId.stdout, stderr: byId.stderr, alpha: outbounds(fx.alpha.bus).length }).toEqual({
      code: 1, stdout: "", stderr: "tap reply: no enrolled team 'beta' on this machine; next: tap teams\n", alpha: 0,
    });
    const byPath = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: byPath.code, stderr: byPath.stderr, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) }).toEqual({
      code: 1, stderr: "tap reply: sender team 'beta' acting registry unreachable (unreachable) — enroll or repair; will not fall back to the retired bus mirror; next: tap doctor\n",
      alpha: 0, betaDone: null, alphaDone: false,
    });
  }, 120_000);

  // The pre-send authority sample is the reply's SECOND read of the index (the
  // resolver took the first), so the marker can turn between them (partner review).
  // No CLI hook sits between the two samples on either door, so the second
  // sample's policy is pinned at the module boundary: the incumbent's
  // `invalid_flip` sentence for a marker that turned invalid, `unreachable_team`
  // for one that was deleted (never the retired mirror on this door).
  test("between the two index samples: a marker that turns invalid is invalid_flip with the incumbent's sentence; one that is deleted is unreachable_team — never the mirror", () => {
    const fx = fixture();
    const saved = process.env.TAP_INDEX_HOME;
    process.env.TAP_INDEX_HOME = fx.index;
    try {
      expect(() => refuseUnreachableSenderTeam("beta")).not.toThrow();
      writeFileSync(join(fx.index, "global-registry.json"), "{ invalid");
      let seen: unknown = null;
      try { refuseUnreachableSenderTeam("beta"); } catch (error) { seen = error instanceof TapError ? { code: error.code, cls: error.errorClass, action: error.action, detail: error.detail } : error; }
      expect(seen).toEqual({ code: 1, cls: "invalid_flip", action: "tap doctor", detail: "registry flip marker is present but invalid — refusing foreign reply that would bind the retired bus mirror" });
      writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({ schema: "0.20", teams: {} })}\n`);
      try { refuseUnreachableSenderTeam("beta"); } catch (error) { seen = error instanceof TapError ? { code: error.code, cls: error.errorClass, action: error.action, detail: error.detail } : error; }
      expect(seen).toEqual({ code: 1, cls: "unreachable_team", action: "tap doctor", detail: "sender team 'beta' acting registry unreachable (unreachable) — enroll or repair; will not fall back to the retired bus mirror" });
      unlinkSync(join(fx.index, "global-registry.json"));
      try { refuseUnreachableSenderTeam("beta"); } catch (error) { seen = error instanceof TapError ? { cls: error.errorClass } : error; }
      expect(seen).toEqual({ cls: "unreachable_team" });
    } finally {
      if (saved === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = saved;
    }
  });

  test("an invalid machine index at the start: the reference resolves with no index and the foreign path fails on the FIRST sample, nothing placed", () => {
    const fx = fixture({ invalidIndex: true });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) }).toEqual({
      code: 1, stdout: "", stderr: expect.any(String), alpha: 0, betaDone: null, alphaDone: false,
    });
    expect(v.stderr).toEqual(expect.stringContaining("invalid"));
  }, 120_000);

  // tap-fyttg: the same corrupt-index refusal at reply's seam, with the raw
  // 0xe9 the marker-kind arms pin — in an unrelated team's name, so a lossy
  // decode would leave every team resolvable and the reply would run. No
  // delivery, no settlement; the valid-UTF-8 rewrite of the same document
  // answers, so the arm is about the bytes.
  test("refusal: an index with a raw 0xe9 in an unrelated team name refuses reply without delivery or settlement; the same document in valid UTF-8 answers", () => {
    const fx = fixture();
    const marker = join(fx.index, "global-registry.json");
    writeFileSync(marker, Buffer.concat([
      Buffer.from(`{"schema":"0.20","teams":{"oth`),
      Buffer.from([0xe9]),
      Buffer.from(`er":{"root":"/nowhere","registry_location":"/nowhere/r.json"},` +
        `"alpha":{"root":${JSON.stringify(fx.alpha.wt)},"registry_location":${JSON.stringify(fx.alpha.registry)},"state":"registered"},` +
        `"beta":{"root":${JSON.stringify(fx.beta.wt)},"registry_location":${JSON.stringify(fx.beta.registry)},"state":"registered"}}}`),
    ]));
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, alpha: outbounds(fx.alpha.bus).length, injected: injected(fx).length, ...settlement(fx) })
      .toEqual({ code: 1, route: "native reply", stdout: "", alpha: 0, injected: 0, betaDone: null, alphaDone: false });
    // The established invalid-marker diagnostic, byte-exact at this public seam
    // (probed once at the door, pinned verbatim — same sentence whoami renders).
    expect(v.stderr).toBe("tap reply: registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation; next: tap doctor\n");
    writeFileSync(marker, JSON.stringify({
      schema: "0.20",
      teams: {
        other: { root: "/nowhere", registry_location: "/nowhere/r.json", state: "registered" },
        alpha: { root: fx.alpha.wt, registry_location: fx.alpha.registry, state: "registered" },
        beta: { root: fx.beta.wt, registry_location: fx.beta.registry, state: "registered" },
      },
    }));
    const ok = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: ok.code, route: ok.route, stdout: ok.stdout }).toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n` });
  }, 120_000);

  test("relocated acting registry: reply sends through beta's enrolled root and settles on its bus", () => {
    const fx = fixture({ betaRelocated: true });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const mail = outbounds(fx.alpha.bus);
    expect({ mail: mail.length, injected: injected(fx).length, ...settlement(fx) })
      .toEqual({ mail: 1, injected: 1, betaDone: { via: "reply", by: "ua", replyId: mail[0]!.replace(/\.md$/, ""), adoptedFrom: undefined, preview: "answer", epoch: "3" }, alphaDone: false });
  }, 120_000);

  // Reset custody on the FOREIGN bus (partner review): the native door holds
  // custody of every bus it mutates, so beta's live fence refuses reply's own
  // custody check before any outbound.
  for (const betaRelocated of [false, true]) test(`reset custody on the FOREIGN bus, relocated=${betaRelocated}: beta's live fence refuses before any outbound at reply's custody check`, () => {
    const fx = fixture({ betaResetFence: true, betaRelocated });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    const seen = { code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, injected: injected(fx).length, ...settlement(fx) };
    expect(seen).toEqual({ code: 1, route: "native reply", stdout: "", stderr: expect.stringContaining("mid-reset"), alpha: 0, injected: 0, betaDone: null, alphaDone: false });
  }, 120_000);

  test("reset custody on the FOREIGN bus, local reply_to redirect: the native door refuses before any outbound and writes no beta .done", () => {
    const fx = fixture({ betaResetFence: true, inbound: { reply_to: "ua2" } });
    const v = run(fx, ["reply", fx.payload, "-m", "answer", "--by", "ua"]);
    const seen = { code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, injected: injected(fx).length, ...settlement(fx) };
    expect(seen).toEqual({ code: 1, route: "native reply", stdout: "", stderr: expect.stringContaining("mid-reset"), alpha: 0, injected: 0, betaDone: null, alphaDone: false });
  }, 120_000);
});
