import { type PaneEffects } from "../src/deliver";
import { submitNotice } from "../src/notice-submit";
import { inputBackupBody } from "../src/input-backup";
import { installSpoolPane } from "./support/spool-pane";
import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drainOnce, type DrainContext, type SpoolBinding } from "../src/spool-drain";
import * as drainEffects from "../src/spool-drain-effects";
import * as deadline from "../src/spool-deadline";
const { injectDigest, notifyDigestSenders, realDrainEffects, redeliver } = drainEffects;
import { claimAcquire, reapStaleSidecars } from "../src/spool-sidecar";
import { recoverStrandedReparks } from "../src/spool-repark";
import { acquireObligationLock, acquirePathLock } from "../src/panelock";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scripts = join(import.meta.dir, "../../../skills/tap/scripts");

function fixture(rc = 0) {
  const root = mkdtempSync(join(tmpdir(), "spool-effect-")); roots.push(root);
  const home = join(root, ".tap", "bus"); mkdirSync(home, { recursive: true });
  const scriptsDir = join(home, "scripts"), spoolDir = join(home, "spool");
  for (const path of [scriptsDir, spoolDir, join(home, "payloads"), join(home, "receipts")]) mkdirSync(path);
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {} }));
  writeFileSync(join(home, ".tap-bus-authority"), "");
  const env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(home, "index"), SUBMIT_RC: String(rc), TAP_SPOOL_DISABLE_DELIVERER: "1" };
  installSpoolPane(home, registry, env).writeSeat({ boot_id: "" });
  const ctx: DrainContext = { home, scriptsDir, spoolDir, payloadsDir: join(home, "payloads"), receiptsDir: join(home, "receipts"),
    eventLog: join(home, "registry-events.log"), actingRegistry: registry, team: "fixture", verbLabel: "tap", courierIdentity: "courier",
    alert: { mode: "none" }, now: 100, unroutedGrace: 1800, env };
  const binding: SpoolBinding = { target: "peer", targetRegistry: registry, toTeam: "fixture", pane: "fixture:0.0", paneId: "%401" };
  const park = (id: string, policy = "standard") => {
    writeFileSync(join(spoolDir, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody ${id}\n`);
    writeFileSync(join(spoolDir, `${id}.meta.json`), JSON.stringify({ id, target: "peer", pane: binding.pane, pane_id: binding.paneId,
      target_registry: binding.targetRegistry, to_team: binding.toTeam, policy, first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
  };
  const calls = () => existsSync(join(home, "effects")) ? readFileSync(join(home, "effects"), "utf8").trim().split("\n") : [];
  let typed = "", queued = false;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%401", session: "fixture", serverEpoch: "srv:123:456", currentCommand: "codex", panePid: "4242" }),
    harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    paneState: () => rc === 1 ? { state: "unobservable", reason: "permission prompt" } : typed ? { state: "busy", text: typed } : { state: "ready" },
    injectText: (_, text) => {
      writeFileSync(join(home, "effects"), "a\n", { flag: "a" }); typed = text; queued = rc === 7;
      return rc === 124 ? "rate_limited" : rc !== 5;
    },
    inputHasId: (_, __, id) => typed.includes(id), pressEnter: () => { typed = ""; return true; }, settle: () => {},
    clearInput: () => { typed = ""; return true; }, backspace: () => { typed = ""; return true; },
    restoreInput: (_, value) => { typed = value; return true; },
    submitFrame: () => ({ state: queued ? "queued" : typed ? "staged" : "empty", mode: "idle", width: "80" }),
  };
  return { ctx, binding, park, calls, fx, text: (value?: string) => value === undefined ? typed : (typed = value) };
}

for (const layout of ["standard", "relocated"])
for (const reader of ["readiness", "single-early", "single-late", "digest-late"])
test(`${reader} honors the enrolled root clear fence with a ${layout} registry`, async () => {
  const f = fixture();
  const root = resolve(f.ctx.home, "../.."), index = f.ctx.env!.TAP_INDEX_HOME!;
  const registry = join(root, ".tap", ...(layout === "relocated" ? ["elsewhere", "registry.json"] : ["team-registry.json"]));
  mkdirSync(resolve(registry, ".."), { recursive: true });
  renameSync(f.binding.targetRegistry, registry);
  f.binding.targetRegistry = f.ctx.actingRegistry = registry;
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    fixture: { root, registry_location: registry, state: "registered" },
  } }));
  f.park("a"); f.park("b");
  const fence = join(f.ctx.home, "clear-fence", "peer.json");
  const publishFence = () => {
    mkdirSync(resolve(fence, ".."), { recursive: true });
    writeFileSync(fence, JSON.stringify({ since_epoch: Date.now() / 1000, ceiling_seconds: 90 }));
  };
  if (reader.endsWith("late")) {
    const observe = f.fx.observePane;
    f.fx.observePane = (...args) => { publishFence(); return observe(...args); };
  } else publishFence();
  const deliver = () => reader === "readiness" ? realDrainEffects(f.ctx).readiness(f.binding)
    : reader === "digest-late" ? injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)
    : redeliver(f.ctx, "a", f.binding, {}, f.fx);
  expect(await deliver()).toBe(reader === "readiness" ? "busy:clearing" : 1);
  expect(f.calls()).toEqual([]);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.ctx.spoolDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.attempted`))).toBe(false);
  }
});

for (const authority of ["absent", "invalid", "historical", "unreachable", "mismatch"])
for (const reader of ["readiness", "single", "digest"])
test(`${reader} holds unavailable fence authority: ${authority}`, async () => {
  const f = fixture(), index = f.ctx.env!.TAP_INDEX_HOME!;
  mkdirSync(index, { recursive: true });
  const marker = join(index, "global-registry.json");
  if (authority === "absent") rmSync(marker, { force: true });
  const other = join(f.ctx.home, "other-registry.json");
  writeFileSync(other, readFileSync(f.binding.targetRegistry));
  if (authority !== "absent") writeFileSync(marker, authority === "invalid" ? "{broken" : JSON.stringify({ schema: "0.20", teams: {
    fixture: { root: resolve(f.ctx.home, "../.."), registry_location: authority === "mismatch" ? other
      : authority === "unreachable" ? join(f.ctx.home, "missing.json") : f.binding.targetRegistry,
      state: authority === "historical" ? "historical" : "registered" },
  } }));
  f.park("a"); f.park("b");
  const result = reader === "readiness" ? await realDrainEffects(f.ctx).readiness(f.binding)
    : reader === "digest" ? await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)
    : await redeliver(f.ctx, "a", f.binding, {}, f.fx);
  expect(result).toBe(reader === "readiness" ? "busy:decision-unavailable" : 1);
  expect(f.calls()).toEqual([]);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.ctx.spoolDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.attempted`))).toBe(false);
  }
});

test("a kill after the pre-submit move is recovered by repark, never retired as unconfirmed", async () => {
  const f = fixture();
  f.park("a");
  f.fx.crashAfterMove = () => { throw new Error("sigkill: after pre-submit move"); };
  await expect(redeliver(f.ctx, "a", f.binding, {}, f.fx)).rejects.toThrow("sigkill");
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(true);
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(false);
  recoverStrandedReparks(f.ctx.spoolDir, f.ctx.payloadsDir, f.ctx.env);
  reapStaleSidecars(f.ctx.spoolDir, f.ctx.payloadsDir, f.ctx.env);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(true);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(false);
  expect(existsSync(join(f.ctx.receiptsDir, "a.unconfirmed"))).toBe(false);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(true);
  f.fx.crashAfterMove = undefined;
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(f.calls()).toEqual(["a"]);
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(true);
});

test("attempt evidence after the move is surfaced, never reparked or re-entered", async () => {
  const f = fixture();
  f.park("a");
  writeFileSync(join(f.ctx.receiptsDir, "a.attempted"), "{}");
  f.fx.crashAfterMove = () => { throw new Error("sigkill: after pre-submit move"); };
  await expect(redeliver(f.ctx, "a", f.binding, {}, f.fx)).rejects.toThrow("sigkill");
  recoverStrandedReparks(f.ctx.spoolDir, f.ctx.payloadsDir, f.ctx.env);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  reapStaleSidecars(f.ctx.spoolDir, f.ctx.payloadsDir, f.ctx.env);
  const receipt = JSON.parse(readFileSync(join(f.ctx.receiptsDir, "a.unconfirmed"), "utf8"));
  expect(receipt.effect).toBe("possible");
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(true);
  expect(f.calls()).toEqual([]);
});

test("single delivery backs up and restores a short human draft, admitting only at the clear key", async () => {
  const f = fixture(); f.park("a"); f.text("keep this draft");
  const clear = f.fx.clearInput!;
  let clears = 0;
  f.fx.clearInput = target => {
    expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(true);
    clears++; return clear(target);
  };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(clears).toBe(1);
  expect(f.calls()).toEqual(["a"]);
  expect(f.text()).toBe("keep this draft");
  const backups = join(f.ctx.home, "input-backups");
  expect(inputBackupBody(readFileSync(join(backups, readdirSync(backups)[0]!), "utf8"))).toBe("keep this draft");
});

for (const input of ["[[TAP v0.23 ask", "[[TAP v0.23 ask one]] [[TAP v0.23 ask two]]"])
test(`unparseable staged input stays retryable without a pane effect: ${input}`, async () => {
  const f = fixture(); f.park("a"); f.text(input);
  f.fx.clearInput = () => { throw new Error("must not clear unparseable TAP input"); };
  f.fx.pressEnter = () => { throw new Error("must not submit unparseable TAP input"); };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(f.text()).toBe(input);
  expect(f.calls()).toEqual([]);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(true);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(true);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(false);
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(false);
});

for (const mode of ["unobservable", "auto", "cancel-fails"] as const)
test(`single copy-mode admission: ${mode}`, async () => {
  const f = fixture(); f.park("a");
  const registry = JSON.parse(readFileSync(f.binding.targetRegistry, "utf8"));
  registry.seats.peer.permissions = mode === "auto" ? "auto" : "bypass";
  writeFileSync(f.binding.targetRegistry, JSON.stringify(registry));
  f.fx.copyMode = () => mode === "unobservable" ? { status: "unobservable", reason: "fixture observation refused" } : { status: "copy-mode" };
  const tmux = join(f.ctx.home, "pane-bin/tmux");
  const source = readFileSync(tmux, "utf8");
  writeFileSync(tmux, source.replace('  send-keys)\n', `  send-keys)
    if [ "\${!#}" = cancel ]; then
      [ -f "$TAP_HOME/receipts/a.attempted" ] || exit 77
      printf admitted > "$TAP_HOME/cancel-observed"
      exit 1
    fi
`));
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(existsSync(join(f.ctx.home, "cancel-observed"))).toBe(mode === "cancel-fails");
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(mode === "cancel-fails");
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(true);
  expect(f.calls()).toEqual([]);
});

test("a failed backup preserves the draft and admits no pane effect", async () => {
  const f = fixture(); f.park("a"); f.text("keep this draft");
  writeFileSync(join(f.ctx.home, "input-backups"), "not a directory");
  f.fx.clearInput = () => { throw new Error("clear must not run without a backup"); };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5);
  expect(f.text()).toBe("keep this draft");
  expect(f.calls()).toEqual([]);
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(false);
});

for (const state of ["reachable", "missing", "invalid", "same-team", "manual"] as const)
test(`single sender index evidence: ${state}`, async () => {
  const f = fixture();
  const fromTeam = state === "same-team" ? "fixture" : "alpha";
  const toTeam = state === "manual" ? "" : "fixture";
  f.binding.toTeam = fromTeam === toTeam ? "" : toTeam;
  f.park("a");
  const payload = join(f.ctx.spoolDir, "a.md"), index = f.ctx.env!.TAP_INDEX_HOME!;
  writeFileSync(payload, readFileSync(payload, "utf8").replace("from: sender\n", `from: sender\nfrom_team: ${fromTeam}\n${toTeam ? `to_team: ${toTeam}\n` : ""}`));
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), state === "reachable" || state === "missing"
    ? JSON.stringify({ schema: "0.20", teams: state === "reachable" ? {
      alpha: { root: f.ctx.home, registry_location: f.ctx.actingRegistry, state: "registered" },
    } : {} }) : "{invalid");
  let wire = "";
  const inject = f.fx.injectText;
  f.fx.injectText = (pane, text) => { wire = text; return inject(pane, text); };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(state === "invalid" ? 1 : 0);
  if (state === "invalid") {
    expect(f.calls()).toEqual([]);
    expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(false);
    expect(existsSync(payload)).toBe(true);
  } else {
    expect(f.calls()).toEqual(["a"]);
    expect(wire.includes(" path=")).toBe(state === "missing" || state === "manual");
  }
});

for (const rc of [0, 5, 124, 7]) test(`digest submit ${rc}: native custody precedes a lost caller response`, async () => {
  const f = fixture(rc); f.park("a"); f.park("b");
  const loseResponse = async () => {
    await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx);
    throw new Error("callback response lost after submit");
  };
  await expect(loseResponse()).rejects.toThrow("response lost");
  expect(f.calls()).toHaveLength(1);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.ctx.payloadsDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(f.ctx.spoolDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(f.ctx.spoolDir, `${id}.meta.json`))).toBe(false);
    expect(existsSync(join(f.ctx.spoolDir, `${id}.claim`))).toBe(false);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.attempted`))).toBe(true);
  }
  expect(readdirSync(join(f.ctx.spoolDir, "digests")).filter(n => n.endsWith(".json"))).toHaveLength(1);
  expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(2);
  expect(f.calls()).toHaveLength(1);
});

test("verified single delivery writes the exact receipt and event without touching its sibling", async () => {
  const f = fixture(); f.park("a"); f.park("sibling");
  writeFileSync(join(f.ctx.receiptsDir, "a.placed"), "placed");
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(JSON.parse(readFileSync(join(f.ctx.receiptsDir, "a.sent"), "utf8"))).toEqual({
    id: "a", from: "sender", to: "peer", pane: "fixture:0.0", kind: "discuss", turn: "unconfirmed", delivery: "pane",
  });
  expect(readFileSync(f.ctx.eventLog, "utf8")).toContain("actor=courier action=redelivery_delivered handle=peer pane=fixture:0.0 detail=id=a");
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
  expect(existsSync(join(f.ctx.receiptsDir, "a.placed"))).toBe(true);
  expect(existsSync(join(f.ctx.spoolDir, "sibling.md"))).toBe(true);
  expect(existsSync(join(f.ctx.spoolDir, "sibling.meta.json"))).toBe(true);
  expect(existsSync(join(f.ctx.receiptsDir, "sibling.sent"))).toBe(false);
});

for (const drop of ["receipt", "event", "both"] as const) test(`single receipt discriminator: deleting ${drop} is observed independently`, async () => {
  const f = fixture(); f.park("a");
  const source = join(import.meta.dir, "../src/spool-drain-effects.ts");
  let bytes = readFileSync(source, "utf8");
  const receipt = /atomicWrite\(join\(ctx\.receiptsDir, `\$\{id\}\.sent`\), receiptBytes\(\{[\s\S]*?delivery: "pane" \}\)\);/g;
  const event = 'event("redelivery_delivered", `id=${id}`);';
  expect(bytes.match(receipt)).toHaveLength(1);
  expect(bytes.split(event)).toHaveLength(2);
  if (drop !== "event") bytes = bytes.replace(receipt, "void 0;");
  if (drop !== "receipt") bytes = bytes.replace(event, "void 0;");
  // Keep the mutant's dependencies at the real source and the mutable copy in runner scratch.
  bytes = bytes.replace(/from "(\.\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(resolve(import.meta.dir, "../src", path))}`);
  const mutant = join(f.ctx.home, `mutant-${drop}.ts`); writeFileSync(mutant, bytes);
  const altered = await import(mutant) as typeof import("../src/spool-drain-effects");
  expect(await altered.redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(existsSync(join(f.ctx.receiptsDir, "a.sent"))).toBe(drop === "event");
  expect(existsSync(f.ctx.eventLog) && readFileSync(f.ctx.eventLog, "utf8").includes("action=redelivery_delivered")).toBe(drop === "receipt");
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
});

test("an unwritable post-submit receipt still retires retry; pre-effect evidence failure preserves the body", async () => {
  for (const before of [false, true]) {
    const f = fixture(); f.park("a");
    const breakReceipts = () => {
      renameSync(f.ctx.receiptsDir, `${f.ctx.receiptsDir}-saved`);
      writeFileSync(f.ctx.receiptsDir, "not a directory");
      expect(() => writeFileSync(join(f.ctx.receiptsDir, "probe"), "")).toThrow();
    };
    if (before) breakReceipts();
    else { const inject = f.fx.injectText; f.fx.injectText = (target, text) => { const result = inject(target, text); breakReceipts(); return result; }; }
    expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(before ? 1 : 0);
    expect(f.calls()).toEqual(before ? [] : ["a"]);
    expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(before);
    expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(!before);
    expect(existsSync(join(f.ctx.receiptsDir, "a.sent"))).toBe(false);
  }
});

for (const rc of [0, 5, 124, 7]) test(`single submit ${rc}: lost response cannot requeue or invent success`, async () => {
  const f = fixture(rc); f.park("a");
  const loseResponse = async () => {
    await redeliver(f.ctx, "a", f.binding, {}, f.fx);
    throw new Error("single response lost");
  };
  await expect(loseResponse()).rejects.toThrow("response lost");
  expect(f.calls()).toEqual(["a"]);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(true);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(true);
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(f.calls()).toEqual(["a"]);
});

test("unavailable pre-effect observation releases only the digest's claims and leaves bodies", async () => {
  const f = fixture(); f.park("a"); f.park("b");
  f.ctx.env!.FAKE_CAPTURE_FAIL = "1";
  expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(1);
  expect(f.calls()).toEqual([]);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.ctx.spoolDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(f.ctx.spoolDir, `${id}.claim`))).toBe(false);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.attempted`))).toBe(false);
  }
});

test("a late attempted member refuses the digest without marking its earlier sibling", async () => {
  const f = fixture(); f.park("a"); f.park("b");
  const observe = f.fx.observePane;
  f.fx.observePane = (...args) => {
    writeFileSync(join(f.ctx.receiptsDir, "b.attempted"), "prior attempt\n");
    return observe(...args);
  };
  expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(1);
  expect(f.calls()).toEqual([]);
  expect(readdirSync(join(f.ctx.spoolDir, "digests"))).toEqual([]);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.ctx.spoolDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(f.ctx.spoolDir, `${id}.claim`))).toBe(false);
  }
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(false);
});

for (const failure of ["move", "metadata"]) test(`digest ${failure} failure preserves possible-effect evidence for every member`, async () => {
  const f = fixture(); f.park("a"); f.park("b");
  const inject = f.fx.injectText;
  f.fx.injectText = (pane, text) => {
    if (failure === "move") mkdirSync(join(f.ctx.payloadsDir, "a.md"));
    else {
      rmSync(join(f.ctx.spoolDir, "a.meta.json"));
      mkdirSync(join(f.ctx.spoolDir, "a.meta.json"));
    }
    return inject(pane, text);
  };
  expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(0);
  expect(f.calls()).toEqual(["a"]);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.attempted`))).toBe(true);
    expect(existsSync(join(f.ctx.spoolDir, `${id}.claim`))).toBe(false);
  }
  expect(existsSync(join(f.ctx.payloadsDir, "b.md"))).toBe(true);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(failure === "move");
  expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(2);
  expect(f.calls()).toEqual(["a"]);
});

test("no-effect single refusal restores spool custody and keeps retry eligibility", async () => {
  const f = fixture(1); f.park("a");
  const original = readFileSync(join(f.ctx.spoolDir, "a.md"));
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(readFileSync(join(f.ctx.spoolDir, "a.md"))).toEqual(original);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(false);
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(false);
  expect(f.calls()).toEqual([]);
});

// tap-conft: a busy move back leaves the body canonical; the mark is what lets the
// waiter retry that move, and only a repark carries it.
test("a repark refused as busy marks the entry for the waiter and leaves the body canonical", async () => {
  const f = fixture(1); f.park("a");
  let held = null as ReturnType<typeof acquirePathLock>;
  const observe = f.fx.paneState;
  f.fx.paneState = (...args) => {
    // After the pre-submit move, before the refusal's repark: another holder takes reset custody.
    if (!held && existsSync(join(f.ctx.payloadsDir, "a.md"))) held = acquirePathLock(join(f.ctx.home, "reset.fence.json.lock"), 0);
    return observe(...args);
  };
  try { expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1); } finally { held?.release(); }
  expect(held).not.toBeNull();
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.ctx.spoolDir, "a.meta.json"), "utf8")).repark_pending).toBeTruthy();
  expect(readFileSync(f.ctx.eventLog, "utf8")).toContain("detail=id=a_stage=repark_reason=busy");
  expect(f.calls()).toEqual([]);
}, 20000);

// tap-c9vlf write-ahead: the mark is taken BEFORE the body moves, under the entry's
// metadata lock. A holder that blocks the mark therefore blocks the move itself: the
// entry stays parked and the refusal is observable, never a silent unmarked strand.
test("a pre-submit move whose mark cannot be written refuses the move and says so", async () => {
  const f = fixture(1); f.park("a");
  const metaLock = acquirePathLock(join(f.ctx.spoolDir, "a.meta.json.lock"), 0)!;
  try { expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1); } finally { metaLock.release(); }
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(true);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.ctx.spoolDir, "a.meta.json"), "utf8")).repark_pending).toBeUndefined();
  expect(readFileSync(f.ctx.eventLog, "utf8")).toContain("action=spool_repark_unmarked");
}, 10000);

// Unparseable metadata is evidence, not a lock holder: never rewritten, never a
// permanent refusal. The entry delivers once without the kill-window mark and the
// missing mark is reported (liveness first; no silent strand).
for (const [label, bytes] of [["bad JSON", Buffer.from("{not json")], ["bad UTF-8", Buffer.from([0x7b, 0xff, 0x7d])]] as const)
test(`a pre-submit move over unparseable metadata (${label}) delivers once unmarked and reports it`, async () => {
  const f = fixture(); f.park("a");
  const meta = join(f.ctx.spoolDir, "a.meta.json");
  writeFileSync(meta, bytes);
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(0);
  expect(f.calls()).toEqual(["a"]);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  if (existsSync(meta)) expect(readFileSync(meta).equals(bytes)).toBe(true);
  expect(existsSync(`${meta}.tmp`)).toBe(false);
  expect(readFileSync(f.ctx.eventLog, "utf8")).toContain("action=spool_repark_unmarked");
  expect(readFileSync(f.ctx.eventLog, "utf8")).toContain("reason=unparseable");
}, 10000);

// Only metadata that was read and failed to parse licenses the unmarked delivery. A read
// failure (here EISDIR) proves nothing about the bytes, so it refuses the move like a busy lock.
test("a pre-submit move whose metadata cannot be read refuses the move", async () => {
  const f = fixture(); f.park("a");
  const meta = join(f.ctx.spoolDir, "a.meta.json");
  rmSync(meta, { force: true }); mkdirSync(meta);
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(f.calls()).toEqual([]);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(true);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(false);
  expect(readFileSync(f.ctx.eventLog, "utf8")).toContain("reason=busy");
  expect(readFileSync(f.ctx.eventLog, "utf8")).not.toContain("reason=unparseable");
}, 10000);

for (const suffix of ["done", "read"]) test(`a member ${suffix} arriving after notice grouping does not hide its unread sibling`, async () => {
  const f = fixture(); f.park("a", "autosettle"); f.park("b", "autosettle");
  for (const id of ["a", "b"]) renameSync(join(f.ctx.spoolDir, `${id}.md`), join(f.ctx.payloadsDir, `${id}.md`));
  const acquire: typeof claimAcquire = (...args) => {
    const result = claimAcquire(...args);
    if (result.status === "acquired") writeFileSync(join(f.ctx.receiptsDir, `a.${suffix}`), JSON.stringify({ id: "a", by: "peer" }));
    return result;
  };
  expect(await notifyDigestSenders(f.ctx, "digest-race", f.binding, ["a", "b"], acquire)).toBe(0);
  const notice = join(f.ctx.payloadsDir, "digest-race-sender-delivery-unconfirmed.md");
  const body = readFileSync(notice, "utf8");
  expect(body).toContain("DELIVERY UNCONFIRMED:");
  expect(body).toContain(join(f.ctx.payloadsDir, "b.md"));
  expect(await notifyDigestSenders(f.ctx, "digest-race", f.binding, ["a", "b"])).toBe(0);
  expect(readFileSync(notice, "utf8")).toBe(body);
});

for (const rc of [0, 5, 124, 7, 1]) test(`digest outcome ${rc}: real custody, notices and no repeated effect`, async () => {
  const f = fixture(rc); f.park("a", "autosettle"); f.park("b", "autosettle");
  const inject = f.fx.injectText;
  f.fx.injectText = (...args) => {
    for (const id of ["a", "b"]) {
      const contender = acquireObligationLock(id, 0, f.ctx.env);
      contender?.release();
      expect(contender).toBeNull();
    }
    return inject(...args);
  };
  const result = await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx);
  for (const id of ["a", "b"]) {
    const lock = acquireObligationLock(id, 0, f.ctx.env);
    expect(lock).not.toBeNull(); lock?.release();
  }
  expect(result).toBe(rc === 7 ? 0 : rc);
  expect(f.calls()).toHaveLength(rc === 1 ? 0 : 1);
  const indices = readdirSync(join(f.ctx.spoolDir, "digests")).filter(n => n.endsWith(".json"));
  expect(indices).toHaveLength(rc === 1 ? 0 : 1);
  const notices = readdirSync(f.ctx.payloadsDir).filter(n => n.includes("delivery-unconfirmed") && n.endsWith(".md"));
  expect(notices).toHaveLength(rc === 5 || rc === 124 ? 1 : 0);
  const event = existsSync(f.ctx.eventLog) ? readFileSync(f.ctx.eventLog, "utf8") : "";
  expect(event.includes("redelivery_submit_timeout")).toBe(rc === 124);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.ctx.payloadsDir, `${id}.md`))).toBe(rc !== 1);
    expect(existsSync(join(f.ctx.spoolDir, `${id}.md`))).toBe(rc === 1);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.attempted`))).toBe(rc !== 1);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.harness-queued`))).toBe(rc === 7);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.sent`))).toBe(false);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.done`))).toBe(false);
  }
  if (rc !== 1) {
    const before = readFileSync(join(f.ctx.receiptsDir, "a.attempted"));
    expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(2);
    expect(f.calls()).toHaveLength(1);
    expect(readFileSync(join(f.ctx.receiptsDir, "a.attempted"))).toEqual(before);
  }
});

for (const [scenario, count, want] of [["one", 20, 1], ["two", 20, 2], ["absent", 2, 1], ["ordinary", 2, 0], ["all-read", 2, 0], ["part-read", 2, 1]] as const)
test(`digest sender notices ${scenario}: group once and retain every member obligation`, async () => {
  const f = fixture(5), ids = Array.from({ length: count }, (_, i) => `member-${String(i).padStart(2, "0")}`);
  const registry = JSON.parse(readFileSync(f.ctx.actingRegistry, "utf8"));
  if (scenario !== "absent") for (const [name, paneId] of [["alice", "%402"], ["bob", "%403"]])
    registry.seats[name!] = { status: "active", pane: `sess:${paneId}`, pane_id: paneId, harness: "codex" };
  writeFileSync(f.ctx.actingRegistry, JSON.stringify(registry));
  const originals = new Map<string, string>();
  for (const [i, id] of ids.entries()) {
    f.park(id, scenario === "ordinary" ? "standard" : "autosettle");
    const path = join(f.ctx.spoolDir, `${id}.md`);
    const raw = readFileSync(path, "utf8").replace("from: sender", `from: ${scenario === "two" && i >= 10 ? "bob" : "alice"}`).replace("reply: expected", "reply: settle-only");
    writeFileSync(path, raw); originals.set(id, raw);
    if (scenario === "all-read" || (scenario === "part-read" && i === 0)) writeFileSync(join(f.ctx.receiptsDir, `${id}.read`), JSON.stringify({ id, by: "peer" }));
  }
  const unlockedAtNotice: boolean[] = [];
  f.ctx.submit = input => {
    for (const id of ids) {
      const lock = acquireObligationLock(id, 0, f.ctx.env);
      unlockedAtNotice.push(lock !== null); lock?.release();
    }
    return submitNotice(input);
  };
  expect(await injectDigest(f.ctx, f.binding, ids, f.fx)).toBe(5);
  const names = () => readdirSync(f.ctx.payloadsDir).filter(n => n.endsWith(".md") && readFileSync(join(f.ctx.payloadsDir, n), "utf8").includes("\nkind: delivery-failed\n"));
  const notices = names(); expect(notices).toHaveLength(want);
  expect(unlockedAtNotice).toEqual(Array((scenario === "absent" ? 0 : want) * ids.length).fill(true));
  const attempts = () => readdirSync(f.ctx.payloadsDir).filter(n => n.endsWith(".attempts"));
  expect(attempts().sort()).toEqual(scenario === "absent" ? [] : notices.map(n => n.slice(0, -3) + ".attempts").sort());
  for (const id of ids) {
    expect(readFileSync(join(f.ctx.payloadsDir, `${id}.md`), "utf8")).toBe(originals.get(id)!);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.done`))).toBe(false);
    expect(existsSync(join(f.ctx.receiptsDir, `${id}.sent`))).toBe(false);
  }
  for (const notice of notices) {
    const body = readFileSync(join(f.ctx.payloadsDir, notice), "utf8");
    expect(body).toContain("DELIVERY UNCONFIRMED:");
    const sender = body.split("\n").find(line => line.startsWith("to: "))!.slice(4);
    for (const id of ids) {
      const included = originals.get(id)!.includes(`from: ${sender}\n`) && !(scenario === "part-read" && id === ids[0]);
      expect(body.includes(join(f.ctx.payloadsDir, `${id}.md`))).toBe(included);
    }
  }
  const snapshot = new Map([...notices, ...attempts()].map(name => [name, readFileSync(join(f.ctx.payloadsDir, name))]));
  const index = readdirSync(join(f.ctx.spoolDir, "digests")).find(n => n.endsWith(".json"))!.slice(0, -5);
  writeFileSync(join(f.ctx.receiptsDir, `${ids[0]}.done`), "{}");
  if (scenario !== "ordinary") await notifyDigestSenders(f.ctx, index, f.binding, ids);
  for (const id of ids) writeFileSync(join(f.ctx.receiptsDir, `${id}.sent`), "{}");
  if (scenario !== "ordinary") await notifyDigestSenders(f.ctx, index, f.binding, ids);
  expect(names()).toEqual(notices);
  for (const [name, bytes] of snapshot) expect(readFileSync(join(f.ctx.payloadsDir, name))).toEqual(bytes);
  expect(f.calls()).toEqual(["a"]);
});

test("digest diagnostics follow custody and preserve member detail despite a writer failure", async () => {
  for (const broken of [false, true]) {
    const f = fixture(5); f.park("a"); f.park("b");
    const old = process.env.TAP_INDEX_HOME;
    process.env.TAP_INDEX_HOME = f.ctx.env!.TAP_INDEX_HOME;
    mkdirSync(join(process.env.TAP_INDEX_HOME!, "debug"), { recursive: true });
    writeFileSync(join(process.env.TAP_INDEX_HOME!, "debug/enabled.json"), JSON.stringify({ id: "probe", directory: f.ctx.home }));
    f.ctx.scriptsDir = scripts;
    if (broken) {
      const inject = f.fx.injectText;
      f.fx.injectText = (pane, text) => {
        // Prevent diagnostic publication without preventing the member moves.
        const id = text.split(" ")[3]!;
        mkdirSync(join(f.ctx.payloadsDir, `${id}.debug.attempts`));
        return inject(pane, text);
      };
    }
    try {
      expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(5);
      expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(true);
      expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
      if (!broken) {
        const path = readdirSync(f.ctx.payloadsDir).find(n => n.endsWith(".debug.attempts"))!;
        const evidence = JSON.parse(readFileSync(join(f.ctx.payloadsDir, path), "utf8"));
        expect(evidence.detail).toContain("members=[ a b]");
        expect(evidence.effect).toBe("possible");
      }
    } finally { if (old === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = old; }
  }
});

test("digest excludes public settlement from revalidation through the pane effect", async () => {
  const f = fixture();
  const ids = ["sender-20260924T040000Z-aaaaaaaaaaaa", "sender-20260924T040001Z-bbbbbbbbbbbb"];
  for (const id of ids) f.park(id);
  const first = join(f.ctx.spoolDir, `${ids[0]}.md`);
  const body = readFileSync(first, "utf8").replace("reply: expected", `reply: settle-only\npath: ${join(f.ctx.payloadsDir, `${ids[0]}.md`)}`);
  writeFileSync(first, body);
  linkSync(first, join(f.ctx.payloadsDir, `${ids[0]}.md`));
  const claim = join(f.ctx.spoolDir, `${ids[0]}.claim`);
  writeFileSync(claim, JSON.stringify({ v: 1, id: ids[0], owner_pid: 1, claimed_at_epoch: 1 }));
  utimesSync(claim, 1, 1);
  const root = resolve(f.ctx.home, "../..");
  writeFileSync(join(f.ctx.env!.TAP_INDEX_HOME!, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    fixture: { root, registry_location: f.binding.targetRegistry, state: "registered" },
  } }));
  let reader: ReturnType<typeof Bun.spawnSync> | undefined;
  const observe = f.fx.observePane;
  f.fx.observePane = (...args) => {
    if (!reader) reader = Bun.spawnSync([process.execPath, join(import.meta.dir, "support/native-read-entry.ts"),
      ids[0]!, "--by", "peer", "--team", "fixture"], { cwd: root, env: f.ctx.env });
    return observe(...args);
  };
  expect(await injectDigest(f.ctx, f.binding, ids, f.fx)).toBe(0);
  expect(reader).toBeDefined();
  expect(reader!.exitCode, (reader!.stdout?.toString() ?? "") + (reader!.stderr?.toString() ?? "")).toBe(1);
  expect(reader!.stderr?.toString()).toContain("exclusive eligibility");
  expect(existsSync(join(f.ctx.receiptsDir, `${ids[0]}.done`))).toBe(false);
  expect(f.calls()).toHaveLength(1);
  const after = Bun.spawnSync([process.execPath, join(import.meta.dir, "support/native-read-entry.ts"),
    ids[0]!, "--by", "peer", "--team", "fixture"], { cwd: root, env: f.ctx.env });
  expect(after.exitCode, after.stderr.toString()).toBe(0);
  expect(existsSync(join(f.ctx.receiptsDir, `${ids[0]}.done`))).toBe(true);
}, 30000);


test("digest contention and thrown effects release all acquired member locks", async () => {
  for (const mode of ["contended", "throw"]) {
    const f = fixture(); f.park("a"); f.park("b");
    const held = mode === "contended" ? acquireObligationLock("b", 0, f.ctx.env) : null;
    if (mode === "throw") f.fx.injectText = () => { throw new Error("effect failed"); };
    try {
      if (mode === "contended") expect(await injectDigest(f.ctx, f.binding, ["b", "a"], f.fx)).toBe(1);
      else await expect(injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).rejects.toThrow("effect failed");
    } finally { held?.release(); }
    expect(f.calls()).toEqual([]);
    for (const id of ["a", "b"]) {
      const lock = acquireObligationLock(id, 0, f.ctx.env);
      expect(lock).not.toBeNull(); lock?.release();
      expect(existsSync(join(f.ctx.spoolDir, `${id}.claim`))).toBe(false);
      expect(existsSync(join(f.ctx.receiptsDir, `${id}.attempted`))).toBe(mode === "throw");
    }
  }
});

test("digest protection observes the real cohort without registering its synthetic ID", async () => {
  const f = fixture(); f.park("a"); f.park("b");
  let probes = 0;
  f.fx.protectInput = (_obs, _band, options) => {
    probes++;
    expect(options?.message).toBeUndefined();
    return null;
  };
  expect(await injectDigest(f.ctx, f.binding, ["a", "b"], f.fx)).toBe(0);
  expect(probes).toBe(1);
  expect(f.calls()).toEqual(["a"]);
});


for(const mode of ["single","digest"] as const)test(`${mode} reparks a pre-effect OpenCode rate refusal and retries once`,async()=>{
 const f=fixture();f.park("a");if(mode==="digest")f.park("b");
 f.ctx.env!.FAKE_COMMAND="opencode";
 writeFileSync(f.ctx.env!.FAKE_FRAME!,readFileSync(join(import.meta.dir,"fixtures/opencode-capture/welcome-124.ansi")));
 const registry=JSON.parse(readFileSync(f.binding.targetRegistry,"utf8"));registry.seats.peer.harness="opencode";
 writeFileSync(f.binding.targetRegistry,JSON.stringify(registry));
 const observe=f.fx.observePane,inject=f.fx.injectText;let limited=true;
 f.fx.observePane=(target)=>({...observe(target) as any,currentCommand:"opencode"});
 f.fx.injectText=(target,text,_bracketed,_permit,admit)=>{
  if(limited)return "rate_limited";
  if(admit&&!admit())return false;
  return inject(target,text);
 };
 const deliver=()=>mode==="single"?redeliver(f.ctx,"a",f.binding,{},f.fx):injectDigest(f.ctx,f.binding,["a","b"],f.fx);
 expect(await deliver()).toBe(1);expect(f.calls()).toEqual([]);
 // A rate refusal with no attempt evidence is the no-effect case: no terminal disposition at all.
 expect(readdirSync(f.ctx.payloadsDir).filter(n=>n.endsWith("-delivery-unconfirmed.md"))).toEqual([]);
 expect(existsSync(join(f.ctx.receiptsDir,"a.unconfirmed"))).toBe(false);
 for(const id of mode==="single"?["a"]:["a","b"]){
  expect(existsSync(join(f.ctx.spoolDir,`${id}.md`))).toBe(true);
  expect(existsSync(join(f.ctx.spoolDir,`${id}.meta.json`))).toBe(true);
  expect(existsSync(join(f.ctx.receiptsDir,`${id}.attempted`))).toBe(false);
 }
 limited=false;
 expect(await deliver()).toBe(0);expect(f.calls()).toEqual(["a"]);
 for(const id of mode==="single"?["a"]:["a","b"])expect(existsSync(join(f.ctx.spoolDir,`${id}.md`))).toBe(false);
});

// tap-67y3s: a terminal redelivery (rc 5, rc 124) gets the same honest disposition as
// the grace deadline — one deterministic sender notice and an .unconfirmed receipt naming it.
// fixture(124) types the wire before its rate refusal: a refusal after an earlier pane
// effect, which is why rc 124 (rate refusal WITH .attempted) is labelled possible.
const unconfirmedNotice = (f: ReturnType<typeof fixture>) => join(f.ctx.payloadsDir, "a-delivery-unconfirmed.md");
const unconfirmedReceipt = (f: ReturnType<typeof fixture>) => JSON.parse(readFileSync(join(f.ctx.receiptsDir, "a.unconfirmed"), "utf8"));
const deliveryNotices = (f: ReturnType<typeof fixture>) => readdirSync(f.ctx.payloadsDir).filter(name => name !== "a.md")
  .filter(name => /^kind: delivery-failed$/m.test(readFileSync(join(f.ctx.payloadsDir, name), "utf8")));

for (const [rc, reason, effect] of [[5, "redelivery_submit_unverified", "possible"], [124, "redelivery_rate_limited", "possible"]] as const)
test(`terminal redelivery rc ${rc}: one deterministic notice and an .unconfirmed receipt, no retry`, async () => {
  const f = fixture(rc); f.park("a");
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(rc);
  expect(f.calls()).toEqual(["a"]);
  expect(deliveryNotices(f)).toEqual(["a-delivery-unconfirmed.md"]);
  const notice = readFileSync(unconfirmedNotice(f), "utf8");
  expect(notice).toMatch(/^to: sender$/m);
  expect(notice).toContain("DELIVERY UNCONFIRMED: a to peer may or may not have reached them.");
  expect(unconfirmedReceipt(f)).toMatchObject({ id: "a", status: "unconfirmed", effect, notice_id: "a-delivery-unconfirmed",
    by: "courier", reason, target: "peer" });
  expect(existsSync(join(f.ctx.receiptsDir, "a.sent"))).toBe(false);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
  const events = readFileSync(f.ctx.eventLog, "utf8");
  expect(events.match(/action=redelivery_submit_unverified handle=peer pane=fixture:0\.0 detail=id=a team=/g)).toHaveLength(1);
  expect(events.match(/action=spool_terminal_delivery_unconfirmed [^\n]*detail=id=a_notice_id=a-delivery-unconfirmed/g)).toHaveLength(1);
  // The entry is gone: a later drain tick has nothing to retry and publishes nothing new.
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(f.calls()).toEqual(["a"]);
  expect(deliveryNotices(f)).toEqual(["a-delivery-unconfirmed.md"]);
});

test("a failed terminal notice still removes the entry, writes no receipt and never retries", async () => {
  const f = fixture(5); f.park("a");
  // A foreign file at the deterministic notice path: the notifier refuses to adopt it.
  const squatter = "---\nid: a-delivery-unconfirmed\nfrom: someone\nto: sender\nkind: discuss\n---\nnot ours\n";
  writeFileSync(unconfirmedNotice(f), squatter);
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5);
  expect(readFileSync(unconfirmedNotice(f), "utf8")).toBe(squatter);
  expect(existsSync(join(f.ctx.receiptsDir, "a.unconfirmed"))).toBe(false);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(false);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
  expect(existsSync(join(f.ctx.payloadsDir, "a.md"))).toBe(true);
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(f.calls()).toEqual(["a"]);
});

test("the terminal disposition is idempotent: a repeat publishes no second notice and keeps the first receipt", async () => {
  const f = fixture(5); f.park("a");
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5);
  const receipt = readFileSync(join(f.ctx.receiptsDir, "a.unconfirmed"), "utf8");
  const input = { id: "a", target: "peer", pane: f.binding.pane, registry: f.binding.targetRegistry,
    reason: "redelivery_submit_unverified", effect: "possible" as const, detail: "repeat" };
  expect(deadline.publishUnconfirmed(f.ctx, input)).toBe("published");
  expect(deadline.publishUnconfirmed(f.ctx, input)).toBe("published");
  expect(deliveryNotices(f)).toEqual(["a-delivery-unconfirmed.md"]);
  expect(readFileSync(join(f.ctx.receiptsDir, "a.unconfirmed"), "utf8")).toBe(receipt);
  expect(readFileSync(f.ctx.eventLog, "utf8").match(/action=spool_terminal_delivery_unconfirmed/g)).toHaveLength(1);
});

test("one terminal failure through the drain orchestrator yields exactly one sender notice", async () => {
  const f = fixture(5); f.park("a");
  const effects = { ...realDrainEffects(f.ctx), readiness: async () => "ready" as const,
    redeliverLocked: (id: string, b: SpoolBinding, force: boolean) => redeliver(f.ctx, id, b, { locked: true, force }, f.fx) };
  expect(await drainOnce(f.ctx, effects, { cap: "8", target: "" })).toBe(5);
  expect(f.calls()).toEqual(["a"]);
  expect(deliveryNotices(f)).toEqual(["a-delivery-unconfirmed.md"]);
  expect(unconfirmedReceipt(f).notice_id).toBe("a-delivery-unconfirmed");
});

test("a terminal attempt whose removal is refused still notifies; the orphan sweep writes the receipt", async () => {
  const f = fixture(5); f.park("a");
  // Hold the metadata lock from the first pane observation (after the pre-submit move) through the removal.
  const observe = f.fx.observePane;
  const held: { lock: ReturnType<typeof acquirePathLock> } = { lock: null };
  f.fx.observePane = target => {
    held.lock ??= acquirePathLock(join(f.ctx.spoolDir, "a.meta.json.lock"), 1000, f.ctx.env);
    return observe(target);
  };
  try {
    expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5);
  } finally { held.lock?.release(); }
  expect(held.lock).not.toBeNull();
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(true);
  expect(deliveryNotices(f)).toEqual(["a-delivery-unconfirmed.md"]);
  // No receipt beside the retained sidecar: it would stop the sweep from archiving it.
  expect(existsSync(join(f.ctx.receiptsDir, "a.unconfirmed"))).toBe(false);
  expect(readFileSync(f.ctx.eventLog, "utf8").match(/action=spool_terminal_delivery_unconfirmed/g)).toHaveLength(1);
  reapStaleSidecars(f.ctx.spoolDir, f.ctx.payloadsDir, f.ctx.env);
  expect(existsSync(join(f.ctx.spoolDir, "a.meta.json"))).toBe(false);
  expect(unconfirmedReceipt(f)).toMatchObject({ id: "a", effect: "possible", reason: "orphaned_spool" });
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(1);
  expect(f.calls()).toEqual(["a"]);
  expect(deliveryNotices(f)).toEqual(["a-delivery-unconfirmed.md"]);
});

test("a published notice whose optional sender wake throws still gets its receipt", async () => {
  const f = fixture(5); f.park("a");
  const registry = JSON.parse(readFileSync(f.binding.targetRegistry, "utf8"));
  registry.seats.sender = { status: "active", pane: "fixture:0.1", pane_id: "%98", harness: "codex" };
  writeFileSync(f.binding.targetRegistry, JSON.stringify(registry));
  let wakes = 0;
  f.ctx.submit = () => { wakes++; throw new Error("sender wake failed"); };
  expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5);
  expect(wakes).toBe(1);
  expect(deliveryNotices(f)).toEqual(["a-delivery-unconfirmed.md"]);
  expect(unconfirmedReceipt(f)).toMatchObject({ notice_id: "a-delivery-unconfirmed", reason: "redelivery_submit_unverified" });
});

test("a pre-effect rc 5 whose removal is refused stays licensed for repark: no terminal notice", async () => {
  const f = fixture(); f.park("a"); f.text("keep this draft");
  writeFileSync(join(f.ctx.home, "input-backups"), "not a directory");
  f.fx.clearInput = () => { throw new Error("clear must not run without a backup"); };
  const observe = f.fx.observePane;
  const held: { lock: ReturnType<typeof acquirePathLock> } = { lock: null };
  f.fx.observePane = target => {
    held.lock ??= acquirePathLock(join(f.ctx.spoolDir, "a.meta.json.lock"), 1000, f.ctx.env);
    return observe(target);
  };
  try {
    expect(await redeliver(f.ctx, "a", f.binding, {}, f.fx)).toBe(5);
  } finally { held.lock?.release(); }
  expect(held.lock).not.toBeNull();
  expect(f.calls()).toEqual([]);
  expect(existsSync(join(f.ctx.receiptsDir, "a.attempted"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.ctx.spoolDir, "a.meta.json"), "utf8")).repark_pending).toBeTruthy();
  expect(deliveryNotices(f)).toEqual([]);
  expect(existsSync(join(f.ctx.receiptsDir, "a.unconfirmed"))).toBe(false);
  // The licensed repark moves it back for another attempt; it is no orphan.
  recoverStrandedReparks(f.ctx.spoolDir, f.ctx.payloadsDir, f.ctx.env);
  expect(existsSync(join(f.ctx.spoolDir, "a.md"))).toBe(true);
});
