import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recipientRetired, retirementCandidates } from "../src/spool-retired";

const ROOT = join(import.meta.dir, "../../..");
for (const failure of ["none", "receipt", "canonical", "claim", "engine-empty", "engine-invalid", "sender-unbound", "notice-conflict", "notice-long-id"]) test(`drain preserves retirement custody (${failure})`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-retired.")));
  const home = join(root, "repo/.tap/bus"), registry = join(home, "registry.json");
  for (const dir of ["payloads", "receipts", "spool"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, ".tap-bus-authority"), "");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    sender: { instance: "sender|new", registered_at: "2026-09-07T11:52:03Z", status: "active", pane: "sender:0.0", pane_id: "%88", harness: "codex" },
    target: { instance: "target|new", registered_at: "2026-09-07T11:52:03Z", status: "active", pane: "sess:0.0", pane_id: "%107" },
  } }));
  // Born live: an absent marker opens no legacy door, so the team is enrolled.
  mkdirSync(join(root, "index"), { recursive: true });
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    fixture: { root: join(root, "repo"), registry_location: registry, state: "registered" },
  } }));
  const conflictCase = failure === "notice-conflict" || failure === "notice-long-id";
  const bodies: Record<string, string> = {};
  for (const [fixtureId, instance, policy] of [["old-stamped", "target|old", "standard"], ["old-auto-stamped", "target|old", "autosettle"], ["old-legacy", "", "autosettle"]]) {
    const id = failure === "notice-long-id" ? fixtureId!.padEnd(180, "x") : fixtureId;
    const body = `---\nid: ${id}\nfrom: sender\nto: target\nkind: discuss\npath: ${home}/payloads/${id}.md\nreply: expected\n${instance ? `recipient_instance: ${instance}\n` : ""}${failure === "sender-unbound" ? "" : "sender_instance: sender|old\n"}---\nPreserve original ${id} body.\n`;
    bodies[id!] = body;
    if (policy === "standard") {
      writeFileSync(join(home, "receipts", id + ".attempted"), '{"effect":"possible"}');
      writeFileSync(join(home, "receipts", id + ".unconfirmed"), '{"status":"unconfirmed"}');
    }
    writeFileSync(join(home, "spool", id + ".md"), body);
    writeFileSync(join(home, "spool", id + ".meta.json"), JSON.stringify({ id, target: "target", target_registry: registry,
      team: "fixture", to_team: "", pane: "sess:0.0", pane_id: "%192", policy, reason: policy === "standard" ? "pending-input" : "auto-settle", reason_class: "busy",
      first_spooled_epoch: policy === "standard" ? 1788623678 : 1788624181,
      deadline_epoch: policy === "standard" ? 1788623738 : 1788624481, escalated_at: "2026-09-05T16:08:05Z",
      waiter_lifetime: policy === "standard" ? "grace-window" : "autosettle-hold", attempts: policy === "standard" ? 1 : 0 }));
  }
  if (failure === "receipt") {
    renameSync(join(home, "receipts"), join(home, "receipt-evidence"));
    writeFileSync(join(home, "receipts"), "blocked receipt directory");
  }
  for (const id of Object.keys(bodies)) {
    if (failure === "canonical") writeFileSync(join(home, "payloads", id + ".md"), "conflicting canonical");
    if (conflictCase) writeFileSync(join(home, "payloads", id + "-recipient-retired.md"), "unrelated canonical notice");
    if (failure === "claim") writeFileSync(join(home, "spool", id + ".claim"), "another owner");
  }
  const env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(root, "index"), TAP_LOCK_DIR: join(root, "locks"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SELF: undefined, TMUX: undefined, TMUX_PANE: undefined };
  try {
    // The candidate reader is now in-process. Missing/invalid transport evidence
    // is tested at the new native engine completion boundary, before retirement.
    const broken = failure.startsWith("engine-") ? `eval "$(declare -f tap_bun_call | sed '1s/tap_bun_call/real_bun_call/')"; tap_bun_call() { if [ "$1" = spool-drain ]; then ${failure === "engine-invalid" ? "printf 'spool-engine\\tinvalid\\n'; " : ""}return 0; else real_bun_call "$@"; fi; }; ` : "";

    if (failure === "notice-conflict") {
      // Simulate interruption after publication, before the shell removes custody.
      const withdraw = () => Bun.spawnSync(["bun", join(ROOT, "runtime/bun/src/spool-retired.ts"),
        "withdraw", home, registry, "old-stamped"], { env, stdout: "pipe", stderr: "pipe" });
      expect(withdraw().exitCode).toBe(0);
      const published = readdirSync(join(home, "payloads")).sort();
      const receipt = readFileSync(join(home, "receipts/old-stamped.cancelled"));
      const selectedId = JSON.parse(receipt.toString()).notice_id;
      const selectedPath = join(home, "payloads", selectedId + ".md");
      const selectedBytes = readFileSync(selectedPath);
      const conflict = join(home, "payloads/old-stamped-recipient-retired.md");
      // Selection survives a crash before publication as well as loss of the
      // payload after a possible wake. Neither may allocate another identity.
      rmSync(selectedPath);
      expect(withdraw().exitCode).toBe(0);
      expect(readFileSync(selectedPath)).toEqual(selectedBytes);
      const attemptedPath = join(home, "payloads", selectedId + ".attempts");
      writeFileSync(attemptedPath, "prior possible notice delivery");
      writeFileSync(selectedPath, "new selected-path conflict");
      expect(withdraw().exitCode).toBe(2);
      expect(readFileSync(selectedPath, "utf8")).toBe("new selected-path conflict");
      expect(existsSync(join(home, "spool/old-stamped.meta.json"))).toBe(true);
      rmSync(selectedPath);
      const originalRegistry = readFileSync(registry, "utf8");
      const returnedSender = JSON.parse(originalRegistry);
      returnedSender.seats.sender.instance = "sender|old";
      writeFileSync(registry, JSON.stringify(returnedSender));
      rmSync(conflict);
      expect(withdraw().exitCode).toBe(0);
      expect(existsSync(conflict)).toBe(false);
      expect(readdirSync(join(home, "payloads")).sort()).toEqual([...published.filter(name => name !== "old-stamped-recipient-retired.md"), selectedId + ".attempts"].sort());
      expect(readFileSync(selectedPath)).toEqual(selectedBytes);
      expect(readFileSync(attemptedPath, "utf8")).toBe("prior possible notice delivery");
      expect(readFileSync(join(home, "receipts/old-stamped.cancelled"))).toEqual(receipt);
      writeFileSync(registry, originalRegistry);
      writeFileSync(conflict, "unrelated canonical notice");
    }
    const result = Bun.spawnSync(["bash", "-c",
      '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; ' + broken + 'spool_drain_fixture_once "$3" "" target "$2"',
      // An hour past the fixtures' deadlines (1788624481) and far inside the 72 h park retention:
      // retirement is under test here, not age expiry, which would otherwise end every
      // fixture as park_expired once the real clock passes the fixtures' 2026-09-07 epochs.
      "_", join(ROOT, "skills/tap/scripts/smoke/runtime-helpers.sh"), registry, "1788628081"], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(failure.startsWith("engine-") ? 1 : 0);
    for (const [id, body] of Object.entries(bodies)) {
      const receipt = join(home, "receipts", id + ".cancelled");
      if (id.startsWith("old-legacy") || (failure !== "none" && failure !== "sender-unbound" && !conflictCase)) {
        expect(existsSync(receipt)).toBe(false);
        expect(readFileSync(join(home, "spool", id + ".md"), "utf8")).toBe(body);
        expect(existsSync(join(home, "spool", id + ".meta.json"))).toBe(true);
        if (failure === "canonical") expect(readFileSync(join(home, "payloads", id + ".md"), "utf8")).toBe("conflicting canonical");
        if (failure === "claim") expect(readFileSync(join(home, "spool", id + ".claim"), "utf8")).toBe("another owner");
        continue;
      }
      expect(existsSync(receipt)).toBe(true);
      expect(JSON.parse(readFileSync(receipt, "utf8")).reason).toBe("instance_retired");
      expect(readFileSync(join(home, "payloads", id + ".md"), "utf8")).toBe(body);
      expect(existsSync(join(home, "spool", id + ".meta.json")), result.stderr.toString() + " id=" + id).toBe(false);
      expect(existsSync(join(home, "receipts", id + ".done"))).toBe(false);
      if (failure === "sender-unbound") {
        expect(existsSync(join(home, "payloads", id + "-recipient-retired.md"))).toBe(false);
        continue;
      }
      const noticeName = JSON.parse(readFileSync(receipt, "utf8")).notice_id + ".md";
      if (conflictCase) expect(readFileSync(join(home, "payloads", id + "-recipient-retired.md"), "utf8")).toBe("unrelated canonical notice");
      const notice = readFileSync(join(home, "payloads", noticeName), "utf8");
      expect(notice).toContain("Recipient instance retired");
      expect(notice).toContain("recipient_instance: sender|old");
      expect(existsSync(join(home, "payloads", id + "-recipient-retired.attempts"))).toBe(false);
      expect(notice).toContain("does not establish whether an earlier attempt reached");
      if (id.startsWith("old-stamped")) {
        expect(readFileSync(join(home, "receipts", id + ".unconfirmed"), "utf8")).toBe('{"status":"unconfirmed"}');
        expect(readFileSync(join(home, "receipts", id + ".attempted"), "utf8")).toBe('{"effect":"possible"}');
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

const original = "---\nid: old\nfrom: sender\nto: target\nkind: discuss\npath: /bus/payloads/old.md\nrecipient_instance: target|old\n---\nbody\n";
const meta = { id: "old", target: "target", target_registry: "/registry", to_team: "fixture", first_spooled_epoch: 1788623678 };
const row = { instance: "target|new", registered_at: "2026-09-07T11:52:03Z" };
const registry = (target: unknown = row, extra = {}) => ({ schema: "0.20", team: { name: "fixture" }, seats: { target, ...extra } });

test("retirement receipt predicates require a regular file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-retired-kind.")));
  const home = join(root, "bus"), registryPath = join(home, "registry.json"), id = "old";
  for (const dir of ["payloads", "receipts", "spool"]) mkdirSync(join(home, dir), { recursive: true });
  const raw = `---\nid: ${id}\nfrom: sender\nto: target\nto_team: fixture\nkind: discuss\npath: ${join(home, "payloads", `${id}.md`)}\nreply: expected\nrecipient_instance: target|old\n---\nbody\n`;
  writeFileSync(join(home, "spool", `${id}.md`), raw);
  writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, target: "target", target_registry: registryPath,
    to_team: "fixture", first_spooled_epoch: 1788623678 }));
  writeFileSync(registryPath, JSON.stringify(registry()));
  const marker = join(home, "receipts", `${id}.done`), directory = join(root, "directory");
  mkdirSync(directory);
  try {
    mkdirSync(marker);
    expect(retirementCandidates(home, registryPath)).toEqual([id]);
    rmSync(marker, { recursive: true }); symlinkSync(directory, marker);
    expect(retirementCandidates(home, registryPath)).toEqual([id]);
    rmSync(marker); writeFileSync(marker, "settled\n");
    expect(retirementCandidates(home, registryPath)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retirement requires a newer row and preserves matching or adopted instances", () => {
  expect(recipientRetired(meta, original, registry(), "/local")).toBe(true);
  expect(recipientRetired(meta, original.replace("recipient_instance: target|old\n", ""), registry(), "/local")).toBe(false);
  expect(recipientRetired(meta, original, registry({ ...row, instance: "target|old" }), "/local")).toBe(false);
  expect(recipientRetired(meta, original.replace("to: target", "to: target\nto_adopted_from: predecessor"), registry(), "/local")).toBe(false);
  expect(recipientRetired(meta, original, registry({ ...row, registered_at: "2026-09-04T00:00:00Z" }), "/local")).toBe(false);
  expect(recipientRetired(meta, original, registry(row, { successor: { adopted_handles: ["target"], adopted_instances: { target: "target|old" } } }), "/local")).toBe(false);
});

test("an old-format recipient registry is never withdrawal authority", () => {
  expect(recipientRetired(meta, original, registry(), "/local")).toBe(true);
  const { schema: _schema, ...schemaless } = registry();
  expect(recipientRetired(meta, original, schemaless, "/local")).toBe(false);
  expect(recipientRetired(meta, original, { ...registry(), agents: {} }, "/local")).toBe(false);
});

test("missing, malformed, future and cross-team evidence cannot authorize withdrawal", () => {
  for (const unknown of [undefined, null, {}, { ...row, instance: "" }, { ...row, registered_at: "unknown" },
    { ...row, registered_at: "2100-01-01T00:00:00Z" }]) {
    // Explicit undefined needs an absent row, not the fixture factory's default.
    const doc = unknown === undefined ? { schema: "0.20", team: { name: "fixture" }, seats: {} } : registry(unknown);
    expect(recipientRetired(meta, original, doc, "/local")).toBe(false);
  }
  expect(recipientRetired({ ...meta, first_spooled_epoch: null }, original, registry(), "/local")).toBe(false);
  expect(recipientRetired({ ...meta, to_team: "other" }, original, registry(), "/local")).toBe(false);
  expect(recipientRetired(meta, original.replace("to: target", "to: target\nto_team: other"), registry(), "/local")).toBe(false);
  expect(recipientRetired({ ...meta, target: "different" }, original, registry(), "/local")).toBe(false);
  expect(recipientRetired(meta, original.replace("id: old", "id: mismatch"), registry(), "/local")).toBe(false);
  expect(recipientRetired({ ...meta, to_team: "" }, original, registry(), "/local")).toBe(false);
});


test("a stale candidate is revalidated and delivery receipts are never withdrawn", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-retirement-race."));
  const home = join(root, "bus"), path = join(home, "registry.json");
  for (const dir of ["spool", "payloads", "receipts"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, ".tap-bus-authority"), "");
  writeFileSync(join(home, "spool/old.md"), original);
  writeFileSync(join(home, "spool/old.meta.json"), JSON.stringify({ ...meta, target_registry: path }));
  writeFileSync(path, JSON.stringify(registry()));
  const env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(root, "index"), TAP_LOCK_DIR: join(root, "locks") };
  try {
    expect(retirementCandidates(home, path)).toEqual(["old"]);
    renameSync(join(home, "spool/old.md"), join(root, "outside.md"));
    symlinkSync(join(root, "outside.md"), join(home, "spool/old.md"));
    expect(retirementCandidates(home, path)).toEqual([]);
    rmSync(join(home, "spool/old.md"));
    renameSync(join(root, "outside.md"), join(home, "spool/old.md"));
    writeFileSync(path, JSON.stringify(registry({ ...row, instance: "target|old" })));
    const result = Bun.spawnSync(["bash", "-c",
      '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture retired old "$2"', "_",
      join(ROOT, "skills/tap/scripts/smoke/runtime-helpers.sh"), path], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, "receipts/old.cancelled"))).toBe(false);
    expect(readFileSync(join(home, "spool/old.md"), "utf8")).toBe(original);
    writeFileSync(path, JSON.stringify(registry()));
    for (const extension of ["done", "sent", "harness-queued"]) {
      const receipt = join(home, "receipts", `old.${extension}`);
      writeFileSync(receipt, "existing evidence");
      expect(retirementCandidates(home, path)).toEqual([]);
      expect(readFileSync(receipt, "utf8")).toBe("existing evidence");
      rmSync(receipt);
    }
    const spooled = Buffer.concat([Buffer.from(original), Buffer.from([0xff])]);
    const conflicting = Buffer.concat([Buffer.from(original), Buffer.from([0xfe])]);
    writeFileSync(join(home, "spool/old.md"), spooled);
    writeFileSync(join(home, "payloads/old.md"), conflicting);
    const conflict = Bun.spawnSync(["bash", "-c",
      '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture retired old "$2"', "_",
      join(ROOT, "skills/tap/scripts/smoke/runtime-helpers.sh"), path], { env, stdout: "pipe", stderr: "pipe" });
    expect(conflict.exitCode).toBe(1);
    expect(existsSync(join(home, "receipts/old.cancelled"))).toBe(false);
    expect(readFileSync(join(home, "spool/old.md"))).toEqual(spooled);
    expect(readFileSync(join(home, "payloads/old.md"))).toEqual(conflicting);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a withdrawal receipt is not a retirement receipt — the consumer needs the courier marker", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-retired-withdrawal."));
  const home = join(root, "bus"), path = join(home, "registry.json");
  for (const dir of ["spool", "payloads", "receipts"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, ".tap-bus-authority"), "");
  writeFileSync(join(home, "spool/old.md"), original);
  writeFileSync(join(home, "spool/old.meta.json"), JSON.stringify({ ...meta, target_registry: path }));
  writeFileSync(path, JSON.stringify(registry()));
  const receipt = join(home, "receipts/old.cancelled");
  try {
    writeFileSync(receipt, JSON.stringify({ id: "old", status: "cancelled", via: "withdrawn", by: "sa", at: "2026-09-16T12:00:00Z" }));
    expect(retirementCandidates(home, path)).toEqual([]);
    writeFileSync(receipt, JSON.stringify({ id: "old", status: "cancelled", at: "2026-09-16T12:00:00Z", by: "courier", via: "cancelled", reason: "instance_retired", target: "target", target_status: "retired", registry_checked: path, source: "spool" }));
    expect(retirementCandidates(home, path)).toEqual(["old"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const length of [235, 239, 245]) test(`cancelled retirement retries converge at ${length}-byte spool ID boundary`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-retired-limit.")));
  const home = join(root, "bus"), registryPath = join(home, "registry.json");
  for (const dir of ["spool", "payloads", "receipts"]) mkdirSync(join(home, dir), { recursive: true });
  // .meta.json and .cancelled are ten bytes: 245 is the original custody
  // filename limit. Resume durable cancellation to isolate notice publication.
  const id = "x".repeat(length);
  const raw = `---\nid: ${id}\nfrom: sender\nto: target\nkind: discuss\nreply: expected\npath: ${home}/payloads/${id}.md\nsender_instance: sender|old\nrecipient_instance: target|old\n---\nbody\n`;
  writeFileSync(join(home, "spool", id + ".md"), raw);
  writeFileSync(join(home, "spool", id + ".meta.json"), JSON.stringify({ id }));
  const receiptPath = join(home, "receipts", id + ".cancelled");
  writeFileSync(receiptPath, JSON.stringify({ id, by: "courier", reason: "instance_retired", source: "spool" }));
  writeFileSync(registryPath, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { sender: { instance: "sender|new" } } }));
  const env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(root, "index"), TAP_LOCK_DIR: join(root, "locks") };
  try {
    const withdraw = () => Bun.spawnSync(["bun", join(ROOT, "runtime/bun/src/spool-retired.ts"), "withdraw", home, registryPath, id],
      { env, stdout: "pipe", stderr: "pipe" });
    const first = withdraw();
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(first.stdout.toString()).toBe("withdrawn\n");
    const receipt = readFileSync(receiptPath);
    const noticeId = JSON.parse(receipt.toString()).notice_id;
    expect(noticeId).toMatch(/^recipient-retired-[a-f0-9]{64}$/);
    expect(readFileSync(join(home, "payloads", noticeId + ".md"), "utf8")).toContain("recipient_instance: sender|old");
    expect(withdraw().exitCode).toBe(0);
    expect(readFileSync(receiptPath)).toEqual(receipt);
    const wrapped = Bun.spawnSync(["bash", "-c",
      '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture retired "$2" "$3"',
      "bash", join(ROOT, "skills/tap/scripts/smoke/runtime-helpers.sh"), id, registryPath], { env, stdout: "pipe", stderr: "pipe" });
    expect(wrapped.exitCode, wrapped.stderr.toString()).toBe(0);
    expect(existsSync(join(home, "spool", id + ".md"))).toBe(false);
    expect(existsSync(join(home, "spool", id + ".meta.json"))).toBe(false);
    expect(readdirSync(join(home, "payloads")).sort()).toEqual([id + ".md", noticeId + ".md"].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
