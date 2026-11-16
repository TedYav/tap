import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearOwnInjection, clobberBand, type PaneEffects } from "../src/deliver";
import { removeScratchTree } from "./support/scratch";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tap-deliver."));
});

afterEach(() => removeScratchTree(root));

const BOUND = { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" };

function livePane(command = "claude") {
  return { paneId: "%7", session: "team/bob", serverEpoch: "srv:1:2", panePid: "1", currentCommand: command };
}

describe("clobberBand: the shared backup-then-clear door", () => {
  const SENTINEL = "[[TAP v0.23 note peer-20260918T120000Z-aabbccddeeff]]";

  function doorFx(initialBand: string) {
    let band = initialBand;
    const effects: string[] = [];
    const record = (effect: string) => effects.push(effect);
    const fx: PaneEffects = {
      observePane: () => livePane(),
      paneCurrentCommand: () => "claude",
      paneState: () => band ? { state: "busy", text: band } : { state: "ready" },
      clearInput: () => { record("clear"); band = ""; return true; },
      backspace: () => { record("backspace"); return true; },
      injectText: () => { record("inject"); return true; },
      inputHasId: () => true,
      pressEnter: () => { record("enter"); return true; },
      settle: () => {},
    };
    return { fx, effects, get band() { return band; }, set band(value: string) { band = value; } };
  }

  const backupReq = (dir: string) => ({ directory: dir, handle: "bob", payloadId: "payload-1", pane: "team/bob:0.0", paneId: "%7" });

  for (const spelling of ["wait", "warn"]) test(`${spelling} preserves foreign input at the final shared clobber door`, () => {
    const old = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    mkdirSync(join(root, "config/tap"), { recursive: true });
    writeFileSync(join(root, "config/tap/config.toml"), `[injection]\nbehavior="${spelling}"\n`);
    try {
      const door = doorFx(`HUMAN${SENTINEL}`);
      const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
      expect(verdict.kind).toBe("preserved"); expect(door.effects).toEqual([]);
      expect(door.band).toBe(`HUMAN${SENTINEL}`);
    } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
  });

  test("backs up only the foreign bytes and then clears", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    const dir = join(root, "input-backups");
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(dir), SENTINEL);
    expect(verdict.kind).toBe("cleared");
    if (verdict.kind !== "cleared") return;
    expect(verdict.backupPath).toBeTruthy();
    expect(verdict.lines).toBe(1);
    expect(verdict.chip).toBe(false);
    const body = readFileSync(verdict.backupPath!, "utf8");
    expect(body).toContain("recovery_policy: clobber");
    expect(body.endsWith("## Backed-up input\n\nBUG\n")).toBe(true);
    expect(body).not.toContain("TAP v0.23");
    expect(door.effects).toEqual(["clear"]);
    expect(door.band).toBe("");
  });

  test("visual wrapping inside our wire is not retained as foreign input", () => {
    const wrapped = SENTINEL.replace(" note ", "\n  note ");
    const door = doorFx(`BUG${wrapped}TAIL`);
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("cleared");
    if (verdict.kind !== "cleared") return;
    const body = readFileSync(verdict.backupPath!, "utf8");
    expect(body.endsWith("## Backed-up input\n\nBUGTAIL\n")).toBe(true);
    expect(body).not.toContain("TAP v0.23");
  });

  test("a backup failure stops the door before any pane key", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "x");
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(blocker), SENTINEL);
    expect(verdict.kind).toBe("backup-failed");
    expect(door.effects).toEqual([]);
  });

  test("identity drift during the clear is the identity verdict", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    door.fx.observePane = () => ({ ...livePane(), paneId: "%9" });
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("identity");
  });

  test("identity is re-read between the clear key and the continuation key", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    let cleared = false;
    // The clear key leaves the band occupied, and the pane is replaced before the next key.
    door.fx.clearInput = () => { door.effects.push("clear"); cleared = true; return true; };
    door.fx.observePane = () => cleared ? { ...livePane(), paneId: "%9" } : livePane();
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("identity");
    expect(door.effects).toEqual(["clear"]);
  });

  test("a reused pane id from another server generation is the identity verdict", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    door.fx.observePane = () => ({ ...livePane(), serverEpoch: "srv:9:9" });
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("identity");
    expect(door.effects).toEqual([]);
  });

  test("pane loss during the clear is the gone verdict", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    door.fx.observePane = () => null;
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("gone");
  });

  test("paste-chip residue is distinct from plain residue and never clears", () => {
    const chip = doorFx("reasoning [Pasted text #1]");
    chip.fx.clearInput = () => { chip.effects.push("clear"); return true; };
    const chipVerdict = clobberBand("%7", "claude", BOUND, chip.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(chipVerdict.kind).toBe("chip-residue");
    if (chipVerdict.kind === "chip-residue" || chipVerdict.kind === "residue") expect(chipVerdict.chip).toBe(true);

    const plain = doorFx("half a thought");
    plain.fx.clearInput = () => { plain.effects.push("clear"); return true; };
    const plainVerdict = clobberBand("%7", "claude", BOUND, plain.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(plainVerdict.kind).toBe("possible-failure");
    if (plainVerdict.kind === "chip-residue" || plainVerdict.kind === "residue") expect(plainVerdict.chip).toBe(false);
  });

  test("a band that is exactly our wire has nothing foreign to back up", () => {
    const door = doorFx(SENTINEL);
    const verdict = clobberBand("%7", "claude", BOUND, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("cleared");
    if (verdict.kind !== "cleared") return;
    expect(verdict.backupPath).toBeUndefined();
    expect(existsSync(join(root, "input-backups"))).toBe(false);
  });
});

describe("clearOwnInjection: a withheld control takes back only its own bytes (tap-arm4w)", () => {
  const WIRE = "/compact keep the gate loop; next report is report-25 [[sv:self-20260923T172121Z-cbe03497]]";
  function ownFx(initialBand: string) {
    let band = initialBand;
    const effects: string[] = [];
    const fx: PaneEffects = {
      observePane: () => livePane(),
      paneCurrentCommand: () => "claude",
      paneState: () => band ? { state: "busy", text: band } : { state: "ready" },
      clearInput: () => { effects.push("clear"); band = ""; return true; },
      backspace: () => { effects.push("backspace"); return true; },
      injectText: () => { effects.push("inject"); return true; },
      inputHasId: () => true,
      pressEnter: () => { effects.push("enter"); return true; },
      settle: () => {},
    };
    return { fx, effects, get band() { return band; }, setBand: (value: string) => { band = value; } };
  }
  const bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" };

  test("our bytes exactly, across Claude's visual wrap, are cleared with no Enter", () => {
    const door = ownFx(WIRE.replace(" next ", "\n  next "));
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("cleared");
    expect(door.effects).toEqual(["clear"]);
    expect(door.band).toBe("");
  });

  test("our bytes plus foreign bytes are left untouched", () => {
    for (const band of [`${WIRE} and my draft`, `draft ${WIRE}`, WIRE.replace("report-25", "report-26")]) {
      const door = ownFx(band);
      expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("foreign");
      expect(door.effects).toEqual([]);
      expect(door.band).toBe(band);
    }
  });

  test("an empty or unreadable band takes no key", () => {
    const empty = ownFx("");
    expect(clearOwnInjection("%7", "claude", bound, empty.fx, "self-1", WIRE)).toBe("absent");
    const blind = ownFx(WIRE);
    blind.fx.paneState = () => ({ state: "unobservable", reason: "feedback panel" });
    expect(clearOwnInjection("%7", "claude", bound, blind.fx, "self-1", WIRE)).toBe("unread");
    expect([...empty.effects, ...blind.effects]).toEqual([]);
  });

  test("a draft typed between keys stops the next C-u (ownership re-read per key)", () => {
    const door = ownFx(WIRE);
    let rounds = 0;
    door.fx.clearInput = () => {
      door.effects.push("clear");
      rounds++;
      // The first C-u clears only the last row; the human then types a draft.
      door.setBand(rounds === 1 ? "/compact keep the gate loop; my draft" : "");
      return true;
    };
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("residue");
    expect(door.effects).toEqual(["clear"]);
    expect(door.band).toBe("/compact keep the gate loop; my draft");
  });

  test("a band that grows between keys stops even when the typed words occur in our command", () => {
    const door = ownFx(WIRE);
    let rounds = 0;
    door.fx.clearInput = () => {
      door.effects.push("clear");
      rounds++;
      door.setBand(rounds === 1 ? "/compact keep" : rounds === 2 ? "/compact keep the" : "");
      return true;
    };
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("residue");
    expect(door.effects).toEqual(["clear", "clear"]);
    expect(door.band).toBe("/compact keep the");
    // A band that does not shrink after a C-u is not ours to press again either.
    const stuck = ownFx(WIRE);
    stuck.fx.clearInput = () => { stuck.effects.push("clear"); stuck.setBand("/compact keep"); return true; };
    expect(clearOwnInjection("%7", "claude", bound, stuck.fx, "self-1", WIRE)).toBe("residue");
    expect(stuck.effects).toEqual(["clear", "clear"]);
  });

  test("an own remainder after a partial C-u is cleared on the next round", () => {
    const door = ownFx(WIRE);
    let rounds = 0;
    door.fx.clearInput = () => { door.effects.push("clear"); rounds++; door.setBand(rounds === 1 ? "/compact keep the gate loop;" : ""); return true; };
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("cleared");
    expect(door.effects).toEqual(["clear", "clear"]);
  });

  test("a drifted pane generation refuses the clear", () => {
    const door = ownFx(WIRE);
    door.fx.observePane = () => ({ ...livePane(), serverEpoch: "srv:9:9" });
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("identity");
    expect(door.effects).toEqual([]);
  });
});
