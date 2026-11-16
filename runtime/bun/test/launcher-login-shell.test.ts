import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLoginShell } from "../src/launcher/invocation";

const work = mkdtempSync(join(tmpdir(), "login-shell-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Only the fixture directory is on PATH, so zsh/bash/sh candidates cannot
// resolve to a system shell; "/bin/sh" is the terminal fallback.
const FALLBACK = "/bin/sh";

function dirNamedBash(name: string): string {
  const parent = join(work, name);
  mkdirSync(join(parent, "bash"), { recursive: true });
  return parent;
}
function executableBash(name: string): string {
  const parent = join(work, name);
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, "bash"), "#!/bin/sh\n");
  chmodSync(join(parent, "bash"), 0o755);
  return parent;
}

test("a directory named bash is refused as an absolute TAP_LAUNCH_SHELL", () => {
  const parent = dirNamedBash("abs-dir");
  expect(resolveLoginShell({ TAP_LAUNCH_SHELL: join(parent, "bash"), PATH: parent })).toBe(FALLBACK);
});

test("a directory named bash is refused when found on PATH", () => {
  const parent = dirNamedBash("path-dir");
  expect(resolveLoginShell({ TAP_LAUNCH_SHELL: "bash", PATH: parent })).toBe(FALLBACK);
  expect(resolveLoginShell({ PATH: parent })).toBe(FALLBACK);
});

test("an executable file named bash is accepted both absolute and on PATH", () => {
  const parent = executableBash("file");
  const bash = join(parent, "bash");
  expect(resolveLoginShell({ TAP_LAUNCH_SHELL: bash, PATH: parent })).toBe(bash);
  expect(resolveLoginShell({ PATH: parent })).toBe(bash);
});

test("a substituted login shell preserves caller-only harnesses and their env shebangs", async () => {
  const { invocationShellCommand } = await import("../src/launcher/invocation");
  const { spawnSync } = await import("node:child_process");
  const bin = join(work, "caller bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "fish"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  // A supported login shell initializes a different PATH, as a tmux server does.
  writeFileSync(join(bin, "bash"), '#!/bin/sh\nshift\nscript=$1\nshift\nPATH=/usr/bin:/bin exec /bin/sh -c "$script" "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, "fixture-runtime"), '#!/bin/sh\nprintf "%s\\n" "$1"\n', { mode: 0o755 });
  writeFileSync(join(bin, "fixture-harness"), '#!/usr/bin/env fixture-runtime\n', { mode: 0o755 });
  const command = invocationShellCommand({ argv: ["fixture-harness"], env: {} }, { SHELL: join(bin, "fish"), PATH: bin });
  const result = spawnSync("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(join(bin, "fixture-harness"));
});

test("caller PATH stays literal and retains login-shell paths and environment", async () => {
  const { invocationShellCommand } = await import("../src/launcher/invocation");
  const { spawnSync } = await import("node:child_process");
  const bin = join(work, "literal ' $(touch injected)");
  mkdirSync(bin);
  const shell = join(bin, "bash");
  writeFileSync(shell, '#!/bin/sh\nshift\nscript=$1\nshift\nPATH=/login/bin LOADED=yes exec /bin/sh -c "$script" "$@"\n', { mode: 0o755 });
  const command = invocationShellCommand({ argv: ["/bin/sh", "-c", 'printf "%s\\n" "$PATH" "$LOADED"'], env: {} },
    { TAP_LAUNCH_SHELL: shell, PATH: bin });
  const result = spawnSync("/bin/sh", ["-c", command], { cwd: work, env: {}, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([`/login/bin:${bin}`, "yes"]);
});

test("startup diagnostics name the substituted shell", async () => {
  const { loginShellSubstitution } = await import("../src/launcher/invocation");
  expect(loginShellSubstitution({ SHELL: "/bin/fish", PATH: "" }))
    .toBe("launch shell: /bin/sh (POSIX substitute for /bin/fish)");
  expect(loginShellSubstitution({ SHELL: "/bin/sh", PATH: "" })).toBeNull();
  expect(loginShellSubstitution({ TAP_LAUNCH_SHELL: "/bin/sh", SHELL: "/bin/fish", PATH: "" })).toBeNull();
});

test("login-selected harness wins while its caller-only shebang runtime stays available", async () => {
  const { invocationShellCommand } = await import("../src/launcher/invocation");
  const { spawnSync } = await import("node:child_process");
  const caller = join(work, "caller-priority"), login = join(work, "login-priority");
  mkdirSync(caller); mkdirSync(login);
  const shell = join(caller, "bash");
  writeFileSync(shell, `#!/bin/sh\nshift\nscript=$1\nshift\nPATH='${login}' exec /bin/sh -c "$script" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(caller, "fixture-harness"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  writeFileSync(join(caller, "fixture-runtime"), '#!/bin/sh\nprintf "login-selected\\n"\n', { mode: 0o755 });
  writeFileSync(join(login, "fixture-harness"), "#!/usr/bin/env fixture-runtime\n", { mode: 0o755 });
  const command = invocationShellCommand({ argv: ["fixture-harness"], env: {} }, { TAP_LAUNCH_SHELL: shell, PATH: caller });
  const result = spawnSync("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("login-selected");
});
