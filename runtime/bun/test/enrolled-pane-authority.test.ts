// Focused coverage for the authoritative enrolled-pane resolution behind
// `refuseUnanchoredPane` (a review-round catch): the retired Bash
// lookup bound a pane-id row to the observed session and server generation,
// refused contested claimants, and failed closed on unreadable or missing
// acting registries. The weak pane-id match it replaced could name the WRONG
// team's bus in a refusal remedy. Each negative arm pins the incumbent's typed
// verdict class and remedy and proves NO team suggestion; the first arm pins
// byte parity for the positive case.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { removeScratchTree } from "./support/scratch";
import { ESCALATE_COMMAND, refuseUnanchoredPane, TapError } from "../src/context";
import { NO_MACHINE_INDEX } from "../src/selector";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "tap-enrolled-pane-authority-"));
afterAll(() => removeScratchTree(scratch));

let serial = 0;
interface TeamSpec {
  name: string;
  seats?: Record<string, unknown>;
  registryBytes?: string;   // override: raw registry file bytes (corrupt docs)
  registryBytesRaw?: Uint8Array; // override: exact bytes (invalid UTF-8 specimens)
  registryMissing?: boolean; // override: enroll the team but omit the acting file
  noSeatsAxis?: boolean;     // override: acting file without a seats axis
  registryDir?: boolean;      // override: registry_location points at a directory
  rawEntries?: Record<string, unknown>; // verbatim extra entries in the teams map
}

function fixture(...teams: TeamSpec[]) {
  const base = join(scratch, String(serial++));
  const index = join(base, "index");
  const cwd = join(base, "cwd");
  mkdirSync(index, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const enrolled: Record<string, unknown> = {};
  for (const t of teams) {
    const teamRoot = join(base, t.name);
    const registry = join(teamRoot, ".tap", "team-registry.json");
    mkdirSync(join(teamRoot, ".tap"), { recursive: true });
    if (!t.registryMissing) {
      if (t.registryDir) {
        mkdirSync(registry, { recursive: true });
      } else {
        writeFileSync(registry, t.registryBytesRaw ??
          t.registryBytes ??
          JSON.stringify(t.noSeatsAxis ? {} : { schema: "0.20", team: { name: t.name }, seats: t.seats }));
      }
    }
    enrolled[t.name] = { root: teamRoot, registry_location: registry, state: "registered" };
  }
  for (const [key, value] of Object.entries(teams.find((t) => t.rawEntries)?.rawEntries ?? {})) {
    enrolled[key] = value;
  }
  writeFileSync(join(index, "global-registry.json"),
    JSON.stringify({ schema: "0.20", teams: enrolled }));
  return { index, cwd, env: { ...process.env, TAP_INDEX_HOME: index } };
}

function refusal(fn: () => never): TapError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TapError) return error;
    throw error;
  }
  throw new Error("expected refuseUnanchoredPane to throw");
}

const OBSERVED = { session: "s1", serverEpoch: "E2" };
// The typed verdicts never name a team or an executable team remedy.
const ESCALATE = ESCALATE_COMMAND;
// Same class and fail-closed refusal for every cause; the hint blames only what failed.
const TMUX_HINT = `${ESCALATE}   (do not retry; tmux state is unreadable)`;
const UNREADABLE_HINT = `${ESCALATE}   (do not retry; repair the unreadable team's registry)`;
const MALFORMED_ROOT_HINT = `${ESCALATE}   (do not retry; the enrolled team's root in the machine index is malformed and a human must repair the enrollment)`;

describe("refuseUnanchoredPane resolves enrollment authoritatively", () => {
  test("a current single claimant keeps the incumbent bytes (both remedy shapes)", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } });
    const err = refusal(() =>
      refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.code).toBe(4);
    expect(err.errorClass).toBe("unanchored_bus");
    const teamRoot = join(f.cwd, "..", "alpha");
    expect(err.action).toBe(`cd ${teamRoot}  OR  pass --team alpha`);
    expect(err.detail).toBe(`unanchored cwd (${f.cwd}) has no TAP bus; pane %5 is registered as 'h1' on team 'alpha' at '${teamRoot}'`);
    // The whoami/peek shape keeps the cwd-only remedy.
    const whoamiShape = refusal(() =>
      refuseUnanchoredPane("%5", f.cwd, 2, OBSERVED, f.env, "%5"));
    expect(whoamiShape.action).toBe(`cd ${teamRoot}`);
    expect(whoamiShape.detail).not.toContain("pass --team");
  });

  test("a non-active row is still a claimant (the incumbent adds no status filter)", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2", status: "launching" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toContain("pass --team alpha");
  });

  test("a stale prior-generation row maps to unregistered + tap register", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E1" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unregistered");
    expect(err.action).toBe("tap register");
    expect(err.detail).toContain("no CURRENT-generation seat claims that session");
    expect(err.detail).toContain("alpha/h1");
    expect(err.detail).not.toContain("pass --team");
    expect(err.detail).not.toContain(join(f.cwd, "..", "alpha"));
  });

  test("a row recorded under a different session is not a claimant", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: "%5", session: "other", server_epoch: "E2" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unregistered");
    expect(err.action).toBe("tap register");
  });

  test("an unstamped row cannot bind a pane id to this server lifetime", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: "%5", session: "s1" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unregistered");
    expect(err.detail).toContain("an unstamped row cannot bind a pane id to this server lifetime");
  });

  test("a pane name equal to or ending in '/<pane-id>' is a claimant (incumbent match set)", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane: "/dev/ttys001/%5", session: "s1", server_epoch: "E2" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toContain("pass --team alpha");
  });

  test("two current claimants refuse as contested with the escalate remedy", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", seats: { h2: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("pane_contested");
    expect(err.action).toBe(`${ESCALATE}   (a human decides which seat owns this pane; the first non-empty line of <question-file> is the question to ask them)`);
    expect(err.detail).toContain("cannot be resolved to one seat");
    expect(err.detail).toContain("2 claimants agree with this pane's session");
    expect(err.detail).toContain("alpha/h1");
    expect(err.detail).toContain("beta/h2");
  });

  test("an unreadable acting registry leaves uniqueness unproven (pane_unknown, escalate)", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", registryBytes: "{not json" },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(UNREADABLE_HINT);
    expect(err.detail).not.toContain("tmux state is unreadable");
    expect(err.detail).toContain("pane %5 was observed");
    expect(err.detail).toContain("registered team(s) beta could not be read");
    expect(err.detail).toContain("uniqueness is unproven");
    expect(err.detail).not.toContain(join(f.cwd, "..", "alpha"));
  });

  // tap-xbpuc: a positively absent acting file holds zero rows, so another
  // team's stale enrollment never vetoes this pane's unique claimant.
  test("another team's missing acting registry does not block a unique claimant", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", registryMissing: true },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toBe(`cd ${join(f.cwd, "..", "alpha")}  OR  pass --team alpha`);
  });

  test("a pane whose session names the data-gone team refuses stale_enrollment", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", registryMissing: true },
    );
    const stale = { session: "beta/h2", serverEpoch: "E2" };
    const err = refusal(() => refuseUnanchoredPane("%9", f.cwd, 4, stale, f.env, "%9", true));
    expect(err.errorClass).toBe("stale_enrollment");
    expect(err.action).toBe("tap admin refresh   (purges enrolled teams whose acting registry file is gone)");
    expect(err.detail).toContain("team 'beta' is enrolled but its acting registry file is gone");
    expect(err.detail).not.toContain("alpha");
    // Control: a session naming a team that is NOT data-gone stays unregistered.
    const other = refusal(() => refuseUnanchoredPane("%9", f.cwd, 4, { session: "alpha/h9", serverEpoch: "E2" }, f.env, "%9", true));
    expect(other.errorClass).toBe("unregistered");
  });

  test("a registry without a readable seats axis is a structural defect, not empty", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", noSeatsAxis: true },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(UNREADABLE_HINT);
    expect(err.detail).toContain("registered team(s) beta (old_store) could not be read");
  });

  test("a directory at registry_location is unreadable, never missing", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", registryDir: true },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(UNREADABLE_HINT);
    expect(err.detail).toContain("registered team(s) beta could not be read");
    expect(err.detail).not.toContain("tap admin refresh");
  });

  test("a malformed (non-dict) seat value is skipped, never a crash", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", seats: { broken: null } },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toContain("pass --team");
    expect(err.detail).toContain("registered as 'h1' on team 'alpha'");
  });

  test("a team whose index state is not registered is not a claim source", () => {
    const base = join(scratch, `state-${serial++}`);
    const index = join(base, "index");
    const cwd = join(base, "cwd");
    const teamRoot = join(base, "alpha");
    const registry = join(teamRoot, ".tap", "team-registry.json");
    mkdirSync(join(teamRoot, ".tap"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(index, { recursive: true });
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: { alpha: { root: teamRoot, registry_location: registry, state: "historical" } },
    }));
    const err = refusal(() => refuseUnanchoredPane("%5", cwd, 4, OBSERVED,
      { ...process.env, TAP_INDEX_HOME: index }, "%5", true));
    expect(err.errorClass).toBe("unregistered");
    expect(err.action).toBe("tap register");
  });

  // F2b: no machine index means no enrolled team, so the refusal is the
  // selector's own `tap init` remedy at the caller's exit code. A stray
  // teams.json whose bus registry claims the pane (exactly what the deleted
  // legacy walk resolved) must not change the answer.
  test("an absent machine index refuses with the tap init remedy", () => {
    const base = join(scratch, `noindex-${serial++}`);
    const index = join(base, "index");
    const cwd = join(base, "cwd");
    const teamRoot = join(base, "alpha");
    mkdirSync(index, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(teamRoot, ".tap", "bus"), { recursive: true });
    writeFileSync(join(teamRoot, ".tap", "bus", "registry.json"),
      JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: { h1: { pane_id: "%5" } } }));
    writeFileSync(join(index, "teams.json"), JSON.stringify({ teams: { alpha: { root: teamRoot } } }));
    const env = { ...process.env, TAP_INDEX_HOME: index };
    const err = refusal(() => refuseUnanchoredPane("%5", cwd, 4, OBSERVED, env, "%5", true));
    expect(err.code).toBe(4);
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toBe("tap init  OR  tap session launch");
    expect(err.detail).toBe(NO_MACHINE_INDEX);
    expect(err.detail).not.toContain("alpha");
    expect(err.action).not.toContain("pass --team");
    // The whoami/peek shape keeps its own exit code.
    expect(refusal(() => refuseUnanchoredPane("%5", cwd, 2, OBSERVED, env, "%5")).code).toBe(2);
  });

  test("structured identity data cannot claim a pane", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: ["%5"], session: "s1", server_epoch: "E2" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    // String(["%5"]) is "%5", but Python never coerces: a list pane_id is a
    // malformed row, not a claimant.
    expect(err.errorClass).toBe("unregistered");
    expect(err.action).toBe("tap register");
    expect(err.detail).not.toContain("pass --team");
    expect(err.detail).not.toContain("alpha/h1");
  });

  test("an empty state stays in the registered population", () => {
    const base = join(scratch, `emptystate-${serial++}`);
    const index = join(base, "index");
    const cwd = join(base, "cwd");
    const alphaRoot = join(base, "alpha");
    mkdirSync(join(alphaRoot, ".tap"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(index, { recursive: true });
    writeFileSync(join(alphaRoot, ".tap", "team-registry.json"),
      JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: {
        alpha: { root: alphaRoot, registry_location: join(alphaRoot, ".tap", "team-registry.json"), state: "" },
        beta: { root: join(base, "beta"), registry_location: join(base, "beta", "gone.json"), state: "registered" },
      },
    }));
    const err = refusal(() => refuseUnanchoredPane("%5", cwd, 4, OBSERVED,
      { ...process.env, TAP_INDEX_HOME: index }, "%5", true));
    // state "" is falsy, so the incumbent's or-chain reads it as registered:
    // alpha's claim resolves (excluded, the pane would read unregistered), and
    // beta's data-gone acting file holds no rows to veto it (tap-xbpuc).
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.detail).toContain("registered as 'h1' on team 'alpha'");
  });

  test("a live index that omits teams yields the typed miss, not the generic refusal", () => {
    const base = join(scratch, `noteams-${serial++}`);
    const index = join(base, "index");
    const cwd = join(base, "cwd");
    mkdirSync(index, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20" }));
    const err = refusal(() => refuseUnanchoredPane("%5", cwd, 4, OBSERVED,
      { ...process.env, TAP_INDEX_HOME: index }, "%5", true));
    // `.get("teams") or {}` on a valid live marker: an empty enrollment map
    // walks zero teams and lands on the typed unclaimed verdict — the
    // generic no-authority refusal is only for an unreadable index.
    expect(err.errorClass).toBe("unregistered");
    expect(err.action).toBe("tap register");
    expect(err.detail).toContain("no CURRENT-generation seat claims");
    expect(err.detail).not.toContain("no registry at cwd");
  });

  // A malformed enrollment row (the machine index, not the team registry) has
  // its own cause: pointing the operator at "the unreadable team's registry"
  // sends them to a file that was never named. Same class, same fail-closed
  // refusal, same escalate action; only the blame and the repair target move.
  const MALFORMED_ENROLLMENT_HINT = `${ESCALATE}   (do not retry; the enrolled team's registry_location in the machine index is missing or malformed and a human must repair the enrollment, not the team registry)`;
  const malformedLocations: Array<[string, Record<string, unknown>]> = [
    ["a non-string", { registry_location: ["/no/such/path"] }],
    ["an empty", { registry_location: "" }],
    ["a missing", {}],
  ];
  for (const [label, locField] of malformedLocations) {
    test(`${label} registry_location is a malformed enrollment, not a fabricated path or an unreadable registry`, () => {
      const betaRoot = join(scratch, `badloc-${serial++}`, "beta");
      const f = fixture({
        name: "alpha",
        seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } },
        rawEntries: {
          beta: { root: betaRoot, ...locField, state: "registered" },
        },
      });
      const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
      // String(["/no/such/path"]) is "/no/such/path": without the string check
      // the array becomes an executable path and the verdict flips from
      // unreadable to stale enrollment. Fail closed instead.
      expect(err.code).toBe(4);
      expect(err.errorClass).toBe("pane_unknown");
      expect(err.action).toBe(MALFORMED_ENROLLMENT_HINT);
      expect(err.action).not.toBe(UNREADABLE_HINT);
      expect(err.action).not.toContain("tap admin refresh");
      expect(err.detail).toContain("malformed enrollment");
      expect(err.detail).toContain("beta");
      expect(err.detail).toContain("pane %5 was observed, so tmux is not the cause");
      expect(err.detail).not.toContain("could not be read");
      expect(err.detail).not.toContain("tmux state is unreadable");
      expect(err.detail).not.toContain("/no/such/path");
    });
  }

  test("a genuinely unreadable registry keeps registry_unreadable and its hint", () => {
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "beta", registryDir: true, seats: {} },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.code).toBe(4);
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(UNREADABLE_HINT);
    expect(err.detail).toContain("registered team(s) beta could not be read");
    expect(err.detail).not.toContain("malformed enrollment");
  });

  test("an unreadable registry beside a malformed enrollment keeps today's cause and names both", () => {
    const betaRoot = join(scratch, `mixed-${serial++}`, "beta");
    const f = fixture(
      { name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } },
      { name: "gamma", registryDir: true, seats: {}, rawEntries: { beta: { root: betaRoot, state: "registered" } } },
    );
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(UNREADABLE_HINT);
    expect(err.detail).toContain("registered team(s) gamma could not be read");
    expect(err.detail).toContain("malformed enrollment: beta");
  });

  test("a non-string team root never becomes a fabricated cd path", () => {
    const base = join(scratch, `badroot-${serial++}`);
    const index = join(base, "index");
    const cwd = join(base, "cwd");
    const alphaRoot = join(base, "alpha");
    mkdirSync(join(alphaRoot, ".tap"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(index, { recursive: true });
    writeFileSync(join(alphaRoot, ".tap", "team-registry.json"),
      JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: { alpha: { root: ["/fabricated"], registry_location: join(alphaRoot, ".tap", "team-registry.json"), state: "registered" } },
    }));
    const err = refusal(() => refuseUnanchoredPane("%5", cwd, 4, OBSERVED,
      { ...process.env, TAP_INDEX_HOME: index }, "%5", true));
    // Fail closed: the winning claimant's malformed root makes the remedy
    // unverifiable, so identity is unproven — never an unregistered miss that
    // invites a duplicate `tap register`, and never a fabricated `cd`.
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(MALFORMED_ROOT_HINT);
    expect(err.detail).not.toContain("tmux state is unreadable");
    expect(err.detail).toContain("pane %5 was observed");
    expect(err.detail).toContain("malformed team root");
    expect(err.detail).toContain("alpha/h1");
    expect(err.detail).not.toContain("/fabricated");
    expect(err.detail).not.toContain("tap register");
  });

  test("an observation with no session name routes to the incumbent pane_gone rebind refusal", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4,
      { session: "", serverEpoch: "" }, { ...process.env, TAP_INDEX_HOME: f.index }, "%5", true));
    expect(err.errorClass).toBe("pane_gone");
    expect(err.action).toBe("tap register   (the recorded pane is from a previous tmux server; re-register to rebind)");
    expect(err.detail).not.toContain("pass --team");
  });

  test("an observation with no server generation routes to the incumbent unknown refusal", () => {
    const f = fixture({ name: "alpha", seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } } });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4,
      { session: "s1", serverEpoch: "" }, { ...process.env, TAP_INDEX_HOME: f.index }, "%5", true));
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(TMUX_HINT);
    expect(err.detail).toContain("could not be observed");
    expect(err.detail).not.toContain("pass --team");
  });

  test("an invalid modern marker never licenses the legacy fallback", () => {
    const base = join(scratch, `badmarker-${serial++}`);
    const index = join(base, "index");
    const cwd = join(base, "cwd");
    const teamRoot = join(base, "alpha");
    mkdirSync(join(teamRoot, ".tap", "bus"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(index, { recursive: true });
    writeFileSync(join(teamRoot, ".tap", "bus", "registry.json"),
      JSON.stringify({ seats: { h1: { pane_id: "%5" } } }));
    writeFileSync(join(index, "teams.json"),
      JSON.stringify({ teams: { alpha: { root: teamRoot } } }));
    writeFileSync(join(index, "global-registry.json"), "{not json");
    const err = refusal(() => refuseUnanchoredPane("%5", cwd, 4, OBSERVED,
      { ...process.env, TAP_INDEX_HOME: index }, "%5", true));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toBe("tap register");
    expect(err.detail).toContain("no registry at cwd");
    expect(err.detail).not.toContain("pass --team");
  });

  test("an array-shaped teams entry is skipped, not an unreadable source poisoning a unique claim", () => {
    const f = fixture({
      name: "alpha",
      seats: { h1: { pane_id: "%5", session: "s1", server_epoch: "E2" } },
      rawEntries: { junk: ["not", "a", "team"] },
    });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toContain("pass --team alpha");
    expect(err.errorClass).not.toBe("pane_unknown");
  });

  test("invalid UTF-8 in an acting registry leaves uniqueness unproven, not a resolved remedy", () => {
    // The incumbent's Python reader refuses invalid bytes; Node's lax "utf8"
    // decode would replacement-decode the lone 0xE9 and hand identity
    // authority to a document the incumbent could never read.
    const f = fixture({
      name: "alpha",
      registryBytesRaw: Buffer.concat([
        Buffer.from('{"note":"caf', "utf8"),
        Buffer.from([0xe9]),
        Buffer.from('","seats":{"h1":{"pane_id":"%5","session":"s1","server_epoch":"E2"}}}', "utf8"),
      ]),
    });
    const err = refusal(() => refuseUnanchoredPane("%5", f.cwd, 4, OBSERVED, f.env, "%5", true));
    expect(err.errorClass).toBe("pane_unknown");
    expect(err.action).toBe(UNREADABLE_HINT);
    expect(err.detail).toContain("registered team(s) alpha could not be read");
    expect(err.action).not.toContain("pass --team");
    expect(err.detail).not.toContain("cd ");
  });
});
