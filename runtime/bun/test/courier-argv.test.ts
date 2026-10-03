import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunBinary, courierArgv, initArgv, peerSubmitArgv, recoveryCliArgv, verbArgv } from "../src/courier-argv";
import { artifactBun, artifactRouter, runtimeModule, tapRoot } from "../src/scripts-dir";

test("the courier runs bun from PATH on the main.ts beside the real scripts dir, never the compiled router", () => {
  // process.execPath is the compiled TAP router under `bun build --compile`, and a
  // compiled module's import.meta.dir is virtual: both must come from elsewhere.
  const argv = courierArgv("/opt/tap/skills/tap/scripts", ["peer", "-m", "x"], {});
  expect(argv).toEqual(["bun", resolve("/opt/tap/runtime/bun/main.ts"), "send", "peer", "-m", "x"]);
  expect(argv[0]).not.toBe(process.execPath);
});

test("a stand-in courier gets the send arguments without the verb", () => {
  expect(courierArgv("/opt/tap/skills/tap/scripts", ["peer", "-m", "x"], { TAP_COURIER_SCRIPT: "/tmp/fake" }))
    .toEqual(["bash", "/tmp/fake", "peer", "-m", "x"]);
  // An empty stand-in is no stand-in: the real courier runs.
  expect(courierArgv("/s/skills/tap/scripts", ["p"], { TAP_COURIER_SCRIPT: "" })[0]).toBe("bun");
});

test("an internal verb spawn runs main.ts directly, never the tap.sh shim or the bin/tap public door", () => {
  const argv = verbArgv("/opt/tap/skills/tap/scripts", ["register", "h", "--pane", "s:1.0"], {});
  expect(argv).toEqual(["bun", resolve("/opt/tap/runtime/bun/main.ts"), "register", "h", "--pane", "s:1.0"]);
  expect(argv.join(" ")).not.toContain("tap.sh");
  expect(argv.join(" ")).not.toContain("bin/tap");
});

test("a stand-in verb script gets the whole verb argv; a send stand-in never leaks into it", () => {
  expect(verbArgv("/s/skills/tap/scripts", ["attach", "--no-resume", "t"], { TAP_VERB_SCRIPT: "/tmp/fake" }))
    .toEqual(["bash", "/tmp/fake", "attach", "--no-resume", "t"]);
  expect(verbArgv("/s/skills/tap/scripts", ["x"], { TAP_VERB_SCRIPT: "" })[0]).toBe("bun");
  // The courier keeps its own seam: a verb stand-in does not capture sends.
  expect(courierArgv("/s/skills/tap/scripts", ["p"], { TAP_VERB_SCRIPT: "/tmp/fake" })[0]).toBe("bun");
});

test("init runs Bun on its own entry, with no tap-init.sh adapter; a stand-in gets the verb", () => {
  expect(initArgv("/opt/tap/skills/tap/scripts", ["--yes"], {}))
    .toEqual(["bun", resolve("/opt/tap/runtime/bun/src/verbs/init.ts"), "--yes"]);
  expect(initArgv("/s/skills/tap/scripts", ["--team", "t"], { TAP_VERB_SCRIPT: "/tmp/fake" }))
    .toEqual(["bash", "/tmp/fake", "init", "--team", "t"]);
});

test("a recovery adapter op runs bun from PATH on the shipped cli.ts, never the compiled router or its virtual dir", () => {
  const argv = recoveryCliArgv("/opt/tap/skills/tap/scripts", ["repaint-probe", "/r.json", "peer", "s:0.0", "%3"]);
  expect(argv).toEqual(["bun", resolve("/opt/tap/runtime/bun/src/recovery/cli.ts"), "repaint-probe", "/r.json", "peer", "s:0.0", "%3"]);
  expect(argv[0]).not.toBe(process.execPath);
});

test("a child that must run a module gets process.execPath from source, where that is Bun (the compiled case is compiled-router-spawns)", () => {
  expect(bunBinary()).toBe(process.execPath);
});

test("the router's init fallback spawns the init entry", async () => {
  const { routerFallback } = await import("../main");
  const dir = mkdtempSync(join(tmpdir(), "init-leaf-"));
  try {
    const standIn = join(dir, "stand-in.sh");
    writeFileSync(standIn, 'printf "%s|" "$@" > "$(dirname "$0")/argv"\nexit 5\n');
    const rc = await routerFallback(join(dir, "skills/tap/scripts"))(["init", "--yes", "--team", "t"], { ...process.env, TAP_VERB_SCRIPT: standIn });
    expect(rc).toBe(5);
    expect(readFileSync(join(dir, "argv"), "utf8")).toBe("init|--yes|--team|t|");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp root shaped like a release artifact: libexec/tap/{tap,bun}, with the shim's mode chosen by the caller. */
function artifactRoot(shimMode: number): { root: string; scripts: string; shim: string } {
  const root = mkdtempSync(join(tmpdir(), "artifact-root-"));
  mkdirSync(join(root, "libexec/tap"), { recursive: true });
  mkdirSync(join(root, "skills/tap/scripts"), { recursive: true });
  const shim = join(root, "libexec/tap/bun");
  writeFileSync(join(root, "libexec/tap/tap"), "");
  writeFileSync(shim, "#!/bin/sh\n");
  chmodSync(shim, shimMode);
  return { root, scripts: join(root, "skills/tap/scripts"), shim };
}

test("the root and runtime modules resolve from the real scripts dir", () => {
  expect(tapRoot("/opt/tap/skills/tap/scripts")).toBe(resolve("/opt/tap"));
  expect(runtimeModule("src/verbs/init.ts", "/opt/tap")).toBe(resolve("/opt/tap/runtime/bun/src/verbs/init.ts"));
  // From source the default root is this checkout, which has no libexec/: no artifact Bun.
  expect(artifactBun()).toBeNull();
});

test("in a release artifact every builder runs the shipped shim or the compiled router, never bun from PATH", () => {
  const { root, scripts, shim } = artifactRoot(0o755);
  try {
    expect(artifactBun(root)).toBe(shim);
    expect(artifactRouter(root)).toBe(join(root, "libexec/tap/tap"));
    // The compiled router is main.ts, so an internal verb runs it directly.
    expect(verbArgv(scripts, ["register", "h"], {})).toEqual([join(root, "libexec/tap/tap"), "register", "h"]);
    expect(courierArgv(scripts, ["peer", "-f", "b"], {})).toEqual([join(root, "libexec/tap/tap"), "send", "peer", "-f", "b"]);
    expect(initArgv(scripts, ["--yes"], {})).toEqual([shim, resolve(root, "runtime/bun/src/verbs/init.ts"), "--yes"]);
    expect(peerSubmitArgv(scripts)).toEqual([shim, resolve(root, "runtime/bun/src/verbs/compact-peer-submit.ts")]);
    expect(recoveryCliArgv(scripts, ["op"])).toEqual([shim, resolve(root, "runtime/bun/src/recovery/cli.ts"), "op"]);
    // Test stand-ins still win over the artifact.
    expect(verbArgv(scripts, ["x"], { TAP_VERB_SCRIPT: "/tmp/fake" })).toEqual(["bash", "/tmp/fake", "x"]);
    expect(courierArgv(scripts, ["p"], { TAP_COURIER_SCRIPT: "/tmp/fake" })).toEqual(["bash", "/tmp/fake", "p"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shim that is not executable is no artifact: every builder keeps today's argv", () => {
  const { root, scripts } = artifactRoot(0o644);
  try {
    expect(artifactBun(root)).toBeNull();
    expect(artifactRouter(root)).toBeNull();
    expect(verbArgv(scripts, ["x"], {})).toEqual(["bun", resolve(root, "runtime/bun/main.ts"), "x"]);
    expect(initArgv(scripts, [], {})[0]).toBe("bun");
    expect(peerSubmitArgv(scripts)[0]).toBe("bun");
    expect(recoveryCliArgv(scripts, [])[0]).toBe("bun");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
