import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { enrollScratchRoot } from "./support/enroll-scratch";
import { spawnSync as spawnPlan } from "node:child_process";
import { buildHarnessInvocation, withoutNoDaemonForRemote } from "../src/launcher/adapters";
import { codexAutoProfileArgv, codexAutoProfileName, enforcePermissions, prepareCodexAutoReceipts, refuseAmbientCodexSockets } from "../src/launcher/permissions";
import { bootId } from "../src/tmux";

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
function plan(args: string[], env: { HOME: string; XDG_CONFIG_HOME: string }, json = true) {
  spawnPlan("git", ["init", "-q", env.HOME]);
  enrollScratchRoot(env.HOME, join(env.HOME, "index"));
  const merged = Object.fromEntries(Object.entries({ ...process.env, ...env, TAP_INDEX_HOME: join(env.HOME, "index"), TAP_HOME: undefined, TAP_JSON: undefined })
    .filter(([, value]) => value !== undefined)) as Record<string, string>;
  const result = spawnPlan(process.execPath, [newTs, "--dry-run", ...(json ? ["--json"] : []), ...args], { cwd: env.HOME, env: merged, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr,
    argv: result.status === 0 && json ? JSON.parse(result.stdout).argv as string[] : [] };
}
const refusesPermissions = (result: ReturnType<typeof plan>) => {
  expect(result.status).toBe(2);
  expect(result.output).toContain("permissions");
};
/** The profile name an argv selects through `default_permissions`. */
const selectedProfile = (argv: string[]): string => /default_permissions="([^"]+)"/.exec(argv.join("\n"))![1]!;

test("Codex auto can write enrolled receipt folders without granting acting registries", () => {
  const env = fixture("codex", '"auto"');
  const index = join(env.HOME, "index");
  const root = realpathSync(env.HOME);
  const current = join(root, "current"), peer = join(root, "peer"), old = join(root, "old"), legacy = join(root, "legacy");
  const registry = (root: string) => join(root, ".tap/team-registry.json");
  for (const root of [current, peer, old]) {
    mkdirSync(join(root, ".tap/bus/receipts"), { recursive: true });
    writeFileSync(registry(root), JSON.stringify({ schema: "0.20", seats: {} }));
  }
  const legacyRegistry = join(legacy, ".tap/bus/registry.json");
  mkdirSync(join(legacy, ".tap/bus/receipts"), { recursive: true });
  writeFileSync(legacyRegistry, JSON.stringify({ schema: "0.20", seats: {} }));
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    current: { root: current, registry_location: registry(current), state: "registered" },
    peer: { root: peer, registry_location: registry(peer), state: "registered" },
    old: { root: old, registry_location: registry(old), state: "historical" },
    legacy: { root: legacy, registry_location: legacyRegistry, state: "registered" },
  } }));
  const argv = codexAutoProfileArgv({ ...env, TAP_INDEX_HOME: index }, "tap_launcher_auto_0123456789ab");
  const config = Bun.TOML.parse(argv.filter((_, i) => i % 2 === 1).join("\n")) as any;
  const filesystem = config.permissions.tap_launcher_auto_0123456789ab.filesystem;
  expect(filesystem[join(current, ".tap/bus/receipts")]).toBe("write");
  expect(filesystem[join(peer, ".tap/bus/receipts")]).toBe("write");
  expect(filesystem[join(legacy, ".tap/bus/receipts")]).toBe("write");
  expect(filesystem[join(old, ".tap/bus")]).toBeUndefined();
  expect(filesystem[peer]).toBeUndefined();
  expect(filesystem[registry(peer)]).toBeUndefined();
  const grants = Object.entries(filesystem).filter(([, access]) => access === "write").map(([path]) => path);
  for (const protectedPath of [legacyRegistry, legacyRegistry + ".lock", join(legacy, ".tap/bus/locks")]) {
    expect(grants.some(path => protectedPath === path || protectedPath.startsWith(path + "/"))).toBe(false);
  }
});

test.each(["symlink", "file"])("Codex auto refuses a receipts %s instead of granting it write access", kind => {
  const env = fixture("codex", '"auto"');
  const root = realpathSync(env.HOME), index = join(root, "index"), peer = join(root, "peer");
  mkdirSync(peer);
  enrollScratchRoot(peer, index, "peer");
  const bus = join(peer, ".tap/bus");
  if (kind === "symlink") symlinkSync(bus, join(bus, "receipts"));
  else writeFileSync(join(bus, "receipts"), "not a directory");
  expect(() => codexAutoProfileArgv({ ...env, TAP_INDEX_HOME: index })).toThrow("receipts must be a real directory");
  expect(() => prepareCodexAutoReceipts("codex", "auto", { ...env, TAP_INDEX_HOME: index })).toThrow("receipts must be a real directory");
});

test.each([true, false])("Codex dry-run previews missing receipt creation without writing it (json=%s)", json => {
  const env = fixture("codex", '"auto"');
  const result = plan(["codex", "seat"], env, json);
  expect(result.status).toBe(0);
  expect(existsSync(join(env.HOME, ".tap/bus/receipts"))).toBe(false);
  if (json) {
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).harness).toBe("codex");
  } else {
    expect(result.stderr.match(/will be created/g)).toHaveLength(1);
  }
});

test("Codex auto creates a missing receipt directory without granting its parent bus", () => {
  const env = fixture("codex", '"auto"');
  const root = realpathSync(env.HOME), index = join(root, "index"), peer = join(root, "peer");
  mkdirSync(peer);
  enrollScratchRoot(peer, index, "peer");
  const bus = join(peer, ".tap/bus"), receipts = join(bus, "receipts");
  prepareCodexAutoReceipts("codex", "auto", { ...env, TAP_INDEX_HOME: index });
  const argv = codexAutoProfileArgv({ ...env, TAP_INDEX_HOME: index }, "tap_launcher_auto_0123456789ab");
  const config = Bun.TOML.parse(argv.filter((_, i) => i % 2 === 1).join("\n")) as any;
  const filesystem = config.permissions.tap_launcher_auto_0123456789ab.filesystem;
  expect(lstatSync(receipts).isDirectory()).toBe(true);
  expect(filesystem[receipts]).toBe("write");
  const grants = Object.keys(filesystem);
  for (const protectedPath of [bus, join(bus, "registry.json"), join(bus, "locks")]) {
    expect(grants.some(path => protectedPath === path || protectedPath.startsWith(path + "/"))).toBe(false);
  }
});

for (const harness of ["claude", "codex"]) {
  const bypass = harness === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox";
  const auto = harness === "claude" ? ["--permission-mode", "auto"] : ["--approve-for-me"];
  for (const action of ["new", "resume"]) for (const mode of [undefined, '"bypass"', '"auto"']) {
    test(`${harness} ${action} base argv follows ${mode ?? "absent (auto)"} policy`, () => {
      // An absent choice is the auto default, so only a saved bypass yields the bypass flag.
      const env = fixture(harness, mode);
      const argv = buildHarnessInvocation(action, { name: "seat", harness, cwd: env.HOME, base: "team" }, null, null, env).argv;
      expect(argv).toEqual([harness, ...(harness === "codex" ? ["--no-daemon"] : []), ...(mode === '"bypass"' ? [bypass] : auto),
        ...(harness === "codex" && mode !== '"bypass"' ? codexAutoProfileArgv(env, selectedProfile(argv)) : []),
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
// Every Codex route carries --no-daemon so a seat's tools never run under another seat's shared app-server (tap-21bdj).
for (const mode of ['"bypass"', '"auto"']) for (const action of ["new", "resume", "native"]) {
  test(`Codex ${action} argv starts with --no-daemon under ${mode}`, () => {
    expect(nativeInvocation(fixture("codex", mode), { harness: "codex", action }).argv?.slice(0, 2)).toEqual(["codex", "--no-daemon"]);
  });
}
// Codex rejects --no-daemon together with --remote, so a remote launch keeps its own flag and drops ours.
for (const passthrough of [["--remote", "ws://127.0.0.1:9"], ["--remote=unix:///tmp/codex.sock"]]) for (const action of ["new", "resume", "native"]) {
  test(`Codex ${action} drops --no-daemon for ${passthrough.join(" ")}`, () => {
    const argv = nativeInvocation(fixture("codex", '"bypass"'), { harness: "codex", action, passthrough }).argv ?? [];
    expect(argv).not.toContain("--no-daemon");
    expect(argv).toEqual(expect.arrayContaining(passthrough));
  });
}
test("withoutNoDaemonForRemote ignores --remote after the -- delimiter and other harnesses", () => {
  expect(withoutNoDaemonForRemote("codex", ["codex", "--no-daemon", "--", "--remote", "x"])).toEqual(["codex", "--no-daemon", "--", "--remote", "x"]);
  expect(withoutNoDaemonForRemote("claude", ["claude", "--remote", "x", "--no-daemon"])).toEqual(["claude", "--remote", "x", "--no-daemon"]);
});
test("Codex fork argv starts with --no-daemon and claude's argv has none", () => {
  const env = fixture("codex", '"bypass"');
  const fork = buildHarnessInvocation("fork", { name: "seat", harness: "codex", cwd: env.HOME, base: "team", fork_source_session_id: "src-id" }, null, null, env).argv;
  expect(fork.slice(0, 2)).toEqual(["codex", "--no-daemon"]);
  expect(fork).toContain("fork");
  expect(nativeInvocation(fixture("claude", '"bypass"'), { harness: "claude", action: "new" }).argv).not.toContain("--no-daemon");
});
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
  ["-c", 'default_permissions="other"'], ["-c", "permissions.tap_launcher_auto_0123456789ab.network.enabled=false"],
  ["-c", "features.network_proxy=false"], ["-c", 'permissions.x.filesystem={"/"="write"}'],
  ["--config", 'permissions.tap_launcher_auto_0123456789ab.network.unix_sockets={"/tmp/other"="allow"}'],
  // Ancestor, descendant and re-spelled forms of the proxy key reach the same setting.
  ["-c", "features={network_proxy=false}"], ["-c", "features.network_proxy.enabled=false"],
  ["-c", '"features"."network_proxy"=false'], ["-c", " features . network_proxy = false"], ["-c", "permissions={}"],
  ["-c", "default_permissions.x=1"], ["--disable", "network_proxy"], ["--disable=network_proxy"], ["--enable", "network_proxy"],
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
      // An absent choice is the auto default, so only a saved bypass yields the bypass flags.
      if (mode !== '"bypass"') {
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
    test(`Native ${harness} ${action} default is auto`, () => {
      const out = nativeInvocation(fixture(harness), { harness, action });
      expect(out.refusal).toBeUndefined();
      expect(out.permissions).toBe("auto");
      expect(out.stored_permissions).toBe("auto");
      for (const token of spec.bypass.filter(t => t.startsWith("-"))) expect(out.argv).not.toContain(token);
      for (const token of spec.auto) expect(out.argv).toContain(token);
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
  // Policy is re-read on every resume and the unsaved default is auto, so such
  // a row resumes with auto; a saved bypass choice is what keeps bypass.
  for (const action of ["resume", "native"]) test(`legacy ${harness} row without permissions ${action}s with the auto default`, () => {
    const out = nativeInvocation(fixture(harness), { harness, action });
    expect(out.refusal).toBeUndefined();
    for (const token of spec.bypass.filter(t => t.startsWith("-"))) expect(out.argv).not.toContain(token);
    expect(out.stored_permissions).toBe("auto");
  });
  test(`${harness} auto refuses a bypass flag in the replayed harness tail`, () => {
    const record: LaunchRecord = { name: "seat", harness, cwd: "/tmp/wt", base: "team", harness_tail: [spec.bypass[0]!] };
    const notices = new Notices(() => {});
    expect(() => launchInvocation("resume", record, notices, { env: { ...process.env, ...fixture(harness, '"auto"') }, resume: null }))
      .toThrow("harness_permissions_conflict");
  });
  test(`${harness} crew replay keeps its recorded auto choice when the catalog now says bypass`, async () => {
    const env = { ...process.env, ...fixture(harness, '"bypass"') };
    const { command } = await crewRecipeInvocation("team", "crew", { harness, model: "m", harness_env: {}, passthrough: [], cwd: "/tmp", permissions: "auto" }, env);
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

// Codex auto's launcher-owned profile (tap-21bdj): the exact socket through the proxy, the index home writable, nothing else.
test("Codex auto profile names only the tmux socket and the TAP index home (locks live inside it)", () => {
  const seat = { HOME: "/h", TAP_INDEX_HOME: "/h/idx", TMUX: "/private/tmp/tmux-1/s,1,0" };
  const argv = codexAutoProfileArgv(seat);
  const name = selectedProfile(argv);
  const values = argv.filter((_, i) => i % 2 === 1);
  expect(argv.filter((_, i) => i % 2 === 0).every(flag => flag === "-c")).toBe(true);
  expect(values).toEqual([
    `default_permissions="${name}"`,
    `permissions.${name}.extends=":workspace"`,
    `permissions.${name}.network.enabled=true`,
    'features.network_proxy={enabled=true,domains={"**"="deny"},dangerously_allow_all_unix_sockets=false}',
    `permissions.${name}.network.dangerously_allow_all_unix_sockets=false`,
    `permissions.${name}.network.unix_sockets={"/private/tmp/tmux-1/s"="allow"}`,
    `permissions.${name}.filesystem={"/h/idx"="write"}`,
  ]);
  // No allow anywhere: the only domain entry is a deny-all, and no escape hatch is switched on.
  expect(values.some(value => /"allow"/.test(value) && /domains/.test(value))).toBe(false);
  expect(values.some(value => /dangerously\w*=true/.test(value))).toBe(false);
  expect(name).toMatch(/^tap_launcher_auto_[0-9a-f]{12}$/);
  // A lock dir pinned outside the index home is a second named root.
  const pinned = codexAutoProfileArgv({ HOME: "/h", TAP_INDEX_HOME: "/h/idx", TAP_LOCK_DIR: "/elsewhere/locks", TMUX: "/private/tmp/tmux-1/s,1,0" });
  expect(pinned[pinned.length - 1]).toBe(`permissions.${selectedProfile(pinned)}.filesystem={"/h/idx"="write","/elsewhere/locks"="write"}`);
});

test("Codex auto profile index home defaults to ~/.tap of the seat's HOME", () => {
  expect(codexAutoProfileArgv({ HOME: "/h" }).join(" ")).toContain('filesystem={"/h/.tap"="write"');
});

test("enforcePermissions accepts the launcher's own Codex profile and refuses a changed value of the same key", () => {
  const env = { HOME: "/h", TMUX: "/private/tmp/tmux-1/s,1,0" };
  expect(() => enforcePermissions("codex", "auto", ["--approve-for-me", ...codexAutoProfileArgv(env)], env)).not.toThrow();
  const own = codexAutoProfileArgv(env);
  expect(() => enforcePermissions("codex", "auto", ["-c", `permissions.${selectedProfile(own)}.network.enabled=false`], env)).toThrow("permissions");
  // A changed value is refused even next to the launcher's own flags for that profile.
  expect(() => enforcePermissions("codex", "auto", [...own, "-c", `permissions.${selectedProfile(own)}.network.unix_sockets={"/tmp/other"="allow"}`], env)).toThrow("permissions");
  // Bypass mode has no profile.
  expect(codexAutoProfileArgv(env).length).toBeGreaterThan(0);
  expect(buildHarnessInvocation("new", { name: "s", harness: "codex", cwd: "/h", base: "t" }, null, null,
    { ...env, XDG_CONFIG_HOME: "/nonexistent" }, "bypass").argv.join(" ")).not.toContain("default_permissions");
});

test("Codex auto stamps the HOST boot id into the seat env, ignoring an inherited TAP_BOOT_ID; bypass stamps nothing", () => {
  const base = { name: "s", harness: "codex", cwd: "/h", base: "t" };
  const host = bootId({ ...process.env, TAP_BOOT_ID: undefined });
  const env = { HOME: "/h", PATH: process.env.PATH, XDG_CONFIG_HOME: "/nonexistent", TAP_BOOT_ID: "bootuuid:00000000-bogus-bogus-bogus-000000000000" };
  const stamped = buildHarnessInvocation("new", base, null, null, env, "auto").env.TAP_BOOT_ID;
  expect(stamped).toBe(host || undefined);
  expect(stamped).not.toBe(env.TAP_BOOT_ID);
  expect(buildHarnessInvocation("new", base, null, null, env, "bypass").env.TAP_BOOT_ID).toBeUndefined();
});

test("native-adoption Codex auto resume stamps the host boot id too; bypass and Claude stamp nothing", () => {
  const bogus = "bootuuid:00000000-bogus-bogus-bogus-000000000000";
  const host = bootId({ ...process.env, TAP_BOOT_ID: undefined });
  const stamp = (harness: string, mode: string) => {
    const merged = { ...process.env, ...fixture(harness, mode), TAP_BOOT_ID: bogus };
    const record: LaunchRecord = { name: "seat", harness, cwd: "/tmp/wt", base: "team", harness_passthrough: [], passthrough_from_config: false };
    return buildInvocation("resume", record, new Notices(() => {}), merged, null, null, null).env.TAP_BOOT_ID;
  };
  const auto = stamp("codex", '"auto"');
  expect(auto).toBe(host || undefined);
  expect(auto).not.toBe(bogus);
  expect(stamp("codex", '"bypass"')).toBeUndefined();
  expect(stamp("claude", '"auto"')).toBeUndefined();
});

test("enforcePermissions leaves unrelated Codex feature and config keys alone under auto", () => {
  const env = { HOME: "/h", TMUX: "/private/tmp/tmux-1/s,1,0" };
  for (const args of [["-c", "features.other=true"], ["-c", "features.network_proxy_extra=true"], ["--disable", "other_feature"], ["-c", 'model="x"']]) {
    expect(() => enforcePermissions("codex", "auto", args, env)).not.toThrow();
  }
});

test("the Codex auto profile name is fresh random bytes per launch, never derived from stable paths", () => {
  const env = { HOME: "/h", TMUX: "/private/tmp/tmux-1/s,1,0" };
  const names = new Set(Array.from({ length: 20 }, () => selectedProfile(codexAutoProfileArgv(env))));
  expect(names.size).toBe(20);
  for (const name of names) expect(name).toMatch(/^tap_launcher_auto_[0-9a-f]{12}$/);
  expect(codexAutoProfileName()).toMatch(/^tap_launcher_auto_[0-9a-f]{12}$/);
});

// Ambient Codex config cannot be cleared through argv, so an auto launch refuses it by name (tap-21bdj).
function codexConfig(text: string, where: "user" | "project"): { env: NodeJS.ProcessEnv; cwd: string } {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? "/tmp", "ambient-codex."));
  roots.push(root);
  const home = join(root, "home"), project = join(root, "project");
  mkdirSync(join(home, ".codex"), { recursive: true }); mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(join(where === "user" ? home : project, ".codex", "config.toml"), text);
  return { env: { HOME: home }, cwd: project };
}
for (const where of ["user", "project"] as const) for (const [label, text, key] of [
  ["table form", '[features.network_proxy.unix_sockets]\n"/tmp/other.sock" = "allow"\n', "features.network_proxy.unix_sockets"],
  ["inline form", 'features = { network_proxy = { unix_sockets = { "/tmp/other.sock" = "allow" } } }\n', "features.network_proxy.unix_sockets"],
  ["all-sockets escape", "[features.network_proxy]\ndangerously_allow_all_unix_sockets = true\n", "features.network_proxy.dangerously_allow_all_unix_sockets"],
] as const) test(`Codex auto refuses a ${where}-layer config with ${label}, naming the key and the recovery`, () => {
  const { env, cwd } = codexConfig(text, where);
  expect(() => refuseAmbientCodexSockets(env, cwd)).toThrow(key);
  expect(() => refuseAmbientCodexSockets(env, cwd)).toThrow("bypass");
  expect(() => buildHarnessInvocation("new", { name: "s", harness: "codex", cwd, base: "t" }, null, null, env, "auto")).toThrow("harness_permissions_conflict");
  // Bypass has no profile, so the same config is not this launcher's concern.
  expect(() => buildHarnessInvocation("new", { name: "s", harness: "codex", cwd, base: "t" }, null, null, env, "bypass")).not.toThrow();
});
test("Codex auto accepts configs that add no socket: absent, empty, unrelated, domains-only, invalid TOML", () => {
  for (const text of ["", 'model = "x"\n', '[features.network_proxy.domains]\n"example.com" = "allow"\n', "[features.network_proxy]\ndangerously_allow_all_unix_sockets = false\nunix_sockets = {}\n", "= not toml ["]) {
    const { env, cwd } = codexConfig(text, "user");
    expect(() => refuseAmbientCodexSockets(env, cwd)).not.toThrow();
  }
  expect(() => refuseAmbientCodexSockets({ HOME: "/nonexistent-home" }, "/nonexistent-project")).not.toThrow();
});

test("the refusal follows the directory the harness starts in: launch_workdir, and ancestors up to the repository root", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? "/tmp", "ambient-layers."));
  roots.push(root);
  const home = join(root, "home"), anchor = join(root, "anchor"), repo = join(root, "repo"), sub = join(repo, "pkg", "deep");
  for (const dir of [home, anchor, join(repo, ".git"), sub, join(repo, ".codex"), join(root, ".codex")]) mkdirSync(dir, { recursive: true });
  const record = (extra: object) => ({ name: "s", harness: "codex", base: "t", cwd: anchor, ...extra });
  const build = (extra: object) => buildHarnessInvocation("new", record(extra), null, null, { HOME: home }, "auto");
  // Nothing set anywhere: both launch.
  expect(() => build({})).not.toThrow();
  expect(() => build({ launch_workdir: sub })).not.toThrow();
  // The allow sits in the repo-root layer; the seat starts in a subdirectory with no layer of its own.
  writeFileSync(join(repo, ".codex", "config.toml"), '[features.network_proxy.unix_sockets]\n"/tmp/other.sock" = "allow"\n');
  expect(() => build({ launch_workdir: sub })).toThrow(join(repo, ".codex", "config.toml"));
  // The registration anchor has no such layer, so the anchor alone would have launched.
  expect(() => build({})).not.toThrow();
  // A layer above the repository root is not one Codex loads for it.
  writeFileSync(join(repo, ".codex", "config.toml"), "");
  writeFileSync(join(root, ".codex", "config.toml"), '[features.network_proxy.unix_sockets]\n"/tmp/other.sock" = "allow"\n');
  expect(() => build({ launch_workdir: sub })).not.toThrow();
});

for (const args of [["--profile", "work"], ["--profile=work"], ["-p", "work"], ["-pwork"]]) test(`Codex auto refuses a user ${args.join(" ")} with a clear recovery; bypass does not`, () => {
  const env = { HOME: "/h", TMUX: "/private/tmp/tmux-1/s,1,0" };
  expect(() => enforcePermissions("codex", "auto", args, env)).toThrow("AUTO uses TAP's own Codex profile");
  expect(() => enforcePermissions("codex", "bypass", args, env)).not.toThrow();
  refusesPermissions(plan(["codex", "seat", "--", ...args], fixture("codex", '"auto"')));
});

// The unsaved default is auto for every harness TAP owns, and a bypass flag left
// in params without a saved bypass choice is a conflict whose refusal names the
// default and both remedies: the shape a config carries when it predates the
// permissions key (an operator machine config on 2026-10-15 had exactly this for
// all four harnesses).
const LEGACY_PARAM: Record<string, string> = {
  claude: "dangerously-skip-permissions", codex: "dangerously-bypass-approvals-and-sandbox",
  cursor: "yolo", agy: "dangerously-skip-permissions",
};
for (const harness of ["claude", "codex", "cursor", "agy"]) {
  test(`${harness} with no config file at all launches with auto`, () => {
    const env = fixture(harness);
    const out = nativeInvocation({ HOME: env.HOME, XDG_CONFIG_HOME: join(env.HOME, "absent") }, { harness, action: "new" });
    expect(out.refusal).toBeUndefined();
    expect(out.permissions).toBe("auto");
    expect(out.stored_permissions).toBe("auto");
  });
  test(`${harness} bypass param without a saved choice refuses naming the auto default and both remedies`, () => {
    const env = fixture(harness, undefined, `[harness.${harness}.params]\n${LEGACY_PARAM[harness]} = true\n`);
    for (const action of ["new", "resume", "native"]) {
      const out = nativeInvocation(env, { harness, action });
      expect(out.refusal).toContain("harness_permissions_conflict");
      expect(out.refusal).toContain("default permission mode, auto");
      expect(out.refusal).toContain(`[harness.${harness}] permissions = "bypass"`);
      expect(out.refusal).toContain(`--${LEGACY_PARAM[harness]}`);
    }
    const { output } = plan([harness, "seat"], env);
    expect(output).toContain("default permission mode, auto");
  });
  test(`${harness} bypass param with a saved bypass choice launches with bypass`, () => {
    const env = fixture(harness, '"bypass"', `[harness.${harness}.params]\n${LEGACY_PARAM[harness]} = true\n`);
    const out = nativeInvocation(env, { harness, action: "new" });
    expect(out.refusal).toBeUndefined();
    expect(out.permissions).toBe("bypass");
  });
  test(`${harness} bypass param with a saved auto choice keeps the saved-choice wording`, () => {
    const env = fixture(harness, '"auto"', `[harness.${harness}.params]\n${LEGACY_PARAM[harness]} = true\n`);
    const out = nativeInvocation(env, { harness, action: "new" });
    expect(out.refusal).toContain(`contradicts [harness.${harness}] permissions = "auto"`);
    expect(out.refusal).not.toContain("default permission mode");
  });
}

for (const harness of ["claude", "codex", "cursor", "agy"]) test(`${harness} public dry-run with no saved choice launches with auto`, () => {
  const { argv, output } = plan([harness, "seat"], fixture(harness));
  expect(argv.length, output).toBeGreaterThan(0);
  const auto = harness === "claude" ? ["--permission-mode", "auto"] : harness === "codex" ? ["--approve-for-me"] : harness === "cursor" ? ["--auto-review"] : [];
  for (const token of auto) expect(argv).toContain(token);
  for (const token of ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--force", "--yolo"]) expect(argv).not.toContain(token);
});
