import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { peekResult } from "../src/verbs/peek";
import { realBlockedSeams } from "../src/watch-blocked";
import { realSeams as evaluatorSeams } from "../src/watch-evaluator";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const scripts = join(root, "skills/tap/scripts");
const leaf = join(root, "runtime/bun/src/verbs/peek.ts");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) removeScratchTree(dir); });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tap-peek.")));
  scratch.push(dir);
  // Born live: an absent marker opens no legacy door, so the team is enrolled
  // and its bus is canonical at <root>/.tap/bus.
  const bus = join(dir, ".tap", "bus"), bin = join(dir, "bin"), index = join(dir, "index");
  for (const path of [bus, bin, index]) mkdirSync(path, { recursive: true });
  const registry = join(dir, ".tap", "team-registry.json"), calls = join(dir, "tmux.calls"), frame = join(dir, "frame");
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    fixture: { root: dir, registry_location: registry, state: "registered" },
  } }));
  const row = { status: "active", delivery: "pane", pane: "fixture/a:0.0", pane_id: "%1", session: "fixture/a",
    registered_at: "2026-09-01T00:00:00Z", server_epoch: "srv:4242:100", boot_id: "boot:1", harness: "claude" };
  const save = (patch: Record<string, unknown> = {}) => writeFileSync(registry, JSON.stringify({
    schema: "0.20", team: { name: "fixture", worktree_root: dir }, seats: { a: { ...row, ...patch } },
  }));
  save();
  writeFileSync(frame, "transcript café 🐎\n\n❯ private draft\n");
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PEEK_CALLS"
case "$1" in -L|-S) shift 2 ;; esac
target=""; prev=""
for a in "$@"; do [ "$prev" != -t ] || target="$a"; prev="$a"; done
case "$1" in
  list-sessions) if [ "\${PEEK_GONE:-}" = 1 ]; then printf 'fixture/other\\t4242:100\\t0\\n'; else printf 'fixture/a\\t4242:100\\t0\\n'; fi ;;
  list-panes) printf 'fixture/a\\tfixture/a:0.0\\t%s\\t%s\\t999\\t4242:100\\t0\\n' "\${PEEK_PANE_ID:-%1}" "\${PEEK_COMMAND:-claude}" ;;
  display-message)
    case "\${!#}" in
      '#{pane_id}') [ "$target" = gone ] || printf '%%1\\n' ;;
      '#{pane_current_command}') printf '%s\\n' "\${PEEK_COMMAND:-claude}" ;;
      '#{pane_pid}')
        [ "\${PEEK_PID_FORK_FAIL:-}" != 1 ] || { printf 'fork failed: Device not configured\\n' >&2; exit 1; }
        printf '999\\n' ;;
      '#{pane_width}') printf '80\\n' ;;
      '#{pid}:#{start_time}')
        if [ "\${PEEK_EPOCH_RACE:-}" = 1 ]; then
          n=0; [ ! -f "$PEEK_CALLS.epoch" ] || read -r n < "$PEEK_CALLS.epoch"
          printf '%s\\n' "$((n+1))" > "$PEEK_CALLS.epoch"
          printf '4242:%s\\n' "$((100+n))"
        else printf '4242:100\\n'; fi ;;
      '#{socket_path}') printf '/tmp/peek-fixture-socket\\n' ;;
    esac ;;
  capture-pane)
    [ "\${PEEK_CAPTURE_FAIL:-}" != 1 ] || { printf 'capture failed\\n' >&2; exit 1; }
    cat "$PEEK_FRAME" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir,
    TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_BOOT_ID: "boot:1", TAP_SERVER_EPOCH: "srv:4242:100",
    TAP_ONBOARDING_CHECKED: "1", TAP_INTERNAL_OVERDUE_CHECKED: "1", PEEK_FRAME: frame, PEEK_CALLS: calls };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_JSON", "TAP_PEEK_CONTEXT", "TAP_PEEK_JSON", "TAP_OBS_SESSION_SCOPE"]) delete env[key];
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const childEnv = { ...env, ...overrides };
    const r = spawnSync("bun", [leaf, ...args], { cwd: dir, env: childEnv, encoding: "utf8" });
    const result = { status: r.status, stdout: r.stdout, stderr: r.stderr };
    // Optional local comparison with the exact pre-deletion body; no historical runtime dependency.
    if (process.env.PEEK_TEST_REFERENCE && !overrides.PEEK_EPOCH_RACE) {
      const old = spawnSync("bash", [process.env.PEEK_TEST_REFERENCE, ...args], { cwd: dir, env: childEnv, encoding: "utf8" });
      if (args.at(-1) === "--pane" || (args.at(-2) === "--pane" && args.at(-1) === "")) {
        expect(result.status).toBe(old.status);
        expect(result.stdout).toBe(old.stdout);
        expect(result.stderr).toContain("--pane needs a value");
        expect(old.stderr).toContain("--pane needs a value");
      } else expect(result).toEqual({ status: old.status, stdout: old.stdout, stderr: old.stderr });
    }
    return result;
  };
  return { dir, bus, env, registry, calls, frame, save, run };
}

test("preserves native parser bytes, seats authority, draft stripping and no row learning", () => {
  const f = fixture(), before = readFileSync(f.registry, "utf8");
  const human = f.run(["a"]);
  expect(human.status).toBe(0);
  expect(human.stdout).toContain("input_state: other-text\n---\ntranscript café 🐎\n");
  expect(human.stdout).not.toContain("private draft");
  const json = f.run(["a", "--json"]);
  expect(json.status).toBe(0);
  expect(json.stderr).toBe("");
  expect(json.stdout).toContain("caf\\u00e9");
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, pane: "fixture/a:0.0", harness: "claude", input_state: "other-text" });
  expect(f.run(["a"], { TAP_JSON: "1", TAP_PEEK_JSON: "1" }).stdout).toBe(human.stdout);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(existsSync(join(f.bus, "payloads"))).toBe(true);
  expect(existsSync(join(f.bus, ".tap-bus-authority"))).toBe(true);
  f.save({ harness: "claude-extra" });
  expect(JSON.parse(f.run(["a", "--json"]).stdout).harness).toBe("claude");
  // Read-only lookup must not reject an unrelated numeric extension it will never rewrite.
  writeFileSync(f.registry, readFileSync(f.registry, "utf8").replace('"team":', '"extension":9007199254740993,"team":'));
  expect(f.run(["a"]).status).toBe(0);
});

test("an agents axis beside seats refuses old_store before any pane read", () => {
  const f = fixture();
  const hybrid = JSON.stringify({ ...JSON.parse(readFileSync(f.registry, "utf8")), agents: { a: { pane: "foreign" } } });
  writeFileSync(f.registry, hybrid);
  const json = f.run(["a", "--json"]);
  expect(json.status).toBe(1);
  expect(JSON.parse(json.stdout).error_class).toBe("old_store");
  expect(existsSync(f.calls) ? readFileSync(f.calls, "utf8") : "").not.toContain("capture-pane");
  expect(readFileSync(f.registry, "utf8")).toBe(hybrid);
});

test("a corrupt acting registry refuses registry_invalid; a missing one stays unregistered", () => {
  const f = fixture();
  writeFileSync(f.registry, '{"team":');
  const corrupt = f.run(["a", "--json"]);
  expect(corrupt.status).toBe(1);
  const doc = JSON.parse(corrupt.stdout);
  expect(doc.error_class).toBe("registry_invalid");
  expect(doc.detail).toContain(f.registry);
  // JSON-valid bytes that are not a registry object refuse the same way —
  // seatMap would silently answer "unregistered" for e.g. a truncated-to-[]
  // registry, sending the operator to tap register instead of tap doctor.
  writeFileSync(f.registry, "[]");
  const emptyArray = f.run(["a", "--json"]);
  expect(emptyArray.status).toBe(1);
  expect(JSON.parse(emptyArray.stdout).error_class).toBe("registry_invalid");
  // Positive control: the same fixture with readable bytes answers the seat
  // question instead of refusing — the mutant this test catches is the old
  // swallow, which reported the corrupt file as "unregistered".
  const control = fixture();
  expect(control.run(["absent", "--json"]).stdout).toContain('"error_class":"unregistered"');
  // A missing registry never reaches the row read: context resolution refuses
  // it earlier (unanchored_bus), so the fresh-team decision point here is
  // unreachable by construction.
});

test("argument and identity refusals keep their codes and JSON channel", () => {
  const f = fixture();
  for (const [args, cls] of [[[], "usage_error"], [["a", "b"], "usage_error"], [["a/b"], "usage_error"], [["--bad"], "unknown_option"]] as const) {
    const r = f.run(["--json", ...args]);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).error_class).toBe(cls);
  }
  for (const args of [["--json", "a", "--pane"], ["--json", "a", "--pane", ""]]) {
    const r = f.run(args);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--pane needs a value");
  }
  expect(f.run(["absent", "--json"]).stdout).toContain('"error_class":"unregistered"');
  f.save({ status: "retired" });
  expect(f.run(["a", "--json"]).stdout).toContain('"error_class":"unregistered"');
  f.save({ status: null });
  expect(f.run(["a", "--json"]).stdout).toContain('"error_class":"unregistered"');
  for (const patch of [{ session: ["fixture/a"] }, { pane_id: ["%1"] }]) {
    f.save(patch);
    expect(f.run(["a", "--json"]).status).not.toBe(0);
  }
  f.save({ status: "suspended", status_reason: "server_restarted", pane: "", pane_id: "" });
  expect(f.run(["a", "--json"], { PEEK_GONE: "1" }).stdout).toContain('"error_class":"pane_unproven"');
  f.save({ pane: "", pane_id: "" });
  expect(f.run(["a", "--json"]).stdout).toContain("designated_pane_missing");
  f.save();
  const recycled = f.run(["a", "--json"], { PEEK_PANE_ID: "%2" });
  expect(recycled.status).toBe(1);
  expect(recycled.stdout).toContain('"error_class":"pane_recycled"');
  const gone = f.run(["a", "--json"], { PEEK_GONE: "1" });
  expect(gone.status).toBe(3);
  expect(gone.stdout).toContain("tap session resume a");
  expect(readFileSync(f.calls, "utf8")).not.toContain("capture-pane");
});

test("explicit pane bypasses the row guard and rejects gone targets and capture failures", () => {
  const f = fixture();
  f.save({ status: "retired" });
  expect(f.run(["a", "--pane", "%1"]).status).toBe(0);
  expect(f.run(["a", "--pane", "gone", "--json"]).status).toBe(3);
  const failed = f.run(["a", "--pane", "%1"], { PEEK_CAPTURE_FAIL: "1" });
  expect(failed.status).toBe(1);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("slice_failed");
  // Explicit targets retain the direct leaf's no-registry exception.
  unlinkSync(f.registry);
  expect(f.run(["a", "--pane", "%1"]).status).toBe(0);
  expect(existsSync(join(f.bus, "payloads"))).toBe(false);
});

// Post-merge review catch: peek only observes. An exhausted
// courier submit-rate bucket must not turn a live pane into pane_gone or a
// capture into slice_failed, as it never did through tmux_deadline.py.
test("an exhausted tmux submit-rate bucket does not fail a read-only peek", () => {
  const f = fixture();
  const socket = join(f.dir, "sock");
  const cache = join(f.dir, "index", "runtime-cache");
  mkdirSync(cache, { recursive: true });
  const key = createHash("sha256").update(socket).digest("hex");
  writeFileSync(join(cache, `tmux-rate-${key}.json`), JSON.stringify({ tokens: 0, at: Date.now() + 3_600_000 }));
  const r = f.run(["a", "--pane", "%1"], { TAP_TMUX_SOCKET_PATH: socket });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("transcript café");
  // Review catch: the context read's before/after epoch
  // probes are peek observations too, and an unpinned epoch reaches tmux.
  f.save({ harness: "codex" });
  writeFileSync(f.frame, "transcript\nContext 70% left\n");
  for (const args of [["a"], ["a", "--pane", "%1"]]) {
    expect(f.run(args, { TAP_TMUX_SOCKET_PATH: socket, TAP_PEEK_CONTEXT: "1", PEEK_COMMAND: "codex", TAP_SERVER_EPOCH: undefined }))
      .toEqual({ status: 0, stdout: "30\n", stderr: "" });
  }
});

// Post-merge review catch: the pane-pid read only refines an
// unsupported shallow command; when it cannot run, the shallow family stands.
test("a pane-pid read that cannot run keeps the shallow harness instead of failing peek", () => {
  const f = fixture();
  f.save({ harness: "" });
  const r = f.run(["a"], { PEEK_COMMAND: "node", PEEK_PID_FORK_FAIL: "1" });
  expect(r.stderr).not.toContain("ServerUnresponsive");
  expect(r.status).toBe(0);
});

test("context reads retain raw capture, resolved pane id, unknown gauge, and epoch fences", () => {
  const f = fixture();
  f.save({ harness: "codex" });
  writeFileSync(f.frame, "transcript\nContext 70% left\n");
  const context = { TAP_PEEK_CONTEXT: "1", PEEK_COMMAND: "codex" };
  expect(f.run(["a"], context)).toEqual({ status: 0, stdout: "30\n", stderr: "" });
  expect(readFileSync(f.calls, "utf8")).toContain("capture-pane -t %1 -p");
  writeFileSync(f.frame, "no gauge\n");
  expect(f.run(["a"], context).stdout).toBe("");
  expect(f.run(["a"], { ...context, PEEK_CAPTURE_FAIL: "1" }).status).toBe(1);
  expect(f.run(["a"], { ...context, TAP_SERVER_EPOCH: "" }).status).toBe(1);
  const changed = { ...context, TAP_SERVER_EPOCH: undefined, PEEK_EPOCH_RACE: "1" };
  expect(f.run(["a", "--pane", "%1"], changed).status).toBe(1);
});

test("watcher result and both real consumers preserve supplied bus/env and output policy", () => {
  const f = fixture();
  // A caller bus distinct from the test process's ambient bus. Process globals must stay unchanged.
  f.env.TAP_SPOOL_HOME_AUTHORITY_MARKER = ".custom-authority";
  const before = { ...process.env };
  const result = peekResult("a", scripts, f.env);
  expect(result.status).toBe(0);
  expect(existsSync(join(f.bus, ".custom-authority"))).toBe(false);
  expect(existsSync(join(f.bus, ".tap-bus-authority"))).toBe(true);
  const args = { bus: f.bus, registry: f.registry, scripts, now: "1", env: { ...f.env, TAP_HOME: "/wrong-bus" } };
  expect(realBlockedSeams(args).peek("a")).toBe(result.stdout);
  const body = Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\n");
  writeFileSync(f.frame, `${body}\n❯ \n`);
  const long = peekResult("a", scripts, f.env).stdout;
  const lines = long.split("\n");
  if (lines.at(-1) === "") lines.pop();
  expect(evaluatorSeams(args).transcripts()).toBe(`## a\n${lines.slice(-80).join("\n")}\n\n`);
  const bad = { ...args, env: { ...args.env, PEEK_CAPTURE_FAIL: "1" } };
  expect(realBlockedSeams(bad).peek("a")).toBe("");
  expect(evaluatorSeams(bad).transcripts()).toBe("## a\nunavailable\n\n");
  // JSON failures have stdout even at nonzero status: blocked keeps it, evaluator tails it then marks unavailable.
  const jsonEnv = { ...bad.env, PEEK_CAPTURE_FAIL: "", PEEK_GONE: "1", TAP_JSON: "1" };
  const refused = peekResult("a", scripts, { ...jsonEnv, TAP_HOME: f.bus });
  expect(refused.status).toBe(3);
  expect(realBlockedSeams({ ...args, env: jsonEnv }).peek("a")).toBe(refused.stdout);
  expect(evaluatorSeams({ ...args, env: jsonEnv }).transcripts()).toBe(`## a\n${refused.stdout}unavailable\n\n`);
  expect(process.env).toEqual(before);
});
