// tap-2zzft: every TAP read of OpenCode's `message` table is an index seek, never a scan.
// `tap team` took 89 s on a ~156 GB store because each OpenCode seat filtered on
// json_extract(data, '$.sessionID') -- a value OpenCode does not even store in `data`.
// The fixture carries the real DDL, so these plans are the ones a live store would use.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENCODE_COMPACTION_SQL, readCompactionProof } from "../src/compaction-proof";
import { opencodeTurnState, turnStateSql } from "../src/opencode-turn-state";
import { OPENCODE_EVIDENCE_SQL, opencodeEvidence } from "../src/readiness-stall";
import { proofFixture } from "./fixtures/compaction-proof";
import { OPENCODE_SESSION_SQL, derive } from "../src/session-store";
import { addMessage, addProject, addSession, createOpenCodeStore } from "./support/opencode-store";
import { removeScratchTree } from "./support/scratch";

let root = "";
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "opencode-index-reads.")); });
afterAll(() => { removeScratchTree(root); });

const assistant = (created: number, completed: number | null, finish: string | null) =>
  ({ type: "assistant", time: { created, completed }, finish });

/** Three sessions plus noise; `id` order and `time_created` order deliberately disagree for "tie". */
function store(name: string): string {
  const path = join(root, name);
  const db = createOpenCodeStore(path);
  for (let i = 0; i < 200; i++) addMessage(db, assistant(10 + i, 20 + i, "stop"), { session: `noise-${i % 7}` });
  addMessage(db, { type: "user", time: { created: 100 } }, { session: "s1" });
  addMessage(db, assistant(200, 300, "stop"), { session: "s1" });
  addMessage(db, { type: "idle", time: { created: 350 }, outcome: "succeeded" }, { session: "s1" });
  addMessage(db, { type: "user", time: { created: 400 } }, { session: "s1" });
  addMessage(db, assistant(50, null, null), { session: "s2" });
  addMessage(db, assistant(500, 600, "stop"), { session: "tie", id: "msg_a" });
  addMessage(db, assistant(500, null, null), { session: "tie", id: "msg_b" });
  db.close();
  return path;
}

const planOf = (db: Database, sql: string, ...args: unknown[]) =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as { detail: string }[]).map(r => r.detail);

describe("query plans", () => {
  const queries: [string, string, unknown[]][] = [
    ["readiness evidence", OPENCODE_EVIDENCE_SQL, ["s1"]],
    ["turn state", turnStateSql("s1"), []],
    ["compaction proof", OPENCODE_COMPACTION_SQL, ["s1", 0, 0, 0]],
  ];
  for (const [name, sql, args] of queries) {
    test(`${name} seeks the session sequence index and never scans`, () => {
      const db = new Database(store(`${name.replace(/ /g, "-")}.db`), { readonly: true });
      try {
        const plan = planOf(db, sql, ...args);
        expect(plan.join("\n")).not.toMatch(/\bSCAN\b/);
        expect(plan.some(d => /^SEARCH session_message USING INDEX session_message_session_(type_)?seq_idx \(session_id=\?/.test(d))).toBe(true);
      } finally { db.close(); }
    });
  }


});

describe("answers on a store whose data omits sessionID", () => {
  test("readiness evidence reads the newest row of its own session only", () => {
    const env = { OPENCODE_DB_PATH: store("evidence.db") };
    expect(opencodeEvidence("s1", env)).toEqual({ ended: false, lastActivity: 0.4, at: null }); // the newer user message
    expect(opencodeEvidence("s2", env)).toEqual({ ended: false, lastActivity: 0.05, at: null });
    expect(opencodeEvidence("absent", env)).toBeNull();
  });

  test("sequence decides the newest row, in both readers", () => {
    const env = { OPENCODE_DB_PATH: store("tie.db") };
    expect(opencodeEvidence("tie", env)?.ended).toBe(false); // msg_b: open
    expect(opencodeTurnState("tie", env)).toBe("in-turn");
  });

  test("turn state skips the newer user row to the newest assistant", () => {
    const env = { OPENCODE_DB_PATH: store("turn.db") };
    expect(opencodeTurnState("s1", env)).toBe("idle");
    expect(opencodeTurnState("s2", env)).toBe("in-turn");
    expect(opencodeTurnState("absent", env)).toBe("unknown");
  });
});

describe("a store without the index fails closed instead of scanning", () => {
  const dropIndex = (path: string) => {
    const db = new Database(path);
    db.exec("DROP INDEX session_message_session_seq_idx; DROP INDEX session_message_session_type_seq_idx");
    db.close();
  };

  test("evidence is unknown and turn state is error", () => {
    const path = store("noindex.db");
    dropIndex(path);
    const env = { OPENCODE_DB_PATH: path };
    expect(opencodeEvidence("s1", env)).toBeNull();
    expect(opencodeTurnState("s1", env)).toBe("error");
  });

  test("a compaction proof that was provable is withheld", () => {
    const f = proofFixture(root, "opencode");
    f.summary(2000);
    expect(readCompactionProof(f.boundary)).not.toBeNull();
    dropIndex(f.path);
    expect(readCompactionProof(f.boundary)).toBeNull();
  });
});

// tap-0zip2: binding discovery finds a worktree's sessions through session_v2_project_idx, never a
// SCAN of `session`. OpenCode files a session under the project resolved at creation (a git
// project for repo roots, subdirectories and sandbox worktrees) or `global` (non-git), and
// reassigns global sessions off `global` only where directory equals the opened root. The
// candidate projects come from OpenCode's own small metadata tables and are not provably
// complete, so a hit is reported as derived_ambiguous (container, no id) and never as unique.
describe("session by directory", () => {
  const REPO = "/work/repo";
  const home = (name: string, fill: (db: Database) => void): string => {
    const hm = join(root, name);
    mkdirSync(join(hm, ".local", "share", "opencode"), { recursive: true });
    const db = createOpenCodeStore(join(hm, ".local", "share", "opencode", "opencode.db"));
    fill(db);
    db.close();
    return hm;
  };
  const found = (hm: string, dir: string) => {
    const r = derive("opencode", dir, { home: hm, env: {} });
    return { id: r.harness_session_id, trust: r.trust, candidates: r.candidates, store: r.store_kind };
  };
  const HIT = (candidates: number) => ({ id: "", trust: "derived_ambiguous" as const, candidates, store: "db" });

  test("the plan seeks session_v2_project_idx and never scans session", () => {
    const hm = home("plan", (db) => {
      for (let i = 0; i < 300; i++) addSession(db, `noise-${i}`, `/elsewhere/${i}`, { project: `p${i % 9}` });
      addProject(db, "p1", REPO, { opened: [REPO] });
    });
    const db = new Database(join(hm, ".local", "share", "opencode", "opencode.db"), { readonly: true });
    try {
      const plan = planOf(db, OPENCODE_SESSION_SQL(2), REPO, "/work", REPO);
      expect(plan).toContain("SEARCH session_v2 USING INDEX session_v2_project_idx (project_id=?)");
      expect(plan.some(d => /^SCAN session_v2\b/.test(d))).toBe(false);
    } finally { db.close(); }
  });

  test("a repo-root session is found under its git project", () => {
    const hm = home("root", (db) => {
      addProject(db, "p1", REPO, { opened: [REPO] });
      addSession(db, "ses_root", REPO, { project: "p1" });
      addSession(db, "ses_other", "/work/other", { project: "p1" });
    });
    expect(found(hm, REPO)).toEqual(HIT(1));
  });

  test("a session started in a subdirectory is filed under the root's project", () => {
    const hm = home("subdir", (db) => {
      addProject(db, "p1", REPO, { opened: [REPO] });
      addSession(db, "ses_sub", `${REPO}/pkg/a`, { project: "p1" });
    });
    expect(found(hm, `${REPO}/pkg/a`)).toEqual(HIT(1));
  });

  test("a sandbox worktree's session is found through project.sandboxes", () => {
    const hm = home("sandbox", (db) => {
      addProject(db, "p1", REPO, { sandboxes: ["/trees/lane"] });
      addSession(db, "ses_lane", "/trees/lane", { project: "p1" });
    });
    expect(found(hm, "/trees/lane")).toEqual(HIT(1));
  });

  test("a sandbox session started in a subdirectory resolves through the sandbox ancestor", () => {
    const hm = home("sandbox-sub", (db) => {
      addProject(db, "p1", REPO, { sandboxes: ["/trees/lane"] });
      addSession(db, "ses_lane_sub", "/trees/lane/pkg", { project: "p1" });
    });
    expect(found(hm, "/trees/lane/pkg")).toEqual(HIT(1));
  });

  test("a project_directory row alone (an opened dir outside worktree/sandboxes) resolves", () => {
    const hm = home("opened", (db) => {
      addProject(db, "p1", REPO, { opened: ["/mnt/alias"] });
      addSession(db, "ses_alias", "/mnt/alias", { project: "p1" });
    });
    expect(found(hm, "/mnt/alias")).toEqual(HIT(1));
  });

  test("a non-git directory's session lives under the global project", () => {
    const hm = home("global", (db) => {
      addProject(db, "p1", REPO, { opened: [REPO] });
      addSession(db, "ses_global", "/scratch/notes", { project: "global" });
    });
    expect(found(hm, "/scratch/notes")).toEqual(HIT(1));
  });

  test("a global session in a subdirectory of a repo initialised later is still found", () => {
    // fromDirectory(/repo) reassigns global sessions only where directory = /repo, so the
    // /repo/sub session stays global while /repo/sub is now inside project p1.
    const hm = home("global-sub", (db) => {
      addProject(db, "p1", REPO, { opened: [REPO] });
      addSession(db, "ses_global_sub", `${REPO}/sub`, { project: "global" });
    });
    expect(found(hm, `${REPO}/sub`)).toEqual(HIT(1));
  });

  test("a directory with nothing indexed is none", () => {
    const hm = home("empty", (db) => {
      addProject(db, "p1", REPO, { opened: [REPO] });
      addSession(db, "ses_other", "/work/other", { project: "p1" });
    });
    expect(found(hm, REPO)).toEqual({ id: "", trust: "none" as const, candidates: 0, store: "db" });
  });

  test("a visible session never certifies uniqueness while another hides under an unlisted project", () => {
    // The old directory scan saw both rows (ambiguous). p2 does not name /work/repo (a v2
    // session in an unrecorded worktree, or a moved session), so the seek sees only one --
    // that must stay a refusal, never a unique binding.
    const hm = home("mixed", (db) => {
      addProject(db, "p1", REPO, { opened: [REPO] });
      addProject(db, "p2", "/work/other", { opened: ["/work/other"] });
      addSession(db, "ses_visible", REPO, { project: "p1" });
      addSession(db, "ses_hidden", REPO, { project: "p2" });
    });
    const r = found(hm, REPO);
    expect(r.trust).toBe("derived_ambiguous");
    expect(r.id).toBe("");
  });

  test("a v2 session in a worktree its project never recorded is a quiet none", () => {
    // core/session.ts files session(P, /worktree/sub) without appending /worktree to sandboxes;
    // a moved session likewise keeps project_id and changes only directory.
    const hm = home("unrecorded", (db) => {
      addProject(db, "p1", REPO, { opened: [REPO] });
      addSession(db, "ses_v2", "/trees/unrecorded/sub", { project: "p1" });
    });
    expect(found(hm, "/trees/unrecorded/sub")).toEqual({ id: "", trust: "none" as const, candidates: 0, store: "db" });
  });

  test("a store without session_v2_project_idx fails closed rather than scanning", () => {
    const hm = home("no-index", (db) => {
      db.exec("DROP INDEX session_v2_project_idx");
      addSession(db, "ses_root", REPO, { project: "global" });
    });
    const r = derive("opencode", REPO, { home: hm, env: {} });
    expect(r.trust).toBe("none");
    expect(r.harness_session_id).toBe("");
    expect(r.detail).toContain("unreadable");
  });
});
