/**
 * Parity for the clearing fence's read half against a FROZEN capture of the
 * Python it replaces.
 *
 * The oracle is a capture rather than a live twin because this slice deletes
 * `clear_fence.inspect` and `notice_expired_once` in the same PR, and the arms
 * that drove them directly go with them. The capture was taken while the Python
 * still existed, records the blob it came from, and replayed identically on the
 * current interpreter and the 3.11 installer floor.
 *
 * `raised` rows are not skipped. The incumbent exits nonzero there, and the one
 * door that calls it maps any nonzero to "already noticed" — so the row pins a
 * DOOR observable (no warning, nothing written), not a traceback.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  busForRegistry,
  ClearFenceOverflow,
  ClearFenceUnreadable,
  type ClearFenceState,
  fencePath,
  firstLiveFence,
  noticeExpiredOnce,
  noticePath,
  pythonFloat,
  pythonStrip,
  readClearFence,
} from "../src/clear-fence";
import { inspectClearFence } from "../src/courier";

interface OracleCase {
  group: string;
  case: string;
  marker?: unknown;
  marker_bytes?: string;
  now?: number | null;
  state?: string;
  rec?: Record<string, unknown> | null;
  raised?: string;
  sidecar_seed?: string | null;
  sidecar?: string | null;
  returned?: boolean;
  handle?: string;
  seats?: [string, string][];
  first_live?: string;
  sidecar_seed_hex?: string | null;
  sidecar_hex?: string | null;
  sidecar_hex_after?: string | null;
  fence_path?: string;
  notice_path?: string;
  floor_agrees: boolean | null;
}

const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/clear-fence-oracle.json", import.meta.url), "utf8"),
) as { captured_from: { head: string; blobs: Record<string, string> }; cases: OracleCase[] };

// The runner allocates this; there is no afterAll, deliberately. A cleanup hook
// that stats the tree is a flake on a busy box, and the runner already owns the
// scratch root it hands us.
// realpath'd on purpose: busForRegistry resolves symlinks the way Path.resolve
// does, and on macOS the runner's scratch sits under /tmp -> /private/tmp. A
// test that named the logical path would be asserting the platform, not the
// port. The dedicated arm below proves the resolution still happens.
const scratch = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "clear-fence-")));
let counter = 0;
function bus(): string {
  const dir = join(scratch, `bus-${counter++}`);
  mkdirSync(join(dir, "clear-fence"), { recursive: true });
  return dir;
}

function seedMarker(dir: string, content: unknown, bytes?: string): void {
  const target = join(dir, "clear-fence", "midclear.json");
  if (bytes === "DIR") {
    mkdirSync(target);
    return;
  }
  if (bytes !== undefined) {
    writeFileSync(target, Buffer.from(bytes, "latin1"));
    return;
  }
  if (content !== null && content !== undefined) writeFileSync(target, String(content), "utf8");
}

const byGroup = (name: string) => oracle.cases.filter(row => row.group === name);

// The captured record can hold inf/nan, which Python serializes as literals no
// strict JSON reader accepts. They travel as sentinels; this puts them back so
// the arms still compare the record BY VALUE rather than skipping those rows.
function revive(value: unknown): unknown {
  // Non-finite floats travel as {"__nonfinite__": ...}, never as a magic
  // string. A marker may legitimately contain the magic string — the
  // `json_sentinel_*` rows do — and a string-keyed decoding would turn that
  // string into a number, which is the exact defect those rows exist to pin.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const tag = (value as Record<string, unknown>).__nonfinite__;
    if (Object.keys(value).length === 1 && typeof tag === "string") {
      if (tag === "nan") return Number.NaN;
      if (tag === "inf") return Number.POSITIVE_INFINITY;
      if (tag === "-inf") return Number.NEGATIVE_INFINITY;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  if (Array.isArray(value)) return value.map(revive);
  return value;
}

describe("clear-fence oracle provenance", () => {
  test("the fixture pins the blob it was captured from", () => {
    expect(oracle.captured_from.blobs["skills/tap/scripts/clear_fence.py"]).toBe(
      "68b14386dd8ea62121682c30bdfc45eb267e5b4c",
    );
  });

  test("every case replayed identically on the 3.11 installer floor", () => {
    const diverged = oracle.cases.filter(row => row.floor_agrees === false).map(row => row.case);
    expect(diverged).toEqual([]);
    expect(oracle.cases.filter(row => row.floor_agrees === true).length).toBeGreaterThan(80);
  });

  // A replay that reaches zero rows passes vacuously. Each group asserts its
  // own floor so a renamed group cannot quietly empty one of them.
  test("each group carries the cases its arms claim to replay", () => {
    expect(byGroup("inspect").length).toBe(29);
    expect(byGroup("numeric").length).toBe(16);
    expect(byGroup("json").length).toBe(16);
    expect(byGroup("scan").length).toBe(9);
    expect(byGroup("readerr").length).toBe(6);
    expect(byGroup("notice").length).toBe(23);
    expect(byGroup("handle").length).toBe(21);
  });
});

describe("readClearFence replays the frozen inspect", () => {
  for (const row of [...byGroup("inspect"), ...byGroup("numeric"), ...byGroup("json")]) {
    test(`${row.group}: ${row.case}`, () => {
      const dir = bus();
      seedMarker(dir, row.marker);
      if (row.raised === "OverflowError") {
        // float(int) on an out-of-range integer raises OverflowError, an
        // ArithmeticError, which `except (TypeError, ValueError)` does not
        // catch — so it escapes `inspect` and each door applies its polarity.
        expect(() => readClearFence(dir, "midclear", row.now ?? undefined))
          .toThrow(ClearFenceOverflow);
        return;
      }
      const observed = readClearFence(dir, "midclear", row.now ?? undefined);
      expect(observed.state).toBe(row.state as ClearFenceState);
      // The rec half is the malformed-vs-unreadable distinction, so it is
      // asserted by VALUE, not merely for presence.
      expect(observed.rec).toEqual(revive(row.rec ?? null) as Record<string, unknown> | null);
    });
  }
});

describe("a marker that cannot be DECODED raises rather than reading absent", () => {
  for (const row of byGroup("readerr")) {
    test(row.case, () => {
      const dir = bus();
      seedMarker(dir, undefined, row.marker_bytes);
      if (row.raised === "UnicodeDecodeError") {
        expect(() => readClearFence(dir, "midclear", 1)).toThrow(ClearFenceUnreadable);
        return;
      }
      const observed = readClearFence(dir, "midclear", row.now ?? undefined);
      expect(observed.state).toBe(row.state as ClearFenceState);
    });
  }

  test("the two doors read one raise oppositely", () => {
    const dir = bus();
    writeFileSync(join(dir, "clear-fence", "midclear.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    // The reset door: the scan itself fails, and refusing is the clean-team claim.
    expect(() => firstLiveFence(dir)).toThrow(ClearFenceUnreadable);
    // The courier door: the ACTUAL wrapper the send path calls, not the reader
    // underneath it. An earlier version of this arm invoked readClearFence
    // twice and asserted it threw both times — which is true, and says nothing
    // about whether the courier still fails open. The asymmetry lives in the
    // wrapper's catch, so the wrapper is what has to be exercised.
    expect(inspectClearFence(dir, "midclear")).toBe("absent");
  });

  test("the courier wrapper swallows the overflow too, and the reset does not", () => {
    const dir = bus();
    writeFileSync(
      join(dir, "clear-fence", "midclear.json"),
      `{"nonce":"n1","since_epoch":-1${"0".repeat(400)},"ceiling_seconds":90}`,
      "utf8",
    );
    expect(inspectClearFence(dir, "midclear")).toBe("absent");
    expect(() => firstLiveFence(dir, 1_700_000_000)).toThrow(ClearFenceOverflow);
  });
});

describe("noticeExpiredOnce replays the frozen sidecar", () => {
  for (const row of byGroup("notice")) {
    test(row.case, () => {
      const dir = bus();
      if (row.sidecar_seed_hex) {
        writeFileSync(join(dir, "clear-fence", "midclear.json.expired-notice"),
                      Buffer.from(row.sidecar_seed_hex, "hex"));
      } else if (row.sidecar_seed !== null && row.sidecar_seed !== undefined) {
        writeFileSync(join(dir, "clear-fence", "midclear.json.expired-notice"), row.sidecar_seed, "utf8");
      }
      const rec = (row as { rec?: Record<string, unknown> | null }).rec;
      const sidecar = join(dir, "clear-fence", "midclear.json.expired-notice");
      const read = () => { try { return readFileSync(sidecar, "utf8"); } catch { return null; } };
      const hex = () => { try { return readFileSync(sidecar).toString("hex"); } catch { return null; } };
      if (row.raised === "UnicodeDecodeError") {
        // Raised BEFORE the write, so the bytes are untouched. Asserted in HEX
        // against what survived in the capture: a lenient read would compare
        // replacement characters, miss, and overwrite content it could not read.
        expect(() => noticeExpiredOnce(dir, "midclear", rec ?? null)).toThrow(ClearFenceUnreadable);
        expect(hex()).toBe(row.sidecar_hex_after ?? null);
        return;
      }
      const returned = noticeExpiredOnce(dir, "midclear", rec ?? null);
      if (row.raised !== undefined) {
        // The incumbent raised before it could write. At the only door, the
        // traceback exits 1 and `[ "$rc" -eq 0 ] || return 0` reads that as
        // "already noticed": no warning, and the sidecar UNCHANGED — still the
        // seed if there was one, still absent if there was not. The capture
        // reports no sidecar for these rows because it never got that far, so
        // the seed is what the assertion compares against.
        expect(returned).toBe(false);
        expect(read()).toBe(row.sidecar_seed ?? null);
        return;
      }
      expect(returned).toBe(row.returned as boolean);
      expect(read()).toBe(row.sidecar ?? null);
    });
  }

  test("a sidecar write failure warns every time", () => {
    const dir = bus();
    const sidecar = noticePath(dir, "midclear");
    mkdirSync(sidecar);

    expect(noticeExpiredOnce(dir, "midclear", { nonce: "nonce-1" })).toBe(true);
    expect(noticeExpiredOnce(dir, "midclear", { nonce: "nonce-1" })).toBe(true);
    expect(statSync(sidecar).isDirectory()).toBe(true);
  });
});

describe("fencePath and noticePath replay the frozen handle table", () => {
  for (const row of byGroup("handle")) {
    test(`${row.case}: ${JSON.stringify(row.handle)}`, () => {
      expect(fencePath("/BUS", row.handle as string)).toBe(join("/BUS", row.fence_path as string));
      expect(noticePath("/BUS", row.handle as string)).toBe(join("/BUS", row.notice_path as string));
    });
  }
});

describe("the ported primitives are not their JavaScript lookalikes", () => {
  test("pythonStrip is not trim: the separators and the BOM go opposite ways", () => {
    // Python strips these; trim() keeps them.
    for (const ch of ["\x1c", "\x1d", "\x1e", "\x1f", "\x85"]) {
      expect(pythonStrip(`seat${ch}`)).toBe("seat");
      expect(`seat${ch}`.trim()).toBe(`seat${ch}`);
    }
    // trim() strips the BOM; Python keeps it, so it stays part of the filename.
    expect(pythonStrip("seat﻿")).toBe("seat﻿");
    expect("seat﻿".trim()).toBe("seat");
  });

  test("pythonFloat is not Number on inputs a marker can carry", () => {
    expect(pythonFloat("1_000")).toBe(1000);
    expect(Number("1_000")).toBeNaN();
    expect(pythonFloat("infinity")).toBe(Number.POSITIVE_INFINITY);
    expect(Number("infinity")).toBeNaN();
    expect(pythonFloat("nan")).toBeNaN();
    // float() REFUSES these two; Number() happily converts them.
    expect(pythonFloat("0x10")).toBeNull();
    expect(Number("0x10")).toBe(16);
    expect(pythonFloat([1])).toBeNull();
    expect(Number([1])).toBe(1);
    // ...and the empty string, where Number()'s 0 would read as a zero ceiling.
    expect(pythonFloat("")).toBeNull();
    expect(Number("")).toBe(0);
  });

  test("the numeric repertoire is pinned to ASCII digits, so non-ASCII decimals are unparseable", () => {
    // Deliberate change: float("٥.٥") is 5.5 in Python, and this reader used to
    // agree. The interpreters disagree on digits added after Unicode 14, so the
    // reader no longer follows any runtime's table.
    expect(pythonFloat("٥.٥")).toBeNull(); // ARABIC-INDIC FIVE
    expect(pythonFloat("\u{11F51}")).toBeNull(); // KAWI ONE: Unicode 15
    expect(pythonFloat("\u{1E4F1}")).toBeNull(); // NAG MUNDARI ONE: Unicode 15
    expect(pythonFloat("१")).toBeNull(); // DEVANAGARI ONE
    expect(pythonFloat("\uFF11")).toBeNull(); // FULLWIDTH ONE
    // A single foreign digit poisons an otherwise ASCII string, in any slot.
    expect(pythonFloat("1\u0661")).toBeNull();
    expect(pythonFloat("1.5e\u0661")).toBeNull();
    expect(pythonFloat("1_\u0661")).toBeNull();
    // Case-insensitive keywords must not admit look-alike letters.
    expect(pythonFloat("\u0131nf")).toBeNull(); // dotless i
  });

  test("ASCII strings keep their verdicts after the repertoire pin", () => {
    expect(pythonFloat("5.5")).toBe(5.5);
    expect(pythonFloat("  90  ")).toBe(90);
    expect(pythonFloat("\u00a090\u3000")).toBe(90);
    expect(pythonFloat("1_0.5_0e1_0")).toBe(10.5e10);
    expect(pythonFloat("-.5")).toBe(-0.5);
    expect(pythonFloat("+INF")).toBe(Number.POSITIVE_INFINITY);
    expect(pythonFloat("-Infinity")).toBe(Number.NEGATIVE_INFINITY);
    expect(pythonFloat("NaN")).toBeNaN();
    expect(pythonFloat(90)).toBe(90);
    expect(pythonFloat(true)).toBe(1);
    // Underscore placement still follows float(): doubled or edge underscores refuse.
    expect(pythonFloat("1__0")).toBeNull();
    expect(pythonFloat("_10")).toBeNull();
    expect(pythonFloat("10_")).toBeNull();
    // The numeric trim set is explicit: it keeps the BOM and the ASCII separators.
    expect(pythonFloat("90\uFEFF")).toBeNull();
    expect(pythonFloat("90\x1c")).toBeNull();
  });

  test.each([
    ["Kawi digits", "\u{11F51}\u{11F50}"],
    ["Arabic-Indic digits: a deliberate change from the old Python-matching reader", "\u0661\u0660"],
  ])("a ceiling_seconds string of %s reads absent, never live", (_name, digits) => {
    const dir = bus();
    const since = 1_700_000_000;
    seedMarker(dir, JSON.stringify({ nonce: "n1", since_epoch: since, ceiling_seconds: digits }));
    expect(readClearFence(dir, "midclear", since + 1).state).toBe("absent");
    seedMarker(dir, JSON.stringify({ nonce: "n1", since_epoch: digits, ceiling_seconds: 90 }));
    expect(readClearFence(dir, "midclear", since + 1).state).toBe("absent");
    // The ASCII twin of the same marker is live.
    seedMarker(dir, JSON.stringify({ nonce: "n1", since_epoch: since, ceiling_seconds: "90" }));
    expect(readClearFence(dir, "midclear", since + 1).state).toBe("live");
  });

  test("the clock is injected in SECONDS, and milliseconds would expire every fence", () => {
    const dir = bus();
    const since = 1_700_000_000;
    writeFileSync(
      join(dir, "clear-fence", "midclear.json"),
      JSON.stringify({ nonce: "n1", since_epoch: since, ceiling_seconds: 90 }),
      "utf8",
    );
    expect(readClearFence(dir, "midclear", since + 1).state).toBe("live");
    expect(readClearFence(dir, "midclear", (since + 1) * 1000).state).toBe("expired");
  });
});

describe("firstLiveFence keeps the reset scan's order and its blind spot", () => {
  function seat(dir: string, handle: string, since: number, ceiling: number): void {
    writeFileSync(
      join(dir, "clear-fence", `${handle}.json`),
      JSON.stringify({ nonce: handle, since, since_epoch: since, pid: 1, ceiling_seconds: ceiling }),
      "utf8",
    );
  }

  test("sorted by path, first live wins", () => {
    const dir = bus();
    const now = 1_700_000_000;
    seat(dir, "alpha", now - 500, 90);   // expired
    seat(dir, "bravo", now, 90);          // live
    seat(dir, "charlie", now, 90);        // live, but later in sort order
    expect(firstLiveFence(dir, now + 1)).toBe("bravo");
  });

  test("no live fence is an empty answer, not a refusal", () => {
    const dir = bus();
    seat(dir, "alpha", 1_700_000_000 - 500, 90);
    expect(firstLiveFence(dir, 1_700_000_000)).toBe("");
  });

  test("the notice sidecar is not a marker and is never scanned", () => {
    const dir = bus();
    const now = 1_700_000_000;
    // A sidecar whose CONTENT would read live if it were ever globbed.
    writeFileSync(
      join(dir, "clear-fence", "alpha.json.expired-notice"),
      JSON.stringify({ since_epoch: now, ceiling_seconds: 90 }),
      "utf8",
    );
    expect(firstLiveFence(dir, now + 1)).toBe("");
  });

  test("a bus with no clear-fence directory is absent, not an error", () => {
    expect(firstLiveFence(join(scratch, "no-such-bus"))).toBe("");
  });
});

describe("firstLiveFence replays the frozen reset scan", () => {
  for (const row of byGroup("scan")) {
    test(row.case, () => {
      const dir = bus();
      const since = 1_700_000_000;
      for (const [handle, state] of row.seats ?? []) {
        const age = state === "live" ? 1 : 10_000;
        writeFileSync(
          join(dir, "clear-fence", `${handle}.json`),
          JSON.stringify({ nonce: handle || "empty", since: "stamp", pid: 1,
                           since_epoch: since - age, ceiling_seconds: 90 }),
          "utf8",
        );
      }
      expect(firstLiveFence(dir, since)).toBe(row.first_live as string);
    });
  }
});

describe("busForRegistry", () => {
  test("post-flip .tap/bus wins over the registry's own parent", () => {
    const root = join(scratch, "flip");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    writeFileSync(join(root, ".tap", "team-registry.json"), "{}", "utf8");
    expect(busForRegistry(join(root, ".tap", "team-registry.json"))).toBe(join(root, ".tap", "bus"));
  });

  test("pre-flip: registry.json lives IN the bus", () => {
    const root = join(scratch, "preflip");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "registry.json"), "{}", "utf8");
    expect(busForRegistry(join(root, "registry.json"))).toBe(root);
  });

  test("a .tap parent with no bus child stays the parent", () => {
    const root = join(scratch, "nobus");
    mkdirSync(join(root, ".tap"), { recursive: true });
    writeFileSync(join(root, ".tap", "registry.json"), "{}", "utf8");
    expect(busForRegistry(join(root, ".tap", "registry.json"))).toBe(join(root, ".tap"));
  });

  test("a symlinked registry resolves to its physical bus", () => {
    const real = join(scratch, "physical");
    mkdirSync(join(real, ".tap", "bus"), { recursive: true });
    writeFileSync(join(real, ".tap", "team-registry.json"), "{}", "utf8");
    const link = join(scratch, "link-to-registry.json");
    symlinkSync(join(real, ".tap", "team-registry.json"), link);
    // A lexical resolve() would answer the SYMLINK's own parent, which has no
    // bus and is not named .tap.
    expect(busForRegistry(link)).toBe(join(real, ".tap", "bus"));
  });

  test("\"..\" pops the PHYSICAL parent, not the lexical one", () => {
    // Both halves are supported shapes here — symlinked registries and absent
    // files — so their composition is reachable. `alias -> actual/sub`, so
    // `alias/..` is `actual`, and the bus is `actual/team/.tap/bus`. A lexical
    // resolve() collapses `alias/..` to the scratch root first and selects a
    // DIFFERENT team's bus, which reads the wrong seat's marker.
    const root = join(scratch, "physdots");
    mkdirSync(join(root, "actual", "sub"), { recursive: true });
    mkdirSync(join(root, "actual", "team", ".tap", "bus"), { recursive: true });
    mkdirSync(join(root, "team", ".tap", "bus"), { recursive: true });
    symlinkSync(join(root, "actual", "sub"), join(root, "alias"));
    // Built by concatenation, NOT join(): join() collapses ".." lexically, so a
    // path assembled with it never reaches the resolver with the "..'" still in
    // it and the arm would pass against either implementation.
    expect(busForRegistry(`${root}/alias/../team/.tap/missing.json`))
      .toBe(join(root, "actual", "team", ".tap", "bus"));
    // ...and with no symlink in the way the two agree, which is the control
    // that keeps the arm above about symlink ORDER rather than about "..".
    expect(busForRegistry(`${root}/actual/sub/../team/.tap/missing.json`))
      .toBe(join(root, "actual", "team", ".tap", "bus"));
  });

  test("a DANGLING registry symlink is still followed", () => {
    // resolve() follows a link whose target does not exist yet, and a registry
    // link written before its file is an ordinary shape — clear-fence-absent-fast
    // builds exactly that. Stopping at the link selects the link's own parent
    // and reads a different bus entirely.
    const root = join(scratch, "dangling");
    mkdirSync(join(root, "post", ".tap", "bus"), { recursive: true });
    const link = join(root, "registry-link");
    symlinkSync(join(root, "post", ".tap", "team-registry.json"), link);
    expect(busForRegistry(link)).toBe(join(root, "post", ".tap", "bus"));
  });

  test("a RELATIVE path keeps its \"..\" until the symlinks are followed", () => {
    // join() collapses ".." lexically, so a relative registry argument would
    // reach the walk already normalized and the symlink order would be lost —
    // the same defect as the absolute case, surviving in the branch that built
    // its own absolute path.
    //
    // The relative path is derived FROM the current cwd rather than by calling
    // process.chdir(): `bun test` runs every file in one process, so changing
    // the working directory is a global mutation that reaches unrelated tests.
    const root = realpathSync(mkdtempSync(join(scratch, "rel-")));
    mkdirSync(join(root, "actual", "sub"), { recursive: true });
    mkdirSync(join(root, "actual", "team", ".tap", "bus"), { recursive: true });
    mkdirSync(join(root, "team", ".tap", "bus"), { recursive: true });
    symlinkSync(join(root, "actual", "sub"), join(root, "alias"));
    const rel = relative(process.cwd(), root);
    expect(isAbsolute(rel)).toBe(false); // the arm is pointless if this is absolute
    expect(busForRegistry(`${rel}/alias/../team/.tap/missing.json`))
      .toBe(join(root, "actual", "team", ".tap", "bus"));
  });

  test("a relative symlink TARGET containing \"..\" resolves against its own directory", () => {
    const root = realpathSync(mkdtempSync(join(scratch, "reltarget-")));
    mkdirSync(join(root, "actual", "sub"), { recursive: true });
    mkdirSync(join(root, "actual", "team", ".tap", "bus"), { recursive: true });
    mkdirSync(join(root, "team", ".tap", "bus"), { recursive: true });
    // The ".." must cross a SYMLINK, not a real directory: `actual/sub/..` is
    // `actual` both lexically and physically, so that form cannot tell the two
    // implementations apart. `alias/..` can — alias points elsewhere.
    symlinkSync(join(root, "actual", "sub"), join(root, "alias"));
    symlinkSync("alias/../team/.tap/missing.json", join(root, "registry-link"));
    expect(busForRegistry(join(root, "registry-link")))
      .toBe(join(root, "actual", "team", ".tap", "bus"));
  });

  test("an absent registry file still resolves, which is why realpath alone will not do", () => {
    const root = join(scratch, "absent");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    expect(busForRegistry(join(root, ".tap", "never-written.json"))).toBe(join(root, ".tap", "bus"));
  });
});
