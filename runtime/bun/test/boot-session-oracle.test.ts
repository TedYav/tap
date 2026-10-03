import { afterAll, expect, test } from "bun:test";
import { bootId, bootIdsMatch, legacyBootId } from "../src/tmux";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/boot-session-oracle.test.sh: the boot
// identity must not move with wall-clock slew. The retired shell drove
// bootId() through the authority-cli bridge with a count-switched sysctl
// shim; this port imports the oracle directly and passes the shim path
// through bootId's own seam argument, exercising the same spawnSync child.
//
// Arms:
//   derive-twice, stable mode — the derivation is a stable read, not a clock
//   derive-twice, slewed mode — the pre-hotfix kern.boottime oracle returns
//     two identities under a one-second wall-clock correction; the preferred
//     kern.bootsessionuuid oracle does not move (regression arm)
//   bootIdsMatch truth table — the three-valued relation, including the
//     five-second legacy tolerance, the explicit-TAP_BOOT_ID fixture clause,
//     cross-scheme unknowability, and shape-before-equality
//   legacyBootId env pins — TAP_BOOT_ID_LEGACY and the legacy-shaped
//     TAP_BOOT_ID passthrough
//
// Scratch allocation: the fixture tree lives only beneath the runner-owned
// scratch root (runtime/bun/test/run.sh exports TMUX_TMPDIR); this file
// refuses to run without it.

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "boot-session-oracle.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-bootoracle."));
afterAll(() => removeScratchTree(WORK));

const SHIM = join(import.meta.dir, "fixtures", "boot-oracle", "sysctl");

const UUID_STAMP = "7d669766-8a0c-4a4d-9b80-a2476810f46c";
const UUID_ROW = "bootuuid:11111111-1111-4111-8111-111111111111";

/** Derivation environment: no boot pins, shim state keyed by mode. */
function probeEnv(mode: string): NodeJS.ProcessEnv {
  const { TAP_BOOT_ID: _b, TAP_BOOT_ID_LEGACY: _l, ...rest } = process.env;
  return { ...rest, BOOT_PROBE_MODE: mode, BOOT_PROBE_COUNT: join(WORK, `probe-${mode}`) };
}

function deriveTwice(mode: string): [string, string] {
  return [
    bootId(probeEnv(mode), join(WORK, "proc-stat"), SHIM),
    bootId(probeEnv(mode), join(WORK, "proc-stat"), SHIM),
  ];
}

test("derive-twice in stable mode: the boot identity is a stable read", () => {
  const [first, second] = deriveTwice("stable");
  expect(first).toBe(second);
  expect(first).toBe(`bootuuid:${UUID_STAMP}`);
});

test("derive-twice in slewed mode: the uuid oracle wins, the slewed boottime never leaks", () => {
  // Regression arm: a boottime-first oracle derives boot:1785910737 then
  // boot:1785910738 here. The preferred bootsessionuuid oracle is identical
  // across the one-second wall-clock correction.
  const [first, second] = deriveTwice("slew");
  expect(first).toBe(second);
  expect(first).toBe(`bootuuid:${UUID_STAMP}`);
});

test("bootIdsMatch: equal readable stamps match", () => {
  expect(bootIdsMatch(`bootuuid:${UUID_STAMP}`, `bootuuid:${UUID_STAMP}`, {})).toBe("match");
  expect(bootIdsMatch("boot:1785910737", "boot:1785910737", {})).toBe("match");
});

test("bootIdsMatch: a legacy row within five seconds of the legacy epoch matches", () => {
  // The migration cell: a pre-uuid row vs a uuid current, comparable only
  // through the independently observed legacy epoch.
  const env = { TAP_BOOT_ID_LEGACY: "boot:1785910738" };
  expect(bootIdsMatch("boot:1785910737", `bootuuid:${UUID_STAMP}`, env)).toBe("match");
  // The tolerance is exactly the documented five seconds, not a fuzzy window.
  expect(bootIdsMatch("boot:1785910733", "boot:1785910738", env)).toBe("match");
  expect(bootIdsMatch("boot:1785910732", "boot:1785910738", env)).toBe("mismatch");
});

test("bootIdsMatch: a legacy row beyond the tolerance mismatches", () => {
  const env = { TAP_BOOT_ID_LEGACY: "boot:1785910738" };
  expect(bootIdsMatch("boot:1785910700", `bootuuid:${UUID_STAMP}`, env)).toBe("mismatch");
});

test("bootIdsMatch: differing exact ids mismatch", () => {
  expect(bootIdsMatch(UUID_ROW, `bootuuid:${UUID_STAMP}`, {})).toBe("mismatch");
});

test("bootIdsMatch: an explicit TAP_BOOT_ID without a legacy pin keeps exact comparison", () => {
  // The fixture clause: a reboot test's explicit TAP_BOOT_ID must not turn
  // into a tolerance test through the secondary oracle.
  const env = { TAP_BOOT_ID: `bootuuid:${UUID_STAMP}` };
  expect(bootIdsMatch("boot:1785910737", "boot:1785910738", env)).toBe("mismatch");
});

test("bootIdsMatch: a cross-scheme pair with no legacy answer is unknown, not mismatch", () => {
  expect(bootIdsMatch(UUID_ROW, "boot:1785910738", {})).toBe("unknown");
});

test("bootIdsMatch: unreadable stamps are unknown even when equal", () => {
  // Shape is decided first, including for an equal pair: two equal
  // unparseable stamps must not wave the boot factor through as a match.
  expect(bootIdsMatch("boot:not-a-number", "boot:not-a-number", {})).toBe("unknown");
  expect(bootIdsMatch("", `bootuuid:${UUID_STAMP}`, {})).toBe("unknown");
});

test("legacyBootId honors the TAP_BOOT_ID_LEGACY pin without spawning", () => {
  expect(legacyBootId({ TAP_BOOT_ID_LEGACY: "boot:1785910738" }, "/nonexistent")).toBe("boot:1785910738");
});

test("legacyBootId passes a legacy-shaped TAP_BOOT_ID through", () => {
  expect(legacyBootId({ TAP_BOOT_ID: "boot:1785910700" }, "/nonexistent")).toBe("boot:1785910700");
});

test("bootId honors an explicit TAP_BOOT_ID pin without spawning", () => {
  expect(bootId({ TAP_BOOT_ID: "boot:fixed" }, "/nonexistent", SHIM)).toBe("boot:fixed");
});
