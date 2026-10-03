import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { enrollScratchRoot } from "./support/enroll-scratch";
import { spawnSync as spawnPlan } from "node:child_process";
import { buildHarnessInvocation } from "../src/launcher/adapters";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(harness: string, mode?: string, extra = "") {
  const root = mkdtempSync("/tmp/tap-permissions-"); roots.push(root);
  mkdirSync(join(root, "tap"));
  writeFileSync(join(root, "tap/config.toml"), `version = 3\n[harness.${harness}]\n${mode === undefined ? "" : `permissions = ${mode}\n`}${extra}`);
  return { HOME: root, XDG_CONFIG_HOME: root };
}
// The native launch's dry-run plan from an enrolled scratch git root (writes nothing).
const newTs = resolve(import.meta.dir, "../src/launcher/new.ts");
function plan(args: string[], env: { HOME: string; XDG_CONFIG_HOME: string }) {
  spawnPlan("git", ["init", "-q", env.HOME]);
  enrollScratchRoot(env.HOME, join(env.HOME, "index"));
  const merged = Object.fromEntries(Object.entries({ ...process.env, ...env, TAP_INDEX_HOME: join(env.HOME, "index"), TAP_HOME: undefined, TAP_JSON: undefined })
    .filter(([, value]) => value !== undefined)) as Record<string, string>;
  const result = spawnPlan(process.execPath, [newTs, "--dry-run", "--json", ...args], { cwd: env.HOME, env: merged, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr, argv: result.status === 0 ? JSON.parse(result.stdout).argv as string[] : [] };
}
const refusesPermissions = (result: ReturnType<typeof plan>) => {
  expect(result.status).toBe(2);
  expect(result.output).toContain("permissions");
};
for (const harness of ["claude", "codex"]) {
  const bypass = harness === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox";
  const auto = harness === "claude" ? ["--permission-mode", "auto"] : ["--approve-for-me"];
  for (const action of ["new", "resume"]) for (const mode of [undefined, '"bypass"', '"auto"']) {
    test(`${harness} ${action} base argv follows ${mode ?? "absent"} policy`, () => {
      const env = fixture(harness, mode);
      const argv = buildHarnessInvocation(action, { name: "seat", harness, cwd: env.HOME, base: "team" }, null, null, env).argv;
      expect(argv).toEqual([harness, ...(mode === '"auto"' ? auto : [bypass]),
        ...(harness === "claude" ? ["--name", "seat"] : []),
        ...(action === "resume" ? [harness === "claude" ? "--resume" : "resume"] : [])]);
    });
  }
  for (const mode of ['"typo"', 'false', '42', '["auto"]', '""']) test(`${harness} invalid ${mode} refuses`, () => {
    const env = fixture(harness, mode);
    refusesPermissions(plan([harness, "seat"], env));
  });
  for (const source of ["harness", "preset", "passthrough"]) test(`${harness} auto refuses ${source} bypass`, () => {
    const extra = source === "harness" ? `[harness.${harness}.params]\n${bypass.slice(2)} = true\n` :
      source === "preset" ? `[presets.safe]\nharness = "${harness}"\n[presets.safe.params]\n${bypass.slice(2)} = true\n` : "";
    const env = fixture(harness, '"auto"', extra);
    refusesPermissions(plan([source === "preset" ? "safe" : harness, "seat", ...(source === "passthrough" ? ["--", bypass] : [])], env));
  });
  test(`${harness} effective launch argv uses auto`, () => {
    const env = fixture(harness, '"auto"');
    const { argv } = plan([harness, "seat"], env);
    expect(argv).not.toContain(bypass);
    for (const token of auto) expect(argv).toContain(token);
  });
}

import { buildInvocation, composeInvocation, launchInvocation } from "../src/launcher/invocation";
import { Notices } from "../src/launcher/catalog-notices";
import { storeRecipe, type LaunchRecord } from "../src/launcher/transaction";
function nativeInvocation(env: NodeJS.ProcessEnv, request: { harness: string; action: string; passthrough?: string[]; preset?: boolean }): { argv?: string[]; refusal?: string; permissions?: string; stored_permissions?: unknown } {
  const record: LaunchRecord = { name: "seat", harness: request.harness, cwd: "/tmp/wt", base: "team",
    harness_passthrough: request.passthrough ?? [], passthrough_from_config: request.preset ?? false };
  const notices = new Notices(() => {});
  const merged = { ...process.env, ...env };
  try {
    const invocation = request.action === "native"
      ? composeInvocation(buildInvocation("resume", record, notices, merged, null, null, null), record, notices, merged)
      : launchInvocation(request.action, record, notices, { env: merged, resume: null });
    const entry: Record<string, unknown> = {};
    storeRecipe(entry, record);
    return { argv: invocation.argv, permissions: record.permissions ?? undefined, stored_permissions: entry.permissions };
  } catch (error) { return { refusal: String(error) }; }
}
for (const harness of ["claude", "codex"]) for (const action of ["new", "resume", "native"]) {
  test(`Native ${harness} ${action} effective auto argv`, () => {
    const out = nativeInvocation(fixture(harness, '"auto"'), { harness, action });
    expect(out.refusal).toBeUndefined();
    expect(out.permissions).toBe("auto");
    expect(out.stored_permissions).toBe("auto");
    expect(out.argv).toContain(harness === "claude" ? "--permission-mode" : "--approve-for-me");
    expect(out.argv?.some(arg => arg.startsWith("--dangerously-"))).toBe(false);
  });
  test(`Native ${harness} ${action} invalid explicit mode refuses`, () => {
    expect(nativeInvocation(fixture(harness, 'false'), { harness, action }).refusal).toContain("permissions");
  });
  for (const source of ["harness", "preset", "passthrough"]) test(`Native ${harness} ${action} refuses ${source} bypass`, () => {
    const flag = harness === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox";
    const env = fixture(harness, '"auto"', source === "harness" ? `[harness.${harness}.params]\n${flag.slice(2)} = true\n` : "");
    expect(nativeInvocation(env, { harness, action, passthrough: source === "harness" ? [] : [flag], preset: source === "preset" }).refusal).toContain("permissions");
  });
}

for (const args of [
  ["-sdanger-full-access"], ["-s=danger-full-access"],
  ['-c"sandbox_mode"="danger-full-access"'], ["--config", '"sandbox_mode"="danger-full-access"'],
  ["-c", "approval_policy='never'"], ["-anever"],
  ["-c", " approval_policy = 'never'"], ["--config", ' "sandbox_mode" = "danger-full-access"'],
]) test(`Codex auto rejects policy override ${args.join(" ")}`, () => {
  const env = fixture("codex", '"auto"');
  refusesPermissions(plan(["codex", "seat", "--", ...args], env));
  for (const action of ["new", "resume", "native"]) {
    expect(nativeInvocation(env, { harness: "codex", action, passthrough: args }).refusal).toContain("permissions");
  }
});

// Cursor and AGY follow the same policy (tap-6c1me). Cursor auto is its own
// classifier mode; AGY has no auto-approval mode, so auto omits the bypass flag.
const OPT_IN: Record<string, { bypass: string[]; auto: string[]; conflicts: string[][]; param: string }> = {
  cursor: { bypass: ["--force", "--sandbox", "disabled"], auto: ["--auto-review"], param: "force",
    conflicts: [["--force"], ["-f"], ["--yolo"], ["--sandbox", "disabled"], ["--sandbox=disabled"], ["-pf"], ["-fp"], ["-pfH", "x"], ["-pfHX-Test:value"], ["-fH123"]] },
  agy: { bypass: ["--dangerously-skip-permissions"], auto: [], param: "dangerously-skip-permissions",
    conflicts: [["--dangerously-skip-permissions"], ["--dangerously-skip-permissions=true"], ["-dangerously-skip-permissions"], ["-dangerously-skip-permissions=true"]] },
};
const contiguous = (argv: string[], tokens: string[]) =>
  argv.some((_, i) => tokens.every((token, j) => argv[i + j] === token));
for (const [harness, spec] of Object.entries(OPT_IN)) {
  for (const action of ["new", "resume"]) for (const mode of [undefined, '"bypass"', '"auto"']) {
    test(`${harness} ${action} base argv follows ${mode ?? "absent"} policy`, () => {
      const env = fixture(harness, mode);
      const argv = buildHarnessInvocation(action, { name: "seat", harness, cwd: env.HOME, base: "team", harness_session_id: "abc" }, null, null, env).argv;
      if (mode === '"auto"') {
        for (const token of spec.bypass.filter(t => t.startsWith("-"))) expect(argv).not.toContain(token);
        for (const token of spec.auto) expect(argv).toContain(token);
      } else {
        expect(contiguous(argv, spec.bypass)).toBe(true);
        expect(argv).not.toContain("--auto-review");
      }
    });
  }
  for (const mode of ['"typo"', 'false', '["auto"]']) test(`${harness} invalid ${mode} refuses`, () => {
    refusesPermissions(plan([harness, "seat"], fixture(harness, mode)));
  });
  for (const source of ["harness", "preset", "passthrough"]) test(`${harness} auto refuses ${source} bypass`, () => {
    const extra = source === "harness" ? `[harness.${harness}.params]\n${spec.param} = true\n` :
      source === "preset" ? `[presets.safe]\nharness = "${harness}"\n[presets.safe.params]\n${spec.param} = true\n` : "";
    refusesPermissions(plan([source === "preset" ? "safe" : harness, "seat", ...(source === "passthrough" ? ["--", spec.bypass[0]!] : [])], fixture(harness, '"auto"', extra)));
  });
  for (const args of spec.conflicts) test(`${harness} auto refuses ${args.join(" ")}`, () => {
    const env = fixture(harness, '"auto"');
    refusesPermissions(plan([harness, "seat", "--", ...args], env));
    for (const action of ["new", "resume", "native"]) {
      expect(nativeInvocation(env, { harness, action, passthrough: args }).refusal).toContain("harness_permissions_conflict");
    }
  });
  if (harness === "cursor") test("cursor auto accepts an enabled sandbox", () => {
    expect(nativeInvocation(fixture(harness, '"auto"'), { harness, action: "new", passthrough: ["--sandbox", "enabled"] }).refusal).toBeUndefined();
  });
  for (const action of ["new", "resume", "native"]) {
    test(`Native ${harness} ${action} effective auto argv`, () => {
      const out = nativeInvocation(fixture(harness, '"auto"'), { harness, action });
      expect(out.refusal).toBeUndefined();
      expect(out.permissions).toBe("auto");
      expect(out.stored_permissions).toBe("auto");
      for (const token of spec.auto) expect(out.argv).toContain(token);
      for (const token of spec.bypass.filter(t => t.startsWith("-"))) expect(out.argv).not.toContain(token);
    });
    test(`Native ${harness} ${action} default keeps bypass`, () => {
      const out = nativeInvocation(fixture(harness), { harness, action });
      expect(out.refusal).toBeUndefined();
      expect(out.permissions).toBe("bypass");
      expect(contiguous(out.argv ?? [], spec.bypass)).toBe(true);
    });
  }
  test(`${harness} effective launch argv uses auto`, () => {
    const { argv, output } = plan([harness, "seat"], fixture(harness, '"auto"'));
    expect(argv.length, output).toBeGreaterThan(0);
    for (const token of spec.bypass.filter(t => t.startsWith("-"))) expect(argv).not.toContain(token);
    for (const token of spec.auto) expect(argv).toContain(token);
  });
}

import { permissionArgv } from "../src/launcher/permissions";
import { crewRecipeInvocation } from "../src/launcher/crew-invocation";
test("permissionArgv refuses a harness TAP does not own instead of borrowing Codex flags", () => {
  // The launcher worker's permissions op calls this for any harness it is handed.
  for (const harness of ["opencode", "hermes", "unknown"]) for (const mode of ["bypass", "auto"] as const) {
    expect(() => permissionArgv(harness, mode)).toThrow("harness_permissions_unsupported");
  }
});
for (const harness of ["cursor", "agy"]) {
  const spec = OPT_IN[harness]!;
  // Migration control: a row written before tap-6c1me has no permissions field.
  for (const action of ["resume", "native"]) test(`legacy ${harness} row without permissions ${action}s with bypass`, () => {
    const out = nativeInvocation(fixture(harness), { harness, action });
    expect(out.refusal).toBeUndefined();
    expect(contiguous(out.argv ?? [], spec.bypass)).toBe(true);
    expect(out.stored_permissions).toBe("bypass");
  });
  test(`${harness} auto refuses a bypass flag in the replayed harness tail`, () => {
    const record: LaunchRecord = { name: "seat", harness, cwd: "/tmp/wt", base: "team", harness_tail: [spec.bypass[0]!] };
    const notices = new Notices(() => {});
    expect(() => launchInvocation("resume", record, notices, { env: { ...process.env, ...fixture(harness, '"auto"') }, resume: null }))
      .toThrow("harness_permissions_conflict");
  });
  test(`${harness} crew replay keeps its recorded auto choice when the catalog now says bypass`, () => {
    const env = { ...process.env, ...fixture(harness, '"bypass"') };
    const { command } = crewRecipeInvocation("team", "crew", { harness, model: "m", harness_env: {}, passthrough: [], cwd: "/tmp", permissions: "auto" }, env);
    for (const token of spec.bypass.filter(t => t.startsWith("-"))) expect(command).not.toContain(token);
    for (const token of spec.auto) expect(command).toContain(token);
  });
}
for (const args of [["--force=true"], ["--yolo=true"], ["--sandbox="], ["--sandbox"]]) test(`cursor auto refuses spelling ${args.join(" ")}`, () => {
  expect(nativeInvocation(fixture("cursor", '"auto"'), { harness: "cursor", action: "new", passthrough: args }).refusal).toContain("harness_permissions_conflict");
});

// A value-taking short option ends Cursor's bundle; what follows is its value, not -f.
for (const args of [["-Hf"], ["-wf"], ["-p"], ["-pHX-f:value"]]) test(`cursor auto accepts ${args.join(" ")}`, () => {
  expect(nativeInvocation(fixture("cursor", '"auto"'), { harness: "cursor", action: "new", passthrough: args }).refusal).toBeUndefined();
});
test("agy auto refuses a single-dash bypass replayed from the harness tail", () => {
  const record: LaunchRecord = { name: "seat", harness: "agy", cwd: "/tmp/wt", base: "team", harness_tail: ["-dangerously-skip-permissions"] };
  expect(() => launchInvocation("resume", record, new Notices(() => {}), { env: { ...process.env, ...fixture("agy", '"auto"') }, resume: null }))
    .toThrow("harness_permissions_conflict");
});
