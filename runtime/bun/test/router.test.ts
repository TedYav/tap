import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { route } from "../main";
import { removeScratchTree } from "./support/scratch";

const scratch: string[] = [];
const root = resolve(import.meta.dir, "../../..");
const fallbackEntry = join(root, "runtime/bun/test/support/leaf-fallback-entry.ts");

afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "tap-bun-router."));
  scratch.push(path);
  return path;
}

function seedLiveFlipMarker(): () => void {
  const index = process.env.TAP_INDEX_HOME || join(tempDir(), "index");
  mkdirSync(index, { recursive: true });
  const marker = join(index, "global-registry.json");
  const previous = existsSync(marker) ? readFileSync(marker) : undefined;
  writeFileSync(marker, JSON.stringify({ schema: "0.20" }));
  const prevHome = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = index;
  return () => {
    if (prevHome === undefined) delete process.env.TAP_INDEX_HOME;
    else process.env.TAP_INDEX_HOME = prevHome;
    if (previous === undefined) {
      try { unlinkSync(marker); } catch { /* runner index stays markerless */ }
    } else {
      writeFileSync(marker, previous);
    }
  };
}

describe("mixed-runtime router", () => {
  test("send, reply, and retired done are native by default", () => {
    const restore = seedLiveFlipMarker();
    try {
      const calls: string[] = [];
      const handlers = Object.fromEntries(
        ["send", "reply", "done", "poll", "whoami"].map((verb) => [
          verb,
          (argv: string[]) => {
            calls.push(`${verb}:${argv.join("|")}`);
            return 11;
          },
        ]),
      );
      const fallback = (argv: string[]) => {
        calls.push(`bash:${argv.join("|")}`);
        return 22;
      };
      const dir = tempDir();
      const trace = join(dir, "trace");

      for (const verb of ["send", "reply", "done", "poll", "whoami"]) {
        expect(route([verb, "arg"], handlers, fallback, trace)).toBe(11);
      }

      expect(calls).toEqual([
        "send:arg",
        "reply:arg",
        "done:arg",
        "poll:arg",
        "whoami:arg",
      ]);
      expect(readFileSync(trace, "utf8")).toBe(
        "native send\nnative reply\nnative done\nnative poll\nnative whoami\n",
      );
    } finally {
      restore();
    }
  });

  test("all team forms follow native dispatch after Bash-body retirement", () => {
    const calls: string[] = [];
    const handlers = {
      team: (argv: string[]) => {
        calls.push(`native:${argv.join("|")}`);
        return 11;
      },
    };
    const fallback = (argv: string[]) => {
      calls.push(`bash:${argv.join("|")}`);
      return 22;
    };
    const trace = join(tempDir(), "trace");

    const nativeForms = [
      ["team", "list"],
      ["team"],
      ["team", "roster"],
      ["team", "--json"],
      ["team", "roster", "--all"],
      ["team", "--names"],
      ["team", "--names", "--online"],
      ["team", "show"],
      ["team", "--future-option"],
      // tap-nyvty: refresh is native now, with its own flags. It is the first
      // MUTATING team subcommand to leave BASH_OWNED, so the router must carry
      // its argv rather than delegate — including flags the roster does not have.
      ["team", "refresh"],
      ["team", "refresh", "--json"],
      ["team", "refresh", "--hard", "--dry-run"],
      // tap-1064: attach left BASH_OWNED.team when its viewers moved to Bun, so
      // the router carries `team attach` (and its --only/--except/--dry-run/--tabs
      // argv) to the native handler rather than delegating.
      ["team", "attach"],
      ["team", "down"],
      ["team", "down", "--keep-self"],
      ["team", "shutdown"],
      ["team", "shutdown", "--yes", "--json"],
      // Reset and restore left BASH_OWNED when their checkpoint/fence
      // authorities moved to Bun, so the router carries them natively too.
      ["team", "reset"],
      ["team", "restore"],
      ["team", "calibration"],
      ["team", "detach"],
      ["team", "up"],
      ["team", "purge"],
      ["team", "doctor"],
      ["team", "doctor", "--fix", "--only", "session-binding"],
      ["team", "detach", "--only"],
    ];

    for (const argv of nativeForms) expect(route(argv, handlers, fallback, trace)).toBe(11);

    expect(calls).toEqual([
      ...nativeForms.map((argv) => `native:${argv.slice(1).join("|")}`),
    ]);
    expect(readFileSync(trace, "utf8").split("\n").filter(Boolean)).toEqual([
      ...nativeForms.map(() => "native team"),
    ]);
  });

  test("help, the undo verb, bare tap, and unknown verbs delegate with full argv", () => {
    const calls: string[][] = [];
    const fallback = (argv: string[]) => {
      calls.push(argv);
      return 7;
    };
    const trace = join(tempDir(), "trace");

    expect(route([], {}, fallback, trace)).toBe(7);
    expect(route(["help", "poll"], {}, fallback, trace)).toBe(7);
    expect(route(["try", "off"], {}, fallback, trace)).toBe(7);
    expect(route(["not-a-verb", "--json"], {}, fallback, trace)).toBe(7);

    expect(calls).toEqual([
      [],
      ["help", "poll"],
      ["try", "off"],
      ["not-a-verb", "--json"],
    ]);
    expect(readFileSync(trace, "utf8")).toBe(
      "bash <none>\nbash help\nbash try\nbash not-a-verb\n",
    );
  });

  test("an unrecognized verb cannot enter an obsolete native handler even with an empty rollback set", () => {
    // `done` no longer illustrates this: it is a real native verb since the
    // done tombstone, so a caller-supplied handler for it now IS invoked.
    // "not-a-verb" (also used above) stays outside NATIVE_VERBS by construction.
    const trace = join(tempDir(), "trace");
    let fallbackCalls = 0;
    expect(route(
      ["not-a-verb", "help", "-m", "body"],
      { "not-a-verb": (argv) => argv.length },
      () => ++fallbackCalls,
      trace,
    )).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(readFileSync(trace, "utf8")).toBe("bash not-a-verb\n");
  });

  test("exact two-argument help spellings delegate before the native table", () => {
    const trace = join(tempDir(), "trace");
    const calls: string[][] = [];
    for (const spelling of ["help", "--help", "-h"]) {
      expect(route(
        ["poll", spelling],
        { poll: () => 99 },
        (argv) => {
          calls.push(argv);
          return 7;
        },
        trace,
      )).toBe(7);
    }
    expect(calls).toEqual([
      ["poll", "help"],
      ["poll", "--help"],
      ["poll", "-h"],
    ]);
    expect(readFileSync(trace, "utf8")).toBe("bash poll\nbash poll\nbash poll\n");
  });

  test("documented Bash-owned forms delegate whole argv without hiding native unknown options", () => {
    const calls: string[] = [];
    const handlers = Object.fromEntries(
      ["send", "reply", "done", "poll", "whoami"].map((verb) => [verb, () => {
        calls.push(`native:${verb}`);
        return 11;
      }]),
    );
    const fallback = (argv: string[]) => {
      calls.push(`bash:${argv.join("|")}`);
      return 22;
    };
    const trace = join(tempDir(), "trace");
    // D1 (message construction): these forms are native now — the obligation
    // modes, the receipt shape, the id, stdin and a positional payload file.
    const d1Native = [
      ["send", "seat", "-m", "x", "--expect-reply"],
      ["send", "seat", "-m", "x", "--fyi"],
      ["send", "seat", "-m", "x", "--json"],
      ["send", "seat", "-m", "x", "--id", "seat-20260831T000000Z-aabbccddeeff"],
      ["send", "seat", "-f", "-"],
      ["send", "seat", "--body-file", "-"],
      ["send", "seat", "/tmp/payload.md"],
      ["reply", "id", "-m", "x", "--progress"],
      ["reply", "id", "-m", "x", "--json"],
      ["send", "seat", "-m", "x", "--note", "--fyi"],
      ["send", "seat", "-m", "x", "--note", "--expect-reply"],
      // D2 member 2 (team-qualified addressing): a `team/handle` or
      // `team:handle` destination is native; the manual relay and the registry
      // override (`--cross-worktree`, `--pane`, `--remote-registry`) are not.
      ["send", "team/seat", "-m", "x"],
      ["send", "team:seat", "-m", "x"],
      // D3a (send-side delivery classes): polite, its timeout, no-spool and the
      // `polite` / `now` values of --delivery are native.
      ["send", "seat", "-m", "x", "--polite"],
      ["send", "seat", "-m", "x", "--polite", "--polite-timeout", "7"],
      ["send", "seat", "-m", "x", "--no-spool"],
      ["send", "seat", "-m", "x", "--delivery", "polite"],
      ["send", "seat", "-m", "x", "--delivery", "now"],
      // D4b (reply's forwarded forms): `--delivery polite|now`, stdin and
      // `--allow-unattended` are native on reply.
      ["reply", "id", "-m", "x", "--delivery", "now"],
      ["reply", "id", "-m", "x", "--delivery", "polite"],
      ["reply", "id", "-f", "-"],
      ["reply", "id", "--body-file", "-"],
      ["reply", "id", "-m", "x", "--allow-unattended"],
      // D4d (the foreign payload file): every reference spelling, `--payload`
      // and the pane-less `--team` anchor are native on reply.
      ["reply", "/tmp/payload.md", "-m", "x"],
      ["reply", "team/id", "-m", "x"],
      ["reply", "path=/tmp/payload.md", "-m", "x"],
      ["reply", "id", "-m", "x", "--payload", "/tmp/payloads/id.md"],
      ["reply", "id", "-m", "x", "--team", "team"],
      ["reply", "id", "-m", "x", "--json", "--team", "team"],
      // The D feeder is closed: a missing operand is the native parser's
      // usage_error, never a Bash bounce.
      ["reply", "id", "-m", "x", "--delivery"],
      ["reply", "id", "-m"],
      ["reply", "id", "-m", "", "--preview", ""],
    ];
    const restore = seedLiveFlipMarker();
    try {
      for (const argv of d1Native) expect(route(argv, handlers, fallback, trace)).toBe(11);

      expect(route(["poll", "--future-option"], handlers, fallback, trace)).toBe(11);
      expect(route(["send", "seat", "-m", "x", "--kind", "discuss"], handlers, fallback, trace)).toBe(11);
      expect(route(["send", "seat", "-m", "x", "--ask"], handlers, fallback, trace)).toBe(11);
      expect(route(["send", "seat", "-m", "x", "--reply"], handlers, fallback, trace)).toBe(11);
      // --note is native (tap-dk19b); its conflicts with --fyi/--expect-reply
      // are native too since D1 (see d1Native above).
      expect(route(["send", "seat", "-m", "x", "--note"], handlers, fallback, trace)).toBe(11);
      for (const argv of [
        ["poll", "seat", "--json"], ["whoami", "--json"],
        ["poll", "seat", "--quiet", "--json"], ["whoami", "--verbose", "--json"],
        ["poll", "seat", "--team", "team"],
      ]) expect(route(argv, handlers, fallback, trace)).toBe(11);
      expect(calls.filter((call) => call.startsWith("native:"))).toEqual([
        ...d1Native.map((argv) => `native:${argv[0]}`),
        "native:poll", "native:send", "native:send", "native:send", "native:send",
        "native:poll", "native:whoami", "native:poll", "native:whoami", "native:poll",
      ]);
      expect(calls.filter((call) => call.startsWith("bash:"))).toHaveLength(0);
      expect(readFileSync(trace, "utf8").split("\n").filter(Boolean)).toEqual([
        ...d1Native.map((argv) => `native ${argv[0]}`),
        "native poll",
        "native send",
        "native send",
        "native send",
        "native send",
        "native poll", "native whoami", "native poll", "native whoami", "native poll",
      ]);
      const assignHandlers = { ...handlers, assign: () => { calls.push("native:assign"); return 11; } };
      const assignCalls = calls.length;
      expect(route(["assign", "seat", "-m", "x"], assignHandlers, fallback, trace)).toBe(11);
      expect(calls.slice(assignCalls)).toEqual(["native:assign"]);
    } finally {
      restore();
    }
  });

  test("a Bash-owned spelling used as an option value remains native data", () => {
    let nativeArgv: string[] = [];
    let fallbackCalls = 0;
    const restore = seedLiveFlipMarker();
    try {
      const result = route(
        ["send", "seat", "-m", "--team"],
        { send: (argv) => { nativeArgv = argv; return 7; } },
        () => ++fallbackCalls,
        undefined,
      );

      expect(result).toBe(7);
      expect(nativeArgv).toEqual(["seat", "-m", "--team"]);
      expect(fallbackCalls).toBe(0);
    } finally {
      restore();
    }
  });

  test("the Bun entry point delegates help byte-for-byte and records the route", () => {
    const dir = tempDir();
    const trace = join(dir, "trace");
    const bus = join(dir, "bus");
    const index = join(dir, "index");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    mkdirSync(join(bus, "receipts"), { recursive: true });
    mkdirSync(index, { recursive: true });
    const env = {
      ...process.env,
      TAP_BUN_ROUTE_TRACE: trace,
      TAP_HOME: bus,
      TAP_INDEX_HOME: index,
    };
    const incumbent = join(root, "bin/tap");
    const candidate = join(root, "runtime/bun/main.ts");

    const expected = spawnSync("bash", [incumbent, "help"], { encoding: "utf8", env });
    const actual = spawnSync("bun", [candidate, "help"], { encoding: "utf8", env });

    expect(actual.status).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    // bin/tap and main.ts both reach the one native help.
    expect(readFileSync(trace, "utf8")).toBe("native help\nnative help\n");
    // Spool dispatch is native now; byte parity and the route trace above are
    // the contract, not the retired Bash-engine description in bare help.
  });

  test("the leaf fallback preserves stdin, stdout, stderr, and status", () => {
    const dir = tempDir();
    const incumbent = join(dir, "fallback.sh");
    // Exercise the real fallback transport with a stable stdin consumer. The
    // entry-point help test above separately proves public routing reaches it.
    writeFileSync(incumbent, `#!/usr/bin/env bash
if [ "$#" = 0 ]; then printf 'missing verb\\n' >&2; exit 1; fi
IFS= read -r body
printf '%s:%s\\n' "$1" "$body"
printf 'fallback diagnostic\\n' >&2
exit 2
`, { mode: 0o755 });
    const options = { encoding: "utf8" as const, input: "stream survives\n" };
    const expected = spawnSync("bash", [incumbent, "echo-input"], options);
    const actual = spawnSync("bun", [fallbackEntry, incumbent, "echo-input"], options);
    expect(expected.status).toBe(2);
    expect(expected.stdout).toBe("echo-input:stream survives\n");
    expect(actual.status).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);

    const expectedError = spawnSync("bash", [incumbent], options);
    const actualError = spawnSync("bun", [fallbackEntry, incumbent], options);
    expect(expectedError.status).toBe(1);
    expect(expectedError.stderr).not.toBe("");
    expect(actualError.status).toBe(expectedError.status);
    expect(actualError.stdout).toBe(expectedError.stdout);
    expect(actualError.stderr).toBe(expectedError.stderr);
  });

  test("the compiled entry point dispatches from the repo-owned runtime directory", () => {
    const dir = tempDir();
    const binary = join(root, "runtime/bun", `router-test-${process.pid}`);
    scratch.push(binary);
    const candidate = join(root, "runtime/bun/main.ts");
    const incumbent = join(root, "bin/tap");
    const trace = join(dir, "trace");
    const env = { ...process.env, TAP_BUN_ROUTE_TRACE: trace };

    const build = spawnSync(
      "bun",
      ["build", "--compile", candidate, "--outfile", binary],
      { cwd: dir, encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);

    const expected = spawnSync("bash", [incumbent, "help"], { encoding: "utf8", env });
    const actual = spawnSync(binary, ["help"], { encoding: "utf8", env });
    expect(actual.status).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.stderr).toBe(expected.stderr);
    expect(readFileSync(trace, "utf8")).toBe("native help\nnative help\n");
  });

  test("a direct scripts/tap.sh send reaches the router once", () => {
    const dir = tempDir();
    const home = join(dir, "home");
    const index = join(dir, "index");
    mkdirSync(join(home, ".tap"), { recursive: true });
    mkdirSync(index, { recursive: true });
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      TAP_INDEX_HOME: index,
      TAP_SPOOL_DISABLE_DELIVERER: "1",
      TAP_ONBOARDING_CHECKED: "1",
    };
    delete base.TMUX;
    delete base.TMUX_PANE;

    // scripts/tap.sh is a shim into bin/tap: with or without -v before the verb, one
    // route entry.
    for (const [label, argv] of [
      ["plain", ["send", "seat", "-m", "x", "--polite"]],
      ["verbose", ["-v", "send", "seat", "-m", "x", "--polite"]],
    ] as Array<[string, string[]]>) {
      const trace = join(dir, `trace-${label}`);
      const r = spawnSync("bash", [join(root, "scripts/tap.sh"), ...argv], {
        encoding: "utf8", cwd: dir, env: { ...base, TAP_BUN_ROUTE_TRACE: trace },
      });
      expect(readFileSync(trace, "utf8")).toBe("native send\n");
      if (label === "verbose") expect(r.stderr).toContain("tap verbose");
    }
  });

  test("a Bun the kernel refuses to exec gets the install refusal through scripts/tap.sh", () => {
    const dir = tempDir();
    const index = join(dir, "index");
    mkdirSync(index, { recursive: true });
    const fakeDir = join(dir, "fakebin");
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(join(fakeDir, "bun"), "#!/nonexistent/tap-bridge-interpreter\n", { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir,
      PATH: `${fakeDir}:${process.env.PATH}`,
      TAP_INDEX_HOME: index,
      TAP_SPOOL_DISABLE_DELIVERER: "1",
      TAP_ONBOARDING_CHECKED: "1",
    };
    delete env.TMUX;
    delete env.TMUX_PANE;

    // The bun exec itself fails (missing shebang interpreter): scripts/tap.sh's door
    // (bin/tap) refuses with the install remedy, and the absent trace proves
    // the router never ran.
    const trace = join(dir, "trace");
    const r = spawnSync("bash", [join(root, "scripts/tap.sh"), "send", "seat", "-m", "x", "--polite"], {
      encoding: "utf8", cwd: dir, env: { ...env, TAP_BUN_ROUTE_TRACE: trace },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("tap: bun and runtime/bun/main.ts are required; next: brew install oven-sh/bun/bun, then rerun ./install.sh");
    expect(existsSync(trace)).toBe(false);
  });

  test("an absent flip marker refuses reply by name instead of reaching the retired Bash body", () => {
    const dir = tempDir();
    const index = join(dir, "index");
    mkdirSync(index, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TAP_INDEX_HOME: index, TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_ONBOARDING_CHECKED: "1" };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const trace = join(dir, "trace");
    const r = spawnSync(process.execPath, [join(root, "runtime/bun/main.ts"), "reply", "bogus-id", "-m", "x"], {
      encoding: "utf8", cwd: dir, env: { ...env, TAP_BUN_ROUTE_TRACE: trace },
    });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr, traced: existsSync(trace) ? readFileSync(trace, "utf8") : "" }).toEqual({
      status: 1, stdout: "", traced: "native reply\n",
      stderr: "tap reply: no machine index (global-registry.json); this machine has no enrolled team; next: tap init  OR  tap session launch\n",
    });
  });

  test("every session form reaches its native door with no Bash leaf", () => {
    const dir = tempDir();
    const index = join(dir, "index");
    mkdirSync(join(dir, "home", ".tap"), { recursive: true });
    mkdirSync(index, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), TAP_INDEX_HOME: index, TAP_ONBOARDING_CHECKED: "1" };
    delete env.TMUX;
    delete env.TMUX_PANE;
    for (const argv of [
      ["session", "resume", "nobody", "--dry", "--json"],
      ["session", "restart"],
      ["session", "relaunch", "--harness", "codex", "--team", "missing"],
      ["session", "bogus"],
    ]) {
      const trace = join(dir, `trace-${argv[1]}`);
      const result = spawnSync("/bin/bash", [join(root, "bin/tap"), ...argv], {
        cwd: dir, encoding: "utf8", env: { ...env, TAP_BUN_ROUTE_TRACE: trace },
      });
      expect(readFileSync(trace, "utf8"), `${argv.join(" ")}: ${result.stderr}`).toBe("native session\n");
    }
    const unknown = spawnSync("/bin/bash", [join(root, "bin/tap"), "session", "bogus"], { cwd: dir, encoding: "utf8", env });
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toBe("tap session: unknown session subcommand 'bogus'; next: tap help session\n");
  });

  test("the installed router forwards direct SIGTERM to its exact leaf child", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "fallback.pid");
    const fakeBash = join(dir, "bash");
    writeFileSync(fakeBash, `#!/bin/bash
set -euo pipefail
printf '%s\n' "$$" > "$FALLBACK_PID_PATH.partial"
mv "$FALLBACK_PID_PATH.partial" "$FALLBACK_PID_PATH"
trap 'exit 130' INT
trap 'exit 143' TERM
while :; do sleep 1; done
`, { mode: 0o755 });

    // init is the router's one leaf child; its TAP_VERB_SCRIPT stand-in runs
    // under `bash` from PATH, which finds the fake.
    const wrapper = spawn("/bin/bash", [join(root, "bin/tap"), "init"], {
      env: {
        ...process.env,
        HOME: dir,
        PATH: `${dir}:${process.env.PATH}`,
        TAP_VERB_SCRIPT: join(dir, "stand-in"),
        FALLBACK_PID_PATH: pidPath,
      },
      stdio: "ignore",
    });
    let childPid = 0;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      wrapper.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidPath) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(pidPath)).toBe(true);
      childPid = Number(readFileSync(pidPath, "utf8").trim());
      expect(Number.isSafeInteger(childPid)).toBe(true);

      wrapper.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        Bun.sleep(5_000).then(() => null),
      ]);
      expect(result).toEqual({ code: 143, signal: null });
      await Bun.sleep(50);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGKILL");
        await exited;
      }
      if (childPid) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already reaped */ }
      }
    }
  }, 10_000);

  test("the installed router forwards direct SIGHUP to its exact leaf child", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "fallback.pid");
    const fakeBash = join(dir, "bash");
    writeFileSync(fakeBash, `#!/bin/bash
set -euo pipefail
printf '%s\n' "$$" > "$FALLBACK_PID_PATH.partial"
mv "$FALLBACK_PID_PATH.partial" "$FALLBACK_PID_PATH"
trap 'exit 129' HUP
while :; do sleep 1; done
`, { mode: 0o755 });

    // init is the router's one leaf child; its TAP_VERB_SCRIPT stand-in runs
    // under `bash` from PATH, which finds the fake.
    const wrapper = spawn("/bin/bash", [join(root, "bin/tap"), "init"], {
      env: {
        ...process.env,
        HOME: dir,
        PATH: `${dir}:${process.env.PATH}`,
        TAP_VERB_SCRIPT: join(dir, "stand-in"),
        FALLBACK_PID_PATH: pidPath,
      },
      stdio: "ignore",
    });
    let childPid = 0;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      wrapper.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidPath) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(pidPath)).toBe(true);
      childPid = Number(readFileSync(pidPath, "utf8").trim());
      expect(Number.isSafeInteger(childPid)).toBe(true);

      wrapper.kill("SIGHUP");
      const result = await Promise.race([
        exited,
        Bun.sleep(5_000).then(() => null),
      ]);
      expect(result).toEqual({ code: 129, signal: null });
      await Bun.sleep(50);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGKILL");
        await exited;
      }
      if (childPid) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already reaped */ }
      }
    }
  }, 10_000);

  test("a missing leaf executable fails loud", () => {
    const missing = join(tempDir(), "missing-tap.sh");
    const result = spawnSync("bun", [fallbackEntry, missing], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not start");
    expect(result.stderr).toContain(missing);
  });
});

// Checkpoint A (send-reply R2, U1+U2): the send/assign/reply argv rows whose
// native semantics exist route native. Appended as its own block so the
// register/out arms above are untouched (R3 concurrency, plan §6).
describe("send/assign/reply token ownership — checkpoint A", () => {
  function routeOf(argv: string[]): string {
    const restore = seedLiveFlipMarker();
    try {
      const trace = join(tempDir(), "trace");
      const handlers = Object.fromEntries(
        ["send", "assign", "reply"].map((verb) => [verb, () => 11]),
      );
      route(argv, handlers, () => 22, trace);
      return readFileSync(trace, "utf8");
    } finally {
      restore();
    }
  }

  test("every U1 send/assign option routes native", () => {
    for (const token of [
      ["--team", "flip"],
      ["--wake"],
      ["--reply-to", "ub"],
      ["--no-auto-reply-to"],
      ["--in-reply-to", "ub-20260920T010000Z-aabbccddeeff"],
      ["--recipient-instance", "ub|A"],
      ["--sender-instance", "ua|A"],
      ["--historical-recipient"],
      ["--adopted-from", "ub"],
    ]) {
      expect({ token, trace: routeOf(["send", "ub", "-m", "x", ...token]) }).toEqual({
        token, trace: "native send\n",
      });
      expect({ token, assign: routeOf(["assign", "ub", "-f", "payload.md", ...token]) }).toEqual({
        token, assign: "native assign\n",
      });
    }
  });

  test("every U2 send option routes native", () => {
    for (const token of [
      ["--pane", "ub:0.0"],
      ["--cross-worktree", "--pane", "peer:0.0"],
      ["--remote-registry", "/tmp/acting.json"],
    ]) {
      expect({ token, trace: routeOf(["send", "ub", "-m", "x", ...token]) }).toEqual({
        token, trace: "native send\n",
      });
    }
  });

  test("the interrupt class routes native (U4 owns the interrupt sequence)", () => {
    expect(routeOf(["send", "ub", "-m", "x", "--urgent"])).toBe("native send\n");
    expect(routeOf(["send", "ub", "-m", "x", "--kind", "escalate"])).toBe("native send\n");
    expect(routeOf(["send", "ub", "-m", "x", "--delivery", "interrupt"])).toBe("native send\n");
    expect(routeOf(["reply", "ub-20260920T010000Z-aabbccddeeff", "-m", "x", "--delivery", "interrupt"])).toBe("native reply\n");
  });

  test("reply's --reply-to, --pane and positional body route native", () => {
    expect(routeOf(["reply", "ub-20260920T010000Z-aabbccddeeff", "-m", "x", "--reply-to", "ua"])).toBe("native reply\n");
    expect(routeOf(["reply", "ub-20260920T010000Z-aabbccddeeff", "-m", "x", "--pane", "ub:0.0"])).toBe("native reply\n");
    expect(routeOf(["reply", "ub-20260920T010000Z-aabbccddeeff", "body.md"])).toBe("native reply\n");
  });
});
