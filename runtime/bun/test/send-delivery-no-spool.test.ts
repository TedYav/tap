// tap_serial_triggers "bin/" "runtime/bun/main.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh" "runtime/bun/test/support/send-delivery-fixture.ts" "runtime/bun/test/fixtures/agent-state/"
/* --no-spool rows of the former send-delivery-classes.test.ts (D3a): the one direct attempt and every proven pre-effect refusal. Shared fixture: support/send-delivery-fixture.ts (lazy scratch; per-file afterAll). */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePaneLock } from "../src/panelock";
import { createRun } from "../src/recovery/state";
import { removeScratchTree } from "./support/scratch";
import { fixture, one, releaseScratch, run, TAP, type View } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

describe("--no-spool: one direct attempt, a proven pre-effect defer refuses", () => {
  const refused = (reason: string, detail: string) => ({
    code: 1, error_class: "delivery_refused", action: "re-send when the recipient is ready",
    detail: `--no-spool refused (${reason}); no message queued${detail ? `; ${detail}` : ""}`,
  });
  const refusal = (v: View) => ({ code: v.code, error_class: v.receipt.error_class, action: v.receipt.action, detail: v.receipt.detail });

  test("a bare band injects", () => {
    const v = one({}, ["send", "rb", "-m", "hi", "--no-spool"]);
    expect({ code: v.code, status: v.receipt.status, keys: v.keys.length, payloads: v.payloads, spool: v.spool })
      .toEqual({ code: 0, status: "injected", keys: 3, payloads: 1, spool: [] });
  }, 120_000);

  test("a human draft is a positive hold: refused, nothing queued, canonical and .placed gone, no keys", () => {
    const v = one({ draft: "HUMAN DRAFT" }, ["send", "rb", "-m", "hi", "--no-spool"]);
    expect({ refusal: refusal(v), payloads: v.payloads, placed: v.placed, spool: v.spool, keys: v.keys })
      .toEqual({ refusal: refused("no-input-prompt", "tap: draft-preserving delivery refuses pending human input"), payloads: 0, placed: 0, spool: [], keys: [] });
  }, 120_000);

  test("a classified frame with no readable prompt is ambiguous: the one attempt is made (lib.sh:11774)", () => {
    const v = one({ noPrompt: true }, ["send", "rb", "-m", "hi", "--no-spool"]);
    expect({ code: v.code, status: v.receipt.status, keys: v.keys.length,
      notice: v.stderr.includes("explicit --no-spool attempt with no readable input band -> injecting") })
      .toEqual({ code: 0, status: "injected", keys: 3, notice: true });
  }, 120_000);

  test("a frame no rule classifies holds the one attempt: refused, nothing typed (default-deny, tap-rlebf.1)", () => {
    const v = one({ unclassified: true }, ["send", "rb", "-m", "hi", "--no-spool"]);
    expect({ code: v.code, error_class: v.receipt.error_class, keys: v.keys, payloads: v.payloads, spool: v.spool,
      notice: v.stderr.includes("explicit --no-spool attempt with no readable input band -> injecting") })
      .toEqual({ code: 1, error_class: "delivery_refused", keys: [], payloads: 0, spool: [], notice: false });
    expect(v.receipt.detail).toContain("--no-spool refused");
  }, 120_000);

  test("a human approval prompt on screen is a positive hold, not an ambiguous frame: refused, no keys (B's control)", () => {
    // classifyPane reads the prompt as `no-band` and toPaneBand collapses it to
    // `unobservable` — the same string an unreadable composer produces. The
    // arm's positive precondition is what keeps this from typing into a
    // human's pending decision (lib.sh's rc 4, never typed over).
    const v = one({ modal: true }, ["send", "rb", "-m", "hi", "--no-spool"]);
    expect({ code: v.code, error_class: v.receipt.error_class, keys: v.keys, payloads: v.payloads, placed: v.placed,
      notice: v.stderr.includes("-> injecting") })
      .toEqual({ code: 1, error_class: "delivery_refused", keys: [], payloads: 0, placed: 0, notice: false });
    expect(refusal(v)).toEqual(refused("no-input-prompt", "tap: pane 'rb:0.0' has no visible input prompt -> defer"));
  }, 120_000);

  test("a live clearing fence refuses with the fence's detail", () => {
    const v = one({ clearFence: true }, ["send", "rb", "-m", "hi", "--no-spool"]);
    expect({ refusal: refusal(v), payloads: v.payloads, placed: v.placed, keys: v.keys })
      .toEqual({ refusal: refused("clearing", "seat 'rb' is mid-clear"), payloads: 0, placed: 0, keys: [] });
  }, 120_000);

  test("copy-mode is never cancelled by --no-spool: refused", () => {
    const v = one({ copyMode: true }, ["send", "rb", "-m", "hi", "--no-spool"]);
    expect({ refusal: refusal(v), keys: v.keys }).toEqual({ refusal: refused("copy-mode", "pane is in copy mode or unreadable"), keys: [] });
  }, 120_000);

  for (const flags of [[], ["--urgent"], ["--no-spool"]]) test(`a held pane-submit lock reports lock-park without effects: ${flags.join(" ") || "standard"}`, () => {
    const fx = fixture();
    const lock = acquirePaneLock("%7", 5000, fx.env);
    expect(lock).not.toBeNull();
    try {
      const v = run(fx, ["send", "rb", "-m", "hi", ...flags]);
      expect(v.route).toBe("native send");
      v.route = "";
      if (flags.includes("--no-spool")) {
        expect({ refusal: refusal(v), payloads: v.payloads, placed: v.placed, spool: v.spool, keys: v.keys })
          .toEqual({ refusal: refused("lock-park", "tap: another submit holds pane 'rb:0.0' (waited 5s) -> park"), payloads: 0, placed: 0, spool: [], keys: [] });
      } else {
        expect({ code: v.code, reason: v.receipt.reason, spool: v.spool, keys: v.keys })
          .toEqual({ code: 0, reason: "lock-park", spool: [{ reason: "lock-park", policy: "standard", timeout_seconds: null, to: "rb" }], keys: [] });
        const meta = JSON.parse(readFileSync(join(fx.bus, "spool", readdirSync(join(fx.bus, "spool")).find(name => name.endsWith(".meta.json"))!), "utf8"));
        expect({ reasonClass: meta.reason_class, lifetime: meta.waiter_lifetime }).toEqual({ reasonClass: "busy", lifetime: "readiness-gate" });
      }
      expect(readdirSync(join(fx.bus, "receipts")).some(name => name.endsWith(".attempted"))).toBe(false);
    } finally { lock!.release(); }
  }, 120_000);

  test("a pane_id drift under the held submit lock (certified pre-effect) refuses and leaves nothing queued under --no-spool (Codex P1)", async () => {
    // The incumbent's pre-submit identity recheck removes the canonical and fails
    // `identity_mismatch` (tap-send.sh:1687-1695); native's queued/poll carve-out
    // for this outcome (ratified for the plain class) yields to the
    // flag's "no message queued" contract.
    const fx = fixture();
    const paneLock = acquirePaneLock("%7", 5000, fx.env);
    expect(paneLock).not.toBeNull();
    const child = Bun.spawn([TAP, "send", "rb", "-m", "hi", "--no-spool", "--json"], {
      cwd: fx.wt, env: { ...fx.env, TAP_SELF: "ua" }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 30_000;
      const payloadsNow = () => readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md")).length;
      while (payloadsNow() === 0 && Date.now() < deadline) await Bun.sleep(20);
      expect(payloadsNow()).toBe(1);
      const reg = JSON.parse(readFileSync(fx.registry, "utf8")) as { seats: Record<string, Record<string, unknown>> };
      reg.seats.rb!.pane_id = "%8";
      writeFileSync(fx.registry, `${JSON.stringify(reg)}\n`);
    } finally {
      paneLock!.release();
    }
    const code = await child.exited;
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const docs = [...out.split("\n"), ...err.split("\n")].filter(l => l.startsWith("{")).map(l => JSON.parse(l) as Record<string, string>);
    const last = docs[docs.length - 1] ?? {};
    const receipts = join(fx.bus, "receipts");
    const seen = { code, error_class: last.error_class ?? "", status: last.status ?? "",
      payloads: readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md")).length,
      placed: existsSync(receipts) ? readdirSync(receipts).filter(f => f.endsWith(".placed")).length : 0,
      spool: existsSync(join(fx.bus, "spool")) ? readdirSync(join(fx.bus, "spool")).filter(f => f.endsWith(".md")).length : 0,
      keys: existsSync(fx.keys) ? readFileSync(fx.keys, "utf8").split("\n").filter(Boolean).length : 0,
      detail: (last.detail ?? "").split(fx.root).join("<root>") };
    expect(seen).toEqual({ code: 1, error_class: "identity_mismatch", status: "", payloads: 0, placed: 0, spool: 0, keys: 0,
      detail: "'rb' is bound to pane id %8, not the captured %7 — refusing to deliver to a pane that is not the addressed seat" });
  }, 240_000);

  test("--delivery now is the default class: injects", () => {
    const v = one({}, ["send", "rb", "-m", "hi", "--delivery", "now"]);
    expect({ code: v.code, status: v.receipt.status }).toEqual({ code: 0, status: "injected" });
  }, 120_000);
});

test("a withdrawn draft attempt does not hold the next no-spool send into a bare composer", () => {
  const f = fixture({draft: "draft before withdrawal"});
  expect(run(f, ["send", "rb", "-m", "first", "--no-spool"]).code).toBe(1);
  writeFileSync(f.env.FAKE_BAND!, "");
  const sent = run(f, ["send", "rb", "-m", "second", "--no-spool"]);
  expect(sent.code, sent.stderr).toBe(0);
  expect(sent.receipt.status).toBe("injected");
}, 120_000);
