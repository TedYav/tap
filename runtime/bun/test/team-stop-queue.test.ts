import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamStopQueueSummary } from "../src/team-stop-queue";

test("terminal receipts suppress seat warnings independently; counting never writes", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-stop-queue-"));
  const payloads = join(root, "payloads"), receipts = join(root, "receipts");
  mkdirSync(payloads); mkdirSync(receipts);
  try {
    for (const id of ["live", "done", "cancelled", "resent"]) {
      writeFileSync(join(payloads, `${id}.md`), `---\nto: alice\n---\nbody\n`);
    }
    for (const terminal of ["done", "cancelled", "resent"]) writeFileSync(join(receipts, `${terminal}.${terminal}`), "{}");
    writeFileSync(join(receipts, "live.sent"), "{}");
    const before = [payloads, receipts].flatMap(dir => readdirSync(dir).map(name => [join(dir, name), readFileSync(join(dir, name), "utf8")]));
    const summary = () => teamStopQueueSummary(payloads, receipts, "demo", ["alice", "bob"]);
    expect(summary()).toEqual({ unsettled: 2, counts: new Map([["alice", 1], ["bob", 0]]) });
    for (const [path, content] of before) expect(readFileSync(path!, "utf8")).toBe(content!);
    for (const terminal of ["done", "cancelled", "resent"]) {
      const path = join(receipts, `${terminal}.${terminal}`);
      rmSync(path);
      expect(summary().counts.get("alice")).toBe(2);
      writeFileSync(path, "{}");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team selection, bus totals, hidden payloads and sparse buses preserve existing counts", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-stop-queue-"));
  const payloads = join(root, "payloads"), receipts = join(root, "receipts");
  try {
    expect(teamStopQueueSummary(payloads, receipts, "demo", ["alice"])).toEqual({ unsettled: 0, counts: new Map([["alice", 0]]) });
    expect(readdirSync(root)).toEqual([]);
    mkdirSync(payloads); mkdirSync(receipts);
    const messages: Record<string, string> = {
      local: "to: demo/alice\nto_team: demo\n",
      foreign: "to: other/alice\n",
      wrongTeam: "to: alice\nto_team: other\n",
      unknown: "to: nobody\n",
      malformed: "not an envelope\n",
      ".hidden": "to: alice\n",
      _internal: "to: alice\n",
      unicodeSpace: "to:\u0085alice\n",
      unicodeLine: "body\u2028to: alice\n",
    };
    for (const [id, text] of Object.entries(messages)) writeFileSync(join(payloads, `${id}.md`), text);
    expect(teamStopQueueSummary(payloads, receipts, "demo", ["alice"])).toEqual({ unsettled: 7, counts: new Map([["alice", 3]]) });
    // A total-only no-op does not need to open payload bodies.
    mkdirSync(join(payloads, "directory.md"));
    expect(teamStopQueueSummary(payloads, receipts, "demo").unsettled).toBe(8);
    // Historic seat counts accept an existing receipt directory; bus totals
    // require a regular file, just as the old Bash -f check did.
    mkdirSync(join(receipts, "directory.done"));
    expect(teamStopQueueSummary(payloads, receipts, "demo", ["alice"]).unsettled).toBe(8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The retired smoke team-stop-terminal-counts.test.sh arm: the CLI's first line
// is a Bash integer (`[ "$summary" = "$expected" ]`), not terminal presentation,
// so a forced-color terminal must not decorate it. The in-process tests above own
// the counting; this owns the OUTPUT CONTRACT at the process boundary.
test("the CLI count stays a plain integer under FORCE_COLOR", () => {
  for (const [expected, payload] of [[0, null], [1, "---\nto: alice\n---\nbody\n"]] as const) {
    const root = mkdtempSync(join(tmpdir(), "tap-stop-queue-cli-"));
    try {
      const payloads = join(root, "payloads"), receipts = join(root, "receipts");
      mkdirSync(payloads); mkdirSync(receipts);
      if (payload !== null) writeFileSync(join(payloads, "live.md"), payload);
      const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/team-stop-queue.ts"), payloads, receipts, "demo"],
        { env: { ...process.env, FORCE_COLOR: "1" } });
      expect(proc.exitCode, `the CLI failed on the ${expected}-row bus`).toBe(0);
      expect(proc.stdout.toString(), "a forced-color terminal must not decorate this machine-readable numeric line").toBe(`${expected}\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
