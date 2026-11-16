// U1 (tap-b8qp5): idle Cursor and Hermes panes classify through the pane
// reader (`pendingInputText`), not the generic bandState fallback.
//
// The fake tmux honours `-e` exactly as the real one does: SGR bytes exist in
// the pane and are returned only when asked for. The live route must capture
// ESCAPED for these families, because the dim rule reads the paint.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { submitVerifyLocked, type BoundRecipient, type PaneEffects } from "../src/courier";
import { pendingSentinel } from "../src/deliver";
import { classifyPane, observePaneKind, paneState } from "../src/pane-state";
import { removeScratchTree } from "./support/scratch";
import { renderSentinel } from "../src/sentinel";

const deliveryWire = (id: string) => renderSentinel({ from: "probe", to: "peer", id,
  kind: "discuss", reply: "expected", path: "/fixture/payload.md" });

// The REAL live-pane bytes (cursor-harness.test.sh:70): the terminal cursor
// block overlays the first character in reverse video, resetting dim on that
// one char and splitting the dim run.
const CURSOR_ESCAPED =
  " \x1b[48;2;32;32;32m \x1b[2m→ \x1b[0;7m\x1b[48;2;32;32;32mA\x1b[0;2m\x1b[48;2;32;32;32mdd a follow-up\x1b[0m";
const CURSOR_PLAIN = " → Add a follow-up";

// Hermes idle chrome: italic (SGR 3) plus the muted 256-colour 136 foreground
// (cursor-harness.test.sh:56,138). Both conjuncts required.
const HERMES_ESCAPED = "\x1b[38;5;230m❯ \x1b[3;38;5;136mWhat would you like to do?\x1b[0m";
const HERMES_PLAIN = "❯ What would you like to do?";

// A HUMAN's typed draft on the same harness: no dim paint at all.
const CURSOR_TYPED_ESCAPED = " → ship the release notes";
const CURSOR_TYPED_PLAIN = " → ship the release notes";

// Multiline drafts: the cursor one is a bounded composer box (▄/▀ borders)
// whose text spans two rows; the hermes one is real-shaped — twin full-width
// horizontal rules flank the composer and the footer sits below the bottom
// one, exactly as live Hermes paints it.
const CURSOR_BOX = "▄▄▄▄▄▄▄▄▄▄▄\n → first line of the draft\nsecond line of the draft\n▀▀▀▀▀▀▀▀▀▀";
const CURSOR_BOX_TEXT = "first line of the draft\nsecond line of the draft";
const HERMES_RULE = "─".repeat(80);
const HERMES_BOX =
  `${HERMES_RULE}\n❯ first line of the hermes draft\nsecond line of the hermes draft\n${HERMES_RULE}\n0s · ctx -- esc to cancel`;
// composerInput's generic branch still emits awk's synthetic trailing newline
// (its own byte contract), but classifyPane strips it before PaneBand.text —
// in-process callers see command-substitution semantics, real hard newlines
// preserved. The rules and footer are Hermes chrome, never input.
const HERMES_BOX_TEXT = "first line of the hermes draft\nsecond line of the hermes draft";

// An empty prompt row above a typed continuation is a draft, not ready — for
// both families. The hermes text keeps its real leading hard newline.
const HERMES_LEADING_NEWLINE = "❯ \nsecond line of the draft";
const HERMES_LEADING_NEWLINE_TEXT = "\nsecond line of the draft";
const CURSOR_EMPTY_PROMPT_BOX = "▄▄▄▄▄▄▄▄▄▄▄\n → \ncontinuation row\n▀▀▀▀▀▀▀▀▀▀";

// A user's line of box-drawing characters is text, never the footer bar: a
// short one is not pane-scale, and a pane-scale one without the composer's
// matching top rule stays text whether blank or typed rows follow it.
const HERMES_USER_SHORT_BAR = `❯ line one\n${"─".repeat(20)}\nstill here`;
const HERMES_USER_LONE_BAR = `❯ line one\n${"─".repeat(60)}\n\n\n`;
const HERMES_USER_RULE_PLUS_ROW = `❯ line one\n${"─".repeat(60)}\nstill here`;

// Repo live-capture fixtures (skills/tap/scripts/smoke/fixtures/hermes-prompt),
// served to the frame classifier directly: full panes, placeholder dim pair in
// the prompt row, typed control undimmed.
const REPO_HERMES_PLACEHOLDER = join(import.meta.dir, "..", "..", "..",
  "skills/tap/scripts/smoke/fixtures/hermes-prompt/placeholder.ansi");
const REPO_HERMES_TYPED = join(import.meta.dir, "..", "..", "..",
  "skills/tap/scripts/smoke/fixtures/hermes-prompt/typed.ansi");

let root: string;
let saved: Record<string, string | undefined> = {};

const FRAMES: Record<string, { escaped: string; plain: string }> = {
  "cursor-placeholder": { escaped: CURSOR_ESCAPED, plain: CURSOR_PLAIN },
  "hermes-placeholder": { escaped: HERMES_ESCAPED, plain: HERMES_PLAIN },
  "cursor-typed": { escaped: CURSOR_TYPED_ESCAPED, plain: CURSOR_TYPED_PLAIN },
  "cursor-box": { escaped: CURSOR_BOX, plain: CURSOR_BOX },
  "hermes-box": { escaped: HERMES_BOX, plain: HERMES_BOX },
  // Deliberate classification: without SGR the exact whole-band wording is
  // still chrome by exact equality, never a substring strip.
  "cursor-unpainted": { escaped: CURSOR_PLAIN, plain: CURSOR_PLAIN },
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tap-u1-generic-band."));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const frames = join(root, "frames");
  mkdirSync(frames, { recursive: true });
  for (const [name, bytes] of Object.entries(FRAMES)) {
    writeFileSync(join(frames, `${name}.esc`), bytes.escaped + "\n");
    writeFileSync(join(frames, `${name}.plain`), bytes.plain + "\n");
  }
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
dm=0 t=0 cap=0 p=0 e=0 inmode=0 width=0
for a in "$@"; do
  [ "$a" = "display-message" ] && dm=1
  [ "$a" = "-t" ] && t=1
  [ "$a" = "capture-pane" ] && cap=1
  [ "$a" = "-p" ] && p=1
  [ "$a" = "-e" ] && e=1
  case "$a" in *pane_in_mode*) inmode=1 ;; esac
  case "$a" in *pane_width*) width=1 ;; esac
done
if [ "$inmode" = 1 ]; then printf '0\\n'; exit 0; fi
if [ "$width" = 1 ]; then printf '160\\n'; exit 0; fi
if [ "$dm" = 1 ] && [ "$t" = 0 ]; then printf '1:1\\n'; exit 0; fi
if [ "$dm" = 1 ] && [ "$t" = 1 ]; then
  printf '%s\\n' "%0	sess	4242	\${TAP_U1_CMD:-cursor-agent}	0"; exit 0
fi
if [ "$cap" = 1 ] && [ "$p" = 1 ]; then
  f="${frames}/\${TAP_U1_FRAME:-cursor-placeholder}"
  if [ "$e" = 1 ]; then cat "\$f.esc"; else cat "\$f.plain"; fi
  exit 0
fi
echo "generic-band-cursor-hermes.test: unexpected tmux argv: $*" >&2
exit 1
`);
  chmodSync(join(bin, "tmux"), 0o755);
  for (const k of ["PATH", "TAP_INDEX_HOME", "TAP_TMUX_SOCKET", "TAP_U1_FRAME", "TAP_U1_CMD"]) {
    saved[k] = process.env[k];
  }
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.TAP_INDEX_HOME = join(root, "index");
  mkdirSync(process.env.TAP_INDEX_HOME, { recursive: true });
  process.env.TAP_TMUX_SOCKET = "tapbun-u1-generic-band";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  removeScratchTree(root);
});

function withFrame<T>(frame: string, cmd: string, fn: () => T): T {
  process.env.TAP_U1_FRAME = frame;
  process.env.TAP_U1_CMD = cmd;
  try { return fn(); } finally {
    delete process.env.TAP_U1_FRAME;
    delete process.env.TAP_U1_CMD;
  }
}

describe("classifyPane: Cursor and Hermes read the supplied frame through the pane reader", () => {
  test("styled idle Cursor placeholder is ready for cursor-agent and cursor", () => {
    for (const harness of ["cursor-agent", "cursor"]) {
      expect(classifyPane(CURSOR_ESCAPED, harness, false)).toEqual({ kind: "ready" });
    }
  });

  test("styled idle Hermes placeholder (live-pane specimen) is ready", () => {
    expect(classifyPane(HERMES_ESCAPED, "hermes", false)).toEqual({ kind: "ready" });
  });

  test("repo Hermes placeholder fixture is ready; repo typed fixture is a draft", () => {
    expect(classifyPane(readFileSync(REPO_HERMES_PLACEHOLDER, "utf8"), "hermes", false))
      .toEqual({ kind: "ready" });
    // Real framed bytes: the typed control survives as the prompt row only —
    // the bottom rule and everything under it are chrome, excluded verbatim,
    // and awk's synthetic trailing newline does not reach PaneBand.text.
    expect(classifyPane(readFileSync(REPO_HERMES_TYPED, "utf8"), "hermes", false))
      .toEqual({ kind: "draft", text: "TAP-HERMES-TYPED-CONTROL-7R3FN37" });
  });

  test("a real framed Hermes staged sentinel survives classification and stays parseable", () => {
    const id = "probe-20260918T000000Z-aabbccddeeff";
    const frame = readFileSync(REPO_HERMES_TYPED, "utf8")
      .replace("TAP-HERMES-TYPED-CONTROL-7R3FN37", `/queue [[TAP v0.23 ask ${id}]]`);
    const classified = classifyPane(frame, "hermes", false);
    expect(classified.kind).toBe("draft");
    expect(classified.kind === "draft" ? pendingSentinel(classified.text, "hermes") : null)
      .toEqual({ id, to: "" });
  });

  test("unpainted exact Cursor whole-band wording is ready deliberately", () => {
    expect(classifyPane(CURSOR_PLAIN, "cursor-agent", false)).toEqual({ kind: "ready" });
  });

  test("a typed Cursor draft holds with its text", () => {
    expect(classifyPane(CURSOR_TYPED_ESCAPED, "cursor-agent", false))
      .toEqual({ kind: "draft", text: "ship the release notes" });
  });

  test("path-shaped and mixed-case Cursor/Hermes harness values classify through the family", () => {
    expect(classifyPane(CURSOR_ESCAPED, "/opt/homebrew/bin/cursor-agent", false)).toEqual({ kind: "ready" });
    expect(classifyPane(CURSOR_ESCAPED, "Cursor-Agent", false)).toEqual({ kind: "ready" });
    expect(classifyPane(HERMES_ESCAPED, "Hermes", false)).toEqual({ kind: "ready" });
  });

  test("a multiline Cursor draft carries every continuation row from the composer box", () => {
    expect(classifyPane(CURSOR_BOX, "cursor-agent", false)).toEqual({ kind: "draft", text: CURSOR_BOX_TEXT });
  });

  test("a multiline Hermes draft carries every continuation row below the prompt", () => {
    expect(classifyPane(HERMES_BOX, "hermes", false)).toEqual({ kind: "draft", text: HERMES_BOX_TEXT });
  });

  test("an empty prompt row above a typed continuation is a draft, not ready", () => {
    expect(classifyPane(HERMES_LEADING_NEWLINE, "hermes", false))
      .toEqual({ kind: "draft", text: HERMES_LEADING_NEWLINE_TEXT });
    expect(classifyPane(CURSOR_EMPTY_PROMPT_BOX, "cursor-agent", false))
      .toEqual({ kind: "draft", text: "continuation row" });
  });

  test("a user's line of box-drawing characters is never truncated as footer chrome", () => {
    const short = classifyPane(HERMES_USER_SHORT_BAR, "hermes", false);
    expect(short).toEqual({ kind: "draft", text: `line one\n${"─".repeat(20)}\nstill here` });
    // Pane scale but uncorroborated: no top rule, no chrome below.
    const lone = classifyPane(HERMES_USER_LONE_BAR, "hermes", false);
    expect(lone).toEqual({ kind: "draft", text: `line one\n${"─".repeat(60)}` });
    // Pane scale with a matching-width top rule absent AND a nonblank row
    // below: continuation text is not footer corroboration.
    const plusRow = classifyPane(HERMES_USER_RULE_PLUS_ROW, "hermes", false);
    expect(plusRow).toEqual({ kind: "draft", text: `line one\n${"─".repeat(60)}\nstill here` });
  });

  test("Claude on Cursor bytes is not a draft", () => {
    const got = classifyPane(CURSOR_ESCAPED, "claude", false);
    expect(got.kind).not.toBe("draft");
  });
});

describe("observePaneKind: the live route captures escaped and classifies through the reader", () => {
  test("an idle Cursor pane is ready for cursor-agent", () => {
    const got = withFrame("cursor-placeholder", "cursor-agent",
      () => observePaneKind("%0", "cursor-agent", "cursor-agent"));
    expect(got.kind).toBe("ready");
  });

  test("unknown Gemini is no-band with the shared-classifier reason", () => {
    const got = withFrame("cursor-placeholder", "gemini",
      () => observePaneKind("%0", "gemini", "gemini"));
    expect(got).toEqual({ kind: "no-band", reason: "no shared classifier for this harness" });
  });

  test("empty harness with command cursor-agent is ready (command is the family fallback)", () => {
    const got = withFrame("cursor-placeholder", "cursor-agent",
      () => observePaneKind("%0", "", "cursor-agent"));
    expect(got.kind).toBe("ready");
  });

  test("hermes-profile rides the Hermes route (family contract is prefix-based)", () => {
    const got = withFrame("hermes-placeholder", "hermes-profile",
      () => observePaneKind("%0", "hermes-profile", "hermes-profile"));
    expect(got.kind).toBe("ready");
  });

  test("multiline drafts reach PaneBand.text with every continuation row", () => {
    for (const [frame, harness, text] of [
      ["cursor-box", "cursor-agent", CURSOR_BOX_TEXT],
      ["hermes-box", "hermes", HERMES_BOX_TEXT],
    ] as const) {
      const [kind, band] = withFrame(frame, harness, () => [
        observePaneKind("%0", harness, harness),
        paneState("%0", harness, harness),
      ]);
      expect(kind).toEqual({ kind: "draft", text });
      expect(band).toEqual({ state: "busy", text });
    }
  });
});

describe("submitVerifyLocked traverses the real paneState", () => {
  // The real paneState stays; only the effects around it are faked. The
  // defect U1 fixes IS which reader paneState reaches, so an injected
  // paneState fake would make these tests blind to it.
  const bound = (harness: string): BoundRecipient =>
    ({ paneId: "%0", serverEpoch: "srv:1:2", harness });
  const fx = (): PaneEffects => {
    let samples = 0;
    return {
      observePane: () => ({ paneId: "%0", session: "s", serverEpoch: "srv:1:2",
        panePid: "4242", currentCommand: process.env.TAP_U1_CMD ?? "cursor-agent" }),
      injectText: () => true,
      inputHasId: () => true,
      pressEnter: () => true,
      settle: () => {},
      harnessEvidence: () => "alive",
      // The REAL paneState seam: the defect U1 fixes IS which reader
      // paneState reaches, so an injected paneState fake would blind these.
      paneState: (t, h, c) => paneState(t, h, c),
      // First sample lands the injected sentinel; afterwards the band reads
      // clear so the Enter loop confirms and delivery completes.
      observeInput: () => (++samples === 1
        ? { state: "present" as const, text: "sentinel" }
        : { state: "absent" as const }),
    };
  };

  test("an idle Cursor seat injects instead of refusing", () => {
    const id = "probe-20260918T000000Z-u1genericb001";
    const r = withFrame("cursor-placeholder", "cursor-agent", () =>
      submitVerifyLocked("sess:0.0", id, deliveryWire(id), bound("cursor-agent"), fx()));
    expect(r.status).toBe("injected");
  });

  test("an idle Hermes seat injects instead of refusing", () => {
    const id = "probe-20260918T000000Z-u1genericb002";
    const r = withFrame("hermes-placeholder", "hermes", () =>
      submitVerifyLocked("sess:0.0", id, deliveryWire(id), bound("hermes"), fx()));
    expect(r.status).toBe("injected");
  });

  test("a typed Cursor draft stays refused with the draft text", () => {
    const id = "probe-20260918T000000Z-u1genericb003";
    const r = withFrame("cursor-typed", "cursor-agent", () =>
      submitVerifyLocked("sess:0.0", id, deliveryWire(id), bound("cursor-agent"), fx()));
    expect(r.status).toBe("band_busy");
    expect("bandText" in r && String(r.bandText)).toContain("ship the release notes");
  });
});
