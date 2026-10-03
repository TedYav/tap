import { expect, test } from "bun:test";
import { HARNESSES } from "../src/launcher/catalog";
import { LauncherError } from "../src/launcher/types";
import { TUNING_CAPABILITIES, resolveCliTuning } from "../src/launcher/tuning";

// tap-ppo7 enumerating pin (same doctrine as tap-ctzt), moved from
// the retired Python tuning table. Equality in both directions: a row without
// a harness is leftover fiction; a harness without a row is the incident (agy
// had CLI flags and no table). The superset check keeps a shrunken HARNESSES
// from passing vacuously.
test("every harness has exactly one tuning capability row", () => {
  expect(new Set(HARNESSES)).toEqual(new Set([...HARNESSES, "agy", "claude", "codex", "cursor", "hermes", "opencode"]));
  expect(Object.keys(TUNING_CAPABILITIES).sort()).toEqual([...HARNESSES].sort());
});

// Domain clamping stays on the CLI --effort axis. Config params are verbatim
// and do not consult the table.
test("agy effort outside its domain refuses on the CLI axis", () => {
  let error: unknown;
  try { resolveCliTuning("agy", null, "max", {}); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LauncherError);
  const refusal = error as LauncherError;
  expect(refusal.errorClass).toBe("launch_arg_invalid");
  expect(refusal.message).toContain("max");
  expect(refusal.message).toContain("low, medium, high");
  expect(refusal.message).not.toContain("xhigh");
  expect(resolveCliTuning("agy", null, "high", {}).harness_passthrough).toEqual(["--effort", "high"]);
});
