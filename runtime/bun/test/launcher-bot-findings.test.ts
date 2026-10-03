import { test, expect } from "bun:test";
import { catalogDisplayRows, parsePresetCatalog, requirePreset } from "../src/launcher/catalog-listing";

const read = (src: string) => {
  const notices: string[] = [];
  const catalog = parsePresetCatalog(Buffer.from(src), "/x/config.toml", "sha256:d", m => notices.push(m));
  return { catalog, notices };
};

/**
 * An operator-authored table is not a JavaScript object with a prototype.
 *
 * `key in table` answers yes for everything on `Object.prototype`, so a preset
 * declaring `family = "toString"` bound the inherited FUNCTION as its note AND
 * suppressed the missing-entry warning. A launch printed
 * `function toString() { [native code] }` where an operator annotation belongs.
 * Every lookup into an operator table now asks whether the table OWNS the key.
 */
for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
  test(`family '${inherited}' is an unbound family, not an inherited member`, () => {
    const { catalog, notices } = read(
      `version = 3\n[notes]\nreal = "a real note"\n` +
      `[presets.review]\nharness = "claude"\nfamily = "${inherited}"\n`);
    const preset = catalog.presets.get("review");
    expect(preset).toBeDefined();
    expect(preset!.note).toBeNull();
    expect(notices.some(n => n.includes("has no [notes] entry"))).toBe(true);
  });
  test(`role '${inherited}' is unbound vocabulary, not an inherited member`, () => {
    const { notices } = read(
      `version = 3\n[roles]\nreal = "a real role"\n` +
      `[presets.review]\nharness = "claude"\n` +
      `[presets.review.metadata]\nprimary_roles = ["${inherited}"]\n`);
    // Either the name is rejected as a role name, or it is reported unbound --
    // never silently accepted because Object.prototype happens to carry it.
    expect(notices.some(n => n.includes("has no [roles] entry") || n.includes("unusable role"))).toBe(true);
  });
}

/**
 * A `[roles]` description that says nothing is not a definition.
 *
 * A blank or control-only description was accepted as a known role, so metadata
 * naming it counted as BOUND and the notice an operator needs never fired: the
 * vocabulary silently contained a role with no meaning. The incumbent validates
 * the name, refuses retired names, and requires a usable description; these are
 * its exact wordings.
 */
test("a blank role description is dropped and reported, and leaves the role unbound", () => {
  const { catalog, notices } = read(
    'version = 3\n[roles]\nreal = "a real role"\nblank = "   "\n' +
    '[presets.review]\nharness = "claude"\n' +
    '[presets.review.metadata]\nprimary_roles = ["blank"]\n');
  expect(catalog.roles).toEqual({ real: "a real role" });
  expect(notices.some(n => n.includes("roles.blank is not a usable description"))).toBe(true);
  expect(notices.some(n => n.includes("names role 'blank', which has no [roles] entry"))).toBe(true);
});

test("a control-character role description is equally unusable", () => {
  const { catalog, notices } = read(
    `version = 3\n[roles]\nbad = "a\\u0007b"\nreal = "a real role"\n`);
  expect(catalog.roles).toEqual({ real: "a real role" });
  expect(notices.some(n => n.includes("roles.bad is not a usable description"))).toBe(true);
});

test("an unusable role NAME is reported as a name problem, not a description one", () => {
  const { catalog, notices } = read('version = 3\n[roles]\n"9bad" = "starts with a digit"\n');
  expect(catalog.roles).toEqual({});
  expect(notices.some(n => n.includes("unusable role name '9bad' in [roles]"))).toBe(true);
});

test("a retired role name is reported as retired", () => {
  const { catalog, notices } = read('version = 3\n[roles]\nexecutor = "implements code"\n');
  expect(catalog.roles).toEqual({});
  expect(notices.some(n => n.includes("role 'executor' in [roles] is retired"))).toBe(true);
});

for (const bucket of ["primary_roles", "secondary_roles", "avoid_roles", "banned_roles"] as const) {
  test(`watcher retirement drops only the ${bucket} hint and keeps the preset launchable`, () => {
    const { catalog, notices } = read(
      'version = 3\n[roles]\nwatcher = "old monitor"\nmonitor = "samples on cadence"\n' +
      '[presets.sampler]\nharness = "claude"\nparams.model = "sonnet"\n' +
      `metadata.${bucket} = ["watcher", "monitor"]\n`);
    expect(catalog.roles).toEqual({ monitor: "samples on cadence" });
    const preset = requirePreset(catalog, "sampler");
    expect(preset.harness).toBe("claude");
    expect(preset.model).toBe("sonnet");
    expect(preset.metadata?.[bucket]).toEqual(["monitor"]);
    expect(catalogDisplayRows(catalog)[0]?.roles).toBe(bucket === "primary_roles" ? "monitor" : "");
    expect(notices.some(n => n.includes("role 'watcher' in [roles] is retired; use 'monitor' instead"))).toBe(true);
    expect(notices.some(n => n.includes("metadata names retired role 'watcher'; use 'monitor' instead"))).toBe(true);
  });
}

test("a watcher hint does not silently become monitor", () => {
  const { catalog } = read(
    'version = 3\n[presets.sampler]\nharness = "claude"\nmetadata.primary_roles = ["watcher"]\n');
  expect(requirePreset(catalog, "sampler").metadata?.primary_roles).toEqual([]);
  expect(catalogDisplayRows(catalog)[0]?.roles).toBe("");
});

// The vocabulary survives one bad entry -- a table that refused wholesale would
// take every role definition down with a single typo.
test("one bad entry costs that entry, never the vocabulary", () => {
  const { catalog } = read('version = 3\n[roles]\na = "one"\nblank = ""\nb = "two"\n');
  expect(catalog.roles).toEqual({ a: "one", b: "two" });
});

import { rosterDisplayFacts } from "../src/launcher/catalog-listing";
import { jsonSafe, parseMetadata, metadataToJson } from "../src/launcher/catalog-metadata";

/**
 * The roster's `recorded` map is operator registry data keyed by SEAT HANDLE.
 *
 * `recorded[handle]` answered with an inherited function for a seat named
 * `toString` or `constructor`, and a recorded name outranks inference -- so a
 * seat whose preset genuinely IS in the catalog was reported
 * `preset_absent_from_catalog`, and a genuinely unjoined `valueOf` acquired the
 * same false fact instead of being omitted. Verified against a run of the pinned
 * program: it infers `toString`/`constructor` and omits `valueOf`.
 */
test("a prototype-named handle infers its real preset instead of reporting it absent", () => {
  const { catalog } = read('version = 3\n[presets.toString]\nharness = "claude"\n' +
                           '[presets.constructor]\nharness = "codex"\n');
  const facts = rosterDisplayFacts(["toString", "constructor", "valueOf"], { recorded: {}, catalog });
  // Indexed, not dotted: `facts.toString` resolves to Object.prototype.toString
  // at the TYPE level too, which is the same confusion this test exists about.
  const at = (key: string) => (facts as Record<string, unknown>)[key];
  expect(at("toString")).toEqual({ preset: "toString", preset_inferred: true, roles: "" });
  expect(at("constructor")).toEqual({ preset: "constructor", preset_inferred: true, roles: "" });
  // Genuinely unjoined: OMITTED, not given a false missing-entry fact.
  expect(at("valueOf")).toBeUndefined();
});

test("a REAL recorded name still outranks inference, including when it is missing", () => {
  const { catalog } = read('version = 3\n[presets.review]\nharness = "claude"\n');
  const facts = rosterDisplayFacts(["a", "b"],
    { recorded: { a: "review", b: "gone" }, catalog });
  expect(facts.a?.preset).toBe("review");
  expect(facts.a?.preset_inferred).toBeUndefined();
  // The RECORD outranks a guess: say what the seat was launched with.
  expect(facts.b?.preset).toBe("gone");
  expect(facts.b?.preset_absent_from_catalog).toBe(true);
});

/**
 * Unknown metadata keys are carried VERBATIM by contract. `out["__proto__"] = v`
 * on a plain object literal invokes the inherited setter and changes the
 * object's prototype instead of creating a key, so a valid TOML
 * `"__proto__" = "value"` disappeared from the wire entirely -- the contract
 * broken by the transport rather than by a decision. The fixtures go through the
 * TOML PARSER, because `__proto__:` in a JS object literal is that same setter
 * syntax and cannot express the input.
 */
test("a __proto__ metadata key survives as own data, top-level and nested", () => {
  const doc = Bun.TOML.parse('"__proto__" = "top"\nkeep = "yes"\n[nested]\n"__proto__" = "deep"\nkeep = "yes"\n');
  const safe = jsonSafe(doc) as Record<string, unknown>;
  expect(Object.keys(safe)).toContain("__proto__");
  expect(safe["__proto__"]).toBe("top");
  const nested = safe.nested as Record<string, unknown>;
  expect(nested["__proto__"]).toBe("deep");
  expect(nested.keep).toBe("yes");
  // It has to survive the actual wire, not just the in-memory object.
  expect(JSON.parse(JSON.stringify(safe))["__proto__"]).toBe("top");
});

test("a __proto__ metadata extra reaches metadataToJson", () => {
  const meta = parseMetadata("review",
    Bun.TOML.parse('summary = "s"\n"__proto__" = "extra value"\n') as Record<string, unknown>, () => {});
  const out = metadataToJson(meta!);
  expect(out["__proto__"]).toBe("extra value");
  expect(out.summary).toBe("s");
  expect(JSON.parse(JSON.stringify(out))["__proto__"]).toBe("extra value");
});

// Negative control: a known field still cannot be shadowed by an extra.
test("an extra cannot shadow a known metadata field", () => {
  const meta = parseMetadata("review",
    Bun.TOML.parse('summary = "real summary"\nunknown_thing = "carried"\n') as Record<string, unknown>, () => {});
  const out = metadataToJson(meta!);
  expect(out.summary).toBe("real summary");
  expect(out.unknown_thing).toBe("carried");
});

/**
 * `[intelligences]` is `[roles]`'s sibling and was left behind when that one was
 * fixed: a blank definition stayed BOUND, so metadata naming it read as known
 * and neither the invalid-description notice nor the unbound one fired.
 *
 * The name pattern is deliberately NOT the role pattern. The incumbent says so
 * in its own docstring -- role names forbid hyphens, the live vocabulary opens
 * with `s-tier`, and sharing one regex "would have made the reader refuse the
 * file it was written to accept". `s-tier` is asserted here so the obvious-
 * looking tidy-up cannot land silently.
 */
test("a hyphenated intelligence name is legal, and a blank definition is not", () => {
  const { notices } = read(
    'version = 3\n[intelligences]\n"s-tier" = "hyphens are legal here"\ngood = "fine"\n' +
    'blank = "   "\n"9bad" = "starts with a digit"\n' +
    '[presets.review]\nharness = "claude"\n[presets.review.metadata]\nintelligence = "blank"\n');
  expect(notices.some(n => n.includes("intelligences.blank is not a usable description"))).toBe(true);
  expect(notices.some(n => n.includes("unusable intelligence name '9bad'"))).toBe(true);
  // s-tier survived: it is in the KNOWN list, and nothing complained about it.
  expect(notices.some(n => n.includes("known: good, s-tier"))).toBe(true);
  expect(notices.some(n => n.includes("s-tier") && n.includes("unusable"))).toBe(false);
});

test("a control-character intelligence description is unusable too", () => {
  const { notices } = read(`version = 3\n[intelligences]\nbad = "a\\u0007b"\ngood = "fine"\n`);
  expect(notices.some(n => n.includes("intelligences.bad is not a usable description"))).toBe(true);
});

/**
 * Prefix ownership sits on ONE side: the reader. Every notice it emits already
 * begins `tap config:` or `tap session:`, so a caller that prefixes again
 * produces `tap detective: tap config: ...`. `request.ts` was fixed for this and
 * `detective.ts` was not -- the fix did not sweep its own class.
 *
 * The policy fallback was the reader's own exception: the one notice it emitted
 * with no canonical prefix, which is what made prefixing look like a caller's job.
 */
test("every notice the reader emits carries exactly one canonical prefix", () => {
  const seen: string[] = [];
  // A file that provokes as many distinct notice sites as one document can.
  read('version = 4\n[notes]\nreal = "n"\n[roles]\nblank = "  "\n[intelligences]\nbad = "  "\n' +
       '[presets.ok]\nharness = "claude"\nfamily = "missing"\n' +
       '[presets.bad]\nharness = "nope"\n').notices.forEach(n => seen.push(n));
  expect(seen.length).toBeGreaterThan(3);
  for (const line of seen) {
    expect(line.startsWith("tap config: ") || line.startsWith("tap session: ")).toBe(true);
    // ... and exactly one: no `tap config: tap config:` or `tap session: tap config:`.
    expect(/^tap (config|session): tap (config|session): /.test(line)).toBe(false);
  }
});
