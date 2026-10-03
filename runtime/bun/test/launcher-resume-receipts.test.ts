import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessInvocation } from "../src/launcher/adapters";
import { emitResumeTargetReceipts, resolveResumeTarget } from "../src/launcher/resume-identity";
import { buildInvocation, discardReceipts, launchInvocation } from "../src/launcher/invocation";
import { Notices } from "../src/launcher/catalog-notices";
import { UNBOUND_RESUME_IDENTITY, type SessionRecord } from "../src/launcher/types";
import { removeScratchTree } from "./support/scratch";

/**
 * The resume-target receipts (tap-03b71 §1).
 *
 * The S2 oracle compares the builder's output when the DRIVER hands it a sink.
 * That can never answer the question this file exists for: whether production
 * speaks when nobody hands it anything. An optional `receipts?` parameter whose
 * absence means silence would pass every oracle row -- the driver supplies the
 * sink, the rows go green, and no operator ever reads a receipt. The instrument
 * would be agreeing with a defect it had itself filled in.
 *
 * So the load-bearing arm here is the DEFAULT, and it is written against the
 * incumbent's own structure: `build_harness_invocation` calls
 * `resolved_resume_identity(record, emit_receipts=True)` UNCONDITIONALLY when it
 * resolves an unbound identity itself (launcher.py:2371-2376). The `False`
 * default lives one level down, on `resolved_resume_identity`, because that
 * function has two readers and "the gate must not print a second set of
 * resume-target receipts for one launch" (launcher.py:2297).
 */

/** The `sweep/claude/resume/unbound/opus` oracle case, as a record. */
function pickerBound(): SessionRecord {
  return {
    base: "team", cwd: "/wt", harness: "claude", harness_env: {},
    harness_session_id: null, model: "opus", name: "seat",
    quarantined_harness_session_id: null, transcript_path: null,
  } as unknown as SessionRecord;
}

const ENVIRON = { HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent/cfg" };
const PICKER = "tap session: no verified resume transcript; falling through to id-less harness picker";

/** Capture whatever reaches stderr while `body` runs, restoring on failure too. */
function onStderr(body: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { body(); } finally { process.stderr.write = original; }
  return lines.join("").split("\n").filter(Boolean);
}

test("an unbound resume speaks its receipt with NO sink supplied", () => {
  // Mutation guard: restore `receipts?` (absent means silent) and this reds
  // while every oracle row stays green, because the driver passes a sink.
  const said = onStderr(() => {
    buildHarnessInvocation("resume", pickerBound(), null, UNBOUND_RESUME_IDENTITY, ENVIRON);
  });
  expect(said).toContain(PICKER);
});

test("a BOUND identity says nothing: the caller already decided", () => {
  // This is the double-print guard, not a tidiness preference. `planArgv`
  // computes argv for the Python bridge, which prints its own receipts; if the
  // bound path also spoke, one launch would report itself twice.
  const said = onStderr(() => {
    buildHarnessInvocation("resume", pickerBound(), null, "some-id", ENVIRON);
  });
  expect(said).toEqual([]);
});

test("a non-resume action resolves no target and says nothing", () => {
  const said = onStderr(() => {
    buildHarnessInvocation("new", pickerBound(), null, UNBOUND_RESUME_IDENTITY, ENVIRON);
  });
  expect(said).toEqual([]);
});

test("discardReceipts keeps a validation build silent while the real build speaks (tap-2qrt)", () => {
  const said = onStderr(() => {
    buildHarnessInvocation("resume", pickerBound(), null, UNBOUND_RESUME_IDENTITY, ENVIRON, undefined, discardReceipts);
    buildHarnessInvocation("resume", pickerBound(), null, UNBOUND_RESUME_IDENTITY, ENVIRON);
  });
  expect(said.filter(line => line === PICKER)).toHaveLength(1);
});

test("launchInvocation and buildInvocation honor a discarded receipt sink for picker and native-query paths", () => {
  const said = onStderr(() => {
    launchInvocation("resume", pickerBound(), new Notices(), { env: ENVIRON, receipts: discardReceipts });
    buildInvocation("resume", pickerBound(), new Notices(), ENVIRON, null, UNBOUND_RESUME_IDENTITY, "not-a-transcript", discardReceipts);
  });
  expect(said).toEqual([]);
  const spoke = onStderr(() => { launchInvocation("resume", pickerBound(), new Notices(), { env: ENVIRON }); });
  expect(spoke.filter(line => line === PICKER)).toHaveLength(1);
});

test("an explicit silencer is how a caller opts out", () => {
  const said = onStderr(() => {
    buildHarnessInvocation("resume", pickerBound(), null, UNBOUND_RESUME_IDENTITY, ENVIRON,
                           undefined, () => {});
  });
  expect(said).toEqual([]);
});

test("two independent launches each say it: the receipts are NOT deduped across calls (tap-2qrt)", () => {
  // Once per launch comes from validation-only builds discarding their receipts,
  // not from dedup. Dedup state that spans calls -- the `Notices` shape -- would
  // red here: two independent launches each owe their own diagnostic.
  const said = onStderr(() => {
    buildHarnessInvocation("resume", pickerBound(), null, UNBOUND_RESUME_IDENTITY, ENVIRON);
    buildHarnessInvocation("resume", pickerBound(), null, UNBOUND_RESUME_IDENTITY, ENVIRON);
  });
  expect(said.filter(line => line === PICKER)).toHaveLength(2);
});

test("the split-brain line renders its values the way Python repr does", () => {
  // `None` unquoted and `'value'` single-quoted: the incumbent interpolates a
  // raw repr, so a JS-shaped `null`/`"value"` would diverge on the one line an
  // operator reads while their identity and transcript disagree.
  const said: string[] = [];
  emitResumeTargetReceipts(
    { harness_session_id: null, transcript_path: "/t/x.jsonl" } as unknown as SessionRecord,
    { split_brain: true, source: "transcript_path", session_id: "abc", disclosure: null } as never,
    line => said.push(line));
  expect(said[0]).toContain("harness_session_id=None");
  expect(said[0]).toContain("transcript_path='/t/x.jsonl'");
  expect(said[0]).toContain("using transcript_path id=abc");
});

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });

/** A Claude home holding exactly the named session transcripts. */
function claudeHomeWith(...ids: string[]): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "tap-resume-receipts."));
  scratch.push(home);
  const proj = join(home, "projects", "p1");
  mkdirSync(proj, { recursive: true });
  for (const id of ids) writeFileSync(join(proj, `${id}.jsonl`), "{}\n");
  return { TAP_CLAUDE_HOME: home, CLAUDE_HOME: home, HOME: home };
}

function claudeRecord(extra: Partial<SessionRecord>): SessionRecord {
  return { name: "seat", cwd: "/wt", base: "team", harness: "claude", ...extra } as SessionRecord;
}

function receiptsFor(record: SessionRecord, env: NodeJS.ProcessEnv): string[] {
  const said: string[] = [];
  emitResumeTargetReceipts(record, resolveResumeTarget(record, env), line => said.push(line));
  return said;
}

const QUARANTINE_DISCLOSURE = "tap session: resuming quarantined session; attestation previously failed";

test("a quarantined fallback with one stale hsid keeps its disclosure and reports no identity split", () => {
  // One stale field is not two disagreeing fields: with no transcript_path there
  // is nothing for harness_session_id to conflict with, so a split receipt would
  // name `transcript_path=None` and tell the operator to realign nothing.
  const record = claudeRecord({ harness_session_id: "ghost-id", quarantined_harness_session_id: "qid-id" });
  const env = claudeHomeWith("qid-id");
  expect(resolveResumeTarget(record, env)).toMatchObject({ source: "quarantined", session_id: "qid-id", split_brain: false });
  const said = receiptsFor(record, env);
  expect(said).toEqual([QUARANTINE_DISCLOSURE]);
});

test("a quarantined fallback whose hsid and transcript_path really disagree still reports the split", () => {
  const record = claudeRecord({
    harness_session_id: "ghost-a",
    transcript_path: "/snap/projects/p1/ghost-b.jsonl",
    quarantined_harness_session_id: "qid-id",
  });
  const env = claudeHomeWith("qid-id");
  expect(resolveResumeTarget(record, env)).toMatchObject({ source: "quarantined", session_id: "qid-id", split_brain: true });
  const said = receiptsFor(record, env);
  expect(said).toHaveLength(2);
  expect(said[0]).toContain("resume_identity_split");
  expect(said[0]).toContain("harness_session_id='ghost-a'");
  expect(said[1]).toBe(QUARANTINE_DISCLOSURE);
});
