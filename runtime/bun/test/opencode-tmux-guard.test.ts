// S1 flip: the OpenCode tmux-guard plugin spawns the Bun hook through its
// generated sibling shim. The plugin is copied verbatim into ~/.config/
// opencode/plugins/, so it cannot import the hook's runtime/bun/src graph
// relatively — the shim carries the absolute quoted repo path. This test
// reproduces the installed shape in a sandbox OUTSIDE the repo (plugin copy
// + sibling shim only) and exercises the deny/allow seam end to end.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dir, "../../..");

async function loadSandboxedPlugin() {
  const sandbox = mkdtempSync(join(tmpdir(), "opencode-guard-"));
  const plugins = join(sandbox, "plugins");
  mkdirSync(plugins);
  copyFileSync(
    join(repoRoot, "hooks", "tap-opencode-tmux-guard.ts"),
    join(plugins, "tap-opencode-tmux-guard.ts"),
  );
  // Exactly what install.sh generates: absolute quoted path to the repo hook.
  const shim = join(plugins, "tap-shell-body-guard");
  writeFileSync(shim, `#!/usr/bin/env bash\nexec bun "${repoRoot}/hooks/tap-shell-body-guard.ts" "$@"\n`);
  chmodSync(shim, 0o755);
  const mod = await import(pathToFileURL(join(plugins, "tap-opencode-tmux-guard.ts")).href);
  expect(typeof mod.default.id).toBe("string");
  expect(typeof mod.default.setup).toBe("function");
  let handler: (event: { tool: string; input: { command: unknown } }) => Promise<void>;
  await mod.default.setup({ tool: { hook: async (name: string, callback: typeof handler) => {
    expect(name).toBe("execute.before");
    handler = callback;
  } } });
  return { sandbox, handler: handler! };
}

describe("opencode tmux-guard plugin via sibling shim (installed shape)", () => {
  test("unscoped tmux kill-server is denied", async () => {
    const { sandbox, handler } = await loadSandboxedPlugin();
    try {
      await handler({ tool: "shell", input: { command: "tmux kill-server" } });
      expect.unreachable("guard must throw on unscoped kill-server");
    } catch (error) {
      expect((error as Error).message).toContain("BLOCKED");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("allow, scoped kill, non-bash tool and non-string command pass silently", async () => {
    const { sandbox, handler } = await loadSandboxedPlugin();
    try {
      await handler({ tool: "shell", input: { command: "echo hi" } });
      await handler({ tool: "shell", input: { command: 'tmux -L "priv" kill-server' } });
      await handler({ tool: "edit", input: { command: "tmux kill-server" } });
      await handler({ tool: "shell", input: { command: 42 } });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
