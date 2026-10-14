import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callingPane, observeCallingPane } from "../src/context";
import { DEFAULT_AGENT_FAMILIES, classifyHolderCommand } from "../src/observe";
import { physicalSocketPath } from "../src/tmux";
import { parentPid, pidHasAncestor, processRow } from "../src/process-ancestry";
import { removeScratchTree } from "./support/scratch";

// The caller-pane observer's one admitted climb past a controlling terminal no
// pane owns: a harness holding that terminal for its own tool (Antigravity's
// run_command runs each command on a fresh pty while agy stays on the pane
// tty). The dead-pane-tty pattern supplies the pane half: a REAL private tmux
// server behind a `tmux` wrapper that reports every live pane on the fixture
// tty, so pane id, session and server generation are the server's own. The
// process half is a scripted `ps` answering the two spellings the runtime uses
// (`-o ppid= -o tty= -p <pid>` and the `-Ao` table), with the test process as
// the walk's root so each case states one ancestry shape.

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error("caller-pane-held-pty.test.ts: TMUX_TMPDIR is unset — this fixture spawns tmux only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it)");
}
const scratch = mkdtempSync(join(RUNNER_ROOT, "tap-held-pty."));
const socket = `held-pty-${process.pid}`;
const realTmux = Bun.which("tmux")!;
const tmuxEnv = { ...process.env };
delete tmuxEnv.TMUX;
delete tmuxEnv.TMUX_PANE;
const T = (...args: string[]) => {
  const result = spawnSync(realTmux, ["-L", socket, ...args], { env: tmuxEnv, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

const ME = process.pid;
const ZSH = 70002, HOLDER = 70003, INNER = 70004, OTHER = 70005;
const FIRST = "ttys087";   // the tool's terminal, as ps spells it
const PANE_TTY = "faketty"; // what the wrapper reports for every live pane
let live = "";
let panePid = "";
let baseEnv: NodeJS.ProcessEnv;

type Tree = Array<[number, number | string, string]>;
type Table = Array<[number, string, string]>;
function envFor(tree: Tree, table: Table): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    FAKE_PS_TREE: tree.map(([pid, ppid, tty]) => `${pid} ${ppid} ${tty}`).join("\n"),
    FAKE_PS_TABLE: table.map(([pid, comm, command]) => `${pid} ${pid} ${pid} ${comm} ${command}`).join("\n"),
  };
}
/** The reference shape: tap -> zsh on the tool terminal, held by agy on the pane tty under pane_pid. */
function agyTree(): Tree {
  return [[ME, ZSH, FIRST], [ZSH, HOLDER, FIRST], [HOLDER, panePid, PANE_TTY], [Number(panePid), 1, PANE_TTY]];
}
const agyTable: Table = [[HOLDER, "agy", "agy --dangerously-skip-permissions --model gemini"]];

beforeAll(() => {
  live = T("new-session", "-d", "-s", "fixture/writer", "-P", "-F", "#{pane_id}", "sleep 120");
  panePid = T("display-message", "-p", "-t", live, "#{pane_pid}");
  expect(panePid).toMatch(/^[0-9]+$/);

  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/bash
# Scripted process rows. The -Ao table is FAKE_PS_TABLE verbatim; a targeted
# row comes from FAKE_PS_TREE (pid ppid tty), empty with exit 1 for a pid it
# does not list, as ps itself answers for a pid that is gone.
if [ "$1" = "-Ao" ]; then printf '%s\\n' "$FAKE_PS_TABLE"; exit 0; fi
pid=""
while [ $# -gt 0 ]; do case "$1" in -p) pid="$2"; shift ;; esac; shift; done
printf '%s\\n' "$FAKE_PS_TREE" | awk -v pid="$pid" '$1 == pid { print $2, $3; found = 1; exit } END { exit found ? 0 : 1 }'
`, { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
args=()
for arg in "$@"; do args+=( "\${arg//'#{pane_tty}'//dev/${PANE_TTY}}" ); done
exec "$HELD_PTY_TMUX" -L "$HELD_PTY_SOCKET" "\${args[@]}"
`, { mode: 0o755 });
  baseEnv = { ...tmuxEnv, PATH: `${bin}:${process.env.PATH}`, HELD_PTY_TMUX: realTmux, HELD_PTY_SOCKET: socket,
    TAP_INDEX_HOME: join(scratch, "index") };
  delete baseEnv.TAP_TMUX_SOCKET;
  delete baseEnv.TAP_TMUX_SOCKET_PATH;
  delete baseEnv.TAP_CALLING_PANE_SOCKET;
});

afterAll(() => {
  T("kill-server");
  removeScratchTree(scratch);
});

describe("the shared process-row oracle", () => {
  test("reads the scripted row and refuses an unlisted pid", () => {
    const env = envFor([[ME, ZSH, FIRST]], []);
    expect(processRow(ME, env)).toEqual({ ppid: String(ZSH), tty: FIRST });
    expect(processRow(ZSH, env)).toBeNull();
  });

  test("the ancestry walk keeps its own ps spelling, distinct from the tty-aware row", () => {
    // The re-registration smoke's ps stub delegates exactly `-o ppid= -p` to
    // the real ps and answers `-o ppid= -o tty= -p` with a canned outside row;
    // a self-attested rebind must still prove ancestry under that stub (full
    // gate on c40af9e16).
    const bin = join(scratch, "bin-ancestry-only");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ps"), `#!/bin/bash
if [ "$#" = 4 ] && [ "$1" = "-o" ] && [ "$2" = "ppid=" ] && [ "$3" = "-p" ]; then
  case "$4" in ${ME}) printf '%s\\n' "${ZSH}" ;; ${ZSH}) printf '%s\\n' "${HOLDER}" ;; ${HOLDER}) printf '1\\n' ;; *) exit 1 ;; esac
  exit 0
fi
printf '1 ??\\n'
`, { mode: 0o755 });
    const env = { ...tmuxEnv, PATH: `${bin}:${process.env.PATH}` };
    expect(parentPid(ME, env)).toBe(String(ZSH));
    expect(pidHasAncestor(ME, String(HOLDER), env)).toBe(true);
    expect(pidHasAncestor(ME, String(OTHER), env)).toBe(false);
    expect(processRow(ME, env)).toEqual({ ppid: "1", tty: "??" });
  });

  test("ancestry is fail-closed: a listed chain proves, a gap or init refuses", () => {
    const env = envFor([[ME, ZSH, FIRST], [ZSH, HOLDER, FIRST], [HOLDER, 1, PANE_TTY]], []);
    expect(pidHasAncestor(ME, String(HOLDER), env)).toBe(true);
    expect(pidHasAncestor(ME, String(ME), env)).toBe(true);
    expect(pidHasAncestor(ME, String(OTHER), env)).toBe(false);
    expect(pidHasAncestor(ME, "not-a-pid", env)).toBe(false);
    expect(pidHasAncestor(OTHER, String(HOLDER), env)).toBe(false);
  });
});

describe("a terminal held by the pane's harness resolves to that pane", () => {
  test("the agy shape is inside, with the server's own pane record", () => {
    expect(observeCallingPane(envFor(agyTree(), agyTable))).toMatchObject({
      state: "inside", paneId: live, session: "fixture/writer",
    });
  });

  test("a deeper run on the tool terminal still reaches the holder", () => {
    const tree: Tree = [[ME, INNER, FIRST], [INNER, ZSH, FIRST], [ZSH, HOLDER, FIRST],
      [HOLDER, panePid, PANE_TTY], [Number(panePid), 1, PANE_TTY]];
    expect(observeCallingPane(envFor(tree, agyTable))).toMatchObject({ state: "inside", paneId: live });
  });

  test("a holder that descends from pane_pid, not pane_pid itself, qualifies", () => {
    const tree: Tree = [[ME, ZSH, FIRST], [ZSH, HOLDER, FIRST], [HOLDER, INNER, PANE_TTY],
      [INNER, panePid, PANE_TTY], [Number(panePid), 1, PANE_TTY]];
    expect(observeCallingPane(envFor(tree, agyTable))).toMatchObject({ state: "inside", paneId: live });
  });

  test("read-only and extended modes return the same verdict and the extended record", () => {
    expect(observeCallingPane(envFor(agyTree(), agyTable), true)).toMatchObject({ state: "inside", paneId: live });
    const extended = observeCallingPane(envFor(agyTree(), agyTable), false, true);
    expect(extended).toMatchObject({ state: "inside", paneId: live, panePid, currentCommand: "sleep" });
  });

  test("argv[0] names the family when comm is a runtime, and a runtime's script entrypoint does too", () => {
    for (const table of [
      [[HOLDER, "node", "/opt/agy/bin/agy --model gemini"]],
      [[HOLDER, "node", "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"]],
      [[HOLDER, "python3", "python3 /opt/hermes/hermes-agent.py --serve"]],
      // Trailing arguments after the entrypoint stay fine.
      [[HOLDER, "node", "node /opt/x/claude-code/cli.js --resume"]],
    ] as Table[]) {
      expect(observeCallingPane(envFor(agyTree(), table))).toMatchObject({ state: "inside", paneId: live });
    }
  });
});

describe("every other terminal boundary keeps the positive outside verdict", () => {
  const OUTSIDE = "observed caller terminal is not owned by a pane on this tmux server";
  const expectOutside = (env: NodeJS.ProcessEnv, climb: string) => {
    const seen = observeCallingPane(env);
    expect(seen).toMatchObject({ state: "outside", detail: OUTSIDE });
    expect(seen.state === "outside" ? seen.climb ?? "" : "").toContain(climb);
  };

  test("a holder with no controlling terminal (an emulator launched from a tool child)", () => {
    const tree: Tree = [[ME, ZSH, FIRST], [ZSH, OTHER, "??"], [OTHER, HOLDER, PANE_TTY], [HOLDER, panePid, PANE_TTY]];
    expectOutside(envFor(tree, [...agyTable, [OTHER, "xterm", "xterm -e zsh"]]), "no controlling terminal");
  });

  test("a second foreign terminal between the caller and the pane", () => {
    const tree: Tree = [[ME, ZSH, FIRST], [ZSH, OTHER, FIRST], [OTHER, HOLDER, "ttys088"], [HOLDER, panePid, PANE_TTY]];
    expectOutside(envFor(tree, agyTable), "no pane on this server owns either");
  });

  test("a holder on the pane tty that is not under the pane's pane_pid", () => {
    const tree: Tree = [[ME, ZSH, FIRST], [ZSH, HOLDER, FIRST], [HOLDER, 1, PANE_TTY]];
    expectOutside(envFor(tree, agyTable), "not under pane");
  });

  test("a holder that is not a harness process (an emulator launched from the pane shell)", () => {
    expectOutside(envFor(agyTree(), [[HOLDER, "xterm", "xterm -e zsh"]]), "not a harness process");
  });

  test("a harness name later in the holder's argv does not make it a harness", () => {
    // Only the executable (or a runtime's entrypoint) may name the family.
    for (const table of [
      [[HOLDER, "script", "script -q /dev/null claude"]],
      [[HOLDER, "xterm", "xterm -e codex exec"]],
      [[HOLDER, "bash", "bash -c claude"]],
      [[HOLDER, "node", "node /opt/tools/relay.js --spawn claude"]],
      // An option-led runtime command line: the preload value is not an entrypoint.
      [[HOLDER, "node", "node --require /tmp/claude.js /tmp/relay.js"]],
      [[HOLDER, "node", "node -r /tmp/claude.js /tmp/relay.js"]],
      [[HOLDER, "bun", "bun --preload /tmp/claude.ts /tmp/relay.ts"]],
      // Refuses even though the entrypoint itself would match: no option may precede it.
      [[HOLDER, "python3", "python3 -W ignore /opt/hermes/hermes-agent.py"]],
    ] as Table[]) {
      expectOutside(envFor(agyTree(), table), "not a harness process");
    }
  });

  test("a rate-limited pane_pid probe is unverifiable with the live pane id, never outside", () => {
    // One token: the inventory read spends it, so the climb's targeted
    // pane_pid probe meets an exhausted bucket (the same sidecar unit3-tmux
    // seeds). The `at` in the future stops any refill.
    // Its own index home: the exhausted bucket must not outlive this case.
    const env = { ...envFor(agyTree(), agyTable), TAP_INDEX_HOME: join(scratch, "index-rate") };
    const cache = join(env.TAP_INDEX_HOME, "runtime-cache");
    const key = createHash("sha256").update(physicalSocketPath(env)).digest("hex");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, `tmux-rate-${key}.json`), JSON.stringify({ tokens: 1, at: Date.now() + 10_000 }));
    const seen = observeCallingPane(env);
    expect(seen).toMatchObject({ state: "unobservable", unverifiable: true, paneId: live });
    expect(seen.state === "unobservable" ? seen.refusal : "").toContain("rate limiting");
    writeFileSync(join(cache, `tmux-rate-${key}.json`), JSON.stringify({ tokens: 1, at: Date.now() + 10_000 }));
    expect(callingPane(env)).toEqual({ status: "unverifiable", paneId: live });
  });

  test("an ambient family override does not admit a non-harness holder", () => {
    // TAP_OBS_HARNESS_FAMILIES is caller-controlled; the climb classifies
    // against the fixed canonical set only.
    const env = { ...envFor(agyTree(), [[HOLDER, "xterm", "xterm -e zsh"]]), TAP_OBS_HARNESS_FAMILIES: "xterm" };
    expectOutside(env, "not a harness process");
  });

  test("a holder missing from the process table", () => {
    expectOutside(envFor(agyTree(), []), "process table has no row");
  });

  test("ancestry that ends on the tool terminal", () => {
    expectOutside(envFor([[ME, ZSH, FIRST], [ZSH, 1, FIRST]], agyTable), "ended on terminal");
  });

  test("a holder terminal that two live panes report", () => {
    const second = T("new-session", "-d", "-s", "fixture/second", "-P", "-F", "#{pane_id}", "sleep 120");
    try {
      expectOutside(envFor(agyTree(), agyTable), "maps to multiple panes");
    } finally {
      T("kill-pane", "-t", second);
    }
  });

  test("the default-mode record shape is untouched for a caller directly on the pane tty", () => {
    expect(observeCallingPane(envFor([[ME, ZSH, PANE_TTY], [ZSH, 1, PANE_TTY]], []))).toEqual({
      state: "inside", paneId: live, session: "fixture/writer",
      serverEpoch: expect.stringMatching(/^srv:[0-9]+:[0-9]+$/),
    });
  });
});

describe("the holder classifier keys on the executable", () => {
  const F = DEFAULT_AGENT_FAMILIES;
  test("executables and runtime entrypoints name a family", () => {
    expect(classifyHolderCommand("agy", "agy --model gemini", F)).toBe("agy");
    expect(classifyHolderCommand("claude", "/opt/homebrew/bin/claude --resume", F)).toBe("claude");
    expect(classifyHolderCommand("cursor-agent", "cursor-agent", F)).toBe("cursor");
    expect(classifyHolderCommand("node", "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", F)).toBe("claude");
    expect(classifyHolderCommand("node", "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", F)).toBe("codex");
    expect(classifyHolderCommand("bun", "bun /srv/opencode-tui.ts", F)).toBe("opencode");
    expect(classifyHolderCommand("python3.14", "python3.14 /opt/hermes/hermes-agent.py", F)).toBe("hermes");
  });
  test("later argv words, shells and relays never do", () => {
    expect(classifyHolderCommand("script", "script -q /dev/null claude", F)).toBe("");
    expect(classifyHolderCommand("xterm", "xterm -e codex exec", F)).toBe("");
    expect(classifyHolderCommand("bash", "bash -c claude", F)).toBe("");
    expect(classifyHolderCommand("node", "node /opt/tools/relay.js --spawn claude", F)).toBe("");
    expect(classifyHolderCommand("tmux", "tmux -L inner new-session claude", F)).toBe("");
    // A runtime subcommand is not an entrypoint; the rule stays narrow by design.
    expect(classifyHolderCommand("bun", "bun run /srv/opencode-tui.ts", F)).toBe("");
    // Only argv[1] can be the entrypoint: an option may take a separate value,
    // and the parse never guesses which do, so an option-led line admits nothing.
    expect(classifyHolderCommand("node", "node --require /tmp/claude.js /tmp/relay.js", F)).toBe("");
    expect(classifyHolderCommand("node", "node -r /tmp/claude.js /tmp/relay.js", F)).toBe("");
    expect(classifyHolderCommand("node", "node --max-old-space-size=4096 /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", F)).toBe("");
    expect(classifyHolderCommand("python3", "python3 -m hermes", F)).toBe("");
    expect(classifyHolderCommand("bun", "bun --preload /tmp/claude.ts /tmp/relay.ts", F)).toBe("");
    expect(classifyHolderCommand("python3", "python3 -W ignore /opt/hermes/hermes-agent.py", F)).toBe("");
    expect(classifyHolderCommand("node", "node /opt/x/claude-code/cli.js --resume", F)).toBe("claude");
    expect(classifyHolderCommand("", "", F)).toBe("");
  });
  test("a version-named executable is not admitted, whatever HOME holds", () => {
    // The only proof nativeClaudeCommand offers is a file under $HOME, which the
    // judged process controls; the holder classifier does not consult it.
    const home = join(scratch, "home-versions");
    const versions = join(home, ".local", "share", "claude", "versions");
    mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, "1.2.3"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(versions, "1.2.3"), 0o755);
    expect(classifyHolderCommand("1.2.3", `${versions}/1.2.3 --resume`, F)).toBe("");
    const table: Table = [[HOLDER, "1.2.3", `${versions}/1.2.3 --resume`]];
    const seen = observeCallingPane({ ...envFor(agyTree(), table), HOME: home });
    expect(seen).toMatchObject({ state: "outside" });
    expect(seen.state === "outside" ? seen.climb ?? "" : "").toContain("not a harness process");
  });
});

describe("no terminal at all stays unobservable", () => {
  test("ancestry that ends without a controlling terminal", () => {
    const seen = observeCallingPane(envFor([[ME, 1, "??"]], []));
    expect(seen.state).toBe("unobservable");
    expect(seen.state === "unobservable" ? seen.refusal : "").toContain("process ancestry ended");
  });
});
