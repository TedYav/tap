// G1 dark argv differential: Bun planner vs frozen Python build_harness_invocation.
// Captured before the Python bridge was retired; mutation controls remain below.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AGENT_FAMILIES } from "../src/verbs/team";
import {
  ADAPTER_HARNESSES,
  argvCellId,
  cursorResumeIdFirst,
  cursorTrustAuthorizedWorktree,
  HERMES_BIN,
  planArgv,
  setCursorResumeIdFirst,
  setCursorTrustAuthorizedWorktree,
} from "../src/launcher/adapters";


const DISCRIMINATING_CELL = "argv:cursor/new/hsid=ghost-id-0000/model=null/prompt=null";
const TRUST_CELL = "argv:cursor/new/hsid=null/model=null/prompt=null";

/**
 * Authorized deviations from the frozen Python oracle (tap-we6b rework).
 * A stored cursor id whose chat store never persisted is refused upstream, so
 * a null resolved identity emits NO `--resume`: the Python bare picker
 * fallback is gone on purpose. Each cell is listed by id with its reason —
 * the closed-set test below fails when a NEW divergence appears without a
 * named entry, so the list cannot silently grow (the tap-j86wd lesson).
 */
const AUTHORIZED_DEVIATIONS = new Map<string, string>([
  ["argv:cursor/resume/hsid=null/model=null/prompt=null", "bare --resume picker removed: null identity emits nothing"],
  ["argv:cursor/resume/hsid=null/model=null/prompt=go", "bare --resume picker removed: null identity emits nothing"],
  ["argv:cursor/resume/hsid=null/model=sonnet/prompt=null", "bare --resume picker removed: null identity emits nothing"],
  ["argv:cursor/resume/hsid=null/model=sonnet/prompt=go", "bare --resume picker removed: null identity emits nothing"],
]);

/** The deviation's expected bytes: the Python row minus its one bare `--resume`. */
function deviationArgv(row: OracleRow): string[] | undefined {
  if (!row.argv) return row.argv;
  const at = row.argv.indexOf("--resume");
  if (at < 0) return row.argv;
  return [...row.argv.slice(0, at), ...row.argv.slice(at + 1)];
}

type OracleRow = {
  harness: string;
  action: string;
  model: string | null;
  hsid: string | null;
  prompt: string | null;
  argv?: string[];
  refusal?: string;
};

function loadOracle(): OracleRow[] {
  return JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/launcher-g1-adapters-oracle.json"), "utf8")).cases;
}

function comparable(row: OracleRow): { argv?: string[]; refusal?: string } {
  if (row.refusal) return { refusal: row.refusal };
  return { argv: expectedArgv(row) };
}

/**
 * The Python row, verbatim. It used to be the Python row PLUS a spliced
 * `--trust`, under the comment "tap-nxvht addendum: Python still omits
 * `--trust`" -- which is how a differential that reported 96 byte-identical rows
 * could sit on top of a real divergence for four weeks. The expected side was
 * being edited to match the port, so the one test that could have caught the
 * difference was the test hiding it.
 *
 * `36df76b16` gave the incumbent the flag (tap-j86wd, leader's ruling (a)), so
 * the compensation is not merely unnecessary now -- it DOUBLES the token. This
 * function stays, rather than being inlined away, because the shape is worth
 * keeping visible: the moment it grows a second branch, ask whether the
 * incumbent should have changed instead.
 */
function expectedArgv(row: OracleRow): string[] | undefined {
  return row.argv;
}

describe("G1 adapters argv differential", () => {
  afterEach(() => {
    setCursorResumeIdFirst(true);
    setCursorTrustAuthorizedWorktree(true);
  });

  test("AGENT_FAMILIES is the one harness set", () => {
    expect(AGENT_FAMILIES).toEqual(new Set(ADAPTER_HARNESSES));
  });

  test("HERMES_BIN is the launcher.py literal, not a derivation", () => {
    expect(HERMES_BIN).toBe("hermes");
  });

  test("96 python oracle rows: 92 byte-identical + the 4 named tap-we6b deviations", () => {
    const oracle = loadOracle();
    expect(oracle.length).toBe(96);
    const mismatches: string[] = [];
    for (const row of oracle) {
      const id = argvCellId(row);
      const bun = planArgv(row);
      const py = comparable(row);
      const expected = AUTHORIZED_DEVIATIONS.has(id) ? { argv: deviationArgv(row) } : py;
      if (JSON.stringify(bun) !== JSON.stringify(expected)) {
        mismatches.push(
          `${id}\n  expected ${JSON.stringify(expected)}\n  bun      ${JSON.stringify(bun)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("the authorized deviation list is exactly the cells that diverge from Python", () => {
    const oracle = loadOracle();
    const diverging = oracle
      .filter((row) => JSON.stringify(planArgv(row)) !== JSON.stringify(comparable(row)))
      .map(argvCellId)
      .sort();
    expect(diverging).toEqual([...AUTHORIZED_DEVIATIONS.keys()].sort());
  });

  test("cursorResumeIdFirst mutant is present and reds the discriminating cell", () => {
    const oracle = loadOracle();
    const cell = oracle.find(
      (row) => argvCellId(row) === DISCRIMINATING_CELL,
    );
    expect(cell).toBeDefined();
    expect(cursorResumeIdFirst).toBe(true);
    const healthy = planArgv(cell!);
    expect(healthy).toEqual(comparable(cell!));
    expect(healthy.argv).toContain("--resume");
    expect(healthy.argv).toContain("ghost-id-0000");

    setCursorResumeIdFirst(false);
    expect(cursorResumeIdFirst).toBe(false);

    const mutant = planArgv(cell!);
    expect(mutant).not.toEqual(comparable(cell!));
    expect(mutant.argv ?? []).not.toContain("--resume");
    expect(mutant.argv ?? []).not.toContain("ghost-id-0000");
  });

  test("mutant leaves sibling cursor cells identical", () => {
    const oracle = loadOracle();
    setCursorResumeIdFirst(false);
    expect(cursorResumeIdFirst).toBe(false);
    const siblings = oracle.filter((row) => {
      if (row.harness !== "cursor") return false;
      return argvCellId(row) !== DISCRIMINATING_CELL
        && !(row.action === "new" && row.hsid === "ghost-id-0000");
    });
    expect(siblings.length).toBeGreaterThan(0);
    for (const row of siblings) {
      // tap-we6b rework rows: the flag no longer gates any token there (a null
      // identity emits nothing on both sides), so compare against the deviation
      // bytes instead of the retired Python row.
      const expected = AUTHORIZED_DEVIATIONS.has(argvCellId(row))
        ? { argv: deviationArgv(row) }
        : comparable(row);
      expect(planArgv(row)).toEqual(expected);
    }
  });

  test("authorized explicit-worktree cursor argv includes --trust", () => {
    const oracle = loadOracle();
    const cell = oracle.find((row) => argvCellId(row) === TRUST_CELL);
    expect(cell).toBeDefined();
    const bun = planArgv(cell!);
    expect(bun.argv).toEqual(expectedArgv(cell!));
    const workspaceAt = bun.argv!.indexOf("--workspace");
    expect(bun.argv![workspaceAt + 1]).toBe("/tmp/wt");
    expect(bun.argv![workspaceAt + 2]).toBe("--trust");
  });

  test("drop --trust mutant reds the authorized workspace cell", () => {
    const oracle = loadOracle();
    const cell = oracle.find((row) => argvCellId(row) === TRUST_CELL);
    expect(cell).toBeDefined();
    expect(cursorTrustAuthorizedWorktree).toBe(true);
    const healthy = planArgv(cell!);
    expect(healthy.argv).toContain("--trust");
    expect(healthy).toEqual(comparable(cell!));

    setCursorTrustAuthorizedWorktree(false);
    expect(cursorTrustAuthorizedWorktree).toBe(false);
    const mutant = planArgv(cell!);
    expect(mutant.argv ?? []).not.toContain("--trust");
    expect(mutant).not.toEqual(comparable(cell!));
    // The mutant lands on the incumbent's argv MINUS the trust token -- i.e.
    // dropping the port's flag reintroduces exactly the divergence tap-j86wd
    // closed, and nothing else. This line used to read `toEqual(cell!.argv)`,
    // which was true only while the incumbent omitted the flag; stating it as a
    // difference of one named token keeps the assertion honest whichever side
    // changes next.
    expect(mutant.argv).toEqual(cell!.argv!.filter((token) => token !== "--trust"));
  });

  test("empty cwd is not an authorized worktree and does not get --trust", () => {
    const bun = planArgv({
      harness: "cursor",
      action: "new",
      model: null,
      hsid: null,
      prompt: null,
      cwd: "",
    });
    expect(bun.argv).toContain("--workspace");
    expect(bun.argv ?? []).not.toContain("--trust");
  });

  test("tap-we6b rework: a null cursor resume emits no --resume at all", () => {
    const bun = planArgv({ harness: "cursor", action: "resume", model: null, hsid: null, prompt: null });
    expect(bun.argv ?? []).not.toContain("--resume");
    expect(bun.refusal).toBeUndefined();
  });

  test("tap-we6b rework: a live cursor id still resumes exactly", () => {
    const bun = planArgv({ harness: "cursor", action: "resume", model: null, hsid: "ghost-id-0000", prompt: null });
    const at = bun.argv!.indexOf("--resume");
    expect(at).toBeGreaterThan(0);
    expect(bun.argv![at + 1]).toBe("ghost-id-0000");
    expect(bun.argv!.filter((token) => token === "--resume")).toHaveLength(1);
  });
});
