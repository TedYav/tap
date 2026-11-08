import { describe, expect, test } from "bun:test";
import { TapError } from "../src/context";
import { DEFAULT_STALE_AFTER } from "../src/roster-stalled";
import { SEAT_STATES, displayState, emptySeatFilters, hasSeatFilters, idleSeconds, isSeatFilterFlag, seatMatches, takeSeatFilters, type SeatFacts, type SeatFilters } from "../src/seat-filter";

const seat = (over: Partial<SeatFacts> = {}): SeatFacts => ({ harness: "claude", models: ["claude-opus-5-5"], state: "working", idleSeconds: null, ...over });
const filters = (over: Partial<SeatFilters>): SeatFilters => ({ ...emptySeatFilters(), ...over });
const parsed = (...argv: string[]) => takeSeatFilters(argv, "tap help team");
const refusal = (...argv: string[]): TapError => {
  try { parsed(...argv); } catch (error) { if (error instanceof TapError) return error; throw error; }
  throw new Error(`no refusal for ${argv.join(" ")}`);
};

describe("takeSeatFilters", () => {
  test("removes the three flags and keeps every other token in order", () => {
    const { filters: seen, rest } = parsed("roster", "--harness", "codex", "--json", "--model=opus", "alpha", "--state", "idle");
    expect(seen).toEqual({ harness: ["codex"], model: ["opus"], state: ["idle"] });
    expect(rest).toEqual(["roster", "--json", "alpha"]);
  });

  test("comma lists trim, lowercase, drop empties and accumulate across repeats", () => {
    expect(parsed("--harness", " Codex,CLAUDE,,", "--harness=agy").filters.harness).toEqual(["codex", "claude", "agy"]);
    expect(parsed("--model", "Opus,GLM").filters.model).toEqual(["opus", "glm"]);
    expect(parsed("--state", "IDLE,Active").filters.state).toEqual(["idle", "active"]);
  });

  test("a value is required and an option is not a value", () => {
    for (const argv of [["--harness"], ["--model", "--json"], ["--state", ","], ["--state="]]) {
      const error = refusal(...argv);
      expect(error.errorClass).toBe("usage_error");
      expect(error.detail).toContain("needs a comma list of values");
      expect(error.action).toBe("tap help team");
    }
  });

  test("a bad state refuses and lists every valid value", () => {
    const error = refusal("--state", "idle,sleeping");
    expect(error.errorClass).toBe("usage_error");
    expect(error.detail).toContain("'sleeping'");
    for (const state of [...SEAT_STATES, "active"]) expect(error.detail).toContain(state);
  });

  test("a bad harness refuses and lists the families and daemon", () => {
    const error = refusal("--harness", "bash");
    expect(error.detail).toContain("'bash'");
    for (const name of ["claude", "codex", "opencode", "cursor", "hermes", "agy", "daemon"]) expect(error.detail).toContain(name);
  });

  test("tokens after -- are operands, not filters", () => {
    expect(parsed("--", "--state", "bogus")).toEqual({ filters: emptySeatFilters(), rest: ["--", "--state", "bogus"] });
  });

  test("a pass-through flag keeps the word typed after it, so no filter takes it or is taken by it", () => {
    const pass = (...argv: string[]) => takeSeatFilters(argv, "tap help team", ["-n"]);
    // -n's value word stays with it, even when that word is a filter flag.
    expect(pass("-n", "--harness", "codex", "2")).toEqual({ filters: emptySeatFilters(), rest: ["-n", "--harness", "codex", "2"] });
    expect(pass("--harness", "codex", "-n", "2", "web")).toEqual({ filters: filters({ harness: ["codex"] }), rest: ["-n", "2", "web"] });
    // A filter whose next word is -n has no value, as without the pass-through.
    expect(() => pass("--harness", "-n", "2", "codex")).toThrow("--harness needs a comma list of values");
    // `--` is never the value: the scan still stops there.
    expect(pass("-n", "--", "--state", "x")).toEqual({ filters: emptySeatFilters(), rest: ["-n", "--", "--state", "x"] });
    expect(pass("--model", "opus", "-n")).toEqual({ filters: filters({ model: ["opus"] }), rest: ["-n"] });
    // Without the option, -n is an ordinary word and the filter after it is lifted.
    expect(parsed("-n", "--harness", "codex")).toEqual({ filters: filters({ harness: ["codex"] }), rest: ["-n"] });
  });

  test("names the flag in both spellings and nothing else", () => {
    for (const arg of ["--harness", "--harness=a", "--model", "--state=idle"]) expect(isSeatFilterFlag(arg)).toBe(true);
    for (const arg of ["--harnesses", "--stale-after", "--states", "harness"]) expect(isSeatFilterFlag(arg)).toBe(false);
    expect(hasSeatFilters(emptySeatFilters())).toBe(false);
    expect(hasSeatFilters(filters({ model: ["x"] }))).toBe(true);
  });
});

describe("seatMatches", () => {
  test("no filters keep every seat", () => {
    expect(seatMatches(emptySeatFilters(), seat({ state: "offline" }))).toBe(true);
  });

  test("items within a flag OR; different flags AND", () => {
    const either = filters({ harness: ["codex", "claude"] });
    expect(seatMatches(either, seat())).toBe(true);
    expect(seatMatches(either, seat({ harness: "agy" }))).toBe(false);
    const both = filters({ harness: ["claude"], state: ["idle"] });
    expect(seatMatches(both, seat({ state: "idle" }))).toBe(true);
    expect(seatMatches(both, seat({ state: "working" }))).toBe(false);
    expect(seatMatches(both, seat({ harness: "codex", state: "idle" }))).toBe(false);
  });

  test("harness matches its family, as tap nudge --harness does, and daemon matches the displayed label", () => {
    const claude = filters({ harness: ["claude"] });
    expect(seatMatches(claude, seat({ harness: "claude-code" }))).toBe(true);
    expect(seatMatches(claude, seat({ harness: "Claude" }))).toBe(true);
    expect(seatMatches(claude, seat({ harness: "claudette" }))).toBe(false);
    const daemon = filters({ harness: ["daemon"] });
    expect(seatMatches(daemon, seat({ harness: "daemon" }))).toBe(true);
    expect(seatMatches(daemon, seat({ harness: "gateway", daemon: true }))).toBe(true);
    expect(seatMatches(daemon, seat())).toBe(false);
  });

  test("model is a substring of the raw id or the short name, observed or launch", () => {
    for (const item of ["opus", "OPUS5.5".toLowerCase(), "5.5", "claude-opus"]) {
      expect(seatMatches(filters({ model: [item] }), seat())).toBe(true);
    }
    const glm = seat({ models: [null, "zai-coding-plan/glm-5.3"] });
    for (const item of ["glm", "glm5.3", "zai"]) expect(seatMatches(filters({ model: [item] }), glm)).toBe(true);
    expect(seatMatches(filters({ model: ["opus"] }), seat({ models: ["gpt-6-astra", "opus[1m]"] }))).toBe(true);
    expect(seatMatches(filters({ model: ["fable", "opus"] }), seat())).toBe(true);
    expect(seatMatches(filters({ model: ["fable"] }), seat())).toBe(false);
    expect(seatMatches(filters({ model: ["opus"] }), seat({ models: [null, undefined, ""] }))).toBe(false);
  });

  test("a named state matches only that state", () => {
    for (const state of SEAT_STATES) {
      expect(seatMatches(filters({ state: [state] }), seat({ state }))).toBe(true);
      expect(seatMatches(filters({ state: [state === "idle" ? "working" : "idle"] }), seat({ state }))).toBe(false);
    }
  });

  test("active keeps live seats and drops offline, incapable and unbound", () => {
    const active = filters({ state: ["active"] });
    for (const state of ["working", "error", "unknown", "blocked", "waiting", "booting", "overprint", "unsubmitted", "ready"]) {
      expect(seatMatches(active, seat({ state }))).toBe(true);
    }
    for (const state of ["offline", "incapable", "unbound"]) expect(seatMatches(active, seat({ state }))).toBe(false);
  });

  test("active drops an idle seat at exactly the shared threshold, and keeps it one second under", () => {
    const active = filters({ state: ["active"] });
    expect(DEFAULT_STALE_AFTER).toBe(600);
    expect(seatMatches(active, seat({ state: "idle", idleSeconds: 599 }))).toBe(true);
    expect(seatMatches(active, seat({ state: "idle", idleSeconds: 600 }))).toBe(false);
    expect(seatMatches(active, seat({ state: "idle", idleSeconds: 601 }))).toBe(false);
  });

  test("an undated idle seat stays active: it cannot be shown stale", () => {
    expect(seatMatches(filters({ state: ["active"] }), seat({ state: "idle", idleSeconds: null }))).toBe(true);
  });

  test("a long-idle seat is still selected by naming idle alongside active", () => {
    expect(seatMatches(filters({ state: ["active", "idle"] }), seat({ state: "idle", idleSeconds: 9000 }))).toBe(true);
  });
});

describe("state facts", () => {
  const facts = { status: "active", statusReason: "", agentState: "idle", agentStateReason: "", daemon: false };
  test("displayState is the roster's state column", () => {
    expect(displayState(facts)).toBe("idle");
    expect(displayState({ ...facts, daemon: true })).toBe("ready");
    expect(displayState({ ...facts, agentStateReason: "sentinel_unsubmitted" })).toBe("unsubmitted");
    expect(displayState({ ...facts, status: "suspended", statusReason: "incapable" })).toBe("incapable");
    expect(displayState({ ...facts, status: "suspended" })).toBe("offline");
    expect(displayState({ ...facts, status: "unbound" })).toBe("unbound");
    expect(displayState({ ...facts, status: "pending" })).toBe("offline");
    expect(displayState({ ...facts, status: "offline", daemon: true })).toBe("offline");
  });

  test("idleSeconds dates only an idle seat with a finite turn end", () => {
    expect(idleSeconds("idle", 1000, 1600)).toBe(600);
    expect(idleSeconds("working", 1000, 1600)).toBeNull();
    expect(idleSeconds("idle", null, 1600)).toBeNull();
    expect(idleSeconds("idle", undefined, 1600)).toBeNull();
    expect(idleSeconds("idle", Number.NaN, 1600)).toBeNull();
  });
});
