// tap-yk8it: a tmux server that stops answering is a repeatable refusal only
// before `tap send` places anything or touches the pane. The reminder watcher
// re-attempts exactly that refusal; every later fence point keeps the untagged
// "outcome unknown" refusal and the row goes unresolved after one attempt.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flushScratch, teamFixture } from "./support/send-reply-flip-fixture";
import { OUTAGE_BACKOFF_SECONDS } from "../src/remind";

afterEach(() => flushScratch(), 40_000);

const REMIND = resolve(import.meta.dir, "../src/remind.ts");
const SCRIPTS = resolve(import.meta.dir, "../../../skills/tap/scripts");

type Hang = "all" | "copy-mode-cancel" | "after-placement" | "after-keys";

/**
 * Wrap the fixture's fake tmux so that, from the chosen fence point on, every
 * client call outlives the 0.5 s client deadline, as a server that has stopped
 * answering does.
 */
function hangFrom(fx: ReturnType<typeof teamFixture>, hang: Hang): NodeJS.ProcessEnv {
  const bin = join(fx.root, "bin");
  renameSync(join(bin, "tmux"), join(bin, "tmux.real"));
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
stall() { sleep 30; exit 1; }
[ -e "$HANG_ARMED" ] && stall
case "$HANG_MODE" in
  all) stall ;;
  copy-mode-cancel) case " $* " in *" -X cancel "*) : > "$HANG_ARMED"; stall ;; esac ;;
  after-placement) for f in "$HANG_RECEIPTS"/*.placed; do [ -e "$f" ] && { : > "$HANG_ARMED"; stall; }; done ;;
  after-keys) case " $* " in *" send-keys "*" -l "*) "$(dirname "$0")/tmux.real" "$@"; : > "$HANG_ARMED"; exit 0 ;; esac ;;
esac
exec "$(dirname "$0")/tmux.real" "$@"
`, { mode: 0o755 });
  if (hang === "copy-mode-cancel") writeFileSync(fx.env.FAKE_IN_MODE as string, "1");
  return { ...fx.env, HANG_MODE: hang, HANG_ARMED: join(fx.root, "hang-armed"),
    HANG_RECEIPTS: join(fx.bus, "receipts"), TAP_TMUX_TIMEOUT_SECONDS: "0.5" };
}

/** One watcher tick at t=100 against a one-shot reminder to `ub`, through the real `tap send`. */
function fireOnce(fx: ReturnType<typeof teamFixture>, env: NodeJS.ProcessEnv) {
  const watch = join(fx.bus, "watch");
  mkdirSync(watch, { recursive: true });
  const state = join(watch, "reminders.json");
  writeFileSync(join(watch, "arm.json"), JSON.stringify({ mode: "reminders-only", armed_at: 1, evaluator: "none", tick_interval_seconds: 60 }));
  writeFileSync(state, JSON.stringify({ r: { owner: "ua", to: "ub", body: "wake up", due_at: 100, every_seconds: 0, status: "scheduled" } }));
  const script = `const {fire}=await import(${JSON.stringify(REMIND)}); fire(${JSON.stringify(state)}, ${JSON.stringify(SCRIPTS)}, "1", 100);`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: fx.wt, env, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const row = JSON.parse(readFileSync(state, "utf8")).r;
  let refusal: unknown; try { refusal = JSON.parse(row.result); } catch { throw new Error(`non-JSON result: ${row.result}`); }
  return { row, refusal: refusal as Record<string, unknown> & { detail: string }, receipts: readdirSync(join(fx.bus, "receipts")).filter(name => name.startsWith(row.message_id)) };
}

test("a server silent from the first call refuses with effect none, places nothing, and the reminder waits out the outage", () => {
  const fx = teamFixture({});
  const { row, refusal, receipts } = fireOnce(fx, hangFrom(fx, "all"));
  expect(refusal).toMatchObject({ ok: false, error_class: "server_unresponsive", effect: "none" });
  expect(refusal.detail).toContain("refused before placement or any pane effect");
  expect(refusal.detail).not.toContain("outcome unknown");
  expect(receipts).toEqual([]);
  expect(existsSync(join(fx.bus, "payloads", `${row.message_id}.md`))).toBe(false);
  expect(row).toMatchObject({ status: "scheduled", due_at: 100 + OUTAGE_BACKOFF_SECONDS[0], retry_attempts: 1, exit_code: 1 });
  expect(row).not.toHaveProperty("notice");
}, 60_000);

for (const [hang, evidence] of [
  ["copy-mode-cancel", ["attempted"]],
  ["after-placement", ["placed"]],
  ["after-keys", ["attempted", "placed"]],
] as const) test(`a server that stops answering at ${hang} keeps the unknown-outcome refusal and is never re-attempted`, () => {
  const fx = teamFixture({});
  const env = hangFrom(fx, hang);
  const { row, refusal, receipts } = fireOnce(fx, env);
  expect(existsSync(env.HANG_ARMED as string)).toBe(true); // the fence point was reached
  expect(refusal).toMatchObject({ ok: false, error_class: "server_unresponsive", action: "inspect the server; do not retry a possible effect" });
  expect(refusal).not.toHaveProperty("effect");
  for (const suffix of evidence) expect(receipts).toContain(`${row.message_id}.${suffix}`);
  expect(row.status).toBe("unresolved");
  expect(row).not.toHaveProperty("retry_attempts");
  // The one notice to the owner went out (and, with the server still silent, failed).
  expect(row.notice).toMatchObject({ exit_code: 1 });
}, 60_000);
