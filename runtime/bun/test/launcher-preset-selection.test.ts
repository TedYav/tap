// Frozen selection outcomes from 09c65fd39f0dc527d1cf8c233d6bbc23417f53f0, captured before the Python policy was deleted.
// Only scratch-root aliases are normalized; every recipe field, refusal and output byte is pinned.
// The retired-catalog recovery action follows the current setup or bare-launch contract.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Notices } from "../src/launcher/catalog-notices";
import { resolveLaunchPresetArgs } from "../src/launcher/resolve-target";
import { LauncherError } from "../src/launcher/types";

const rich = `version = 2
[roles]
reviewer = "Reviews"
[notes]
family = "Follow the stored recipe"
[presets.rich]
harness = "codex"
family = "family"
description = "Rich fixture"
[presets.rich.params]
model = "gpt-fixture"
effort = "high"
[presets.rich.env]
FIXTURE_VALUE = "a=b"
[presets.rich.metadata]
primary_roles = ["reviewer"]
summary = "  Full recipe  "
pronouns = "they/them"
annotation = ["kept", 7]
[presets.empty]
harness = "claude"
`;
const cases: { name: string; args: Record<string, unknown>; config: string | null; legacy?: boolean; mode?: number; quiet?: boolean; repeat?: boolean; usage?: string }[] = [
  ...["claude", "codex", "opencode", "cursor", "agy", "hermes"].map(harness => ({ name: `fast-${harness}`, args: { harness, label: "help" }, config: "malformed [[[" })),
  { name: "missing-input", args: {}, config: rich },
  { name: "implicit-rich", args: { harness: "rich", label: "worker" }, config: rich },
  { name: "explicit-label", args: { preset: "rich", harness: "worker" }, config: rich },
  { name: "compat", args: { preset: "rich", harness: "codex", label: "worker" }, config: rich },
  { name: "compat-no-label", args: { preset: "rich", harness: "codex" }, config: rich },
  { name: "empty-label", args: { preset: "rich", harness: "codex", label: "" }, config: rich },
  { name: "empty-preset", args: { harness: "empty" }, config: rich },
  { name: "missing-implicit", args: { harness: "typo", model: "ignored" }, config: rich },
  { name: "missing-explicit", args: { preset: "typo" }, config: rich },
  { name: "absent-implicit", args: { harness: "typo" }, config: null, usage: "tap crew add <preset|harness> [name]" },
  { name: "absent-explicit", args: { preset: "rich" }, config: null },
  { name: "model-before-compat", args: { preset: "rich", harness: "claude", model: "" }, config: rich },
  { name: "effort-empty", args: { preset: "rich", effort: "" }, config: rich },
  { name: "both-tuning", args: { preset: "rich", model: "x", effort: "x" }, config: rich },
  { name: "compat-mismatch", args: { preset: "rich", harness: "claude" }, config: rich },
  { name: "quiet", args: { harness: "rich" }, config: rich, quiet: true },
  { name: "dedup-verb", args: { harness: "rich", verb: "tap fixture" }, config: rich, repeat: true },
  { name: "summary-bom", args: { harness: "rich" }, config: rich.replace("  Full recipe  ", "\\uFEFF") },
  { name: "legacy", args: { harness: "rich" }, config: rich, legacy: true },
  { name: "retired", args: { preset: "rich" }, config: rich.replace("version = 2", "version = 1") },
  { name: "dropped", args: { preset: "bad" }, config: 'version = 2\n[presets.bad]\nharness = "bogus"\n' },
  { name: "insecure", args: { preset: "rich" }, config: rich, mode: 0o666 },
];

const expected = [
  {"name": "fast-claude", "value": {"harness": "claude", "label": "help", "preset": null}, "stdout": "", "stderr": ""},
  {"name": "fast-codex", "value": {"harness": "codex", "label": "help", "preset": null}, "stdout": "", "stderr": ""},
  {"name": "fast-opencode", "value": {"harness": "opencode", "label": "help", "preset": null}, "stdout": "", "stderr": ""},
  {"name": "fast-cursor", "value": {"harness": "cursor", "label": "help", "preset": null}, "stdout": "", "stderr": ""},
  {"name": "fast-agy", "value": {"harness": "agy", "label": "help", "preset": null}, "stdout": "", "stderr": ""},
  {"name": "fast-hermes", "value": {"harness": "hermes", "label": "help", "preset": null}, "stdout": "", "stderr": ""},
  {"name": "missing-input", "error": {"kind": "launcher", "detail": "usage: tap session launch <preset|harness> [name]"}, "stdout": "", "stderr": ""},
  {"name": "implicit-rich", "value": {"harness": "codex", "label": "worker", "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/implicit-rich/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap session: rich — Follow the stored recipe\ntap session: rich — reviewer — Full recipe\n"},
  {"name": "explicit-label", "value": {"harness": "codex", "label": "worker", "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/explicit-label/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap session: rich — Follow the stored recipe\ntap session: rich — reviewer — Full recipe\n"},
  {"name": "compat", "value": {"harness": "codex", "label": "worker", "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/compat/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap session: rich — Follow the stored recipe\ntap session: rich — reviewer — Full recipe\n"},
  {"name": "compat-no-label", "value": {"harness": "codex", "label": null, "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/compat-no-label/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap session: rich — Follow the stored recipe\ntap session: rich — reviewer — Full recipe\n"},
  {"name": "empty-label", "value": {"harness": "codex", "label": "", "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/empty-label/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap session: rich — Follow the stored recipe\ntap session: rich — reviewer — Full recipe\n"},
  {"name": "empty-preset", "value": {"harness": "claude", "label": null, "preset": {"harness": "claude", "model": null, "harness_passthrough": [], "env": {}, "provenance": {"name": "empty", "source_path": "@ROOT@/empty-preset/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": null, "note": null, "metadata": null, "description": null, "param_keys": []}}, "stdout": "", "stderr": ""},
  {"name": "missing-implicit", "error": {"kind": "preset", "class": "harness_or_preset_not_found", "action": "tap presets, or launch a harness directly: tap launch claude newcomer", "detail": "'typo' is not a known harness or a saved preset; canonical harnesses: agy, claude, codex, cursor, hermes, opencode; available presets: empty, rich; config: @ROOT@/missing-implicit/tap/config.toml"}, "stdout": "", "stderr": ""},
  {"name": "missing-explicit", "error": {"kind": "preset", "class": "preset_not_found", "action": "choose an available preset (empty, rich) or edit @ROOT@/missing-explicit/tap/config.toml", "detail": "preset 'typo' was not found in @ROOT@/missing-explicit/tap/config.toml"}, "stdout": "", "stderr": ""},
  {"name": "absent-implicit", "error": {"kind": "preset", "class": "harness_or_preset_not_found", "action": "tap presets, or launch a harness directly: tap crew add claude newcomer --model <model>", "detail": "'typo' is not a known harness or a saved preset; canonical harnesses: agy, claude, codex, cursor, hermes, opencode; available presets: none; config: @ROOT@/absent-implicit/tap/config.toml"}, "stdout": "", "stderr": ""},
  {"name": "absent-explicit", "error": {"kind": "preset", "class": "preset_config_missing", "action": "create @ROOT@/absent-explicit/tap/presets.toml", "detail": "requested preset config does not exist: @ROOT@/absent-explicit/tap/presets.toml"}, "stdout": "", "stderr": ""},
  {"name": "model-before-compat", "error": {"kind": "preset", "class": "preset_not_composable", "action": "drop --model, or launch without --preset and pass tuning by flag", "detail": "preset 'rich' is complete; --model cannot override it"}, "stdout": "", "stderr": ""},
  {"name": "effort-empty", "error": {"kind": "preset", "class": "preset_not_composable", "action": "drop --effort, or launch without --preset and pass tuning by flag", "detail": "preset 'rich' is complete; --effort cannot override it"}, "stdout": "", "stderr": ""},
  {"name": "both-tuning", "error": {"kind": "preset", "class": "preset_not_composable", "action": "drop --model and --effort, or launch without --preset and pass tuning by flag", "detail": "preset 'rich' is complete; --model and --effort cannot override it"}, "stdout": "", "stderr": ""},
  {"name": "compat-mismatch", "error": {"kind": "preset", "class": "preset_harness_mismatch", "action": "omit 'claude' or use harness 'codex'", "detail": "preset 'rich' uses harness 'codex', not compatibility harness 'claude'"}, "stdout": "", "stderr": ""},
  {"name": "quiet", "value": {"harness": "codex", "label": null, "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/quiet/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": ""},
  {"name": "dedup-verb", "value": {"harness": "codex", "label": null, "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/dedup-verb/tap/config.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap fixture: rich — Follow the stored recipe\ntap fixture: rich — reviewer — Full recipe\n"},
  {"name": "summary-bom", "value": {"harness": "codex", "label": null, "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/summary-bom/tap/config.toml", "config_digest": "sha256:b5b1722d62f8740b785bf086de32624a017eb7fca1c739f8f9a37230d808d4b4"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "﻿", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap session: rich — Follow the stored recipe\ntap session: rich — reviewer — ﻿\n"},
  {"name": "legacy", "value": {"harness": "codex", "label": null, "preset": {"harness": "codex", "model": "gpt-fixture", "harness_passthrough": ["--effort", "high"], "env": {"FIXTURE_VALUE": "a=b"}, "provenance": {"name": "rich", "source_path": "@ROOT@/legacy/tap/presets.toml", "config_digest": "sha256:a5cc8c8204e07acb9898de82b9bc570b6644e0903dd1307191b67f418eea0b25"}, "family": "family", "note": "Follow the stored recipe", "metadata": {"pronouns": "they/them", "intelligence": null, "cost_basis": null, "cost_level": null, "budget_capacity": null, "speed": null, "summary": "  Full recipe  ", "primary_roles": ["reviewer"], "secondary_roles": [], "avoid_roles": [], "banned_roles": [], "extra": [["annotation", ["kept", 7]]]}, "description": "Rich fixture", "param_keys": ["effort"]}}, "stdout": "", "stderr": "tap session: presets read from @ROOT@/legacy/tap/presets.toml — move them under [presets] in @ROOT@/legacy/tap/config.toml; presets.toml support ends after one release\ntap session: rich — Follow the stored recipe\ntap session: rich — reviewer — Full recipe\n"},
  {"name": "retired", "error": {"kind": "preset", "class": "preset_not_found", "action": "tap setup --machine to choose presets, or tap session launch <harness> <name> without a preset", "detail": "preset 'rich' was not found in @ROOT@/retired/tap/config.toml"}, "stdout": "", "stderr": "tap config: version 1 is retired and its layout is not readable by this release (current: 2, 3) in @ROOT@/retired/tap/config.toml — ignoring it and continuing\n"},
  {"name": "dropped", "error": {"kind": "preset", "class": "preset_not_usable", "action": "fix preset 'bad' in @ROOT@/dropped/tap/config.toml", "detail": "preset 'bad' is defined in @ROOT@/dropped/tap/config.toml but was not usable: invalid preset config @ROOT@/dropped/tap/config.toml: preset 'bad' harness must be one of: agy, claude, codex, cursor, hermes, opencode; got 'bogus'"}, "stdout": "", "stderr": "tap config: preset 'bad' is not usable (invalid preset config @ROOT@/dropped/tap/config.toml: preset 'bad' harness must be one of: agy, claude, codex, cursor, hermes, opencode; got 'bogus') in @ROOT@/dropped/tap/config.toml — ignoring it and continuing\n"},
  {"name": "insecure", "error": {"kind": "preset", "class": "preset_config_insecure", "action": "chmod 600 @ROOT@/insecure/tap/config.toml", "detail": "preset config is group/world writable: @ROOT@/insecure/tap/config.toml"}, "stdout": "", "stderr": ""}
];

// Each case against the native selection (resolveLaunchPresetArgs, launch's
// only selection owner since launch-ts row 6), in the incumbent adapter's
// outcome shape: the value it bound, or the refusal class it raised, plus the
// notices it printed.
function select(caseRoot: string, c: typeof cases[number]) {
  const cfg = join(caseRoot, c.name, "tap");
  mkdirSync(cfg, { recursive: true });
  if (c.config !== null) {
    const path = join(cfg, c.legacy ? "presets.toml" : "config.toml");
    writeFileSync(path, c.config);
    chmodSync(path, c.mode ?? 0o600);
  }
  let stderr = "";
  const notices = new Notices(message => { stderr += `${message}\n`; });
  notices.suppress(c.quiet ?? false);
  const env = { XDG_CONFIG_HOME: join(caseRoot, c.name) };
  const input = { preset: null, harness: null, label: null, model: null, effort: null, usage: c.usage ?? null, verb: null, ...c.args };
  const result: Record<string, unknown> = { name: c.name };
  try {
    let value = resolveLaunchPresetArgs(env, notices, input) as {
      harness: string; label: string | null; preset_name: string | null; catalog: { presets: Record<string, unknown> } | null };
    if (c.repeat) value = resolveLaunchPresetArgs(env, notices, input) as typeof value;
    // The incumbent's PresetResolution carried the recipe, not the raw params table.
    const { params: _params, ...preset } = (value.catalog !== null && value.preset_name !== null
      ? value.catalog.presets[value.preset_name] : null) as Record<string, unknown> ?? {};
    result.value = { harness: value.harness, label: value.label, preset: value.preset_name === null ? null : preset };
  } catch (error) {
    if (!(error instanceof LauncherError)) throw error;
    result.error = error.errorClass ? { kind: "preset", class: error.errorClass, action: error.action, detail: error.detail }
      : { kind: "launcher", detail: error.message };
  }
  result.stdout = "";
  result.stderr = stderr;
  return JSON.parse(JSON.stringify(result).replaceAll(realpathSync(caseRoot), "@ROOT@").replaceAll(caseRoot, "@ROOT@"));
}

test("native selection matches the frozen pre-cut selection outcomes", () => {
  const caseRoot = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "selection-"));
  expect(cases.map(c => select(caseRoot, c))).toEqual(expected);
});
