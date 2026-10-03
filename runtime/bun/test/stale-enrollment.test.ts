// tap-xbpuc: a worktree removed while its team is still enrolled leaves a
// stale root in the machine index. That team's problem must stay that team's:
// every other team's sends proceed, and the stale team gets a named refusal.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME / HOME / TAP_LOCK_DIR and a
// fake tmux on PATH. No real server is started.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enrolledSeatForObservedPane } from "../src/registry";
import { removeScratchTree } from "./support/scratch";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-stale-enrollment."));
afterAll(() => removeScratchTree(scratchRoot));

// Canonical `team/handle` sessions so pane anchoring can take its hint:
// alpha/ua (%6) sends, beta/rb (%7) receives, gamma/gx (%8) lost its worktree.
const FAKE_TMUX = `#!/bin/sh
pane_for() {
  case " $* " in
    *"%7"*|*"beta/rb"*) echo 7 ;;
    *"%8"*|*"gamma/gx"*) echo 8 ;;
    *) echo 6 ;;
  esac
}
sess_for() { case "$1" in 7) echo beta/rb ;; 8) echo gamma/gx ;; *) echo alpha/ua ;; esac; }
p=$(pane_for "$@"); s=$(sess_for "$p")
case " $* " in
  *"list-sessions"*) printf 'alpha/ua\\t123:456\\nbeta/rb\\t123:456\\ngamma/gx\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n%%8\\n' ;;
  *"list-panes"*) printf '%s\\t%s:0.0\\t%%%s\\tclaude\\t4242\\t123:456\\t0\\n' "$s" "$s" "$p" ;;
  *"#{pane_id}"*"#{session_name}"*) printf '%%%s\\t%s\\t4242\\tclaude\\t0\\n' "$p" "$s" ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*) printf '%s\\t123:456\\n' "$s" ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{session_name}"*) printf '%s\\n' "$s" ;;
  *"#{pane_current_command}"*) printf 'claude\\n' ;;
  *"#{pane_in_mode}"*) printf '0\\n' ;;
  *"#{pane_pid}"*) printf '4242\\n' ;;
  *"#{pane_dead}"*) printf '0\\n' ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*) printf '%%%s\\n' "$p" ;;
  *"capture-pane"*) printf '› \\n%s\\n' '──────────────────────────────────────────' ;;
  *"send-keys"*) printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
esac
exit 0
`;

interface Team { name: string; wt: string; bus: string; registry: string }

function team(root: string, name: string, handle: string, pane: string): Team {
  const wt = join(root, name);
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", wt]).exitCode).toBe(0);
  const seat = { status: "active", pane: `${name}/${handle}:0.0`, pane_id: pane, session: `${name}/${handle}`,
    server_epoch: "srv:123:456", instance: `${handle}|${name}`, harness: "claude" };
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name, worktree_root: wt }, seats: { [handle]: seat } })}\n`);
  return { name, wt, bus, registry };
}

function fixture(stale = true) {
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  mkdirSync(index); mkdirSync(bin);
  const alpha = team(root, "alpha", "ua", "%6");
  const beta = team(root, "beta", "rb", "%7");
  const gamma = team(root, "gamma", "gx", "%8");
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20",
    teams: Object.fromEntries([alpha, beta, gamma].map(t =>
      [t.name, { root: t.wt, registry_location: t.registry, state: "registered" }])),
  })}\n`);
  writeFileSync(join(bin, "tmux"), FAKE_TMUX, { mode: 0o755 });
  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  writeFileSync(socketPath, "socket\n");
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    OPENCODE_DB_PATH: join(root, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
    TAP_LOCK_DIR: join(root, "locks"),
    TAP_TMUX_SOCKET_PATH: socketPath,
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    FAKE_KEYS: join(root, "keys"),
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  // The wrong reaping order: gamma's worktree is gone, its enrollment is not.
  if (stale) removeScratchTree(gamma.wt);
  return { root, alpha, beta, gamma, env };
}

type Fx = ReturnType<typeof fixture>;

function run(fx: Fx, args: string[], opts: { cwd: string; self: string; pane?: string; bash?: boolean }) {
  const r = Bun.spawnSync([TAP, ...args, "--json"], {
    cwd: opts.cwd,
    env: { ...fx.env, TAP_SELF: opts.self, TAP_RUNTIME: opts.bash ? "bash" : "", ...(opts.pane ? { TMUX: `${fx.env.TAP_TMUX_SOCKET_PATH},1,0`, TMUX_PANE: opts.pane } : {}) },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const out = r.stdout.toString(), err = r.stderr.toString();
  let errorClass = "", next = "", detail = "";
  for (const line of [...out.split("\n"), ...err.split("\n")].filter(l => l.startsWith("{"))) {
    try {
      const doc = JSON.parse(line) as Record<string, string>;
      if (doc.status === "error" || doc.error_class) { errorClass = doc.error_class ?? ""; next = doc.next ?? doc.action ?? ""; detail = doc.detail ?? ""; }
    } catch { /* not a JSON line */ }
  }
  return { code: r.exitCode, errorClass, next, detail, out, err };
}

const payloads = (bus: string) => existsSync(join(bus, "payloads"))
  ? readdirSync(join(bus, "payloads")).filter(f => f.endsWith(".md")) : [];

const STALE_NEXT = "tap admin refresh   (purges enrolled teams whose acting registry file is gone)";

// The healthy teams' sends run to the same outcome with and without the stale
// third team, and each places its canonical. (The fake tmux never shows a
// submitted prompt, so both arms end submit-unverified after placement.)
for (const [name, target] of [["cross-team", "beta/rb"], ["same-team", "ua"]] as const) {
  test(`${name} send from a healthy team proceeds past a stale third team`, () => {
    const outcome = (stale: boolean) => {
      const fx = fixture(stale);
      const r = run(fx, ["send", target, "-m", `hello ${name}`], { cwd: fx.alpha.wt, self: "ua" });
      return { code: r.code, errorClass: r.errorClass, placed: payloads(fx.alpha.bus).length };
    };
    const control = outcome(false);
    expect(control.placed).toBe(1);
    expect(outcome(true)).toEqual(control);
  });
}

for (const door of ["native", "bash"] as const) {
  test(`a send to the stale team refuses stale_enrollment (${door} door), nothing placed`, () => {
    const fx = fixture(true);
    const r = run(fx, ["send", "gamma/gx", "-m", "hello gamma"], { cwd: fx.alpha.wt, self: "ua", bash: door === "bash" });
    expect({ code: r.code, errorClass: r.errorClass, next: r.next }).toEqual({ code: 1, errorClass: "stale_enrollment", next: STALE_NEXT });
    expect(r.detail).toContain("team 'gamma' is enrolled but its acting registry file is gone");
    expect(payloads(fx.alpha.bus)).toEqual([]);
  });
}

// An untraversable parent (EACCES) proves nothing about absence: both doors keep
// unreachable_team, whose remedy is repair, not a purge that would refuse it.
for (const door of ["native", "bash"] as const) {
  test(`an inaccessible registry is unreachable, not stale (${door} door)`, () => {
    const fx = fixture(false);
    const tapDir = join(fx.gamma.wt, ".tap");
    chmodSync(tapDir, 0o000);
    try {
      const r = run(fx, ["send", "gamma/gx", "-m", "hello gamma"], { cwd: fx.alpha.wt, self: "ua", bash: door === "bash" });
      expect({ code: r.code, errorClass: r.errorClass }).toEqual({ code: 1, errorClass: "unreachable_team" });
      expect(payloads(fx.alpha.bus)).toEqual([]);
    } finally {
      chmodSync(tapDir, 0o755);
    }
  });
}

// Pane identity is resolved over the whole machine enrollment. The observation
// itself needs a real pane ancestry, so the resolver is exercised directly.
test("pane identity: the stale team vetoes no one and refuses only its own panes", () => {
  const fx = fixture(true);
  const index = fx.env.TAP_INDEX_HOME!;
  const alpha = enrolledSeatForObservedPane("%6", "alpha/ua", "srv:123:456", index);
  expect(alpha).toMatchObject({ kind: "resolved", team: "alpha", handle: "ua" });
  const gamma = enrolledSeatForObservedPane("%8", "gamma/gx", "srv:123:456", index);
  expect(gamma).toMatchObject({ kind: "unverified", verdict: "stale_enrollment" });
  // An unreadable (present but corrupt) registry still leaves uniqueness unproven.
  writeFileSync(fx.beta.registry, "{not json");
  expect(enrolledSeatForObservedPane("%6", "alpha/ua", "srv:123:456", index))
    .toMatchObject({ kind: "unverified", verdict: "unknown" });
});
