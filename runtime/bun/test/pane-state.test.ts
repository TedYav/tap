// Unit 1: incumbent bandState false-busy on idle Claude box chrome.
// Unit 2: typed paneState + land/clear; GREEN the Unit 1 surrogate via bound.harness.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authorizePaneEffect, submitVerifyLocked, type BoundRecipient, type PaneEffects } from "../src/courier";
import { classifyPane, observeCopyMode, observeInputId, observePaneKind, observePaneProbe, paneHeight, paneState, toPaneBand, toPaneProbe } from "../src/pane-state";
import { observeSubmitFrame } from "../src/submit-frame";
import { observeInputRegion, promptLineRe } from "../src/tmux";
import { acquirePathLock } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";

const TXT = join(
  import.meta.dir,
  "../../../skills/tap/scripts/smoke/fixtures/pane-state/claude/idle-band.txt",
);
const DRAFT_TXT = join(
  import.meta.dir,
  "../../../skills/tap/scripts/smoke/fixtures/pane-state/claude/draft-box.txt",
);
const CORPUS = join(
  import.meta.dir,
  "../../../skills/tap/scripts/smoke/fixtures/pane-state",
);
const OPENCODE_ALL_WRAPPED = join(import.meta.dir, "fixtures", "opencode-capture", "all-wrapped-160.plain.txt");
const HERMES_PLACEHOLDER = join(
  import.meta.dir,
  "../../../skills/tap/scripts/smoke/fixtures/hermes-prompt/placeholder.ansi",
);
const OPENCODE_ALL_WRAPPED_JOINED = join(import.meta.dir, "fixtures", "opencode-capture", "all-wrapped-160.joined.txt");
// Live OpenCode 1.18.31 captures (tap-yqonr): a fresh seat's welcome screen,
// then the same screen with a typed draft.
const OPENCODE_WELCOME = join(import.meta.dir, "fixtures", "opencode-capture", "welcome-124.ansi");
const OPENCODE_WELCOME_DRAFT = join(import.meta.dir, "fixtures", "opencode-capture", "welcome-draft-124.ansi");
// Live Claude Code 2.1.286 capture, 100x40 (tap-zo67f): a draft scrolled so every visible composer row is blank.
const SCROLLED_BLANK = join(CORPUS, "claude", "20261001-v2.1.286-scrolled-blank-tail-h40");
const SENTINEL_ID = "sol-test-20260830T000000Z-u2landid01";
const corpus = (name: string) => readFileSync(join(CORPUS, name), "utf8");

// Reference implementation of the RETIRED generic prompt-row reader: it
// reproduces what bandState() concluded over supplied bytes so the contrast
// tests keep proving what paneState replaced, without a production bandState.
type ReferenceBand =
  | { state: "clear" }
  | { state: "busy"; text: string }
  | { state: "unobservable"; reason: string };

function referencePromptRowBand(capture: string, cmd: string): ReferenceBand {
  const re = promptLineRe(cmd);
  const lines = capture.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (re.test(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return { state: "unobservable", reason: "no prompt row" };
  const region = lines.slice(start);
  region[0] = region[0]!.replace(re, "");
  const text = region.join("\n").trim();
  return text ? { state: "busy", text } : { state: "clear" };
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

let root: string;
let savedPath: string | undefined;
let savedIndexHome: string | undefined;
let savedSocket: string | undefined;
let savedCapture: string | undefined;
let savedInMode: string | undefined;

beforeAll(() => {
  const bytes = readFileSync(TXT);
  const draftBytes = readFileSync(DRAFT_TXT);
  const obibmBytes = readFileSync(join(CORPUS, "claude/obibm-clear-hint.txt"));
  const opencodeBytes = readFileSync(OPENCODE_ALL_WRAPPED);
  const opencodeJoinedBytes = readFileSync(OPENCODE_ALL_WRAPPED_JOINED);
  root = mkdtempSync(join(tmpdir(), "tap-pane-state."));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fixture = join(root, "idle-band.txt");
  const draftFixture = join(root, "draft-box.txt");
  const obibmFixture = join(root, "obibm.txt");
  const opencodeFixture = join(root, "opencode-all-wrapped.txt");
  const opencodeJoinedFixture = join(root, "opencode-all-wrapped.joined.txt");
  const tryEscaped = readFileSync(join(CORPUS, "claude/20260923-try-empty-100.ansi"), "utf8");
  const tryFixture = join(root, "try-empty.ansi");
  const tryPlainFixture = join(root, "try-empty.txt");
  writeFileSync(tryFixture, tryEscaped);
  for (const [name, path] of [["welcome", OPENCODE_WELCOME], ["welcome-draft", OPENCODE_WELCOME_DRAFT]]) {
    const escaped = readFileSync(path!, "utf8");
    writeFileSync(join(root, `opencode-${name}.ansi`), escaped);
    writeFileSync(join(root, `opencode-${name}.txt`), stripAnsi(escaped));
  }
  writeFileSync(tryPlainFixture, stripAnsi(tryEscaped));
  writeFileSync(fixture, bytes);
  writeFileSync(draftFixture, draftBytes);
  writeFileSync(obibmFixture, obibmBytes);
  writeFileSync(opencodeFixture, opencodeBytes);
  writeFileSync(opencodeJoinedFixture, opencodeJoinedBytes);
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/sh
dm=0 t=0 cap=0 p=0 e=0 j=0 inmode=0 width=0 height=0
for a in "$@"; do
  [ "$a" = "display-message" ] && dm=1
  [ "$a" = "-t" ] && t=1
  [ "$a" = "capture-pane" ] && cap=1
  [ "$a" = "-p" ] && p=1
  [ "$a" = "-e" ] && e=1
  [ "$a" = "-J" ] && j=1
  case "$a" in *pane_in_mode*) inmode=1 ;; esac
  case "$a" in *pane_width*) width=1 ;; esac
  case "$a" in *pane_height*) height=1 ;; esac
done
if [ "$height" = 1 ] && [ "\${TAP_PANE_HEIGHT+x}" = x ]; then
  printf '%s\\n' "\$TAP_PANE_HEIGHT"
  exit 0
fi
if [ "$inmode" = 1 ]; then
  if [ "\${TAP_PANE_IN_MODE_FAIL:-0}" = 1 ]; then exit 1; fi
  if [ "\${TAP_PANE_IN_MODE+x}" = x ]; then
    printf '%s\\n' "\$TAP_PANE_IN_MODE"
  else
    printf '0\\n'
  fi
  exit 0
fi
if [ "$dm" = 1 ] && [ "$t" = 0 ]; then
  printf '%s\\n' "1:1"
  exit 0
fi
if [ "$width" = 1 ]; then
  printf '160\\n'
  exit 0
fi
if [ "$dm" = 1 ] && [ "$t" = 1 ]; then
  case "\${TAP_PANE_STATE_CAPTURE:-idle}" in
    gone) exit 0 ;;
    live-then-gone)
      c="\${TAP_INDEX_HOME}/dm-t.count"
      n=\$(cat "\$c" 2>/dev/null || echo 0)
      n=\$((n + 1))
      printf '%s\\n' "\$n" > "\$c"
      if [ "\$n" -ge 2 ]; then exit 0; fi
      printf '%s\\n' '%0\tsess\t4242\tclaude\t0'
      ;;
    *) printf '%s\\n' '%0\tsess\t4242\tclaude\t0' ;;
  esac
  exit 0
fi
if [ "$cap" = 1 ] && [ "$p" = 1 ]; then
  case "\${TAP_PANE_STATE_CAPTURE:-idle}" in
    fail) echo "capture failed" >&2; exit 1 ;;
    gone|live-then-gone) echo "pane gone" >&2; exit 1 ;;
    empty-prompt|prompt-no-box) printf '%s\\n' "❯ " ;;
    no-prompt) printf '%s\\n' "working with no glyph" ;;
    with-id) printf '%s\\n' "❯ ${SENTINEL_ID}" ;;
    chip) printf '%s\\n' "❯ [Pasted text #1]" ;;
    padded-row) printf '%s\\n' "\${TAP_PANE_PAD}\${TAP_PANE_GLYPH} ${SENTINEL_ID}" ;;
    idle) cat "${fixture}" ;;
    draft-box) cat "${draftFixture}" ;;
    scrolled-blank) if [ "$e" = 1 ]; then cat "${SCROLLED_BLANK}.ansi"; else cat "${SCROLLED_BLANK}.txt"; fi ;;
    obibm) cat "${obibmFixture}" ;;
    claude-try-empty) if [ "$e" = 1 ]; then cat "${tryFixture}"; else cat "${tryPlainFixture}"; fi ;;
    opencode-welcome|opencode-welcome-draft)
      if [ "$e" = 1 ]; then cat "${root}/\${TAP_PANE_STATE_CAPTURE}.ansi"; else cat "${root}/\${TAP_PANE_STATE_CAPTURE}.txt"; fi ;;
    opencode-all-wrapped)
      if [ "$j" = 1 ]; then cat "${opencodeJoinedFixture}"
      else cat "${opencodeFixture}"
      fi ;;
    *) echo "pane-state.test.sh: unknown TAP_PANE_STATE_CAPTURE=\$TAP_PANE_STATE_CAPTURE" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "pane-state.test.sh: unexpected tmux argv: $*" >&2
exit 1
`,
  );
  chmodSync(join(bin, "tmux"), 0o755);
  savedPath = process.env.PATH;
  savedIndexHome = process.env.TAP_INDEX_HOME;
  savedSocket = process.env.TAP_TMUX_SOCKET;
  savedCapture = process.env.TAP_PANE_STATE_CAPTURE;
  savedInMode = process.env.TAP_PANE_IN_MODE;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.TAP_INDEX_HOME = join(root, "index");
  mkdirSync(process.env.TAP_INDEX_HOME, { recursive: true });
  process.env.TAP_TMUX_SOCKET = "tapbun-pane-state-unit1";
  delete process.env.TAP_PANE_STATE_CAPTURE;
  delete process.env.TAP_PANE_IN_MODE;
});

afterAll(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (savedIndexHome === undefined) delete process.env.TAP_INDEX_HOME;
  else process.env.TAP_INDEX_HOME = savedIndexHome;
  if (savedSocket === undefined) delete process.env.TAP_TMUX_SOCKET;
  else process.env.TAP_TMUX_SOCKET = savedSocket;
  if (savedCapture === undefined) delete process.env.TAP_PANE_STATE_CAPTURE;
  else process.env.TAP_PANE_STATE_CAPTURE = savedCapture;
  if (savedInMode === undefined) delete process.env.TAP_PANE_IN_MODE;
  else process.env.TAP_PANE_IN_MODE = savedInMode;
  removeScratchTree(root);
});

describe("idle Claude chrome (Unit 1 surrogate)", () => {
  test("empty box plus border/footer is not human draft", () => {
    const got = paneState("%0", "claude", "claude");
    expect(got.state).toBe("ready");
  });

  test("incumbent bandState still reports leftover chrome as busy (contrast)", () => {
    expect(referencePromptRowBand(readFileSync(TXT, "utf8"), "claude").state).toBe("busy");
  });
});

describe("family authority is bound.harness, not command", () => {
  test("codex harness plus claude command does not take the Claude box reader", () => {
    const got = paneState("%0", "codex", "claude");
    expect(got.state).not.toBe("ready");
  });
});

test("OpenCode all-wrapped panes use physical rows for readiness and submit frames", () => {
  process.env.TAP_PANE_STATE_CAPTURE = "opencode-all-wrapped";
  try {
    expect(classifyPane(readFileSync(OPENCODE_ALL_WRAPPED_JOINED, "utf8"), "opencode", false).kind).toBe("no-band");
    expect(observePaneKind("%0", "opencode", "opencode")).toEqual({ kind: "ready" });
    expect(paneState("%0", "opencode", "opencode")).toEqual({ state: "ready" });
    expect(observeSubmitFrame("%0", "opencode", "[[TAP v0.23 note fixture-id]]")).toMatchObject({
      state: "empty",
      width: "160",
    });
    expect(observeSubmitFrame("%0", "/opt/local/bin/OpenCode", "[[TAP v0.23 note fixture-id]]").state).toBe("empty");
  } finally {
    delete process.env.TAP_PANE_STATE_CAPTURE;
  }
});

test("a fresh OpenCode welcome screen is ready; a typed draft there is not (tap-yqonr)", () => {
  const welcome = readFileSync(OPENCODE_WELCOME, "utf8");
  // The placeholder differs from typed text only by colour: without SGR the
  // reader must keep it, which is why the live observer captures with -e.
  expect(classifyPane(welcome, "opencode", false)).toEqual({ kind: "ready" });
  expect(classifyPane(stripAnsi(welcome), "opencode", false).kind).toBe("draft");
  expect(classifyPane(readFileSync(OPENCODE_WELCOME_DRAFT, "utf8"), "opencode", false))
    .toEqual({ kind: "draft", text: "what is the tech stack here" });
  try {
    process.env.TAP_PANE_STATE_CAPTURE = "opencode-welcome";
    expect(observePaneKind("%0", "opencode", "opencode")).toEqual({ kind: "ready" });
    expect(paneState("%0", "opencode", "opencode")).toEqual({ state: "ready" });
    process.env.TAP_PANE_STATE_CAPTURE = "opencode-welcome-draft";
    expect(observePaneKind("%0", "opencode", "opencode"))
      .toEqual({ kind: "draft", text: "what is the tech stack here" });
  } finally {
    delete process.env.TAP_PANE_STATE_CAPTURE;
  }
});

test("OpenCode preserves a human draft, indented or not", () => {
  const footer = "  ┃  Build · OpenCode Fixture · high";
  const withRow = (row: string) => readFileSync(OPENCODE_ALL_WRAPPED, "utf8").replace(footer, `${row}\n${footer}`);
  // Typed text renders two columns after the border, so a draft there is a draft.
  expect(classifyPane(withRow("  ┃  shallow draft"), "/opt/local/bin/OpenCode", false).kind).toBe("draft");
  expect(classifyPane(withRow("  ┃   three spaces"), "opencode", false).kind).toBe("draft");
  // An indented draft stays a draft. The reader this arm used to test had the
  // safe answer; the incumbent Bash reader read any row indented >= 5 columns as
  // the cwd/branch overlay and returned empty, and unifying them naively would
  // have taken the unsafe answer to both runtimes. Measured geometry says the
  // overlay starts at column 99 or 116 in every captured box while every draft
  // starts at column 1 or 2, so the threshold moved into the middle of that gap
  // and this row is preserved.
  expect(classifyPane(withRow("  ┃       indented draft"), "/opt/local/bin/OpenCode", false).kind).toBe("draft");
  // The overlay itself still reads as chrome, not as a draft.
  expect(classifyPane(withRow("  ┃" + " ".repeat(40) + "~/work/x:"), "opencode", false).kind).toBe("ready");
});

test("OpenCode treats only the gray first-load placeholder as empty", () => {
  const frame = readFileSync(OPENCODE_ALL_WRAPPED, "utf8");
  const row = "  ┃\n  ┃  Build · OpenCode Fixture · high";
  const gray = frame.replace(row, '  ┃  \x1b[38;2;128;128;128mAsk anything... "Fix broken tests"\x1b[39m\n  ┃  Build · OpenCode Fixture · high');
  const typed = frame.replace(row, '  ┃  \x1b[38;2;238;238;238mAsk anything... "Fix broken tests"\x1b[39m\n  ┃  Build · OpenCode Fixture · high');
  expect(classifyPane(gray, "opencode", false).kind).toBe("ready");
  expect(classifyPane(typed, "opencode", false).kind).toBe("draft");
});

// tap-vctb8: the wrapped claude-mem stderr debris is DETECTED today, but the
// band it produces carries no cause, so delivery cannot tell debris (repaint
// and retry) from a broken pane. The overprint no-band names its cause.
test("OpenCode overprint no-band carries cause overprint through the band (tap-vctb8)", () => {
  const lines = readFileSync(OPENCODE_ALL_WRAPPED, "utf8").replace(/\n+$/, "").split("\n");
  const corner = lines.findLastIndex(l => /^\s*╹▀/.test(l));
  lines[corner - 1] = "\x1b[39m\x1b[49m     [claude-mem-capture] Worker POST /api/sessions/observations failed: The socket connection was closed unexpectedly.";
  lines[corner] = "\x1b[39m\x1b[49min the second argument to fetch()";
  const torn = lines.join("\n") + "\n";
  const classified = classifyPane(torn, "opencode", false);
  expect(classified).toEqual({
    kind: "no-band",
    reason: "OpenCode terminal overprint obscures the composer",
    cause: "overprint",
  });
  expect(toPaneBand(classified)).toEqual({
    state: "unobservable",
    reason: "OpenCode terminal overprint obscures the composer",
    cause: "overprint",
  });
  // A plain no-band (no recognized composer) keeps carrying no cause.
  expect(classifyPane("nothing here", "opencode", false)).toEqual({ kind: "no-band", reason: "no recognized OpenCode composer" });
});

describe("B1 pinned corpus (six-state classifyPane)", () => {
  test("idle-current empty box is ready", () => {
    expect(classifyPane(corpus("claude/idle-current.txt"), "claude", false))
      .toEqual({ kind: "ready" });
  });

  test("obibm /clear hint plus permission footer is ready, not draft", () => {
    expect(classifyPane(corpus("claude/obibm-clear-hint.txt"), "claude", false))
      .toEqual({ kind: "ready" });
    expect(classifyPane(corpus("claude/obibm-clear-hint.esc"), "claude", false).kind)
      .toBe("ready");
  });

  test("wrapped draft carries both rows and excludes the footer", () => {
    expect(classifyPane(corpus("claude/wrapped-draft.txt"), "claude", false))
      .toEqual({ kind: "draft", text: "first line of claude draft\nsecond line of claude draft" });
  });

  test("no-prompt surrogate (dialog) is no-band, not ready", () => {
    const got = classifyPane(corpus("claude/no-prompt-surrogate.txt"), "claude", false);
    expect(got.kind).toBe("no-band");
    expect(got.kind).not.toBe("ready");
  });

  test("2026-08-29 OQ1 mid-turn queued rendering is draft (rendering geometry indistinguishable from its human-draft falsifier; composer text is the only byte difference)", () => {
    expect(classifyPane(corpus("claude/mid-turn-queued-input.txt"), "claude", false))
      .toEqual({ kind: "draft", text: "queued-input specimen for paneState", rows: ["queued-input specimen for paneState"], columns: 80 });
  });

  test("mid-turn human draft in the same geometry stays draft", () => {
    expect(classifyPane(corpus("claude/mid-turn-human-draft.txt"), "claude", false))
      .toEqual({ kind: "draft", text: "human follow-up still typing", rows: ["human follow-up still typing"], columns: 80 });
  });

  test("copy-mode overrides visible draft bytes", () => {
    expect(classifyPane(corpus("claude/wrapped-draft.txt"), "claude", true))
      .toEqual({ kind: "copy-mode" });
  });

  test("production paneState maps copy-mode to unobservable (PaneBand frozen)", () => {
    process.env.TAP_PANE_IN_MODE = "1";
    process.env.TAP_PANE_STATE_CAPTURE = "draft-box";
    try {
      const got = paneState("%0", "claude", "claude");
      expect(got.state).toBe("unobservable");
      expect(got.state).not.toBe("ready");
      expect(got.state).not.toBe("busy");
      if (got.state === "unobservable") expect(got.reason).toContain("copy-mode");
    } finally {
      delete process.env.TAP_PANE_IN_MODE;
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("observePaneKind reads the pane height for a scrolled blank-tail Claude draft (tap-zo67f)", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "scrolled-blank";
    try {
      process.env.TAP_PANE_HEIGHT = "40";
      expect(observePaneKind("%0", "claude", "claude")).toMatchObject({ kind: "draft", scrolled: true });
      expect(paneState("%0", "claude", "claude")).toMatchObject({ state: "busy", scrolled: true });
      // A height that is not this pane's, or no readable height: today's verdict.
      for (const height of ["60", "", "x"]) {
        process.env.TAP_PANE_HEIGHT = height;
        expect(observePaneKind("%0", "claude", "claude")).toEqual({ kind: "ready" });
      }
      delete process.env.TAP_PANE_HEIGHT;
      expect(observePaneKind("%0", "claude", "claude")).toEqual({ kind: "ready" });
    } finally {
      delete process.env.TAP_PANE_HEIGHT;
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("a rate-limited pane-height read holds instead of dropping the witness", () => {
    const limited = () => ({ code: 1, stdout: "", stderr: "tmux client rate limited", rateLimited: true });
    expect(paneHeight("%0", limited)).toBe("rate-limited");
    expect(paneHeight("%0", () => ({ code: 0, stdout: "40\n", stderr: "" }))).toBe(40);
    expect(paneHeight("%0", () => ({ code: 1, stdout: "", stderr: "no pane" }))).toBeUndefined();
  });

  test("observePaneKind exposes live pane_in_mode as copy-mode, not no-band", () => {
    process.env.TAP_PANE_IN_MODE = "1";
    process.env.TAP_PANE_STATE_CAPTURE = "draft-box";
    try {
      expect(observeCopyMode("%0")).toEqual({ status: "copy-mode" });
      const kind = observePaneKind("%0", "claude", "claude");
      expect(kind).toEqual({ kind: "copy-mode" });
      expect(toPaneProbe(kind)).toEqual({ kind: "copy-mode" });
      expect(observePaneProbe("%0", "claude", "claude")).toEqual({ kind: "copy-mode" });
      expect(kind.kind).not.toBe("draft");
      expect(kind.kind).not.toBe("no-band");
    } finally {
      delete process.env.TAP_PANE_IN_MODE;
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("observePaneProbe is the owner caller seam: copy-mode stays typed, paneState stays collapsed", () => {
    process.env.TAP_PANE_IN_MODE = "1";
    process.env.TAP_PANE_STATE_CAPTURE = "draft-box";
    try {
      const consume = (pane: string, harness: string, command: string) =>
        observePaneProbe(pane, harness, command);
      expect(consume("%0", "claude", "claude")).toEqual({ kind: "copy-mode" });
      const collapsed = paneState("%0", "claude", "claude");
      expect(collapsed.state).toBe("unobservable");
      if (collapsed.state === "unobservable") expect(collapsed.reason).toContain("copy-mode");
    } finally {
      delete process.env.TAP_PANE_IN_MODE;
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("exact pane_in_mode 1/0/else: copy-mode, normal, unobservable", () => {
    process.env.TAP_PANE_IN_MODE = "1";
    expect(observeCopyMode("%0")).toEqual({ status: "copy-mode" });
    process.env.TAP_PANE_IN_MODE = "0";
    expect(observeCopyMode("%0")).toEqual({ status: "normal" });
    process.env.TAP_PANE_IN_MODE = "";
    const empty = observeCopyMode("%0");
    expect(empty.status).toBe("unobservable");
    process.env.TAP_PANE_IN_MODE = "yes";
    const malformed = observeCopyMode("%0");
    expect(malformed.status).toBe("unobservable");
    expect(observePaneKind("%0", "claude", "claude").kind).toBe("no-band");
    delete process.env.TAP_PANE_IN_MODE;
  });

  test("copy-mode yields zero injection until the pane is ready", () => {
    process.env.TAP_PANE_IN_MODE = "1";
    process.env.TAP_PANE_STATE_CAPTURE = "idle";
    let injected = 0;
    try {
      const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
        paneState,
        copyMode: observeCopyMode,
        injectText: () => {
          injected++;
          return true;
        },
      }));
      expect(observePaneKind("%0", "claude", "claude").kind).toBe("copy-mode");
      expect(blocked.status).toBe("copy_mode");
      if (blocked.status === "copy_mode") expect(blocked.cause).toBe("copy-mode");
      expect(injected).toBe(0);
    } finally {
      delete process.env.TAP_PANE_IN_MODE;
    }
    const ready = paneState("%0", "claude", "claude");
    expect(ready.state).toBe("ready");
    expect(observePaneKind("%0", "claude", "claude").kind).toBe("ready");
    const landed = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      paneState,
      copyMode: observeCopyMode,
      injectText: () => {
        injected++;
        return true;
      },
      observeInput: (() => {
        let n = 0;
        return () => {
          n++;
          return n === 1 ? { state: "present" as const, text: SENTINEL_ID } : { state: "absent" as const };
        };
      })(),
    }));
    expect(landed.status).toBe("injected");
    expect(injected).toBe(1);
    delete process.env.TAP_PANE_STATE_CAPTURE;
  });

  test("malformed pane_in_mode is no-band and yields zero injection", () => {
    process.env.TAP_PANE_IN_MODE = "yes";
    process.env.TAP_PANE_STATE_CAPTURE = "idle";
    let injected = 0;
    try {
      expect(observeCopyMode("%0").status).toBe("unobservable");
      expect(observePaneKind("%0", "claude", "claude").kind).toBe("no-band");
      expect(paneState("%0", "claude", "claude").state).toBe("unobservable");
      const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
        paneState,
        copyMode: observeCopyMode,
        injectText: () => {
          injected++;
          return true;
        },
      }));
      expect(blocked.status).toBe("band_busy");
      expect(blocked.status).not.toBe("copy_mode");
      expect(injected).toBe(0);
    } finally {
      delete process.env.TAP_PANE_IN_MODE;
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("copyMode unobservable refuses even when a later peek is normal and paneState is ready", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1
          ? { status: "unobservable" as const, reason: "unrecognized pane_in_mode" }
          : { status: "normal" as const };
      },
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(1);
    expect(blocked.status).toBe("band_busy");
    expect(blocked.status).not.toBe("copy_mode");
    expect(injected).toBe(0);
  });

  test("normal then unobservable recheck refuses even when paneState is ready", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1
          ? { status: "normal" as const }
          : { status: "unobservable" as const, reason: "unrecognized pane_in_mode" };
      },
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("band_busy");
    expect(blocked.status).not.toBe("copy_mode");
    expect(injected).toBe(0);
  });

  test("normal then mid unobservable preserves pane_gone", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1
          ? { status: "normal" as const }
          : { status: "unobservable" as const, reason: "unrecognized pane_in_mode" };
      },
      paneState: () => ({ state: "gone" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("pane_gone");
    expect(blocked.status).not.toBe("band_busy");
    expect(blocked.status).not.toBe("copy_mode");
    expect(injected).toBe(0);
  });

  test("normal then copy-mode after paneState unobservable is copy_mode with zero injection", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1 ? { status: "normal" as const } : { status: "copy-mode" as const };
      },
      paneState: () => ({ state: "unobservable", reason: "input band is unobservable" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("copy_mode");
    expect(injected).toBe(0);
  });

  test("normal then copy-mode recheck is copy_mode with zero injection", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1 ? { status: "normal" as const } : { status: "copy-mode" as const };
      },
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("copy_mode");
    expect(injected).toBe(0);
  });

  test("initial copy-mode gone is pane_gone not band_busy", () => {
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => ({ status: "gone" as const }),
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(blocked.status).toBe("pane_gone");
    expect(blocked.status).not.toBe("band_busy");
    expect(injected).toBe(0);
  });

  test("initial copy-mode rate-limited is rate_limited not band_busy", () => {
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => ({ status: "rate-limited" as const, reason: "tmux client budget exhausted before copy-mode could be inspected" }),
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(blocked.status).toBe("rate_limited");
    expect(blocked.status).not.toBe("band_busy");
    expect(injected).toBe(0);
  });

  test("mid copy-mode gone replaces band_busy", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1 ? { status: "normal" as const } : { status: "gone" as const };
      },
      paneState: () => ({ state: "busy", text: "draft" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("pane_gone");
    expect(blocked.status).not.toBe("band_busy");
    expect(injected).toBe(0);
  });

  test("mid copy-mode rate-limited replaces band_busy", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1
          ? { status: "normal" as const }
          : { status: "rate-limited" as const, reason: "tmux client budget exhausted before copy-mode could be inspected" };
      },
      paneState: () => ({ state: "busy", text: "draft" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("rate_limited");
    expect(blocked.status).not.toBe("band_busy");
    expect(injected).toBe(0);
  });

  test("final copy-mode gone is pane_gone with zero injection", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1 ? { status: "normal" as const } : { status: "gone" as const };
      },
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("pane_gone");
    expect(injected).toBe(0);
  });

  test("final copy-mode rate-limited is rate_limited with zero injection", () => {
    let peeks = 0;
    let injected = 0;
    const blocked = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      copyMode: () => {
        peeks++;
        return peeks === 1
          ? { status: "normal" as const }
          : { status: "rate-limited" as const, reason: "tmux client budget exhausted before copy-mode could be inspected" };
      },
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injected++;
        return true;
      },
    }));
    expect(peeks).toBe(2);
    expect(blocked.status).toBe("rate_limited");
    expect(injected).toBe(0);
  });

  test("production paneState on live obibm bytes is ready; bandState stays busy", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "obibm";
    try {
      expect(paneState("%0", "claude", "claude").state).toBe("ready");
      expect(referencePromptRowBand(corpus("claude/obibm-clear-hint.txt"), "claude").state).toBe("busy");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("retired generic reader false-busies the Hermes placeholder; the pane reader classifies ready", () => {
    const escaped = readFileSync(HERMES_PLACEHOLDER, "utf8");
    expect(classifyPane(escaped, "hermes", false).kind).toBe("ready");
    expect(referencePromptRowBand(stripAnsi(escaped), "hermes").state).toBe("busy");
  });
});

describe("tap-maavp U2: dim queued placeholder is chrome, not a draft", () => {
  test("2026-09-06 dim queued placeholder beside a real queue is ready", () => {
    expect(classifyPane(corpus("claude/20260906-queued-placeholder.ansi"), "claude", false))
      .toEqual({ kind: "ready" });
  });

  test("2026-09-18 live human draft above a real queue stays draft", () => {
    expect(classifyPane(corpus("claude/20260918-queued-live-draft.ansi"), "claude", false))
      .toEqual({ kind: "draft", text: "Com", rows: ["Com"], columns: 238 });
  });

  test("2026-09-18 emptied composer above its real queue is ready", () => {
    expect(classifyPane(corpus("claude/20260918-queued-empty.ansi"), "claude", false))
      .toEqual({ kind: "ready" });
  });

  test("undimmed identical sentence beside a real queue stays draft", () => {
    const frame = corpus("claude/20260906-queued-placeholder.ansi");
    const undimmed = frame.replace(
      "\x1b[2m\x1b[39mPress up to edit queued messages\x1b[0m",
      "Press up to edit queued messages",
    );
    expect(classifyPane(undimmed, "claude", false))
      .toEqual({ kind: "draft", text: "Press up to edit queued messages", rows: ["Press up to edit queued messages"], columns: 80 });
  });

});

describe("tap-ybz1s: a fully dim Claude prompt row is chrome, by paint not text", () => {
  for (const width of ["100", "145"]) {
    test(`live ${width}-column empty composer with the dim Try suggestion is ready`, () => {
      expect(classifyPane(corpus(`claude/20260923-try-empty-${width}.ansi`), "claude", false)).toEqual({ kind: "ready" });
    });
  }

  test("live typed text at normal intensity stays draft, even starting with Try", () => {
    expect(classifyPane(corpus("claude/20260923-try-typed-100.ansi"), "claude", false))
      .toEqual({ kind: "draft", text: "Try this plain draft of mine", rows: ["Try this plain draft of mine"], columns: 100 });
  });

  test("the same suggestion bytes without dim paint stay draft", () => {
    const frame = corpus("claude/20260923-try-empty-100.ansi").replace("\x1b[2mTry", "Try");
    expect(classifyPane(frame, "claude", false)).toEqual({ kind: "draft", text: 'Try "refactor <filepath>"', rows: ['Try "refactor <filepath>"'], columns: 100 });
  });

  test("a partly dim row (typed text plus a dim completion) stays draft", () => {
    const frame = corpus("claude/20260923-try-empty-100.ansi").replace("\x1b[2mTry", "Try\x1b[2m");
    expect(classifyPane(frame, "claude", false).kind).toBe("draft");
  });

  test("a dim paste chip stays input", () => {
    const frame = corpus("claude/20260923-try-empty-100.ansi").replace('Try "refactor <filepath>"', "[Pasted text #1 +12 lines]");
    expect(classifyPane(frame, "claude", false).kind).toBe("draft");
  });

  test("paneState captures Claude with escapes, so the live reader sees the paint", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "claude-try-empty";
    try {
      expect(paneState("%0", "claude", "claude").state).toBe("ready");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });
});

// tap-6zzsk: selector parity. `observeInputRegion` is the native twin of the incumbent's
// `tap_inputregion`, which chose the LAST prompt row with `awk '$0 ~ re'` — and macOS awk's
// `[[:space:] ]` accepts TAB/VT/FF/CR/SPACE/NBSP and REJECTS U+1680, U+2000-200A, U+2028/29,
// U+202F, U+205F and U+3000 (measured with /usr/bin/awk under en_US.UTF-8; the grep/sed
// classes that accept those belong to other instruments). Not `POSIX_LOCALE_SPACE`: that is
// the wider sed/grep class and would select rows the incumbent's region reader refused.
// No live capture carries a separator before the glyph; this is selector parity, not an incident.
describe("tap-6zzsk: observeInputRegion selects the prompt row with awk's space class", () => {
  const HARNESSES: [string, string][] = [["claude", "❯"], ["codex", "›"], ["cursor", "→"], ["hermes", "❯"]];
  const AWK_ACCEPTS: [string, string][] = [["TAB", "\t"], ["VT", "\v"], ["FF", "\f"], ["CR", "\r"], ["SPACE", " "], ["NBSP", "\u00a0"]];
  const AWK_REJECTS: [string, string][] = [
    ["U+1680", "\u1680"], ["U+2000", "\u2000"], ["U+200A", "\u200a"], ["U+2028", "\u2028"], ["U+202F", "\u202f"],
    ["U+205F", "\u205f"], ["U+3000", "\u3000"], ["U+0085", "\u0085"], ["U+001F", "\u001f"], ["U+FEFF", "\ufeff"], ["U+200B", "\u200b"],
  ];
  const observe = (cmd: string, glyph: string, pad: string) => {
    process.env.TAP_PANE_STATE_CAPTURE = "padded-row";
    process.env.TAP_PANE_PAD = pad;
    process.env.TAP_PANE_GLYPH = glyph;
    try { return observeInputRegion("%0", cmd); }
    finally { delete process.env.TAP_PANE_STATE_CAPTURE; delete process.env.TAP_PANE_PAD; delete process.env.TAP_PANE_GLYPH; }
  };

  for (const [cmd, glyph] of HARNESSES) {
    test(`${cmd}: a row padded with a separator awk accepts is the input band`, () => {
      for (const [name, sep] of AWK_ACCEPTS) {
        const got = observe(cmd, glyph, sep);
        expect({ cmd, sep: name, status: got.status }).toEqual({ cmd, sep: name, status: "captured" });
      }
    });
    test(`${cmd}: a row padded with a separator only grep/sed accept stays no_prompt`, () => {
      for (const [name, sep] of AWK_REJECTS) {
        const got = observe(cmd, glyph, sep);
        expect({ cmd, sep: name, status: got.status }).toEqual({ cmd, sep: name, status: "no_prompt" });
      }
    });
  }

  test("opencode and agy are not awk-selected, and keep their existing ASCII-blank selector", () => {
    // Their incumbent `tap_inputregion` arms were box readers, never the awk row selector.
    for (const [cmd, glyph] of [["opencode", "❯"], ["agy", ">"]] as const) {
      expect(observe(cmd, glyph, " ").status).toBe("captured");
      expect(observe(cmd, glyph, "\u00a0").status).toBe("no_prompt");
    }
  });

  test("observeInputId reads an id behind an NBSP-padded prompt row instead of refusing", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "padded-row";
    process.env.TAP_PANE_PAD = "\u00a0";
    process.env.TAP_PANE_GLYPH = "❯";
    try {
      expect(observeInputId("%0", "claude", SENTINEL_ID).state).toBe("present");
      process.env.TAP_PANE_PAD = "\u3000";
      expect(observeInputId("%0", "claude", SENTINEL_ID).state).toBe("unobservable");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE; delete process.env.TAP_PANE_PAD; delete process.env.TAP_PANE_GLYPH;
    }
  });
});

describe("typed capture outcomes", () => {
  test("capture-pane nonzero is unobservable, not absent", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "fail";
    try {
      const got = observeInputId("%0", "claude", SENTINEL_ID);
      expect(got.state).toBe("unobservable");
      expect(got.state).not.toBe("absent");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("rc=0 empty band with prompt visible is absent", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "empty-prompt";
    try {
      expect(observeInputId("%0", "claude", SENTINEL_ID)).toEqual({ state: "absent" });
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("a paste-collapse chip is chip, not absent", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "chip";
    try {
      const got = observeInputId("%0", "claude", SENTINEL_ID);
      expect(got.state).toBe("chip");
      expect(got.state).not.toBe("absent");
      if (got.state === "chip") expect(got.text).toContain("[Pasted text #1]");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("no prompt glyph with pane still present is unobservable, not gone", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "no-prompt";
    try {
      const got = observeInputId("%0", "claude", SENTINEL_ID);
      expect(got.state).toBe("unobservable");
      expect(got.state).not.toBe("gone");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("id in the visible band is present", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "with-id";
    try {
      const got = observeInputId("%0", "claude", SENTINEL_ID);
      expect(got.state).toBe("present");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("bound Claude prompt with no box border is unobservable, not ready", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "prompt-no-box";
    try {
      const got = paneState("%0", "claude", "claude");
      expect(got.state).toBe("unobservable");
      expect(got.state).not.toBe("ready");
      expect(referencePromptRowBand("❯ ", "claude").state).toBe("clear");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("positive pane absence is gone, not capture-fail unobservable", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "gone";
    try {
      expect(paneState("%0", "claude", "claude").state).toBe("gone");
      expect(observeInputId("%0", "claude", SENTINEL_ID).state).toBe("gone");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test.each(["codex", "opencode", "cursor", "hermes"])("live presence then gone %s band is gone, not no-band", (harness) => {
    process.env.TAP_PANE_STATE_CAPTURE = "live-then-gone";
    const count = join(process.env.TAP_INDEX_HOME ?? "", "dm-t.count");
    try {
      if (existsSync(count)) unlinkSync(count);
      const kind = observePaneKind("%0", harness, harness);
      expect(kind.kind).toBe("gone");
      expect(kind.kind).not.toBe("no-band");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
      if (existsSync(count)) unlinkSync(count);
    }
  });

  test("live presence then Claude capture-fail is gone, not no-band", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "live-then-gone";
    const count = join(process.env.TAP_INDEX_HOME ?? "", "dm-t.count");
    try {
      if (existsSync(count)) unlinkSync(count);
      const kind = observePaneKind("%0", "claude", "claude");
      expect(kind.kind).toBe("gone");
      expect(kind.kind).not.toBe("no-band");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
      if (existsSync(count)) unlinkSync(count);
    }
  });

  test("live presence then copy-mode peek failure is gone, not no-band", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "live-then-gone";
    process.env.TAP_PANE_IN_MODE = "yes";
    const count = join(process.env.TAP_INDEX_HOME ?? "", "dm-t.count");
    try {
      if (existsSync(count)) unlinkSync(count);
      const kind = observePaneKind("%0", "claude", "claude");
      expect(kind.kind).toBe("gone");
      expect(kind.kind).not.toBe("no-band");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
      delete process.env.TAP_PANE_IN_MODE;
      if (existsSync(count)) unlinkSync(count);
    }
  });

  test("observeCopyMode tmux failure on a vanished pane is gone", () => {
    process.env.TAP_PANE_IN_MODE_FAIL = "1";
    process.env.TAP_PANE_STATE_CAPTURE = "gone";
    try {
      expect(observeCopyMode("%0")).toEqual({ status: "gone" });
      expect(observePaneKind("%0", "claude", "claude").kind).toBe("gone");
    } finally {
      delete process.env.TAP_PANE_IN_MODE_FAIL;
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("observeCopyMode uses the budgeted tmux client", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-copy-mode-rate."));
    const socket = join(scratch, "server.sock");
    const started = join(scratch, "tmux-started");
    writeFileSync(socket, "socket\n");
    const prevPath = process.env.PATH;
    const prevIndex = process.env.TAP_INDEX_HOME;
    const prevSockPath = process.env.TAP_TMUX_SOCKET_PATH;
    const prevSock = process.env.TAP_TMUX_SOCKET;
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\n: > ${JSON.stringify(started)}\nprintf '0\\n'\n`, { mode: 0o755 });
    const index = join(scratch, "index");
    mkdirSync(join(index, "runtime-cache"), { recursive: true });
    process.env.PATH = `${bin}:${prevPath}`;
    process.env.TAP_INDEX_HOME = index;
    process.env.TAP_TMUX_SOCKET_PATH = socket;
    delete process.env.TAP_TMUX_SOCKET;
    const key = createHash("sha256").update(realpathSync(socket)).digest("hex");
    const ratePath = join(index, "runtime-cache", `tmux-rate-${key}.json`);
    const held = acquirePathLock(`${ratePath}.lock`, 5000)!;
    try {
      const got = observeCopyMode("%0");
      expect(got.status).toBe("rate-limited");
      expect(existsSync(started)).toBe(false);
    } finally {
      held.release();
      process.env.PATH = prevPath!;
      if (prevIndex === undefined) delete process.env.TAP_INDEX_HOME;
      else process.env.TAP_INDEX_HOME = prevIndex;
      if (prevSockPath === undefined) delete process.env.TAP_TMUX_SOCKET_PATH;
      else process.env.TAP_TMUX_SOCKET_PATH = prevSockPath;
      if (prevSock === undefined) delete process.env.TAP_TMUX_SOCKET;
      else process.env.TAP_TMUX_SOCKET = prevSock;
      removeScratchTree(scratch);
    }
  }, 10_000);
});

const bound: BoundRecipient = { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" };

function landFx(overrides: Partial<PaneEffects> = {}): PaneEffects {
  return {
    observePane: () => ({
      paneId: "%7", session: "s", serverEpoch: "srv:1:2",
      panePid: "4242", currentCommand: "claude",
    }),
    paneState: () => ({ state: "ready" }),
    injectText: () => true,
    inputHasId: () => false,
    pressEnter: () => true,
    settle: () => {},
    harnessEvidence: () => "alive",
    ...overrides,
  };
}

describe("submitVerify typed land/clear", () => {
  for (const stop of [false, true]) test(`Hermes admits its first real effect, not the empty interrupt (${stop})`, () => {
    const home = join(root, `hermes-admission-${stop}`);
    const marker = join(home, "receipts", `${SENTINEL_ID}.attempted`);
    let delayed = false, injections = 0, keys = 0;
    const result = submitVerifyLocked("sess:0.0", SENTINEL_ID, "wire", { ...bound, harness: "hermes" }, landFx({
      observePane: () => stop && delayed ? "unobservable" : {
        paneId: "%7", session: "s", serverEpoch: "srv:1:2", panePid: "4242", currentCommand: "hermes",
      },
      settle: (seconds) => {
        if (seconds === 0.15) { expect(existsSync(marker)).toBe(false); delayed = true; }
      },
      pressKeys: () => { keys++; return true; },
      injectText: () => { expect(existsSync(marker)).toBe(true); injections++; return true; },
      observeInput: () => ({ state: "present", text: SENTINEL_ID }),
      submitFrame: () => ({ state: "staged", mode: "idle", width: "80" }),
    }), { busHome: home, recipient: "peer", registryPath: "", scriptsDir: "", agentFamilies: new Set(["hermes"]), noPromptOk: true,
      deliveryFacts: { urgent: true, noSpool: false, recipientBound: true, harness: "hermes" } });
    if (stop) expect(result.status).toBe("band_busy");
    expect({ injections, keys, attempted: existsSync(marker) }).toEqual({ injections: stop ? 0 : 1, keys: 0, attempted: !stop });
  });

  for (const writable of [true, false]) test(`AGY re-probe requires durable zero-Enter evidence (${writable})`, () => {
    const home = join(root, `reprobe-${writable}`);
    mkdirSync(home, { recursive: true });
    mkdirSync(join(home, "receipts"), { recursive: true });
    if (!writable) mkdirSync(join(home, "receipts", `${SENTINEL_ID}.submit-phases.jsonl`));
    let frames = 0, enters = 0, injections = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP v0.23 ask ${SENTINEL_ID}]]`,
      { ...bound, harness: "agy" }, landFx({
        observePane: () => ({ paneId: "%7", session: "s", serverEpoch: "srv:1:2", panePid: "4242", currentCommand: "agy" }),
        submitFrame: () => ({ state: ++frames === 1 ? "staged" : "changed", mode: "idle", width: "80" }),
        injectText: () => {
          expect(existsSync(join(home, "receipts", `${SENTINEL_ID}.attempted`))).toBe(true);
          injections++; return true;
        },
        pressEnter: () => { enters++; return true; },
      }), { busHome: home, recipient: "peer", registryPath: "", scriptsDir: "", agentFamilies: new Set(["agy"]),
        deliveryFacts: { urgent: false, noSpool: false, recipientBound: true, harness: "agy" } });
    expect(r.status).toBe("unverified");
    expect(r.status === "unverified" && r.reprobePending === true).toBe(writable);
    expect({ injections, enters }).toEqual({ injections: 1, enters: 0 });
  });

  // tap-csrls: the Enter landed after its own post-Enter read; the next attempt's pre-Enter read
  // found the composer empty and the delivered send exited 5 ("empty, idle, width 197").
  for (const [name, late, status, enters] of [
    ["an Enter that lands late is acceptance on the next read", "empty", "injected", 1],
    ["a seat that starts working after a late Enter is acceptance", "unobservable-working", "injected", 1],
    ["a changed composer after an Enter stays unverified", "changed", "unverified", 1],
    ["an empty composer before any Enter is not acceptance", "empty-first", "unverified", 0],
  ] as const) test(`staged submit: ${name}`, () => {
    const home = join(root, `late-enter-${late}`);
    mkdirSync(join(home, "receipts"), { recursive: true });
    // Keyed on Enters, not call count: the landing check reads frames too. Before any Enter the wire is
    // staged; the first read after the first Enter still shows it staged; every later read shows `late`.
    // empty-first lands staged (the landing check's one read), then reads empty before any Enter.
    let pressed = 0, readsAfterEnter = 0, reads = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP v0.23 ask ${SENTINEL_ID}]]`, bound, landFx({
      submitFrame: () => {
        if (late === "empty-first") return { state: ++reads === 1 ? "staged" : "empty", mode: "idle", width: "80" };
        if (pressed === 0 || ++readsAfterEnter === 1) return { state: "staged", mode: "idle", width: "80" };
        return late === "unobservable-working" ? { state: "unobservable", mode: "working", width: "80" }
          : { state: late, mode: "idle", width: "80" };
      },
      pressEnter: () => { pressed++; return true; },
    }), { busHome: home, recipient: "peer", registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]),
      deliveryFacts: { urgent: false, noSpool: false, recipientBound: true, harness: "claude" } });
    // +1: landFx's band reads ready, so the completion step adds its one flush Enter in every case.
    expect({ status: r.status, pressed }).toEqual({ status, pressed: enters + 1 });
  });

  test("a prior courier attempt cannot authorize another ordinary injection", () => {
    const home = join(root, "prior-courier-attempt");
    mkdirSync(join(home, "receipts"), { recursive: true });
    writeFileSync(join(home, "receipts", `${SENTINEL_ID}.attempted`), "{}");
    let injections = 0;
    const result = submitVerifyLocked("sess:0.0", SENTINEL_ID, "wire", bound,
      landFx({ injectText: () => { injections++; return true; } }), {
        busHome: home, recipient: "peer", registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]),
        deliveryFacts: { urgent: false, noSpool: false, recipientBound: true, harness: "claude" },
      });
    expect(result.status).toBe("attempt_evidence_unwritable");
    expect(injections).toBe(0);
  });

  test("empty through ten incumbent land reads then present on the extra phase is not lost", () => {
    let n = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      observeInput: () => {
        n++;
        if (n <= 10) return { state: "absent" };
        if (n === 11) return { state: "present", text: SENTINEL_ID };
        return { state: "absent" };
      },
      inputHasId: () => false,
    }));
    expect(r.status).toBe("injected");
    expect(n).toBeGreaterThan(10);
  });

  test("stale bound boot_id refuses before pane effects while epoch still matches", () => {
    const prev = process.env.TAP_BOOT_ID;
    process.env.TAP_BOOT_ID = "bootuuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    try {
      let injected = 0;
      const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, {
        ...bound,
        bootId: "bootuuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }, landFx({
        injectText: () => { injected++; return true; },
      }));
      expect(r.status).toBe("identity_mismatch");
      if (r.status === "identity_mismatch") {
        expect(r.detail).toContain("boot_id_stale");
        expect(r.detail).toContain("stored boot_id");
      }
      expect(injected).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.TAP_BOOT_ID;
      else process.env.TAP_BOOT_ID = prev;
    }
  });

  test("failed capture after Enter is unverified, not injected", () => {
    let typed = 0;
    let collapsed = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      observeInput: () => {
        typed++;
        if (typed === 1) return { state: "present", text: SENTINEL_ID };
        return { state: "unobservable", reason: "capture-pane failed" };
      },
      inputHasId: () => {
        collapsed++;
        return collapsed === 1;
      },
    }));
    expect(r.status).toBe("unverified");
    expect(r.status).not.toBe("injected");
  });

  test("rate-limited land sample is unverified, no classification guessed", () => {
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      observeInput: () => ({ state: "rate_limited", reason: "tmux client budget exhausted" }),
    }));
    expect(r.status).toBe("unverified");
    expect(r.status).not.toBe("injected");
  });

  test("positive pane absence after inject is not injected", () => {
    let typed = 0;
    let collapsed = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      observeInput: () => {
        typed++;
        if (typed === 1) return { state: "present", text: SENTINEL_ID };
        return { state: "gone" };
      },
      inputHasId: () => {
        collapsed++;
        return collapsed === 1;
      },
    }));
    expect(r.status).not.toBe("injected");
  });

  test("production paneState ready wins over leftover bandState busy", () => {
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      paneState: () => ({ state: "ready" }),
      observeInput: (() => {
        let n = 0;
        return () => {
          n++;
          return n === 1 ? { state: "present" as const, text: SENTINEL_ID } : { state: "absent" as const };
        };
      })(),
    }));
    expect(r.status).toBe("injected");
  });

  test("recognized Claude box with draft is busy and refuses inject", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "draft-box";
    let injected = 0;
    try {
      const got = paneState("%0", "claude", "claude");
      expect(got.state).toBe("busy");
      expect(got.state === "busy" ? got.text : "").toContain("HUMAN-DRAFT");
      const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
        paneState,
        injectText: () => {
          injected++;
          return true;
        },
      }));
      expect(r.status).toBe("band_busy");
      expect(injected).toBe(0);
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("unrecognized Claude box refuses with zero pane effects", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "prompt-no-box";
    let injected = 0;
    try {
      const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
        paneState,
        injectText: () => {
          injected++;
          return true;
        },
      }));
      expect(r.status).toBe("band_busy");
      expect(injected).toBe(0);
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("production pre-inject gone is pane_gone with zero pane effects", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "gone";
    let injected = 0;
    try {
      const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
        paneState,
        injectText: () => {
          injected++;
          return true;
        },
      }));
      expect(r.status).toBe("pane_gone");
      expect(injected).toBe(0);
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("production observeInputId gone after inject is not injected", () => {
    process.env.TAP_PANE_STATE_CAPTURE = "with-id";
    try {
      const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
        paneState: () => ({ state: "ready" }),
        observeInput: observeInputId,
        injectText: () => {
          process.env.TAP_PANE_STATE_CAPTURE = "gone";
          return true;
        },
      }));
      expect(r.status).not.toBe("injected");
    } finally {
      delete process.env.TAP_PANE_STATE_CAPTURE;
    }
  });

  test("swallowed first Enter: exact id remaining after the beat delivers with two Enters", () => {
    let enters = 0;
    let n = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      observeInput: () => {
        n++;
        if (n <= 2) return { state: "present" as const, text: SENTINEL_ID };
        return { state: "absent" as const };
      },
      pressEnter: () => { enters++; return true; },
    }));
    expect(r.status).toBe("injected");
    expect(enters).toBe(2);
  });

  test("first Enter that clears the exact id presses no second Enter", () => {
    let enters = 0;
    let n = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      observeInput: () => {
        n++;
        if (n === 1) return { state: "present" as const, text: SENTINEL_ID };
        return { state: "absent" as const };
      },
      pressEnter: () => { enters++; return true; },
    }));
    expect(r.status).toBe("injected");
    expect(enters).toBe(1);
  });

  test("a paste chip after a landed id is unverified and presses no second Enter", () => {
    let enters = 0;
    let n = 0;
    const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
      observeInput: () => {
        n++;
        if (n === 1) return { state: "present" as const, text: SENTINEL_ID };
        return { state: "chip" as const, text: "[Pasted text #1]" };
      },
      pressEnter: () => { enters++; return true; },
    }));
    expect(r.status).toBe("unverified");
    expect(r.status).not.toBe("injected");
    expect(enters).toBe(1);
    if (r.status === "unverified") {
      expect(r.detail).toContain("paste-collapse chip remains");
    }
  });

  test("injected fake settle keeps the 0.5 beat literal under TAP_TUI_SETTLE_SCALE", () => {
    const prev = process.env.TAP_TUI_SETTLE_SCALE;
    process.env.TAP_TUI_SETTLE_SCALE = "0.1";
    try {
      const waits: number[] = [];
      let n = 0;
      const r = submitVerifyLocked("sess:0.0", SENTINEL_ID, `[[TAP ${SENTINEL_ID}]]`, bound, landFx({
        observeInput: () => {
          n++;
          if (n === 1) return { state: "present" as const, text: SENTINEL_ID };
          return { state: "absent" as const };
        },
        settle: (seconds) => { waits.push(seconds); },
      }));
      expect(r.status).toBe("injected");
      expect(waits).toContain(0.5);
      expect(waits.some((s) => s === 0.05)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TAP_TUI_SETTLE_SCALE;
      else process.env.TAP_TUI_SETTLE_SCALE = prev;
    }
  });
});

describe("tmux.settle TAP_TUI_SETTLE_SCALE", () => {
  const tmuxSrc = join(import.meta.dir, "../src/tmux.ts");

  function settleChild(scale: string, seconds: number) {
    const src = `
      const waits = [];
      Atomics.wait = (_ta, _i, _v, timeout) => { waits.push(timeout); return "timed-out"; };
      process.env.TAP_TUI_SETTLE_SCALE = ${JSON.stringify(scale)};
      const { settle } = await import(${JSON.stringify(tmuxSrc)});
      settle(${seconds});
      settle(${seconds});
      process.stdout.write(JSON.stringify(waits));
    `;
    const r = Bun.spawnSync([process.execPath, "-e", src], { stderr: "pipe", stdout: "pipe" });
    return { exitCode: r.exitCode, stderr: r.stderr.toString(), stdout: r.stdout.toString() };
  }

  test("valid 0.1 announces once; invalid warns once and stays unscaled", () => {
    const active = settleChild("0.1", 0.01);
    expect(active.exitCode).toBe(0);
    expect(JSON.parse(active.stdout)).toEqual([1, 1]);
    expect((active.stderr.match(/TUI settle scale 0.1 active/g) ?? []).length).toBe(1);

    const invalid = settleChild("bogus", 0.08);
    expect(invalid.exitCode).toBe(0);
    expect(JSON.parse(invalid.stdout)).toEqual([80, 80]);
    expect((invalid.stderr.match(/invalid TAP_TUI_SETTLE_SCALE/g) ?? []).length).toBe(1);
  });
});

test("input protection cannot hide a replaced pane identity", () => {
  let holdReads = 0;
  const fx = landFx({
    observePane: () => ({paneId: "%99", session: "s", serverEpoch: "srv:1:2", panePid: "4242", currentCommand: "claude"}),
    inputHeld: () => { holdReads++; throw new Error("must check binding first"); },
  });
  expect(authorizePaneEffect("sess:0.0", bound, fx).status).toBe("identity_mismatch");
  expect(holdReads).toBe(0);
});
