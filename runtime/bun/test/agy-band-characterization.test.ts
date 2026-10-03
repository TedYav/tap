// tap-lwgid: saved Antigravity captures must reach the native readiness seam.
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyPane, paneState } from "../src/pane-state";
import { pendingInputText, realPaneIo } from "../src/pane/reader";
import { agyComposer, agyPermissionOverlay } from "../src/submit-frame";
import { promptGlyphRe, promptLineRe } from "../src/tmux";

// The same real captures the Bash arms use — one corpus, two implementations, so a
// shape that fools one is measurable against the other. Provenance (pane, seat,
// state, capture time, the one redaction) is in that directory's PROVENANCE.md.
const CAPTURES = join(
  import.meta.dir,
  "../../../skills/tap/scripts/smoke/fixtures/agy-capture-20260903",
);
const capture = (name: string): string => readFileSync(join(CAPTURES, `${name}.txt`), "utf8");

let root: string;
let savedPath: string | undefined;
let savedSocket: string | undefined;
let savedFixture: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-agy-char-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // capture-pane returns whatever file TAP_AGY_FIXTURE names. Any other argv is a
  // loud failure rather than an empty string: a fake that answers everything with ""
  // turns "the code called something unexpected" into "the band was empty".
  writeFileSync(
    join(bin, "tmux"),
    `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    *pane_in_mode*) printf '0\\n'; exit 0 ;;
    *pane_current_command*) printf '%s\\n' $'%1\\tagy-fixture\\t1234\\tagy\\t0'; exit 0 ;;
    *start_time*) printf '1:1\\n'; exit 0 ;;
  esac
  if [ "$a" = capture-pane ]; then
    n="$((\$(cat '${root}/captures.count' 2>/dev/null || echo 0) + 1))"
    printf '%s' "$n" > '${root}/captures.count'
    if [ -n "\${TAP_AGY_FAIL_CAPTURE:-}" ] && [ "$n" = "\${TAP_AGY_FAIL_CAPTURE}" ]; then exit 1; fi
    cat "\${TAP_AGY_FIXTURE:?agy-band-characterization: TAP_AGY_FIXTURE unset}"; exit 0
  fi
done
echo "agy-band-characterization: unexpected tmux argv: $*" >&2
exit 1
`,
  );
  chmodSync(join(bin, "tmux"), 0o755);
  savedPath = process.env.PATH;
  savedSocket = process.env.TAP_TMUX_SOCKET;
  savedFixture = process.env.TAP_AGY_FIXTURE;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.TAP_TMUX_SOCKET = "tapbun-agy-characterization";
});

afterAll(() => {
  // This file owns `root` outright — it created it with mkdtempSync and nothing
  // outside it writes there — so removing it is not a pattern-keyed cleanup.
  rmSync(root, { recursive: true, force: true });
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (savedSocket === undefined) delete process.env.TAP_TMUX_SOCKET;
  else process.env.TAP_TMUX_SOCKET = savedSocket;
  if (savedFixture === undefined) delete process.env.TAP_AGY_FIXTURE;
  else process.env.TAP_AGY_FIXTURE = savedFixture;
});

/** Real readiness, including live observation and the harness routing branch. */
function bandFor(name: string): ReturnType<typeof paneState> {
  process.env.TAP_AGY_FIXTURE = join(CAPTURES, `${name}.txt`);
  return paneState("%1", "agy", "agy");
}

describe("agy native readiness (tap-lwgid)", () => {
  test("the fake feeds readiness the fixture bytes; missing glyph refuses", () => {
    expect(bandFor("idle-243").state).toBe("ready");
    const noGlyph = join(root, "no-glyph.txt");
    writeFileSync(noGlyph, "no prompt glyph anywhere in this pane\n");
    process.env.TAP_AGY_FIXTURE = noGlyph;
    expect(paneState("%1", "agy", "agy").state).toBe("unobservable");
  });
  test("classifyPane recognizes agy geometry", () => {
    expect(classifyPane(capture("idle-243"), "agy", false)).toEqual({ kind: "ready" });
  });
  test("promptGlyphRe knows agy's '>'", () => {
    expect(promptGlyphRe("agy")).toBe(">");
    expect(promptLineRe("agy").test("> ")).toBe(true);
    expect(promptLineRe("agy").test("──────────")).toBe(false);
  });
  test("idle agy composer is ready", () => {
    expect(bandFor("idle-243")).toEqual({ state: "ready" });
  });
  test("tool-running composer is ready", () => {
    expect(bandFor("tool-running-254")).toEqual({ state: "ready" });
  });
  test("idle composer with a running background task is ready", () => {
    expect(bandFor("task-idle-footer-228")).toEqual({ state: "ready" });
  });
  test("the tap-92v3r incident captures: generating stays injectable and is not a modal", () => {
    // Ruling (tap-7r3fn.13): a generating agy pane queues input and must
    // never be spooled; the only hold left standing is a visible modal. The
    // task-card capture is the exact pane the courier declared unreachable.
    expect(bandFor("generating-243")).toEqual({ state: "ready" });
    expect(bandFor("generating-taskcard-243")).toEqual({ state: "ready" });
    expect(agyPermissionOverlay(capture("generating-243"))).toBe(false);
    expect(agyPermissionOverlay(capture("generating-taskcard-243"))).toBe(false);
  });
  test("real draft is busy with only its input text", () => {
    const got = bandFor("draft-262");
    expect(got.state).toBe("busy");
    expect(got.state === "busy" && got.text).toContain("[[TAP");
    expect(got.state === "busy" && got.text).not.toContain("Gemini 3.8 Flash");
    expect(got.state === "busy" && got.text).not.toContain("─");
  });
  test("all four saved captures have observable composers", () => {
    for (const name of ["idle-243", "tool-running-254", "task-idle-footer-228", "draft-262", "generating-243", "generating-taskcard-243"]) {
      expect(bandFor(name).state).not.toBe("unobservable");
    }
  });
});

// Constructed modal controls: fleet seats disable permission prompts. The saved
// real corpus supplies the band; tap-lslrc still owns real modal validation.
const modalRows = "Requesting permission for: run_shell_command\nDo you want to proceed?";
const modal = () => capture("idle-243") + "\n" + modalRows;

test("native/Bash modal parity retains positional, task-card and window guards", () => {
  const empty = capture("idle-243");
  const cases: [string, boolean][] = [
    [modal(), true],
    [empty + "\nRequesting permission for: tool; Do you want to proceed?", true],
    [empty + "\nREQUESTING PERMISSION FOR: tool\nDO YOU WANT TO PROCEED?", true],
    [empty + "\nRequesting permission for: tool\n" + "● [23:41:02] task running\n".repeat(6) + "Do you want to proceed?", false],
    [empty + "\nRequesting permission for: tool\nTab amend", true],
    [modalRows + "\n" + empty, false],
    [empty + '\n● [23:41:02] echo "Requesting permission for: tool" running\n○ [23:41:03] grep "Do you want to proceed?" running', false],
    [empty + "\nDo you want to proceed?\nRequesting permission for: tool", false],
    [empty + "\nRequesting permission for: tool" + "\n".repeat(7) + "Do you want to proceed?", false],
    [empty + "\nRequesting permission for: tool" + "\n".repeat(6) + "Do you want to proceed?", true],
    [empty + "\n● [23:41:02] normal task running\n" + modalRows, true],
    ["no band\n" + modalRows, false],
  ];
  for (const [frame, blocked] of cases) {
    expect(agyPermissionOverlay(frame)).toBe(blocked);
    const got = classifyPane(frame, "agy", false);
    if (blocked) expect(got).toEqual({ kind: "no-band", reason: "Antigravity permission overlay is visible" });
    else if (frame.startsWith("no band")) expect(got.kind).toBe("no-band");
    else expect(got.kind).toBe("ready");
  }
});

test("courier reaches injection only for empty composers, never a draft or modal", () => {
  for (const name of ["idle-243", "tool-running-254", "task-idle-footer-228", "draft-262", "modal", "generating-243", "generating-taskcard-243"]) {
    const frame = name === "modal" ? modal() : capture(name);
    const fixture = join(root, "effect.txt");
    writeFileSync(fixture, frame);
    process.env.TAP_AGY_FIXTURE = fixture;
    let injections = 0, enters = 0;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", panePid: "1234", currentCommand: "agy" }),
      paneState,
      harnessEvidence: () => "alive",
      injectText: () => { injections++; return true; },
      inputHasId: () => true,
      pressEnter: () => { enters++; return true; }, settle: () => {},
      submitFrame: () => ({ state: enters ? "empty" : "staged", mode: "idle", width: "80" }),
    };
    const blocked = name === "draft-262" || name === "modal";
    expect(submitVerifyLocked("%1", "agy-effect", "[[TAP v0.23 ask agy-effect]]", { paneId: "%1", serverEpoch: "srv:1:1", harness: "agy" }, fx).status).toBe(blocked ? "band_busy" : "injected");
    expect(injections).toBe(blocked ? 0 : 1);
    expect(enters).toBe(blocked ? 0 : 2);
  }
});

// An unreadable read is not an absent box. The pane's bytes carry a visible
// agy composer, but two claims are pinned separately here. The reader guard:
// pendingInputText's own failed capture answers no-band, never an empty
// composer. The courier behavior: a failed capture among the courier's reads
// (measured: its own band re-read, not the pending reader) holds it — no
// injection, no enter. busy:noprompt (nothing was readable) stays distinct
// from busy:pending (typed text occupies the band).
test("a failed pending read answers no-band; a failed capture holds the courier off the agy box", () => {
  const fixture = join(root, "effect.txt");
  writeFileSync(fixture, capture("idle-243"));
  process.env.TAP_AGY_FIXTURE = fixture;
  // The box IS on the pane: the same bytes a healthy read would parse.
  expect(agyComposer(capture("idle-243"))).not.toBeNull();
  // The guard itself: pendingInputText's failed capture is no-band (an absent
  // answer), never an empty composer — a reader that degrades the failed
  // capture to "" turns an unreadable pane into "ready to type".
  rmSync(join(root, "captures.count"), { force: true });
  process.env.TAP_AGY_FAIL_CAPTURE = "1";
  expect(pendingInputText(realPaneIo, "%1", "agy")).toEqual({ status: "no-band" });
  // A failed capture anywhere in the courier's reads holds it: no injection,
  // no enter.
  rmSync(join(root, "captures.count"), { force: true });
  process.env.TAP_AGY_FAIL_CAPTURE = "2"; // the courier's band re-read; the first read stays healthy
  let injections = 0, enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", panePid: "1234", currentCommand: "agy" }),
    paneState,
    harnessEvidence: () => "alive",
    injectText: () => { injections++; return true; },
    inputHasId: () => true,
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => ({ state: "empty", mode: "idle", width: "80" }),
  };
  try {
    const verdict = submitVerifyLocked("%1", "agy-noband", "[[TAP v0.23 ask agy-noband]]", { paneId: "%1", serverEpoch: "srv:1:1", harness: "agy" }, fx);
    expect(verdict.status, "the courier injected through a failed pane capture").not.toBe("injected");
    expect(injections).toBe(0);
    expect(enters).toBe(0);
  } finally {
    delete process.env.TAP_AGY_FAIL_CAPTURE;
  }
});
