// E2 evidence for the native hook_block renderer and the TOML baseline scan.
// The hook_block oracle bytes were captured ONCE from python3 running the real
// codex_hook_config.hook_block (codex-hook-block-oracle.json, base64 so the
// bytes survive JSON verbatim); the TOML baseline shapes were captured ONCE
// from python3 tomllib (toml-baseline-oracle.json). Neither test invokes
// python3.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hookBlock, MANIFEST_HOOK_EXPECTATIONS, pyRealpath, tomlBaselines } from "../src/install-manifest";

test("hookBlock is byte-identical to python3's codex_hook_config.hook_block", () => {
  const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/codex-hook-block-oracle.json"), "utf8")) as {
    hook: string; guard: string; newline: string; expected_b64: string;
  };
  const expected = Buffer.from(oracle.expected_b64, "base64");
  const actual = Buffer.from(hookBlock(oracle.hook, oracle.guard, oracle.newline), "utf8");
  expect(actual.equals(expected)).toBe(true);
  // The oracle input pins the nasty classes: non-ASCII (ensure_ascii \uXXXX),
  // an astral character (both surrogate escapes), and a raw DEL (\u007f).
  expect(expected.toString("utf8")).toContain('command = "/tmp/h\\u00f6k/\\u2615-tap-codex-session-start\\u007f.sh"');
  expect(expected.toString("utf8")).toContain('command = "/tmp/h\\u00f6k/\\ud83d\\udee1-tap-shell-body-guard.py"');
});

test("hookBlock defaults to newline-terminated lines and the consumer shape strips the tail", () => {
  const fence = hookBlock("/repo/hooks/a.sh", "/repo/hooks/b.py");
  expect(fence.endsWith("# tap-managed:end Codex SessionStart\n")).toBe(true);
  expect(fence.startsWith("# tap-managed:begin Codex SessionStart\n")).toBe(true);
  // install_manifest.py compared text[start:stop] against joined.decode().rstrip("\n").
  expect(fence.replace(/\n$/, "")).toContain('command = "/repo/hooks/a.sh"');
});

test("tomlBaselines matches python3 tomllib's recorder booleans on the captured shapes", () => {
  const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/toml-baseline-oracle.json"), "utf8")) as {
    shapes: Array<
      | { name: string; toml: string; baseline: null }
      | { name: string; toml: string; hooks: boolean; features: boolean; features_hooks: boolean }
    >;
  };
  for (const shape of oracle.shapes) {
    if ("baseline" in shape) {
      // tomllib raises; the recorder's except-pass then records no baseline.
      expect(() => tomlBaselines(shape.toml)).toThrow();
      continue;
    }
    expect(tomlBaselines(shape.toml)).toEqual({
      hooks: shape.hooks, features: shape.features, features_hooks: shape.features_hooks,
    });
  }
});

test("the recorder reads baselines INSIDE the user's own containers", () => {
  const repo = join(import.meta.dir, "..");
  const home = mkdtempSync(join(tmpdir(), "e2-baselines-"));
  const claude = join(home, "claude"), codex = join(home, "codex");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  // A user's own SessionStart hook must not be recorded as one TAP created.
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "user-own" }] } }));
  // A codex user's own hooks as an array of tables: the container is theirs.
  writeFileSync(join(codex, "config.toml"), '[[hooks.SessionStart]]\nuser = "own"\n');
  const manifestPath = join(home, "install-manifest.json");
  const r = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts"), "--init"], {
    env: {
      ...process.env, TAP_INSTALL_REPO: repo, TAP_INSTALL_MANIFEST: manifestPath,
      TAP_RECORD_CLAUDE_HOME: claude, TAP_RECORD_CODEX_HOME: codex,
    },
    stdin: "ignore",
  });
  expect(r.exitCode).toBe(0);
  const baselines = (JSON.parse(readFileSync(manifestPath, "utf8")) as { container_baselines: Record<string, unknown> }).container_baselines;
  expect(baselines[join(claude, "settings.json")]).toEqual({ hooks: false, events: ["PreToolUse"] });
  expect(baselines[join(codex, "config.toml")]).toEqual({ hooks: false, features: true, features_hooks: true });
});

test("a scan over absent link surfaces warns about nothing", () => {
  const repo = join(import.meta.dir, "..");
  const home = mkdtempSync(join(tmpdir(), "e2-absent-"));
  const manifestPath = join(home, "install-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    version: 1, entries: [], repo,
    targets: Object.fromEntries([
      "BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME",
      "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME", "CURSOR_HOME",
    ].map(key => [key, join(home, key)])),
  }));
  const r = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts"), "--scan"], {
    env: { ...process.env, TAP_INSTALL_MANIFEST: manifestPath },
    stdin: "ignore",
  });
  expect(r.exitCode).toBe(0);
  expect(r.stderr.toString()).toBe("");
});

test("a symlinked skills directory is scanned like Python's is_dir, a dangling one stays quiet, a loop warns", () => {
  const repoRoot = join(import.meta.dir, "../../..");
  const home = mkdtempSync(join(tmpdir(), "e2-symlinked-skills-"));
  const manifestPath = join(home, "install-manifest.json");
  const targets = Object.fromEntries([
    "BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME",
    "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME", "CURSOR_HOME",
  ].map(key => [key, join(home, key)]));
  const record = (manifest: object) => {
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [], repo: repoRoot, targets: manifest }));
    const r = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts"), "--scan"], {
      env: { ...process.env, TAP_INSTALL_MANIFEST: manifestPath },
      stdin: "ignore",
    });
    // --scan is a query: entries print on stdout; the manifest file stays.
    return { code: r.exitCode, stderr: r.stderr.toString(), entries: JSON.parse(r.stdout.toString()) as Array<{ kind: string; path: string; target?: string }> };
  };
  // A user who linked the whole skills directory (not per-skill links): the
  // linked dir holds per-skill symlinks into the repo, and each must be
  // recorded so uninstall can remove them.
  const claude = targets["CLAUDE_HOME"]!;
  mkdirSync(claude, { recursive: true });
  const linked = join(home, "linked-skills");
  mkdirSync(linked, { recursive: true });
  symlinkSync(join(repoRoot, "skills", "tap"), join(linked, "tap"));
  symlinkSync(linked, join(claude, "skills"));
  const good = record(targets);
  expect(good.code).toBe(0);
  expect(good.stderr).toBe("");
  expect(good.entries).toContainEqual({ kind: "symlink", path: join(claude, "skills", "tap"), target: join(repoRoot, "skills", "tap") });
  // A dangling skills symlink names nothing: quiet first-install shape.
  const danglingHome = mkdtempSync(join(tmpdir(), "e2-dangling-skills-"));
  const dangling = { ...targets, CLAUDE_HOME: join(danglingHome, "CLAUDE_HOME") };
  mkdirSync(dangling["CLAUDE_HOME"], { recursive: true });
  symlinkSync(join(danglingHome, "nowhere"), join(dangling["CLAUDE_HOME"], "skills"));
  writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [], repo: repoRoot, targets: dangling }));
  const quiet = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts"), "--scan"], {
    env: { ...process.env, TAP_INSTALL_MANIFEST: manifestPath },
    stdin: "ignore",
  });
  expect(quiet.exitCode).toBe(0);
  expect(quiet.stderr.toString()).toBe("");
  // A self-referential skills symlink is unprovable, not absent: ELOOP warns,
  // the scan still records its other surfaces and exits 0.
  const loopHome = mkdtempSync(join(tmpdir(), "e2-loop-skills-"));
  const looped = { ...targets, CLAUDE_HOME: join(loopHome, "CLAUDE_HOME") };
  mkdirSync(looped["CLAUDE_HOME"], { recursive: true });
  symlinkSync(join(looped["CLAUDE_HOME"], "skills"), join(looped["CLAUDE_HOME"], "skills"));
  writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [], repo: repoRoot, targets: looped }));
  const warned = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts"), "--scan"], {
    env: { ...process.env, TAP_INSTALL_MANIFEST: manifestPath },
    stdin: "ignore",
  });
  expect(warned.exitCode).toBe(0);
  expect(warned.stderr.toString()).toContain(`manifest skipped ${join(looped["CLAUDE_HOME"], "skills")}: ELOOP`);
});

test("a CRLF codex config.toml still records its owned fence, storing the on-disk bytes", () => {
  const repoRoot = join(import.meta.dir, "../../..");
  const exp = MANIFEST_HOOK_EXPECTATIONS(join(repoRoot, "hooks"));
  const expected = hookBlock(exp.codexConfig.sessionStart, exp.codexConfig.guard).replace(/\n$/, "");
  for (const [name, eol] of [["lf", "\n"], ["crlf", "\r\n"]] as Array<[string, string]>) {
    const home = mkdtempSync(join(tmpdir(), `e2-crlf-${name}-`));
    const codex = join(home, "CODEX_HOME");
    mkdirSync(codex, { recursive: true });
    const fence = expected.replace(/\n/g, eol);
    writeFileSync(join(codex, "config.toml"), `[user]\r\nname = "own"${eol}${fence}${eol}[features]\r\nx = true${eol}`);
    const manifestPath = join(home, "install-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1, entries: [], repo: repoRoot,
      targets: Object.fromEntries([
        "BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME",
        "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME", "CURSOR_HOME",
      ].map(key => [key, join(home, key)])),
    }));
    const r = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts"), "--scan"], {
      env: { ...process.env, TAP_INSTALL_MANIFEST: manifestPath },
      stdin: "ignore",
    });
    expect(r.exitCode).toBe(0);
    const entries = JSON.parse(r.stdout.toString()) as Array<{ kind: string; path: string; content: string }>;
    const block = entries.find(entry => entry.kind === "block" && entry.path === join(codex, "config.toml"));
    expect(block).toBeDefined();
    expect(block!.content).toBe(fence);
    if (name === "crlf") expect(block!.content).toContain("\r\n");
  }
});

// The legacy-link ownership check must resolve symlink components the way
// python's os.path.realpath did: through dangling links and missing tails,
// never lexically (a foreign link can hide behind an in-repo link's prefix).
test("pyRealpath resolves link prefixes and dangling targets like os.path.realpath", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-pyrealpath-")));
  mkdirSync(join(root, "foreign")); mkdirSync(join(root, "repo"));
  symlinkSync(join(root, "foreign"), join(root, "repo/escape"));
  symlinkSync(join(root, "repo"), join(root, "alias"));
  symlinkSync(join(root, "repo/escape/missing/tap"), join(root, "old-escape"));
  symlinkSync(join(root, "alias/missing/tap"), join(root, "old-alias"));
  symlinkSync("/nonexistent-checkout/bin/tap", join(root, "old-foreign"));
  symlinkSync(join(root, "loop-b"), join(root, "loop-a")); symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
  expect(pyRealpath(join(root, "old-escape"))).toBe(join(root, "foreign/missing/tap"));
  expect(pyRealpath(join(root, "old-alias"))).toBe(join(root, "repo/missing/tap"));
  expect(pyRealpath(join(root, "old-foreign"))).toBe("/nonexistent-checkout/bin/tap");
  expect(pyRealpath(join(root, "foreign/../repo"))).toBe(join(root, "repo"));
  expect(() => pyRealpath(join(root, "loop-a"))).toThrow("symlink loop");
});

test("record retires stale recorded artifacts only on a hash match", () => {
  const home = mkdtempSync(join(tmpdir(), "e2-retire-"));
  const index = join(home, "tap-index");
  mkdirSync(index, { recursive: true });
  const manifestPath = join(index, "install-manifest.json");
  // The two retired artifact shapes older installs recorded: the python3
  // interpreter pin under the index dir and the pre-S1 .py shell-body-guard
  // twin in the OpenCode plugins dir.
  const pin = join(index, "python3");
  const plugins = join(home, "OPENCODE_HOME", "plugins");
  mkdirSync(plugins, { recursive: true });
  const twin = join(plugins, "tap-shell-body-guard.py");
  const pinBytes = "#!/usr/bin/env sh\nexec /some/python3.11\n";
  const twinBytes = "#!/usr/bin/env bash\nexec bun guard.ts \"$@\"\n";
  writeFileSync(pin, pinBytes);
  writeFileSync(twin, twinBytes);
  const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const keeper = { kind: "symlink", path: join(home, "keep"), target: join(home, "t") };
  writeFileSync(manifestPath, JSON.stringify({
    version: 1, repo: join(import.meta.dir, ".."),
    entries: [
      { kind: "file", path: pin, sha256: sha(pinBytes) },
      { kind: "file", path: twin, sha256: sha(twinBytes) },
      { kind: "file", path: join(home, "unrelated"), sha256: sha("x") },
      keeper,
    ],
  }));
  const targets = Object.fromEntries([
    "BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME",
    "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME", "CURSOR_HOME",
  ].map(key => [key, join(home, key)]));
  const r = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts")], {
    env: { ...process.env, TAP_INSTALL_REPO: join(import.meta.dir, ".."), TAP_INSTALL_MANIFEST: manifestPath, ...Object.fromEntries(Object.entries(targets).map(([k, v]) => [`TAP_RECORD_${k}`, v])) },
    stdin: "ignore",
  });
  expect(r.exitCode).toBe(0);
  // Hash matched: both artifacts unlinked, entries dropped, note on stderr.
  expect(existsSync(pin)).toBe(false);
  expect(existsSync(twin)).toBe(false);
  expect(r.stderr.toString()).toContain(`retired stale recorded artifact ${pin}`);
  // The unrelated file entry is outside the retire predicate, so it survives
  // the record untouched; the keeper symlink survives too.
  const doc = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries: Array<{ path: string }> };
  const paths = doc.entries.map(e => e.path);
  expect(paths).not.toContain(pin);
  expect(paths).not.toContain(twin);
  expect(paths).toContain(join(home, "unrelated"));
  expect(paths).toContain(keeper.path);
});

test("record preserves a stale recorded artifact whose bytes no longer match", () => {
  const home = mkdtempSync(join(tmpdir(), "e2-retain-"));
  const index = join(home, "tap-index");
  mkdirSync(index, { recursive: true });
  const manifestPath = join(index, "install-manifest.json");
  const twin = join(home, "OPENCODE_HOME", "plugins", "tap-shell-body-guard.py");
  mkdirSync(join(home, "OPENCODE_HOME", "plugins"), { recursive: true });
  writeFileSync(twin, "#!/usr/bin/env bash\nexec bun guard.ts \"$@\"\n");
  // Recorded hash names DIFFERENT bytes: someone edited the artifact on
  // purpose; the recorder keeps the file and the entry, and warns loudly.
  writeFileSync(manifestPath, JSON.stringify({
    version: 1, repo: join(import.meta.dir, ".."),
    entries: [{ kind: "file", path: twin, sha256: createHash("sha256").update("other bytes").digest("hex") }],
  }));
  const targets = Object.fromEntries([
    "BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME",
    "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME", "CURSOR_HOME",
  ].map(key => [key, join(home, key)]));
  const r = Bun.spawnSync([Bun.which("bun")!, join(import.meta.dir, "../src/install-manifest.ts")], {
    env: { ...process.env, TAP_INSTALL_REPO: join(import.meta.dir, ".."), TAP_INSTALL_MANIFEST: manifestPath, ...Object.fromEntries(Object.entries(targets).map(([k, v]) => [`TAP_RECORD_${k}`, v])) },
    stdin: "ignore",
  });
  expect(r.exitCode).toBe(0);
  expect(existsSync(twin)).toBe(true);
  expect(r.stderr.toString()).toContain(`stale recorded artifact ${twin} kept`);
  const doc = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries: Array<{ path: string }> };
  expect(doc.entries.map(e => e.path)).toContain(twin);
});

test("a release artifact's expectations name the guard's .sh door and shims that exec its own Bun (tap-7r3fn.192)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-manifest-artifact-")));
  mkdirSync(join(root, "libexec/tap"), { recursive: true });
  writeFileSync(join(root, "libexec/tap/bun"), "#!/bin/sh\n", { mode: 0o755 });
  const artifact = MANIFEST_HOOK_EXPECTATIONS(join(root, "hooks"));
  expect(artifact.claudeSettings.PreToolUse).toEqual([`${root}/hooks/tap-shell-body-guard.sh`]);
  expect(artifact.cursorHooks.beforeShellExecution).toEqual([`${root}/hooks/tap-shell-body-guard.sh`]);
  expect(artifact.codexConfig.guard).toBe(`${root}/hooks/tap-shell-body-guard.sh`);
  expect(artifact.geminiHooks.value.PreToolUse[0]!.hooks[0]!.command).toBe(`${root}/hooks/tap-shell-body-guard.sh`);
  const shim = (name: string) => artifact.opencodePlugins.find(p => p.name === name)!.bytes!(root);
  expect(shim("tap-shell-body-guard")).toBe(`#!/usr/bin/env bash\nexec "${root}/libexec/tap/bun" "${root}/hooks/tap-shell-body-guard.ts" "$@"\n`);
  expect(shim("tap-session-context")).toBe(`#!/usr/bin/env bash\nexec "${root}/libexec/tap/bun" "${root}/runtime/bun/src/session-start.ts" "$@"\n`);
  // The same root without libexec/ is a checkout: the bare-Bun forms, byte for byte.
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "tap-manifest-checkout-")));
  const plain = MANIFEST_HOOK_EXPECTATIONS(join(checkout, "hooks"));
  expect(plain.claudeSettings.PreToolUse).toEqual([`${checkout}/hooks/tap-shell-body-guard.ts`]);
  expect(plain.opencodePlugins.find(p => p.name === "tap-shell-body-guard")!.bytes!(checkout)).toBe(`#!/usr/bin/env bash\nexec bun "${checkout}/hooks/tap-shell-body-guard.ts" "$@"\n`);
});
