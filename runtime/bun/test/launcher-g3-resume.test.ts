// G3 resume-identity differential vs frozen Python, frozen TAP_CLAUDE_HOME.
// Also carries G2's 14-row oracle guard (that assertion lives in the G2 test).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { claudeHome, planResume } from "../src/launcher/resume-identity";
import type { SessionRecord } from "../src/launcher/types";
import { removeScratchTree } from "./support/scratch";


const GHOST_CELL = "GHOST";
const PICKER_SPLIT_CELL = "PICKER_SPLIT";
const G3_ORACLE_IDS = [
  "GHOST",
  "ACTING",
  "TPATH",
  "QUARANTINE",
  "SPLIT",
  "CURSOR_ID",
  "CLAUDE_NONE",
  "OPENCODE_NONE",
  "UNKNOWN",
  "PICKER_SPLIT",
] as const;

type OracleRow = {
  id: string;
  target: string | null;
  source: string;
  split_brain: boolean;
  disclosure: string | null;
};

/**
 * Intentional divergences from the frozen Python oracle (tap-e3zs). The Python
 * quarantined branch flags a split for any nonempty identity field, so its
 * QUARANTINE row (one stale hsid, no transcript_path) over-fires: one stale
 * field is not two disagreeing fields. Bun reports split_brain only on an actual
 * hsid/transcript_path disagreement. Target, source and disclosure stay at parity.
 */
const CORRECTED_FROM_ORACLE: Record<string, Partial<Pick<OracleRow, "split_brain">>> = {
  QUARANTINE: { split_brain: false },
};

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

function freezeClaudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tap-g3-claude."));
  scratch.push(home);
  const proj = join(home, "projects", "p1");
  mkdirSync(proj, { recursive: true });
  for (const id of ["live-id", "tpath-id", "qid-id"]) {
    writeFileSync(join(proj, `${id}.jsonl`), "{}\n");
  }
  return home;
}

function frozenEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAP_CLAUDE_HOME: home,
    CLAUDE_HOME: home,
  };
}

function loadOracle(_home: string): OracleRow[] {
  return JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/launcher-g3-resume-oracle.json"), "utf8")).cases;
}

function bunRecord(id: string): SessionRecord {
  const base = {
    name: "seat",
    cwd: "/tmp/wt",
    base: "team",
  };
  switch (id) {
    case "GHOST":
      return { ...base, harness: "claude", harness_session_id: "ghost-id-0000" };
    case "ACTING":
      return { ...base, harness: "claude", harness_session_id: "live-id" };
    case "TPATH":
      return {
        ...base,
        harness: "claude",
        harness_session_id: "ghost-id-0000",
        transcript_path: "/snap/projects/p1/tpath-id.jsonl",
      };
    case "QUARANTINE":
      return {
        ...base,
        harness: "claude",
        harness_session_id: "ghost-id-0000",
        quarantined_harness_session_id: "qid-id",
      };
    case "SPLIT":
      return {
        ...base,
        harness: "claude",
        harness_session_id: "live-id",
        transcript_path: "/snap/projects/p1/tpath-id.jsonl",
      };
    case "CURSOR_ID":
      return { ...base, harness: "cursor", harness_session_id: "cursor-id" };
    case "CLAUDE_NONE":
      return { ...base, harness: "claude" };
    case "OPENCODE_NONE":
      return { ...base, harness: "opencode" };
    case "UNKNOWN":
      return { ...base, harness: "not-a-harness" };
    case "PICKER_SPLIT":
      return {
        ...base,
        harness: "claude",
        harness_session_id: "ghost-a",
        transcript_path: "/snap/projects/p1/ghost-b.jsonl",
      };
    default:
      throw new Error(`unmapped resume cell ${id}`);
  }
}

describe("G3 resume-identity differential", () => {
  test("frozen TAP_CLAUDE_HOME rows are byte-identical to Python", () => {
    const home = freezeClaudeHome();
    const env = frozenEnv(home);
    const oracle = loadOracle(home);
    expect(oracle.length).toBe(10);
    expect(oracle.map((row) => row.id).sort()).toEqual([...G3_ORACLE_IDS].sort());
    const mismatches: string[] = [];
    for (const row of oracle) {
      const { revive_tier: _tier, ...bun } = planResume(bunRecord(row.id), env);
      const py = {
        target: row.target,
        source: row.source,
        split_brain: row.split_brain,
        disclosure: row.disclosure,
        ...CORRECTED_FROM_ORACLE[row.id],
      };
      if (JSON.stringify(bun) !== JSON.stringify(py)) {
        mismatches.push(
          `${row.id}\n  python ${JSON.stringify(py)}\n  bun    ${JSON.stringify(bun)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("ghost row pins target null, source picker, split_brain false, revive_tier exact", () => {
    const home = freezeClaudeHome();
    const env = frozenEnv(home);
    const oracle = loadOracle(home);
    const py = oracle.find((row) => row.id === GHOST_CELL);
    expect(py).toBeDefined();
    expect(py).toMatchObject({
      target: null,
      source: "picker",
      split_brain: false,
    });
    const bun = planResume(bunRecord(GHOST_CELL), env);
    expect(bun).toEqual({
      target: null,
      source: "picker",
      split_brain: false,
      revive_tier: "exact",
      disclosure: null,
    });
  });

  test("PICKER_SPLIT is picker with split_brain true", () => {
    const home = freezeClaudeHome();
    const env = frozenEnv(home);
    const bun = planResume(bunRecord(PICKER_SPLIT_CELL), env);
    expect(bun).toEqual({
      target: null,
      source: "picker",
      split_brain: true,
      revive_tier: "exact",
      disclosure: null,
    });
  });

  test("QUARANTINE is an intentional divergence: the oracle over-fires split_brain, Bun does not", () => {
    const home = freezeClaudeHome();
    const env = frozenEnv(home);
    const py = loadOracle(home).find((row) => row.id === "QUARANTINE");
    expect(py?.split_brain).toBe(true);
    expect(Object.keys(CORRECTED_FROM_ORACLE)).toEqual(["QUARANTINE"]);
    expect(planResume(bunRecord("QUARANTINE"), env)).toMatchObject({
      target: py?.target,
      source: py?.source,
      disclosure: py?.disclosure,
      split_brain: false,
    });
  });

  test("QUARANTINE disclosure is on the compared surface", () => {
    const home = freezeClaudeHome();
    const env = frozenEnv(home);
    const bun = planResume(bunRecord("QUARANTINE"), env);
    expect(bun.disclosure).toBe(
      "resuming quarantined session; attestation previously failed",
    );
    expect(bun.source).toBe("quarantined");
  });

  test("tilde TAP_CLAUDE_HOME expands against supplied HOME, not ambient homedir", () => {
    const tap = mkdtempSync(join(tmpdir(), "tap-g3-tilde."));
    scratch.push(tap);
    const proj = join(tap, ".claude", "projects", "p1");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "live-id.jsonl"), "{}\n");
    const env = {
      ...process.env,
      HOME: tap,
      TAP_CLAUDE_HOME: "~/.claude",
      CLAUDE_HOME: "~/.claude",
    };
    const bun = planResume(
      {
        name: "seat",
        cwd: "/tmp/wt",
        base: "team",
        harness: "claude",
        harness_session_id: "live-id",
      },
      env,
    );
    expect(bun).toMatchObject({
      target: "live-id",
      source: "acting_hsid",
      split_brain: false,
      revive_tier: "exact",
    });
  });

  test("empty HOME is supplied and does not consult ambient homedir", () => {
    const env = {
      ...process.env,
      HOME: "",
      TAP_CLAUDE_HOME: "~/.claude",
      CLAUDE_HOME: "~/.claude",
    };
    const resolved = claudeHome(env);
    expect(resolved).toBe("/.claude");
    expect(resolved).not.toBe(join(homedir(), ".claude"));
  });

  test("empty CLAUDE_HOME is supplied and does not fall through to HOME/.claude", () => {
    // Isolated env: spreading process.env would let operator TAP_CLAUDE_HOME mask this arm.
    const env: NodeJS.ProcessEnv = { CLAUDE_HOME: "" };
    const resolved = claudeHome(env);
    expect(resolved).toBe(".");
    expect(resolved).not.toBe(join(homedir(), ".claude"));
  });
});
