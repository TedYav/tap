/**
 * Child-process probe for digest-window-verb.test.ts. It mocks only the
 * identity seams (calling pane, self, team selection: mock.module is
 * process-wide, so this never runs in the shared test process) and drives the
 * REAL public verb `cmdDigestWindow` (through the router's runNative, so a thrown
 * TapError renders as it does for an operator) against a scratch driver config.
 * Usage: bun digest-window-verb-probe.ts <ok|group-writable|bad-utf8|bad-toml|dotted-key|type-error>
 * (type-error: updateConfig throws a generic TypeError, which the verb must not label)
 * Prints one JSON result line.
 */
import { mock } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeScratchTree } from "../support/scratch";

const src = (p: string) => resolve(import.meta.dir, "../../src", p);
const context = await import(src("context.ts"));
const selection = await import(src("team-selection.ts"));
const override = await import(src("team-override.ts"));
const digestWindow = await import(src("digest-window.ts"));
const [mode = "ok"] = process.argv.slice(2);
mock.module(src("context.ts"), () => ({ ...context,
  callingPane: () => ({ status: "ok", paneId: "%1", session: "demo-sol", serverEpoch: "e1" }),
  resolveSelf: () => ({ handle: "sol", team: "demo", pane: "demo-sol:0.0", paneId: "%1" }) }));
mock.module(src("team-selection.ts"), () => ({ ...selection, resolveSelection: () => ({ team: "demo" }) }));
mock.module(src("team-override.ts"), () => ({ ...override, applyTeamOverride: () => {} }));
if (mode === "type-error") {
  mock.module(src("digest-window.ts"), () => ({ ...digestWindow, updateConfig: () => { throw new TypeError("x is not a function"); } }));
}
const { cmdDigestWindow } = await import(src("verbs/digest-window.ts"));
// The router renders a thrown TapError (human `; next:` line, or the JSON envelope under TAP_JSON=1).
const { runNative } = await import(resolve(import.meta.dir, "../../main.ts"));

const root = mkdtempSync(join(process.env.TAP_HOME!, "dw-verb-"));
const config = join(root, ".config/tap/config.toml");
mkdirSync(join(root, ".config/tap"), { recursive: true });
const initial: Buffer | string =
  mode === "bad-utf8" ? Buffer.from([0x5b, 0x64, 0xff, 0xfe, 0x5d, 0x0a])
  : mode === "bad-toml" ? "[delivery\n"
  : mode === "dotted-key" ? 'delivery.overrides."demo/sol".now_window_seconds = 5\n'
  : "[delivery]\nnow_window_seconds = 10\n";
writeFileSync(config, initial);
chmodSync(config, mode === "group-writable" ? 0o664 : 0o600);

const result: Record<string, unknown> = {};
let stderr = "", stdout = "";
const writeErr = process.stderr.write.bind(process.stderr), writeOut = process.stdout.write.bind(process.stdout);
process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
try {
  process.env.HOME = root;
  delete process.env.XDG_CONFIG_HOME;
  result.rc = runNative("digest-window", cmdDigestWindow, ["30"]);
} catch (error) {
  result.threw = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
} finally {
  process.stderr.write = writeErr;
  process.stdout.write = writeOut;
  result.stderr = stderr;
  result.stdout = stdout;
  result.unchanged = Buffer.compare(readFileSync(config), Buffer.isBuffer(initial) ? initial : Buffer.from(initial)) === 0;
  removeScratchTree(root);
}
process.stdout.write(`\n${JSON.stringify(result)}\n`);
