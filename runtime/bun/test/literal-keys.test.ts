import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { injectText, literalKeysArg } from "../src/tmux";
import { controlChunkLanded, controlPayloadChunks } from "../src/slices/control-payload";

// tmux's argv parser strips a FINAL ';' from a send-keys argument (exit 0,
// silent), so the byte never reaches the pane. tap-k59hc: a compact focus
// chunk ending on ';' at its 250-byte boundary was delivered one byte short
// and the per-chunk contiguity check refused — correctly. These tests pin the
// escaping helper, the real delivery through the production `injectText`, and
// the refusal side: a genuinely missing byte must still fail the check.

test("literalKeysArg escapes exactly a trailing semicolon", () => {
  expect(literalKeysArg("a;")).toBe("a\\;");
  expect(literalKeysArg(";")).toBe("\\;");
  expect(literalKeysArg("a;;")).toBe("a;\\;");
  expect(literalKeysArg("a\\;")).toBe("a\\\\;");
  expect(literalKeysArg("a;b")).toBe("a;b");
  expect(literalKeysArg("plain")).toBe("plain");
  expect(literalKeysArg("")).toBe("");
  expect(literalKeysArg("trail\\")).toBe("trail\\");
});

test("a render missing its final semicolon still fails the chunk check", () => {
  const typed = "/compact alpha (l1-o1 beta);";
  const chunk = typed.slice("/compact ".length);
  const short = "/compact alpha (l1-o1 beta)";
  expect(controlChunkLanded("claude", typed, typed, chunk).ready).toBe(true);
  expect(controlChunkLanded("claude", short, typed, chunk).ready).toBe(false);
});

if (process.env.TMUX_TMPDIR) {
  // Live delivery on the runner's private socket, through the production seam.
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR, "literal-keys."));
  const socket = join(root, "s");
  const T = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  // Keyed by the real names: afterAll restores process.env[key] for each.
  const prior = { TMUX: process.env.TMUX, TAP_TMUX_SOCKET_PATH: process.env.TAP_TMUX_SOCKET_PATH, TAP_TMUX_SOCKET: process.env.TAP_TMUX_SOCKET };
  process.env.TMUX = `${socket},0,0`;
  process.env.TAP_TMUX_SOCKET_PATH = socket;
  delete process.env.TAP_TMUX_SOCKET;

  test("the private server and a no-echo cat pane exist", () => {
    expect(T("new-session", "-d", "-x", "320", "-y", "40", "sh", "-c", "stty -echo; exec cat -v").status).toBe(0);
  });

  const newPane = async (): Promise<string> => {
    const id = T("new-window", "-d", "-P", "-F", "#{pane_id}", "sh", "-c", "stty -echo; exec cat -v");
    expect(id.status).toBe(0);
    // sh must reach stty before the first keystroke lands, or the tty echoes a
    // second copy of the delivery.
    await Bun.sleep(300);
    return id.stdout.trim();
  };

  test("injectText delivers a trailing semicolon byte-exact (tmux 3.7c strip regression)", async () => {
    const pane = await newPane();
    const cases = ["a;", ";;", " ;", "a;", "x/#999 aa;", "a\\;"];
    for (const text of cases) {
      expect(injectText(pane, text)).toBe(true);
      T("send-keys", "-t", pane, "-l", "--", "\n");
    }
    const rows = T("capture-pane", "-t", pane, "-p").stdout.split("\n").map(row => row.replace(/\s+$/, ""));
    expect(rows.slice(0, cases.length)).toEqual(cases);
    T("kill-window", "-t", pane);
  });

  test("a control chunk boundary landing on ';' delivers whole", async () => {
    const pane = await newPane();
    const focus = "a".repeat(249) + ";" + "b".repeat(60) + " tail";
    const chunks = controlPayloadChunks(focus);
    expect(chunks[0]!.endsWith(";")).toBe(true);
    for (const chunk of chunks) {
      expect(injectText(pane, chunk)).toBe(true);
      T("send-keys", "-t", pane, "-l", "--", "\n");
    }
    const rows = T("capture-pane", "-t", pane, "-p").stdout.split("\n").map(row => row.replace(/\s+$/, ""));
    expect(rows.slice(0, chunks.length)).toEqual(chunks);
    T("kill-window", "-t", pane);
  });

  afterAll(() => {
    T("kill-server");
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
} else {
  test.skip("live tmux delivery needs the runner's TMUX_TMPDIR", () => {});
}
