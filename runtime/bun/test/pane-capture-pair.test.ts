// The reader must not DERIVE the plain view from the escaped one.
//
// `stripAnsi` strips CSI. An OSC 8 hyperlink wrapping the prompt row survives
// it, so a derived plain row stops starting with the glyph, the anchor misses,
// and the reader answers rc 3 (absent geometry, the direction the force bound
// may type over) where the incumbent returned the draft. Reproduced on a real
// tmux pane in review.
//
// The incumbent never derived: it took `capture-pane -p`, which tmux renders
// without emitting the hyperlink at all, and its own `tap_strip_ansi` is the
// SAME CSI-only regex. So the fix is paired capture, not a wider strip: a
// wider strip would differ from the incumbent in a new way and still leave
// DCS/APC/PM/SOS behind it.
//
// This drives the REAL reader over a REAL pane on a private server. A fixture
// cannot cover it: the whole point is what tmux puts in each of the two views.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { framePairIo, paneIo } from "../src/pane/reader";
import { stripAnsi } from "../src/pane/geometry";
import { pendingInputText } from "../src/pane/reader";

const ESC = "\u001b";

test("an OSC 8 hyperlink around the prompt row does not hide the draft", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "pair."));
  const sock = join(root, "s");
  const tm = (args: string[]) => spawnSync("tmux", ["-S", sock, ...args], { encoding: "utf8" });
  try {
    tm(["new-session", "-d", "-s", "p", "-x", "80", "-y", "10", "cat"]);
    // OSC 8 open, the prompt row, OSC 8 close: what a harness emits when it
    // renders a file link beside the composer.
    const osc = ESC + "]8;;https://example.com\u0007\u276f owner draft" + ESC + "]8;;\u0007";
    tm(["send-keys", "-t", "p", "-l", "--", osc]);
    tm(["send-keys", "-t", "p", "Enter"]);

    const read = pendingInputText(paneIo({ ...process.env, TMUX_TMPDIR: root, TAP_TMUX_SOCKET_PATH: sock }), "p", "codex");

    // The pane owner typed this. It must come back, not read as an empty band.
    expect(read.status).toBe("text");
    expect("text" in read && read.text).toContain("owner draft");
  } finally {
    tm(["kill-server"]);
    removeScratchTree(root);
  }
}, 20000);

// The test above proves the reader returns the draft. It does NOT prove it
// used the CAPTURED plain view rather than a derived one: a mutation that
// removes the length header only proves the framing is rejected
// (review). This is the control that discriminates.
//
// Both arms hand over a WELL-FORMED pair. They differ only in what the plain
// half contains: the real capture, or a CSI-derived reconstruction of the
// escaped one. If the reader ever goes back to deriving, the second arm starts
// agreeing with the first and this reds.
test("the CAPTURED plain view is what is read, not a CSI-derived reconstruction", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "pairctl."));
  const sock = join(root, "s");
  const tm = (args: string[]) => spawnSync("tmux", ["-S", sock, ...args], { encoding: "utf8" });
  try {
    tm(["new-session", "-d", "-s", "p", "-x", "80", "-y", "10", "cat"]);
    const osc = ESC + "]8;;https://example.com\u0007\u276f owner draft" + ESC + "]8;;\u0007";
    tm(["send-keys", "-t", "p", "-l", "--", osc]);
    tm(["send-keys", "-t", "p", "Enter"]);
    const cap = (escaped: boolean) =>
      tm(["capture-pane", "-J", "-p", ...(escaped ? ["-e"] : []), "-t", "p"]).stdout ?? "";
    const escaped = cap(true), plain = cap(false);

    // tmux emits the hyperlink only in the escaped view. If this ever stops
    // holding, the whole premise of the pair is gone and the test should say so.
    expect(escaped).toContain(ESC + "]8;");
    expect(plain).not.toContain(ESC + "]8;");

    const fromCapture = pendingInputText(framePairIo(escaped, plain, "80"), "p", "codex");
    const fromDerived = pendingInputText(framePairIo(escaped, stripAnsi(escaped), "80"), "p", "codex");

    expect(fromCapture.status).toBe("text");
    expect("text" in fromCapture && fromCapture.text).toContain("owner draft");
    // The derived view is exactly what the OSC defeats; it must NOT agree.
    expect(fromDerived.status).not.toBe(fromCapture.status);
  } finally {
    tm(["kill-server"]);
    removeScratchTree(root);
  }
}, 20000);
