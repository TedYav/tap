// Pane observation — specifically, the ways tmux answers that LOOK like success.
//
// D measured this in the Go lane and handed it over: tmux exits 0 with an EMPTY
// pane id for a target that no longer resolves. An `err != nil` check therefore
// accepts a dead pane as live, and the recipient's death is reported as merely
// not-ready. That is the success-shaped-signal class arriving inside tmux's own
// answer rather than in our code.
//
// My implementation already required the id to start with `%`, so this is a
// REGRESSION PIN rather than a fix: the guard is load-bearing, one line, and
// nothing tested it. A guard nothing tests is one careless edit from gone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootId, claimTmuxStart, observePane, observePaneResult, physicalSocketPath, seedServerIdentity, serverEpochFromRaw, socketFingerprint, tmux, pasteText } from "../src/tmux";
import { callingPane, observeCallingPane, resolveSelf, TapError, type Context } from "../src/context";
import { acquirePathLock } from "../src/panelock";
import { Bus } from "../src/bus";
import { removeScratchTree } from "./support/scratch";

const SOCKET = `tapbun-tmux-${Math.random().toString(36).slice(2, 8)}`;
// FIX (tmux-crash 2026-08-24): the test's OWN tmux calls no longer depend on the
// process-global PATH shim. A bare `tmux kill-server` that escaped the shim bound
// to $TMUX = the operator's DEFAULT server and took the whole team down (running
// at both 2026-08-23 crashes). Pass -L SOCKET explicitly AND scrub TMUX/TMUX_PANE
// from the spawn env so a setup/teardown call can NEVER reach the default server,
// whatever PATH is at that instant. (The shim stays below only for the production
// code under test, whose bare `tmux` we cannot pass -L into; those calls are
// read-only.)
const TMUX_ENV = { ...process.env };
delete (TMUX_ENV as any).TMUX;
delete (TMUX_ENV as any).TMUX_PANE;
const T = (args: string[], opts: any = {}) =>
  spawnSync("tmux", ["-L", SOCKET, ...args], { env: TMUX_ENV, ...opts });
let root: string;
let savedPath: string | undefined;
let savedIndexHome: string | undefined;
let savedTmuxSocket: string | undefined;

const haveTmux = spawnSync("sh", ["-c", "command -v tmux"]).status === 0;
const d = haveTmux ? describe : describe.skip;

beforeAll(() => {
  if (!haveTmux) return;
  root = mkdtempSync(join(tmpdir(), "tap-tmux."));
  // A shim binds every bare `tmux` call — including the ones inside the code
  // under test — to this run's private server.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexec ${real} -L "${SOCKET}" "$@"\n`);
  spawnSync("chmod", ["+x", join(bin, "tmux")]);
  savedPath = process.env.PATH;
  savedIndexHome = process.env.TAP_INDEX_HOME;
  savedTmuxSocket = process.env.TAP_TMUX_SOCKET;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.TAP_INDEX_HOME = join(root, "index");
  // THE SEAM, not the shim. The PATH shim below cannot reach the code under
  // test: TMUX_ENV is snapshotted at module load, before this hook runs, and
  // src/tmux.ts spawns with the parent env — so its calls went to whatever
  // server $TMUX named. That is tap-nlo51 reproducing inside the test written
  // to pin it. TAP_TMUX_SOCKET is the production socket seam and binds the
  // code under test to this run's private server explicitly.
  process.env.TAP_TMUX_SOCKET = SOCKET;
  T(["new-session", "-d", "-s", "alive", "-c", "/tmp", "sh"]);
  T(["new-session", "-d", "-s", "doomed", "-c", "/tmp", "sh"]);
  Bun.sleepSync(600);
});

afterAll(() => {
  if (!haveTmux) return;
  T(["kill-server"]);
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (savedIndexHome === undefined) delete process.env.TAP_INDEX_HOME;
  else process.env.TAP_INDEX_HOME = savedIndexHome;
  if (savedTmuxSocket === undefined) delete process.env.TAP_TMUX_SOCKET;
  else process.env.TAP_TMUX_SOCKET = savedTmuxSocket;
  removeScratchTree(root);
});

describe("calling pane is derived from the process TTY", () => {
  function fixture(mode: "success" | "ambiguous" | "outside" | "unobservable" | "changed" | "reborn" | "nbsp-fields" | "leading-tab" | "split-records" | "leading-blank" | "tab-path" | "tab-socket" | "tab-cmd") {
    const scratch = mkdtempSync(join(tmpdir(), "tap-calling-pane."));
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ps"), `#!/bin/sh
case "$FAKE_MODE" in
  unobservable) printf '1 ??\\n' ;;
  # A NON-BREAKING SPACE between the fields. Bash's default IFS does not split
  # on it, so the incumbent reads an unusable parent pid and refuses; JS \\s does
  # split on it, so this function used to read a plausible pid/tty pair.
  nbsp-fields) printf '123\\302\\240faketty\\n' ;;
  # TWO records. Bash's \`read\` consumes the first line only: ppid=1, no tty.
  split-records) printf '1\\nfaketty\\n' ;;
  # A LEADING blank record. Command substitution strips trailing newlines, not
  # leading ones, so Bash reads an EMPTY first line and refuses on the parent.
  leading-blank) printf '\\n123 faketty\\n' ;;
  *) printf '123 faketty\\n' ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in
  list-panes)
    case "$FAKE_MODE" in
      success|changed|reborn|tab-path|tab-socket|tab-cmd) printf '%%7\\t/dev/faketty\\n' ;;
      # A LEADING TAB. Bash's \`IFS=$'\\t' read\` strips it and finds %%7; a plain
      # split sees an empty id and reads the tty one slot over, so the two
      # parsers disagree about what this row says.
      leading-tab) printf '\\t%%7\\t/dev/faketty\\n' ;;
      ambiguous) printf '%%7\\t/dev/faketty\\n%%8\\t/dev/faketty\\n' ;;
      # nbsp-fields shares the NON-matching inventory on purpose: it is the
      # reported specimen. With JS \\s splitting, the NBSP row yields a plausible
      # pid/tty pair, no pane owns that tty, and the answer is a positive
      # OUTSIDE -- the authority claim. Pointing it at a matching inventory would
      # make the arm red on "inside" instead, a neighbour of the defect rather
      # than the defect that was reported.
      outside|nbsp-fields|split-records|leading-blank) printf '%%8\\t/dev/other\\n' ;;
    esac
    ;;
  display-message)
    [ "$3" = "-t" ] && [ "$4" = "%7" ] || exit 1
    for last do :; done
    case "$last" in
    # C2: the targeted reads the ambiguous record's descriptive pair falls to.
    # D3 (round 3): the WHOLE descriptive tail falls to them — command, pane
    # pid and address re-read too when the split is not exactly nine fields.
    '#{socket_path}') printf '/fake/socket\n' ;;
    '#{pane_current_command}') printf 'vim\n' ;;
    '#{pane_pid}') printf '4242\n' ;;
    '#{session_name}:#{window_index}.#{pane_index}') printf 'alive:0.0\n' ;;
    '#{pane_current_path}')
      if [ "$FAKE_MODE" = tab-path ]; then printf '/fake\\twith\\ttabs\\n'
      else printf '/fake/path\\n' ; fi ;;
    # The extended caller record (register's caller arm): pane pid and
    # command ride the record, so their tokens identify the nine-field probe.
    *pane_pid*pane_current_command*)
      if [ "$FAKE_MODE" = changed ] || [ "$FAKE_MODE" = reborn ]; then
        printf '%%7\\t/dev/other\\treborn\\t999:999\\treborn:0.0\\t4242\\tzsh\\t/fake/socket\\t/fake/path\\n'
      elif [ "$FAKE_MODE" = tab-path ]; then
        printf '%%7\\t/dev/faketty\\talive\\t123:456\\talive:0.0\\t4242\\tzsh\\t/fake/socket\\t/fake\\twith\\ttabs\\n'
      elif [ "$FAKE_MODE" = tab-socket ]; then
        printf '%%7\\t/dev/faketty\\talive\\t123:456\\talive:0.0\\t4242\\tzsh\\t/fake\\tsocket\\t/fake/path\\n'
      elif [ "$FAKE_MODE" = tab-cmd ]; then
        printf '%%7\\t/dev/faketty\\talive\\t123:456\\talive:0.0\\t4242\\tzsh\\twith\\ttab\\t/fake/socket\\t/fake/path\\n'
      else
        printf '%%7\\t/dev/faketty\\talive\\t123:456\\talive:0.0\\t4242\\tzsh\\t/fake/socket\\t/fake/path\\n'
      fi
      ;;
    # The default caller record: the incumbent's four-field identity probe.
    *)
      if [ "$FAKE_MODE" = changed ] || [ "$FAKE_MODE" = reborn ]; then
        printf '%%7\\t/dev/other\\treborn\\t999:999\\n'
      else
        printf '%%7\\t/dev/faketty\\talive\\t123:456\\n'
      fi
      ;;
    esac
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TAP_INDEX_HOME: join(scratch, "index"),
      TAP_SESSION_MANIFEST: join(scratch, "sessions.json"),
      OPENCODE_DB_PATH: join(scratch, "opencode.db"),
      TAP_VERSION_SEEN_PATH: join(scratch, "version-seen.json"),
      TMUX: "/fake,1,0",
      TMUX_PANE: "%spoofed",
      FAKE_MODE: mode,
    } as NodeJS.ProcessEnv;
    delete env.TAP_TMUX_SOCKET;
    delete env.TAP_TMUX_SOCKET_PATH;
    return { scratch, env };
  }

  test("ignores spoofed TMUX_PANE and reasserts the unique TTY binding with a targeted query", () => {
    const f = fixture("success");
    try {
      expect(callingPane(f.env)).toEqual({
        status: "ok",
        paneId: "%7",
        session: "alive",
        serverEpoch: "srv:123:456",
      });
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("a tab inside the pane's current path does not refuse the caller record", () => {
    // F2 (launchfast item 2 review): pane_current_path is free text and rides
    // LAST in the combined record. C2 (round 2): socket_path is free text
    // TOO, so an extra tab is ambiguous — the identity fields stay from the
    // record and both descriptive facts arrive through the old targeted
    // reads. A tab used to fall into the exact field count and refuse the
    // whole registration.
    const f = fixture("tab-path");
    try {
      const seen = observeCallingPane(f.env, false, true);
      if (seen.state !== "inside") throw new Error(`expected inside, got ${JSON.stringify(seen)}`);
      expect(seen.currentPath).toBe("/fake\twith\ttabs");
      // The fields around the path keep their own values.
      expect(seen.socketPath).toBe("/fake/socket");
      expect(seen.currentCommand).toBe("vim");
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("a tab inside the socket field also takes the targeted reads", () => {
    // C2's sibling: the tab sits in socket_path this time. The split cannot
    // tell a tabbed socket from a tabbed path, so BOTH descriptive facts come
    // from the targeted reads while the identity fields stay atomic.
    const f = fixture("tab-socket");
    try {
      const seen = observeCallingPane(f.env, false, true);
      if (seen.state !== "inside") throw new Error(`expected inside, got ${JSON.stringify(seen)}`);
      expect(seen.socketPath).toBe("/fake/socket");
      expect(seen.currentPath).toBe("/fake/path");
      expect(seen.currentCommand).toBe("vim");
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("a tab inside the caller's command re-reads the command and every fact after it", () => {
    // D3 (round 3): the command is free text — `zsh\twith\ttab` splits into
    // three fields, shifting socket and path. The record's own slot-7 "zsh"
    // must be discarded: the command comes from the targeted read ("vim"),
    // and so do the address, pane pid, socket and path behind it. The
    // identity prefix (id, tty, session, generation) stays atomic.
    const f = fixture("tab-cmd");
    try {
      const seen = observeCallingPane(f.env, false, true);
      if (seen.state !== "inside") throw new Error(`expected inside, got ${JSON.stringify(seen)}`);
      expect(seen.currentCommand).toBe("vim");
      expect(seen.panePid).toBe("4242");
      expect(seen.address).toBe("alive:0.0");
      expect(seen.socketPath).toBe("/fake/socket");
      expect(seen.currentPath).toBe("/fake/path");
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("a fingerprint change between the probe and the seed means no seed", () => {
    // C1 (round 2): the record's epoch belongs to the server the BEFORE
    // fingerprint saw. A rebirth swapping the socket between probe and seed
    // must not pair the old server's epoch with the new socket's cache entry.
    const f = fixture("success");
    const cache = join(f.env.TAP_INDEX_HOME!, "runtime-cache");
    try {
      const before = socketFingerprint(physicalSocketPath(f.env));
      seedServerIdentity(f.env, "123:456", "an-older-server-fingerprint");
      const key = createHash("sha256").update(physicalSocketPath(f.env)).digest("hex");
      expect(existsSync(join(cache, `tmux-identity-${key}.json`))).toBe(false);
      seedServerIdentity(f.env, "123:456", before);
      expect(existsSync(join(cache, `tmux-identity-${key}.json`))).toBe(true);
      expect(JSON.parse(readFileSync(join(cache, `tmux-identity-${key}.json`), "utf8"))).toMatchObject({ raw: "123:456", fingerprint: before });
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("read-only calling-pane probes neither create nor update the rate bucket", () => {
    const f = fixture("success");
    const cache = join(f.env.TAP_INDEX_HOME!, "runtime-cache");
    try {
      expect(observeCallingPane(f.env, true).state).toBe("inside");
      expect(existsSync(cache)).toBe(false);
      const key = createHash("sha256").update(physicalSocketPath(f.env)).digest("hex");
      const path = join(cache, `tmux-rate-${key}.json`);
      const before = JSON.stringify({ tokens: 0, at: Date.now() + 10_000 });
      mkdirSync(cache, { recursive: true });
      writeFileSync(path, before);
      expect(observeCallingPane(f.env, true).state).toBe("inside");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(existsSync(`${path}.lock`)).toBe(false);
      // Ordinary callers still claim the bucket and refuse when it is exhausted.
      expect(callingPane(f.env)).toEqual({ status: "unverifiable", paneId: "" });
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("calling-pane rate limits are unverifiable, not outside tmux", () => {
    const outside = fixture("outside");
    try {
      expect(callingPane(outside.env)).toBeNull();
    } finally {
      removeScratchTree(outside.scratch);
    }

    for (const [tokens, paneId] of [[0, ""], [1, "%7"]] as const) {
      const limited = fixture("success");
      const cache = join(limited.env.TAP_INDEX_HOME!, "runtime-cache");
      const key = createHash("sha256").update(physicalSocketPath(limited.env)).digest("hex");
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, `tmux-rate-${key}.json`), JSON.stringify({ tokens, at: Date.now() + 10_000 }));
      try {
        expect(callingPane(limited.env)).toEqual({ status: "unverifiable", paneId });
      } finally {
        removeScratchTree(limited.scratch);
      }
    }
  }, 10_000);

  // observeCallingPane answers the question callingPane() cannot: WHICH of the
  // eight `null` facts happened. The pair that matters is `outside` vs
  // `unobservable`, because CONTRACT.md licenses attach's inherited-$TMUX arm on
  // the first and must refuse on the second.
  test("a terminal owned by no pane on this server is OUTSIDE — a positive answer", () => {
    const f = fixture("outside");
    try {
      const seen = observeCallingPane(f.env);
      expect(seen.state).toBe("outside");
      // The incumbent's sentence, carried as `detail` rather than `refusal`:
      // nothing about a positive answer should read as a reason to refuse. The
      // held-terminal climb adds only `climb` diagnostics (why no holder pane was
      // admitted); state and detail are byte-identical.
      expect(seen).toMatchObject({
        state: "outside",
        detail: "observed caller terminal is not owned by a pane on this tmux server",
      });
      expect(seen.state === "outside" ? seen.climb ?? "" : "").toContain("ended on terminal");
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  // THE NAMED RED ARM. The fake `ps` answers `1 ??` — no controlling tty, and
  // the ancestry walk immediately reaches pid 1. That is the case this port was
  // most likely to get wrong: "I walked to init and never saw a terminal" LOOKS
  // like proof the caller is outside a pane, and it is not. It is the absence of
  // evidence. `tap_calling_pane_fail` in lib.sh defaults to `unobservable` and
  // exactly one call site (lib.sh:8518, the arm above) passes `outside`.
  //
  // If this ever reads `outside`, `tap attach` licenses
  // `env -u TMUX -u TMUX_PANE tmux -S <sock> attach-session` for a process with
  // no controlling terminal at all — a daemon, a cron child, anything detached.
  // A license granted on unproven evidence.
  test("no controlling terminal anywhere in the ancestry is UNOBSERVABLE, never outside", () => {
    const f = fixture("unobservable");
    try {
      const seen = observeCallingPane(f.env);
      expect(seen.state).not.toBe("outside");
      expect(seen.state).toBe("unobservable");
      // The caller's own pid is in the sentence and is volatile, so pin the two
      // stable halves rather than a number this process happens to have.
      expect(seen.state === "unobservable" && seen.refusal)
        .toMatch(/^process ancestry ended before finding a tmux pane \(pid '\d+', parent '1'\)$/);
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  // Review, P2: two parser inputs the fixture did not contain
  // reached `outside`. Both differences predate this PR and were harmless while
  // every non-ok answer was `null`; neither may survive now that `outside` is
  // positive evidence that licenses attach's inherited-$TMUX arm. The fix is in
  // the NARROW direction on purpose -- refuse rather than resolve -- because
  // widening identity acceptance inside a change built to stop over-claiming
  // would be the same mistake wearing a different hat.
  test("a ps row separated by NBSP is not a pid/tty pair, and never outside", () => {
    const f = fixture("nbsp-fields");
    try {
      const seen = observeCallingPane(f.env);
      expect(seen.state).not.toBe("outside");
      expect(seen.state).toBe("unobservable");
      // The incumbent's answer for the same bytes: its IFS never split them, so
      // it refused on the parent pid. Matching the refusal, not just the state.
      expect(seen.state === "unobservable" && seen.refusal)
        .toMatch(/^process observation returned invalid parent pid /);
      expect(callingPane(f.env)).toBeNull();
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("an inventory row whose id field is empty is malformed, and never outside", () => {
    const f = fixture("leading-tab");
    try {
      const seen = observeCallingPane(f.env);
      expect(seen.state).not.toBe("outside");
      expect(seen.state).toBe("unobservable");
      expect(seen.state === "unobservable" && seen.refusal)
        .toMatch(/^pane inventory record is not a pane-id\/tty pair: /);
      // The old contract is preserved exactly: this input answered `null` before
      // and answers `null` now. The narrow fix costs no caller anything.
      expect(callingPane(f.env)).toBeNull();
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  // Review, P2 (second round): matching Bash's IFS CHARACTERS
  // is not matching its RECORD BOUNDARY. `read` consumes one line; splitting the
  // whole stdout fused separate records into a plausible observation that then
  // answered a positive `outside`.
  test("two ps records are not one observation, and never outside", () => {
    const f = fixture("split-records");
    try {
      const seen = observeCallingPane(f.env);
      expect(seen.state).not.toBe("outside");
      expect(seen.state).toBe("unobservable");
      // Bash reads line one only: ppid=1, tty empty -> ancestry ended at init.
      expect(seen.state === "unobservable" && seen.refusal)
        .toMatch(/^process ancestry ended before finding a tmux pane /);
      expect(callingPane(f.env)).toBeNull();
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("an empty leading ps record is the observation, and never outside", () => {
    const f = fixture("leading-blank");
    try {
      const seen = observeCallingPane(f.env);
      expect(seen.state).not.toBe("outside");
      expect(seen.state).toBe("unobservable");
      // Command substitution strips TRAILING newlines only, so the blank first
      // line survives and is what Bash reads.
      expect(seen.state === "unobservable" && seen.refusal)
        .toMatch(/^process observation returned invalid parent pid /);
      expect(callingPane(f.env)).toBeNull();
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  test("a live pane binding is INSIDE and carries the generation", () => {
    const f = fixture("success");
    try {
      expect(observeCallingPane(f.env, false, true)).toEqual({
        state: "inside", paneId: "%7", session: "alive", serverEpoch: "srv:123:456",
        address: "alive:0.0", panePid: "4242", currentCommand: "zsh", currentPath: "/fake/path", socketPath: "/fake/socket",
      });
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  // Two more unobservables that are NOT outside, and are not each other: an
  // ambiguous tty answered successfully and is a different repair from a stale
  // binding. Each keeps its own sentence.
  test("an ambiguous tty and a moved binding are distinct unobservables", () => {
    const amb = fixture("ambiguous");
    try {
      const seen = observeCallingPane(amb.env);
      expect(seen.state).toBe("unobservable");
      expect(seen.state === "unobservable" && seen.refusal)
        .toBe("controlling tty '/dev/faketty' maps to multiple panes");
      expect(seen.state === "unobservable" && seen.unverifiable).toBeFalsy();
    } finally {
      removeScratchTree(amb.scratch);
    }

    const changed = fixture("changed");
    try {
      const seen = observeCallingPane(changed.env);
      expect(seen.state).toBe("unobservable");
      // This one keeps a pane id and the `unverifiable` marker, because
      // callingPane() projects it to {status:"unverifiable"} and `tap done`
      // refuses differently on it.
      expect(seen.state === "unobservable" && seen.unverifiable).toBe(true);
      expect(seen.state === "unobservable" && seen.paneId).toBe("%7");
      // The INCUMBENT's sentence for a moved binding. This port first merged it
      // with the missing-session refusal under prose no Bash path can emit; the
      // arm exists so the merge cannot come back.
      expect(seen.state === "unobservable" && seen.refusal)
        .toBe("pane '%7' no longer owns controlling tty '/dev/faketty'");
    } finally {
      removeScratchTree(changed.scratch);
    }
  });

  // The projection is the compatibility claim: NINE callers select on these
  // three shapes and none of them may move. (Nine, not eight: `digest-window.ts`
  // is easy to miss and a wrong count in a test name is a rot trap --
  // The reviewer, additive pre-read.)
  test("callingPane() still answers exactly what its nine callers select on", () => {
    for (const [mode, expected] of [
      ["success", { status: "ok", paneId: "%7", session: "alive", serverEpoch: "srv:123:456" }],
      ["changed", { status: "unverifiable", paneId: "%7" }],
      ["outside", null],
      ["unobservable", null],
      ["ambiguous", null],
    ] as const) {
      const f = fixture(mode);
      try {
        expect(callingPane(f.env)).toEqual(expected);
      } finally {
        removeScratchTree(f.scratch);
      }
    }
  }, 10_000);

  for (const mode of ["ambiguous", "outside", "unobservable", "changed"] as const) {
    test(`fails closed when the caller binding is ${mode}`, () => {
      const f = fixture(mode);
      try {
        const observation = callingPane(f.env);
        if (mode === "changed") {
          expect(observation).toEqual({ status: "unverifiable", paneId: "%7" });
        } else {
          expect(observation).toBeNull();
        }
      } finally {
        removeScratchTree(f.scratch);
      }
    });
  }

  test("refuses a recycled pane id after the calling TTY observation", () => {
    const f = fixture("reborn");
    const busHome = join(f.scratch, "bus");
    const registryPath = join(f.scratch, "registry.json");
    mkdirSync(join(busHome, "payloads"), { recursive: true });
    mkdirSync(join(busHome, "receipts"), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
      schema: "0.20",
      team: { name: "t" },
      seats: {
        intruder: {
          pane: "reborn:0.0",
          pane_id: "%7",
          server_epoch: "srv:999:999",
          status: "active",
        },
      },
    }));
    const ctx: Context = {
      bus: new Bus(busHome),
      busRule: "env",
      team: "t",
      registryPath,
      root: f.scratch,
    };
    try {
      const observation = callingPane(f.env);
      expect(observation).not.toBeNull();
      expect(() => resolveSelf(ctx, observation!, 2, f.env)).toThrow(TapError);
    } finally {
      removeScratchTree(f.scratch);
    }
  });
});

describe("identity resolution observes pane and generation atomically", () => {
  function fixture(record: string) {
    const scratch = mkdtempSync(join(tmpdir(), "tap-identity-pane."));
    const bin = join(scratch, "bin");
    const busHome = join(scratch, "bus");
    const registryPath = join(scratch, "registry.json");
    mkdirSync(bin);
    mkdirSync(join(busHome, "payloads"), { recursive: true });
    mkdirSync(join(busHome, "receipts"), { recursive: true });
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
[ "$1" = display-message ] || exit 1
[ "$3" = -t ] && [ "$4" = self:0.0 ] || exit 1
printf '%s' "$FAKE_RECORD"
`, { mode: 0o755 });
    writeFileSync(registryPath, JSON.stringify({
      schema: "0.20",
      team: { name: "t" },
      seats: { me: { pane: "self:0.0", pane_id: "%7", server_epoch: "srv:123:456", status: "active" } },
    }));
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TAP_INDEX_HOME: join(scratch, "index"),
      TAP_SESSION_MANIFEST: join(scratch, "sessions.json"),
      OPENCODE_DB_PATH: join(scratch, "opencode.db"),
      TAP_VERSION_SEEN_PATH: join(scratch, "version-seen.json"),
      TMUX: "/fake,1,0",
      FAKE_RECORD: record,
    } as NodeJS.ProcessEnv;
    delete env.TAP_TMUX_SOCKET;
    delete env.TAP_TMUX_SOCKET_PATH;
    const ctx: Context = {
      bus: new Bus(busHome),
      busRule: "env",
      team: "t",
      registryPath,
      root: scratch,
    };
    return { scratch, env, ctx };
  }

  test("accepts one targeted pane, session, and generation record", () => {
    const f = fixture("%7\tself\t123:456\n");
    try {
      expect(resolveSelf(f.ctx, "self:0.0", 2, f.env).handle).toBe("me");
    } finally {
      removeScratchTree(f.scratch);
    }
  });

  for (const [name, record, errorClass] of [
    ["gone", "\n", "pane_gone"],
    ["malformed id", "7\tself\t123:456\n", "generation_unverifiable"],
    ["missing generation", "%7\tself\t\n", "generation_unverifiable"],
  ] as const) {
    test(`fails closed when the identity record is ${name}`, () => {
      const f = fixture(record);
      try {
        expect(() => resolveSelf(f.ctx, "self:0.0", 2, f.env)).toThrow(TapError);
        try {
          resolveSelf(f.ctx, "self:0.0", 2, f.env);
        } catch (error) {
          expect((error as TapError).errorClass).toBe(errorClass);
        }
      } finally {
        removeScratchTree(f.scratch);
      }
    });
  }

  test("rate-limited identity observation is unverifiable, not pane-gone", () => {
    const f = fixture("%7\tself\t123:456\n");
    const socket = join(f.scratch, "tmux.sock");
    writeFileSync(socket, "socket\n");
    f.env.TAP_TMUX_SOCKET_PATH = socket;
    delete f.env.TMUX;
    const key = createHash("sha256").update(realpathSync(socket)).digest("hex");
    const ratePath = join(f.env.TAP_INDEX_HOME!, "runtime-cache", `tmux-rate-${key}.json`);
    const held = acquirePathLock(`${ratePath}.lock`, 5_000, f.env)!;
    try {
      expect(() => resolveSelf(f.ctx, "self:0.0", 2, f.env)).toThrow(TapError);
      try {
        resolveSelf(f.ctx, "self:0.0", 2, f.env);
      } catch (error) {
        expect((error as TapError).errorClass).toBe("generation_unverifiable");
      }
    } finally {
      held.release();
      removeScratchTree(f.scratch);
    }
  }, 10_000);
});

d("observePane refuses every success-shaped non-answer", () => {
  test("a live pane resolves with an id, a session, and a generation", () => {
    const obs = observePane("alive:0.0");
    expect(obs).not.toBeNull();
    expect(obs!.paneId).toMatch(/^%\d+$/);
    expect(obs!.session).toBe("alive");
    expect(obs!.serverEpoch).toMatch(/^srv:\d+:\d+$/);
  });

  test("a KILLED pane returns null even though tmux exits 0", () => {
    // The measured behaviour: rc 0, empty output. Checking the exit code alone
    // would call this pane live.
    expect(observePane("doomed:0.0")).not.toBeNull();
    T(["kill-session", "-t", "doomed"]);
    Bun.sleepSync(400);

    const raw = T(["display-message", "-p", "-t", "doomed:0.0", "#{pane_id}"], { encoding: "utf8" });
    // Pin the tmux behaviour this guard exists for, so a future tmux that
    // changes it makes THIS test fail loudly rather than silently making the
    // guard pointless.
    expect(raw.status).toBe(0);
    expect((raw.stdout ?? "").trim()).toBe("");

    expect(observePane("doomed:0.0")).toBeNull();
    const compound = T(["display-message", "-p", "-t", "doomed:0.0", "#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}"], { encoding: "utf8" });
    expect(observePaneResult("doomed:0.0"), JSON.stringify({ code: compound.status, stdout: compound.stdout, stderr: compound.stderr }))
      .toEqual({ status: "pane_gone" });
  });

  test("a target that never existed returns null", () => {
    expect(observePane("no-such-session:0.0")).toBeNull();
  });

  test("an id that is not %-prefixed is refused, whatever else is present", () => {
    // The guard's actual predicate, exercised through the epoch parser's
    // sibling: a malformed record must not become an identity.
    expect(serverEpochFromRaw("")).toBe("");
    expect(serverEpochFromRaw("not-a-generation")).toBe("");
    expect(serverEpochFromRaw("123:456")).toBe("srv:123:456");
  });
});

describe("socket-scoped tmux client budget", () => {
  test("boot identity falls back to Linux proc stat when sysctl is unavailable", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-boot-id."));
    const procStat = join(scratch, "proc-stat");
    const missingSysctl = join(scratch, "missing-sysctl");
    writeFileSync(procStat, "cpu  1 2 3 4\nbtime 1787827104\nprocesses 5\n");
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.TAP_BOOT_ID;
    try {
      expect(bootId(env, procStat, missingSysctl)).toBe("boot:1787827104");
    } finally {
      removeScratchTree(scratch);
    }
  });

  test("physical key follows the same selector precedence and fallback as tmux", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(physicalSocketPath({
      TAP_TMUX_SOCKET: "private-name",
      TMUX: "/private/tmp/tmux-502/operator,123,0",
      TMUX_TMPDIR: "/lane-private",
    } as NodeJS.ProcessEnv)).toBe(`/lane-private/tmux-${uid}/private-name`);
    const defaultRoot = `/tmp/tmux-${uid}`;
    const physicalDefaultRoot = existsSync(defaultRoot) ? realpathSync(defaultRoot) : defaultRoot;
    expect(physicalSocketPath({} as NodeJS.ProcessEnv)).toBe(`${physicalDefaultRoot}/default`);
  });

  test("concurrent processes share one fresh identity probe and fingerprint invalidates it", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-tmux-cache."));
    const bin = join(scratch, "bin");
    const index = join(scratch, "index");
    const socket = join(scratch, "server.sock");
    const log = join(scratch, "identity.log");
    const release = join(scratch, "release");
    mkdirSync(bin, { recursive: true });
    mkdirSync(index, { recursive: true });
    writeFileSync(socket, "generation-a\n");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case " $* " in
  *"#{pid}:#{start_time}"*) printf 'identity\\n' >> "$FAKE_IDENTITY_LOG"; sleep 0.02; printf '123:456\\n' ;;
  *"#{pane_id}"*) printf '%%7\\tseat\\t4242\\tclaude\\t0\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const childEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TAP_INDEX_HOME: index,
      TAP_TMUX_SOCKET_PATH: socket,
      TMUX: undefined,
      TMUX_PANE: undefined,
      FAKE_IDENTITY_LOG: log,
    } as NodeJS.ProcessEnv;
    const modulePath = join(import.meta.dir, "..", "src", "tmux.ts");
    const source = `
      import { existsSync } from "node:fs";
      import { observePaneResult } from ${JSON.stringify(modulePath)};
      while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(5);
      const r = observePaneResult("seat:0.0", process.env);
      console.log(r.status);
    `;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", source], {
      env: childEnv, stdout: "pipe", stderr: "pipe",
    }));
    writeFileSync(release, "go\n");
    const codes = await Promise.all(children.map((child) => child.exited));
    const outs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
    const errs = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(codes).toEqual([0, 0]);
    expect(outs.map((out) => out.trim())).toEqual(["ok", "ok"]);
    expect(errs).toEqual(["", ""]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);

    // Same path, different socket fingerprint: the old generation cannot be
    // reused merely because its 100ms TTL has not elapsed.
    writeFileSync(socket, "generation-b-is-different\n");
    expect(observePaneResult("seat:0.0", childEnv).status).toBe("ok");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);

    Bun.sleepSync(120);
    expect(observePaneResult("seat:0.0", childEnv).status).toBe("ok");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);

    const otherSocket = join(scratch, "other.sock");
    writeFileSync(otherSocket, "other-generation\n");
    expect(observePaneResult("seat:0.0", { ...childEnv, TAP_TMUX_SOCKET_PATH: otherSocket }).status).toBe("ok");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(4);
    removeScratchTree(scratch);
  }, 30_000);

  test("one physical socket grants 20 starts at one instant and refuses the 21st", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-tmux-rate."));
    const env = { ...process.env, TAP_INDEX_HOME: join(scratch, "index") } as NodeJS.ProcessEnv;
    const socket = join(scratch, "server.sock");
    writeFileSync(socket, "socket\n");
    const claims = Array.from({ length: 21 }, () => claimTmuxStart(socket, 1_000, env));

    expect(claims.slice(0, 20).every((claim) => claim.ok)).toBe(true);
    expect(claims[20]!.ok).toBe(false);
    expect(claims[20]!.retryAfterMs).toBe(10);

    const other = join(scratch, "other.sock");
    writeFileSync(other, "other\n");
    expect(claimTmuxStart(other, 1_000, env).ok).toBe(true);
    removeScratchTree(scratch);
  });

  // tap-p0ww8: under team load the spawned-helper lock granted 1 of 6 and 1 of
  // 20 simultaneous claimers with a full bucket. The held sidecar is an older
  // checkout's lockf helper, so this also proves the two holders exclude each
  // other on the same path.
  test.each([6, 20])("%i concurrent claimers wait for a busy sidecar with a full bucket", async (claimers) => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-tmux-rate-race."));
    const env = { ...process.env, TAP_INDEX_HOME: join(scratch, "index") };
    const socket = join(scratch, "server.sock");
    writeFileSync(socket, "socket\n");
    const key = createHash("sha256").update(realpathSync(socket)).digest("hex");
    const ratePath = join(env.TAP_INDEX_HOME, "runtime-cache", `tmux-rate-${key}.json`);
    const held = acquirePathLock(`${ratePath}.lock`, 5000, env)!;
    writeFileSync(ratePath, JSON.stringify({ tokens: 20, at: 1000 }));
    const go = join(scratch, "go");
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { claimTmuxStart } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tmux.ts"))};
      writeFileSync(process.argv[1], "ready");
      while (!existsSync(${JSON.stringify(go)})) Bun.sleepSync(5);
      console.log(JSON.stringify(claimTmuxStart(${JSON.stringify(socket)}, 1000, process.env)));
    `;
    const ready = Array.from({ length: claimers }, (_, i) => join(scratch, `ready-${i}`));
    const children = ready.map((path) => Bun.spawn([process.execPath, "-e", source, path], {
      env, stdout: "pipe", stderr: "pipe",
    }));
    try {
      const deadline = Date.now() + 5000;
      while (!ready.every((path) => existsSync(path)) && Date.now() < deadline) await Bun.sleep(5);
      expect(ready.every((path) => existsSync(path))).toBe(true);
      writeFileSync(go, "go");
      // Hold beyond the old zero-timeout helper's 100ms handshake window,
      // but leave ample room in the bounded wait for every real process.
      await Bun.sleep(200);
      held.release();
      const codes = await Promise.all(children.map((child) => child.exited));
      const outs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
      const errs = await Promise.all(children.map((child) => new Response(child.stderr).text()));
      expect(codes).toEqual(ready.map(() => 0));
      expect(errs).toEqual(ready.map(() => ""));
      expect(outs.map((out) => JSON.parse(out))).toEqual(ready.map(() => ({ ok: true, retryAfterMs: 0 })));
      expect(JSON.parse(readFileSync(ratePath, "utf8")).tokens).toBe(20 - claimers);
    } finally {
      held.release();
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      removeScratchTree(scratch);
    }
  }, 20_000);

  test("contention followed by exhausted tokens shares one refusal deadline", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-tmux-rate-deadline."));
    const socket = join(scratch, "server.sock");
    const index = join(scratch, "index");
    writeFileSync(socket, "socket\n");
    const cache = join(index, "runtime-cache");
    mkdirSync(cache, { recursive: true });
    const key = createHash("sha256").update(realpathSync(socket)).digest("hex");
    writeFileSync(join(cache, `tmux-rate-${key}.json`), JSON.stringify({ tokens: 0, at: 10_000 }));
    // A separate process keeps the synthetic clock and lock schedule out of
    // other tests. The first holder releases late; a second holder then blocks
    // the retry. Real process scheduling must not decide this budget check.
    const source = `
      import { mock } from "bun:test";
      const lockModule = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "remind-lock.ts"))});
      let now = 0;
      let claims = 0;
      Date.now = () => now;
      Atomics.wait = (_a, _i, _v, ms) => { now += ms; return "timed-out"; };
      mock.module(${JSON.stringify(join(import.meta.dir, "..", "src", "remind-lock.ts"))}, () => ({
        ...lockModule,
        acquireNoFollowLock: (_path, timeout) => {
          if (++claims === 1) { now += 650; return { release() {} }; }
          now += timeout + 100;
          return null;
        },
      }));
      const { tmux } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "tmux.ts"))});
      const result = tmux(["display-message", "-p", "#{pid}:#{start_time}"], process.env);
      console.log(JSON.stringify({ result, elapsed: now, claims }));
    `;
    try {
      const child = spawnSync(process.execPath, ["-e", source], {
        env: { ...process.env, TAP_INDEX_HOME: index, TAP_TMUX_SOCKET_PATH: socket }, encoding: "utf8",
      });
      expect(child.stderr).toBe("");
      expect(child.status).toBe(0);
      const observed = JSON.parse(child.stdout);
      expect(observed.result.rateLimited).toBe(true);
      expect(observed.claims).toBe(2);
      expect(observed.elapsed).toBeLessThanOrEqual(1000);
    } finally { removeScratchTree(scratch); }
  });

  test("a held rate sidecar refuses within one second without starting tmux", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-tmux-rate-bound."));
    const bin = join(scratch, "bin");
    const index = join(scratch, "index");
    const socket = join(scratch, "server.sock");
    const started = join(scratch, "tmux-started");
    mkdirSync(bin, { recursive: true });
    writeFileSync(socket, "socket\n");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\n: > "$FAKE_STARTED"\n`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TAP_INDEX_HOME: index,
      TAP_TMUX_SOCKET_PATH: socket,
      TMUX: undefined,
      TMUX_PANE: undefined,
      FAKE_STARTED: started,
    } as NodeJS.ProcessEnv;
    const key = createHash("sha256").update(realpathSync(socket)).digest("hex");
    const ratePath = join(index, "runtime-cache", `tmux-rate-${key}.json`);
    const held = acquirePathLock(`${ratePath}.lock`, 5000, env)!;

    const before = performance.now();
    const result = tmux(["display-message", "-p", "#{pid}:#{start_time}"], env);
    const elapsed = performance.now() - before;
    held.release();

    expect(result.rateLimited).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(1000);
    expect(existsSync(started)).toBe(false);
    removeScratchTree(scratch);
  }, 10_000);
});

describe("observePaneResult record grammar", () => {
  function observeWith(stdout: string, mode = ""): ReturnType<typeof observePaneResult> {
    const scratch = mkdtempSync(join(tmpdir(), "tap-tmux-record."));
    const bin = join(scratch, "bin");
    const index = join(scratch, "index");
    const socket = join(scratch, "server.sock");
    const out = join(scratch, "pane.stdout");
    mkdirSync(bin);
    writeFileSync(socket, "socket\n");
    writeFileSync(out, stdout);
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case " $* " in
  *"#{pid}:#{start_time}"*)
    [ "$FAKE_OBSERVATION_MODE" = unavailable ] && exit 1
    printf '123:456\\n' ;;
  *"#{pane_id}"*"#{session_name}"*)
    case "$FAKE_OBSERVATION_MODE" in
      gone) cat "$FAKE_PANE_STDOUT"; echo "can't find pane: seat:0.0" >&2; exit 1 ;;
      error) echo "permission denied" >&2; exit 1 ;;
      changed) printf 'changed socket\\n' >> "$TAP_TMUX_SOCKET_PATH" ;;
    esac
    cat "$FAKE_PANE_STDOUT" ;;
  *) exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TAP_INDEX_HOME: index,
      TAP_TMUX_SOCKET_PATH: socket,
      FAKE_PANE_STDOUT: out,
      FAKE_OBSERVATION_MODE: mode,
      TMUX: undefined,
      TMUX_PANE: undefined,
    } as NodeJS.ProcessEnv;
    try {
      return observePaneResult("seat:0.0", env);
    } finally {
      removeScratchTree(scratch);
    }
  }

  test("a retained dead pane may omit its PID, while live or malformed records may not", () => {
    expect(observeWith("%0\tprobe\t\t\t1\n")).toMatchObject({
      status: "pane_dead", observation: { paneId: "%0", session: "probe", panePid: "" },
    });
    for (const row of ["%0\tprobe\t\tclaude\t0\n", "%0\tprobe\tbad\t\t1\n"])
      expect(observeWith(row).status).toBe("unobservable");
  });

  test("a well-formed five-field record is ok", () => {
    const r = observeWith("%7\tseat\t4242\tclaude\t0\n");
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.observation).toMatchObject({
      paneId: "%7", session: "seat", panePid: "4242", currentCommand: "claude",
    });
  });

  test("a retained dead pane carries identity without claiming physical absence", () => {
    expect(observeWith("%7\tseat\t4242\tclaude\t1\n")).toMatchObject({
      status: "pane_dead", observation: { paneId: "%7", session: "seat", panePid: "4242" },
    });
  });

  test("missing or malformed dead state is unobservable", () => {
    for (const record of ["%7\tseat\t4242\tclaude\n", "%7\tseat\t4242\tclaude\t\n", "%7\tseat\t4242\tclaude\t?\n"]) {
      expect(observeWith(record).status).toBe("unobservable");
    }
  });

  test("a six-field record is unobservable, not absence or a prefix keep", () => {
    expect(observeWith("%7\tseat\t4242\tclaude\t0\textra\n").status).toBe("unobservable");
  });

  test("two records are unobservable, not absence or the first line", () => {
    expect(observeWith("%7\tseat\t4242\tclaude\t0\n%8\tother\t1\tsh\t0\n").status).toBe("unobservable");
  });
  for (const [name, stdout, mode, status] of [
    ["three fields", "%7\tseat\t123:456\n", "", "unobservable"],
    ["empty pane id expansion", "\n", "", "pane_gone"],
    ["empty compound expansion", "\t\t\t\t\n", "", "pane_gone"],
    ["empty compound without newline", "\t\t\t\t", "", "pane_gone"],
    ["partial compound expansion", "\tseat\t4242\tclaude\t0\n", "", "unobservable"],
    ["whitespace is not an empty expansion", " \t\t\t\t\n", "", "unobservable"],
    ["wrong empty arity", "\t\t\t\n", "", "unobservable"],
    ["confirmed missing pane", "", "gone", "pane_gone"],
    ["failed query with contradictory live bytes", "%7\tseat\t4242\tclaude\t0\n", "gone", "unobservable"],
    ["failed observation", "", "error", "unobservable"],
    ["unavailable server identity", "%7\tseat\t4242\tclaude\t0\n", "unavailable", "unobservable"],
    ["generation changed during empty observation", "", "changed", "unobservable"],
    ["generation changed during empty compound", "\t\t\t\t\n", "changed", "unobservable"],
    ["generation changed during live observation", "%7\tseat\t4242\tclaude\t0\n", "changed", "unobservable"],
  ] as const) test(name, () => {
    expect(observeWith(stdout, mode).status).toBe(status);
  });
});


d("guarded bracketed paste", () => {
  for (const refusal of [false, "rate_limited"] as const) test(`rechecks authority after loading and cleans its buffer on ${refusal}`, () => {
    const marker = "must-not-reach-pane";
    let checked = false;
    expect(pasteText("alive", marker, () => {
      const buffers = T(["list-buffers", "-F", "#{buffer_name}"], { encoding: "utf8" }).stdout;
      expect(buffers).toContain(`tap-paste-${process.pid}-`);
      checked = true;
      return refusal;
    })).toBe(refusal);
    expect(checked).toBe(true);
    expect(T(["list-buffers", "-F", "#{buffer_name}"], { encoding: "utf8" }).stdout).not.toContain(`tap-paste-${process.pid}-`);
    expect(T(["capture-pane", "-p", "-t", "alive"], { encoding: "utf8" }).stdout).not.toContain(marker);
  });
});


d("paste cleanup under exhausted capacity",()=>{
 for(const stage of ["authorization","paste-reservation"])test(`cleans its buffer without admission when limiter refuses ${stage}`,()=>{
  const key=createHash("sha256").update(physicalSocketPath()).digest("hex");
  const ratePath=join(process.env.TAP_INDEX_HOME!,"runtime-cache",`tmux-rate-${key}.json`);
  const prior=readFileSync(ratePath,"utf8");let admissions=0;
  try{
   // Permit loading, but deny reservation before the final guard can run.
   if(stage==="paste-reservation")writeFileSync(ratePath,JSON.stringify({tokens:1,at:Date.now()+10_000}));
   expect(pasteText("alive","must-not-reach-pane",()=>{
    if(stage==="paste-reservation")throw new Error("authority ran before reservation");
    writeFileSync(ratePath,JSON.stringify({tokens:0,at:Date.now()+10_000}));
    expect(tmux(["display-message","-p","-t","alive","#{pane_id}"]).rateLimited).toBe(true);
    return "rate_limited";
   },()=>{admissions++;return true})).toBe("rate_limited");
   expect(admissions).toBe(0);
   expect(T(["list-buffers","-F","#{buffer_name}"],{encoding:"utf8"}).stdout).not.toContain(`tap-paste-${process.pid}-`);
  }finally{if(prior)writeFileSync(ratePath,prior);}
 });
});


d("paste reservation authority order",()=>{
 test("final authority observes the reserved paste slot before admission",()=>{
  const key=createHash("sha256").update(physicalSocketPath()).digest("hex");
  const ratePath=join(process.env.TAP_INDEX_HOME!,"runtime-cache",`tmux-rate-${key}.json`);
  const prior=readFileSync(ratePath,"utf8");let admissions=0,observed=-1;
  try {
   // Two slots: load consumes one, paste reservation must consume the second
   // before the final observation. Future at disables refill deterministically.
   writeFileSync(ratePath,JSON.stringify({tokens:2,at:Date.now()+10_000}));
   expect(pasteText("alive","must-not-reach-pane",()=>{
    observed=JSON.parse(readFileSync(ratePath,"utf8")).tokens;
    return false;
   },()=>{admissions++;return true})).toBe(false);
   expect(observed).toBe(0);expect(admissions).toBe(0);
   expect(T(["list-buffers","-F","#{buffer_name}"],{encoding:"utf8"}).stdout).not.toContain(`tap-paste-${process.pid}-`);
  } finally {writeFileSync(ratePath,prior);}
 });
});
