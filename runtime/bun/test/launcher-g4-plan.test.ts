// G4 dark plan --json differential vs frozen Python internals.
// Parsed structures; J1/J2 are named text-encoding non-goals; J3/J4 are
// real value rows. IEEE Number and Date are refused on the Bun side.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { jsonSafe, planJson } from "../src/launcher/plan";
import type { SessionRecord } from "../src/launcher/types";
import { removeScratchTree } from "./support/scratch";


const G4_ORACLE_IDS = [
  "CLAUDE_NEW",
  "CLAUDE_RESUME_GHOST",
  "CLAUDE_RESUME_ACTING",
  "OPENCODE_RESUME",
  "UNKNOWN",
  "ENV_SEAT",
  "PICKER_SPLIT",
  "JSON_SAFE",
  "CURSOR_NEW_HSID",
  "CODEX_RESUME",
] as const;

type OracleRow = {
  id: string;
  argv: string[] | null;
  env: Record<string, string>;
  record: {
    name: string;
    harness: string;
    cwd: string;
    base: string;
    model: string | null;
    harness_session_id: string | null;
    transcript_path: string | null;
    quarantined_harness_session_id: string | null;
    harness_env: Record<string, string>;
  };
  resume: {
    target: string | null;
    source: string;
    split_brain: boolean;
    disclosure: string | null;
  };
  refusal: string | null;
  json_safe: unknown;
};

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

function freezeHomes(): { claude: string; tap: string } {
  const claude = mkdtempSync(join(tmpdir(), "tap-g4-claude."));
  scratch.push(claude);
  const proj = join(claude, "projects", "p1");
  mkdirSync(proj, { recursive: true });
  for (const id of ["live-id", "tpath-id", "qid-id"]) {
    writeFileSync(join(proj, `${id}.jsonl`), "{}\n");
  }
  const tap = mkdtempSync(join(tmpdir(), "tap-g4-home."));
  scratch.push(tap);
  mkdirSync(join(tap, "xdg", "tap"), { recursive: true });
  // Match the frozen Python oracle's explicit policy, independent of today's default.
  writeFileSync(join(tap, "xdg/tap/config.toml"), ["version = 3", ...["claude", "codex", "cursor", "agy"]
    .map(harness => `[harness.${harness}]\npermissions = "bypass"`)].join("\n"));
  mkdirSync(join(tap, "home"), { recursive: true });
  mkdirSync(join(tap, "index"), { recursive: true });
  return { claude, tap };
}

function frozenEnv(homes: { claude: string; tap: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAP_CLAUDE_HOME: homes.claude,
    CLAUDE_HOME: homes.claude,
    TAP_HOME: homes.tap,
    HOME: join(homes.tap, "home"),
    XDG_CONFIG_HOME: join(homes.tap, "xdg"),
    TAP_INDEX_HOME: join(homes.tap, "index"),
    TAP_SESSION_MANIFEST: join(homes.tap, "sessions.json"),
    OPENCODE_DB_PATH: join(homes.tap, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(homes.tap, "version-seen.json"),
    CLAUDE_CODE_TMUX_TRUECOLOR: "1",
    CLAUDE_CODE_SCROLL_SPEED: "99",
  };
}

function loadOracle(_env: NodeJS.ProcessEnv): OracleRow[] {
  return JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/launcher-g4-plan-oracle.json"), "utf8")).cases;
}

function jsonSafeFixture(): unknown {
  return {
    int_one: 1n,
    float_one: { $float: "1.0" },
    big_int: 9007199254740993n,
    date: { $toml: "date", year: 2026, month: 8, day: 18 },
    datetime_naive: {
      $toml: "datetime",
      year: 2026,
      month: 8,
      day: 18,
      hour: 10,
      minute: 0,
      second: 0,
    },
    datetime_z: {
      $toml: "datetime",
      year: 2026,
      month: 8,
      day: 18,
      hour: 10,
      minute: 0,
      second: 0,
      offset: "+00:00",
    },
    time: { $toml: "time", hour: 10, minute: 0, second: 0 },
    time_micro: {
      $toml: "time",
      hour: 10,
      minute: 0,
      second: 0,
      microsecond: 123456,
    },
    datetime_half: {
      $toml: "datetime",
      year: 2026,
      month: 8,
      day: 18,
      hour: 10,
      minute: 0,
      second: 0,
      microsecond: 500000,
    },
    date_year1: { $toml: "date", year: 1, month: 2, day: 3 },
    time_leading_us: {
      $toml: "time",
      hour: 10,
      minute: 0,
      second: 0,
      microsecond: 5,
    },
    window: [
      { $toml: "date", year: 2026, month: 8, day: 18 },
      { $toml: "date", year: 2026, month: 8, day: 19 },
    ],
    nested: { since: { $toml: "date", year: 2026, month: 1, day: 1 } },
    esc: "\x1b[0m",
    cafe: "café",
    line_sep: "a\u2028b",
    bool_true: true,
    none: null,
  };
}

function bunRecord(id: string): SessionRecord {
  const base = {
    name: "seat",
    cwd: "/tmp/wt",
    base: "team",
  };
  switch (id) {
    case "CLAUDE_NEW":
    case "JSON_SAFE":
      return { ...base, harness: "claude" };
    case "CLAUDE_RESUME_GHOST":
      return { ...base, harness: "claude", harness_session_id: "ghost-id-0000" };
    case "CLAUDE_RESUME_ACTING":
      return { ...base, harness: "claude", harness_session_id: "live-id" };
    case "OPENCODE_RESUME":
      return { ...base, harness: "opencode" };
    case "UNKNOWN":
      return { ...base, harness: "not-a-harness" };
    case "ENV_SEAT":
      return {
        ...base,
        harness: "claude",
        harness_env: {
          TAP_G4_SEAT: "won",
          CLAUDE_CODE_SCROLL_SPEED: "9",
        },
      };
    case "PICKER_SPLIT":
      return {
        ...base,
        harness: "claude",
        harness_session_id: "ghost-a",
        transcript_path: "/snap/projects/p1/ghost-b.jsonl",
      };
    case "CURSOR_NEW_HSID":
      return { ...base, harness: "cursor", harness_session_id: "ghost-id-0000" };
    case "CODEX_RESUME":
      return { ...base, harness: "codex", harness_session_id: "ghost-id-0000" };
    default:
      throw new Error(`unmapped plan cell ${id}`);
  }
}

function bunAction(id: string): string {
  switch (id) {
    case "CLAUDE_RESUME_GHOST":
    case "CLAUDE_RESUME_ACTING":
    case "OPENCODE_RESUME":
    case "PICKER_SPLIT":
    case "CODEX_RESUME":
      return "resume";
    default:
      return "new";
  }
}

function bunPlan(id: string, env: NodeJS.ProcessEnv) {
  return planJson({
    id,
    action: bunAction(id),
    record: bunRecord(id),
    jsonSafeValues: id === "JSON_SAFE" ? jsonSafeFixture() : undefined,
    env,
  });
}

/**
 * The Python row, verbatim. This used to splice `--trust` into it, because the
 * port emitted the flag and the incumbent did not -- so the differential
 * reported agreement by editing the side it was supposed to be checking against.
 * `36df76b16` gave the incumbent the flag (tap-j86wd), and the splice then
 * DOUBLED the token rather than merely being redundant, which is how this
 * surfaced at all. Its twin lived in `launcher-g1-adapters.test.ts`.
 */
function withAuthorizedCursorTrust(argv: string[] | null): string[] | null {
  return argv;
}

function comparable(row: OracleRow) {
  return {
    argv: withAuthorizedCursorTrust(row.argv),
    env: row.env,
    record: row.record,
    resume: row.resume,
    refusal: row.refusal,
    json_safe: row.json_safe,
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

// Authorized deviation from the frozen Python capture: Codex launches carry `--no-daemon` (tap-21bdj).
function withNoDaemon<T extends { argv?: unknown }>(row: T): T {
  const argv = row.argv;
  return Array.isArray(argv) && argv[0] === "codex" ? { ...row, argv: [argv[0], "--no-daemon", ...argv.slice(1)] } : row;
}

describe("G4 plan --json differential", () => {
  test("frozen-home rows are parsed-identical to Python", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const oracle = loadOracle(env);
    expect(oracle.length).toBe(10);
    expect(oracle.map((row) => row.id).sort()).toEqual([...G4_ORACLE_IDS].sort());
    const mismatches: string[] = [];
    for (const row of oracle) {
      const bun = bunPlan(row.id, env);
      const py = withNoDaemon(comparable(row));
      const { revive_tier: _tier, ...resume } = bun.resume;
      const bunCmp = {
        argv: bun.argv,
        env: bun.env,
        record: bun.record,
        resume,
        refusal: bun.refusal,
        json_safe: bun.json_safe,
      };
      if (JSON.stringify(stable(bunCmp)) !== JSON.stringify(stable(py))) {
        mismatches.push(
          `${row.id}\n  python ${JSON.stringify(py)}\n  bun    ${JSON.stringify(bunCmp)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("J3 int 1 and float 1.0 stay distinct tagged values", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const oracle = loadOracle(env);
    const py = oracle.find((row) => row.id === "JSON_SAFE");
    expect(py).toBeDefined();
    const safe = py!.json_safe as {
      int_one: { $int: string };
      float_one: { $float: string };
      big_int: { $int: string };
    };
    expect(safe.int_one).toEqual({ $int: "1" });
    expect(safe.float_one).toEqual({ $float: "1.0" });
    expect(safe.int_one).not.toEqual(safe.float_one);
    expect(safe.big_int).toEqual({ $int: "9007199254740993" });
    expect(jsonSafe(1n)).toEqual({ $int: "1" });
    expect(jsonSafe({ $float: "1.0" })).toEqual({ $float: "1.0" });
    expect(jsonSafe(9007199254740993n)).toEqual({
      $int: "9007199254740993",
    });
  });

  test("J3 refuses IEEE Number so MAX_SAFE_INTEGER cannot silently round", () => {
    expect(() => jsonSafe(9007199254740993)).toThrow(/IEEE Number/);
    expect(() => jsonSafe(1.0)).toThrow(/IEEE Number/);
  });

  test("J4 TOML temporals use Python isoformat spellings, not Date", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const bun = bunPlan("JSON_SAFE", env);
    const safe = bun.json_safe as {
      date: string;
      datetime_naive: string;
      datetime_z: string;
      time: string;
      time_micro: string;
      datetime_half: string;
      date_year1: string;
      time_leading_us: string;
      window: string[];
      nested: { since: string };
    };
    expect(safe.date).toBe("2026-08-18");
    expect(safe.datetime_naive).toBe("2026-08-18T10:00:00");
    expect(safe.datetime_z).toBe("2026-08-18T10:00:00+00:00");
    expect(safe.time).toBe("10:00:00");
    expect(safe.time_micro).toBe("10:00:00.123456");
    expect(safe.datetime_half).toBe("2026-08-18T10:00:00.500000");
    expect(safe.date_year1).toBe("0001-02-03");
    expect(safe.time_leading_us).toBe("10:00:00.000005");
    expect(safe.window).toEqual(["2026-08-18", "2026-08-19"]);
    expect(safe.nested).toEqual({ since: "2026-01-01" });
    expect(() => jsonSafe(new Date("2026-08-18T10:00:00Z"))).toThrow(/Date/);
  });

  test("J4_MICRO pads .5 to .500000 and keeps .123456", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const oracle = loadOracle(env);
    const py = oracle.find((row) => row.id === "JSON_SAFE")!.json_safe as {
      time_micro: string;
      datetime_half: string;
    };
    const bun = bunPlan("JSON_SAFE", env).json_safe as {
      time_micro: string;
      datetime_half: string;
    };
    expect(py.time_micro).toBe("10:00:00.123456");
    expect(py.datetime_half).toBe("2026-08-18T10:00:00.500000");
    expect(bun.time_micro).toBe(py.time_micro);
    expect(bun.datetime_half).toBe(py.datetime_half);
  });

  test("J4_NOPAD pads leading-zero microseconds to six digits", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const oracle = loadOracle(env);
    const py = oracle.find((row) => row.id === "JSON_SAFE")!.json_safe as {
      time_leading_us: string;
    };
    const bun = bunPlan("JSON_SAFE", env).json_safe as {
      time_leading_us: string;
    };
    expect(py.time_leading_us).toBe("10:00:00.000005");
    expect(bun.time_leading_us).toBe(py.time_leading_us);
  });

  test("ISO year before 1000 is padded to four digits", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const oracle = loadOracle(env);
    const py = oracle.find((row) => row.id === "JSON_SAFE")!.json_safe as {
      date_year1: string;
    };
    const bun = bunPlan("JSON_SAFE", env).json_safe as { date_year1: string };
    expect(py.date_year1).toBe("0001-02-03");
    expect(bun.date_year1).toBe(py.date_year1);
  });

  test("J1/J2 are named text-encoding non-goals under parsed compare", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const oracle = loadOracle(env);
    const py = oracle.find((row) => row.id === "JSON_SAFE")!.json_safe as {
      cafe: string;
      line_sep: string;
    };
    const bun = bunPlan("JSON_SAFE", env).json_safe as {
      cafe: string;
      line_sep: string;
    };
    expect(bun.cafe).toBe("café");
    expect(bun.line_sep).toBe("a\u2028b");
    expect(bun.cafe).toBe(py.cafe);
    expect(bun.line_sep).toBe(py.line_sep);
  });

  test("ENV_SEAT record env wins over claude cosmetics", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const bun = bunPlan("ENV_SEAT", env);
    expect(bun.env.TAP_G4_SEAT).toBe("won");
    expect(bun.env.CLAUDE_CODE_SCROLL_SPEED).toBe("9");
    expect(bun.env.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("1");
    expect(bun.refusal).toBeNull();
  });

  test("ENV_AMBIENT parent-honoring cosmetics beat the fallback, record still wins", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    expect(env.CLAUDE_CODE_SCROLL_SPEED).toBe("99");
    const ambient = bunPlan("CLAUDE_NEW", env);
    expect(ambient.env.CLAUDE_CODE_SCROLL_SPEED).toBe("99");
    expect(ambient.env.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("1");
    const seat = bunPlan("ENV_SEAT", env);
    expect(seat.env.CLAUDE_CODE_SCROLL_SPEED).toBe("9");
  });

  test("OPENCODE_RESUME is a fresh id-less resume, not refused (4b075d370 restored)", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const bun = bunPlan("OPENCODE_RESUME", env);
    expect(bun.argv).toEqual(["opencode"]);
    expect(bun.refusal).toBeNull();
    expect(bun.resume.revive_tier).toBe("fresh");
  });

  test("explicit null resumeIdentity is preserved and does not re-resolve", () => {
    const homes = freezeHomes();
    const env = frozenEnv(homes);
    const bound = planJson({
      id: "BOUND_NULL",
      action: "resume",
      record: {
        name: "seat",
        harness: "codex",
        cwd: "/tmp/wt",
        base: "team",
        harness_session_id: "ghost-id-0000",
      },
      resumeIdentity: null,
      env,
    });
    expect(bound.argv).toEqual([
      "codex", "--no-daemon",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
    ]);
    const unbound = planJson({
      id: "UNBOUND",
      action: "resume",
      record: {
        name: "seat",
        harness: "codex",
        cwd: "/tmp/wt",
        base: "team",
        harness_session_id: "ghost-id-0000",
      },
      env,
    });
    expect(unbound.argv).toContain("ghost-id-0000");
  });
});
