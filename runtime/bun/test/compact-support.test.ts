import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compactNoActor, compactObservedRow } from "../src/compact-support";
import { resolveSelf, TapError, type Context } from "../src/context";
import { Bus } from "../src/bus";
import { removeScratchTree } from "./support/scratch";

const scratch = mkdtempSync(join(process.env.TAP_HOME!, "compact-support-"));
afterAll(() => removeScratchTree(scratch));
let serial = 0;
function fixture() {
  const dir = join(scratch, String(++serial)), index = join(dir, "index"), bus = new Bus(join(dir, ".tap/bus"));
  mkdirSync(index, { recursive: true }); mkdirSync(bus.home, { recursive: true });
  const registryPath = join(dir, ".tap/team-registry.json");
  const seats = { owner: { status: "active", pane: "fixture/owner:0.0", pane_id: "%5", session: "fixture/owner", server_epoch: "srv:2:2" } };
  writeFileSync(registryPath, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root: dir, registry_location: registryPath, state: "registered" } } }));
  const ctx: Context = { bus, registryPath, team: "fixture", root: dir, busRule: "dotdir" };
  return { dir, index, registryPath, seats, ctx, env: { ...process.env, TAP_INDEX_HOME: index, TAP_HOME: bus.home } };
}
function refusal(body: () => unknown): TapError {
  try { body(); } catch (error) { if (error instanceof TapError) return error; throw error; }
  throw new Error("expected refusal");
}
const caller = { state: "inside" as const, paneId: "%5", session: "fixture/owner", serverEpoch: "srv:2:2" };

test("no actor keeps a local registration remedy and only the selected old-store refusal", () => {
  const f = fixture();
  const current = refusal(() => compactNoActor(caller, f.registryPath));
  expect(current.errorClass).toBe("no_actor"); expect(current.action).toBe("run 'tap register' to join this team");
  const stale = refusal(() => compactNoActor({ ...caller, serverEpoch: "srv:3:3" }, f.registryPath));
  expect(stale.action).toBe("run 'tap register' to join this team");
  writeFileSync(f.registryPath, JSON.stringify({ team: { name: "fixture" }, agents: f.seats }));
  const old = refusal(() => compactNoActor(caller, f.registryPath));
  expect(old.errorClass).toBe("old_store"); expect(old.detail).toContain(f.registryPath);
  expect(old.action).not.toContain("tap register");
  const unseen = refusal(() => compactNoActor({ state: "unobservable", refusal: "no controlling tty" }, f.registryPath));
  expect(unseen.errorClass).toBe("no_actor"); expect(unseen.detail).toContain("no controlling tty");
});

test("no-actor remedy ignores a foreign current seat and foreign old store", () => {
  const f = fixture(), foreign = fixture();
  writeFileSync(f.registryPath, JSON.stringify({schema:"0.20", team:{name:"fixture"}, seats:{}}));
  const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8"));
  index.teams.foreign = {root:foreign.dir, registry_location:foreign.registryPath, state:"registered"};
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(index));
  const entry = join(f.dir, "remedy.ts");
  writeFileSync(entry, `import { compactNoActor } from ${JSON.stringify(resolve(import.meta.dir, "../src/compact-support.ts"))};
try { compactNoActor(${JSON.stringify(caller)}, ${JSON.stringify(f.registryPath)}); }
catch (e: any) { console.log(JSON.stringify({error:e.errorClass, action:e.action, detail:e.detail})); }`);
  for (const population of ["seats", "agents"]) {
    writeFileSync(foreign.registryPath, JSON.stringify({schema:"0.20", team:{name:"foreign"}, [population]:foreign.seats}));
    const result = spawnSync(process.execPath, [entry], {cwd:f.dir, encoding:"utf8", env:f.env});
    expect(result.status).toBe(0);
    const reply = JSON.parse(result.stdout);
    expect(reply.error).toBe("no_actor");
    expect(reply.action).toBe("run 'tap register' to join this team");
    expect(result.stdout).not.toContain(foreign.dir);
    expect(result.stdout).not.toContain("foreign");
  }
});

test("native self identity refuses stale, unknown, malformed and unstamped observations", () => {
  const f = fixture(), observation = { status: "ok" as const, ...caller };
  expect(resolveSelf(f.ctx, observation, 1, f.env).handle).toBe("owner");
  expect(refusal(() => resolveSelf(f.ctx, { ...observation, serverEpoch: "srv:3:3" }, 1, f.env)).errorClass).toBe("unregistered");
  for (const obs of [{ status: "unverifiable" as const, paneId: "%5" }, { ...observation, serverEpoch: "" }, { ...observation, paneId: "%bad" }]) {
    expect(() => resolveSelf(f.ctx, obs, 1, f.env)).toThrow();
  }
  writeFileSync(f.registryPath, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { owner: { ...f.seats.owner, server_epoch: "" } } }));
  expect(refusal(() => resolveSelf(f.ctx, observation, 1, f.env)).errorClass).toBe("unregistered");
  expect(() => resolveSelf(f.ctx, { status: "unverifiable", paneId: "%5" }, 1, f.env)).toThrow();
});

test("attention stays on stderr under JSON, preserves next, and honors NO_COLOR presence", () => {
  const f = fixture(), entry = join(f.dir, "attention.ts");
  writeFileSync(entry, `import { attention } from ${JSON.stringify(resolve(import.meta.dir, "../src/compact-support.ts"))}; attention("command", "degraded", "wake missed", "tap send");`);
  const result = spawnSync(process.execPath, [entry], { encoding: "utf8", env: { ...f.env, TAP_JSON: "1", NO_COLOR: "", CLICOLOR_FORCE: "1", TERM: "xterm" } });
  expect(result.status).toBe(0); expect(result.stdout).toBe("");
  expect(result.stderr).toBe("tap command: degraded: wake missed; next: tap send\n");
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "tput"), '#!/bin/sh\nprintf "<%s:%s>" "$1" "${2:-}"\n', { mode: 0o755 });
  const coloredEnv: NodeJS.ProcessEnv = { ...f.env, PATH: `${bin}:${process.env.PATH}`, CLICOLOR_FORCE: "1", TERM: "xterm" };
  delete coloredEnv.NO_COLOR;
  const colored = spawnSync(process.execPath, [entry], { encoding: "utf8", env: coloredEnv });
  expect(colored.status).toBe(0); expect(colored.stderr).toBe("tap command: <setaf:3>degraded<sgr0:>: wake missed; next: tap send\n");
});

test("pane census refuses an old-format claimed population rather than reporting vacuous success", () => {
  const f = fixture();
  writeFileSync(f.registryPath, JSON.stringify({ team: { name: "fixture" }, agents: f.seats }));
  const result = spawnSync("bash", [resolve(import.meta.dir, "../../../scripts/pane-identity-census.sh")], {
    encoding: "utf8", env: { ...f.env, _TAP_SCRIPT_DIR: resolve(import.meta.dir, "../../../skills/tap/scripts") },
  });
  expect(result.status).toBe(1); expect(result.stdout).not.toContain("PASS:");
  expect(result.stderr).toContain("old TAP registry format");
});

test("compact in an unenrolled sibling refuses before creating a split audit bus", () => {
  const f = fixture(), primary = join(f.dir, "primary"), sibling = join(f.dir, "sibling"), bin = join(f.dir, "bin");
  mkdirSync(primary); mkdirSync(bin);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { encoding: "utf8", env: f.env });
    if (result.status) throw new Error(result.stderr);
  };
  git(["init", "-q", primary]);
  git(["-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  git(["-C", primary, "worktree", "add", "--detach", sibling]);
  const bus = join(primary, ".tap/bus"), registry = join(primary, ".tap/team-registry.json");
  mkdirSync(bus, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    lead: { status: "active", delivery: "pane", pane: "fixture/lead:0.0", pane_id: "%0", session: "fixture/lead", harness: "claude", server_epoch: "srv:1:1" },
    peer: { status: "active", delivery: "pane", pane: "fixture/peer:0.0", pane_id: "%1", session: "fixture/peer", harness: "claude", server_epoch: "srv:1:1" },
  } }));
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root: primary, registry_location: registry, state: "registered" } } }));
  writeFileSync(join(bin, "ps"), '#!/bin/sh\nprintf "1 fixturetty\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *pane_tty*session_name*) printf '%%0\\t/dev/fixturetty\\tfixture/lead\\t1:1\\n' ;;
  *pane_tty*) printf '%%0\\t/dev/fixturetty\\n' ;;
  *pane_current_command*) printf 'claude\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const entry = join(f.dir, "sibling.ts"), marker = join(f.dir, "submitted");
  writeFileSync(entry, `import { mock } from "bun:test";
const gather = await import(${JSON.stringify(resolve(import.meta.dir, "../src/observe-gather.ts"))});
mock.module(${JSON.stringify(resolve(import.meta.dir, "../src/observe-gather.ts"))}, () => ({ ...gather,
  gatherRowsFromEnv: (rows: any[]) => rows.map(r => [r.key, 'active', '', r.pane, r.pane_id, r.harness, '0'].join('\\x1f')) }));
const { cmdCompact } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/verbs/compact.ts"))});
const { writeFileSync } = await import("node:fs");
try { process.exitCode = await cmdCompact(['peer'], ${JSON.stringify(resolve(import.meta.dir, "../../../skills/tap/scripts"))}, false,
 async (r) => { writeFileSync(${JSON.stringify(marker)}, 'yes'); writeFileSync(r.proofReceipt, JSON.stringify({ id: r.id, state: 'resume-sent', evidence: 'transcript-proven', compactedAt: new Date().toISOString() })); return 0; }); }
catch (e: any) { process.stdout.write(JSON.stringify({ error: e.errorClass, action: e.action })); process.exitCode = e.code ?? 1; }
`);
  const env: NodeJS.ProcessEnv = { ...f.env, PATH: `${bin}:${process.env.PATH}`, TAP_SERVER_EPOCH: "srv:1:1" };
  delete env.TAP_HOME;
  const result = spawnSync(process.execPath, [entry], { cwd: sibling, encoding: "utf8", env });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ error: "no_actor", action: "run 'tap register' to join this team" });
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(sibling, ".tap/bus"))).toBe(false);
  // An explicit home owned by a different root cannot split authority either.
  const foreignHome = join(sibling, ".tap/bus");
  const foreign = spawnSync(process.execPath, [entry], { cwd: primary, encoding: "utf8", env: { ...env, TAP_HOME: foreignHome } });
  expect(foreign.status).toBe(1);
  expect(JSON.parse(foreign.stdout).error).toBe("bus_not_acting");
  expect(existsSync(marker)).toBe(false); expect(existsSync(foreignHome)).toBe(false);
  expect(existsSync(join(bus, "payloads"))).toBe(false);
  // Same-root non-acting pins now follow the shared selector refusal too.
  const customHome = join(primary, "custom-bus");
  const custom = spawnSync(process.execPath, [entry], { cwd: primary, encoding: "utf8", env: { ...env, TAP_HOME: customHome } });
  expect(custom.status).toBe(1); expect(JSON.parse(custom.stdout).error).toBe("bus_not_acting");
  expect(existsSync(marker)).toBe(false); expect(existsSync(customHome)).toBe(false);
  const acting = spawnSync(process.execPath, [entry], { cwd: primary, encoding: "utf8", env: { ...env, TAP_HOME: bus } });
  expect(acting.status).toBe(0); expect(existsSync(marker)).toBe(true);
  expect(existsSync(join(bus, "payloads"))).toBe(true);
}, 15000);

// Ported from the retired smoke session-name-liveness.test.sh: name authority
// plus designated-pane liveness over compactObservedRow, under a fake tmux and
// fake ps that model the hostile boundary shapes exactly (tmux 3.6a dead-target
// rc 0 with EMPTY output, an unreachable server, a garbled name snapshot, a ps
// probe that exits 2). Absence-of-observation is not observation-of-absence:
// every unobservable shape answers `unknown`, never a corpse classification.
const livenessRoot = mkdtempSync(join(process.env.TMUX_TMPDIR ?? "/tmp", "session-liveness-"));
const livenessBin = join(livenessRoot, "bin");
mkdirSync(livenessBin);
writeFileSync(join(livenessBin, "ps"), `#!/usr/bin/env bash
case "\${TAP_LIVENESS_CASE:-}" in
  harness-unobservable) exit 2 ;;
  shell-foreground)
    printf ' 700 700 701 zsh zsh\\n'
    printf ' 701 701 701 node node /opt/cursor-agent/index.js\\n'
    exit 0 ;;
  shell-background)
    printf ' 700 700 700 zsh zsh\\n'
    printf ' 702 702 700 node node /opt/cursor-agent/index.js\\n'
    exit 0 ;;
  shell-bare)
    printf ' 700 700 700 zsh zsh\\n'
    exit 0 ;;
esac
printf ' 999 999 999 node node /opt/cursor-agent/index.js\\n'
`, { mode: 0o755 });
writeFileSync(join(livenessBin, "tmux"), `#!/usr/bin/env bash
set -euo pipefail
case "\${TAP_LIVENESS_CASE:-}" in
  tmux-unobservable)
    echo "no server running on /fake/socket" >&2
    exit 1
    ;;
esac

verb="\${1:-}"; shift || true
case "$verb" in
  list-sessions)
    case "\${TAP_LIVENESS_CASE:-}" in
      absent-current|absent-stale) printf 'demo/other\\t1:1\\n' ;;
      malformed-name) printf 'demo/seat\\tgarbled\\n' ;;
      pane-live-elsewhere) printf 'demo/seat\\t1:1\\ndemo/foreign\\t1:1\\n' ;;
      *) printf 'demo/seat\\t1:1\\n' ;;
    esac
    ;;
  has-session)
    case "\${TAP_LIVENESS_CASE:-}" in
      absent-current|absent-stale) exit 1 ;;
      *) exit 0 ;;
    esac
    ;;
  list-panes)
    case "\${TAP_LIVENESS_CASE:-}" in
      absent-current|absent-stale)
        echo "can't find session: demo/seat" >&2
        exit 1
        ;;
      restart-between-probes)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tcodex\\t111\\t2:2\\t0\\n'
        ;;
      address-rebound)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%99\\tcodex\\t111\\t1:1\\t0\\n'
        ;;
      pane-live-elsewhere)
        if [[ "$*" == *'=demo/foreign'* ]]; then
          printf 'demo/foreign\\tdemo/foreign:0.0\\t%%11\\tcodex\\t211\\t1:1\\t0\\n'
        else
          printf 'demo/seat\\tdemo/seat:1.0\\t%%99\\tcodex\\t111\\t1:1\\t0\\n'
        fi
        ;;
      crew-alive)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tcodex\\t111\\t1:1\\t0\\n'
        printf 'demo/seat\\tdemo/seat:1.0\\t%%12\\tcodex\\t112\\t1:1\\t0\\n'
        ;;
      crew-gone)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tcodex\\t111\\t1:1\\t0\\n'
        ;;
      shell)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tzsh\\t111\\t1:1\\t0\\n'
        ;;
      shell-foreground)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tnode\\t700\\t1:1\\t0\\n'
        ;;
      shell-background)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tpython3\\t700\\t1:1\\t0\\n'
        ;;
      shell-bare)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tzsh\\t700\\t1:1\\t0\\n'
        ;;
      harness-unobservable)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tnode\\t999\\t1:1\\t0\\n'
        ;;
      *)
        printf 'demo/seat\\tdemo/seat:0.0\\t%%11\\tcodex\\t111\\t1:1\\t0\\n'
        ;;
    esac
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="\$2"; shift 2 ;;
        *) fmt="\$1"; shift ;;
      esac
    done
    case "$fmt" in
      *pane_id*)
        case "\${TAP_LIVENESS_CASE:-}:\$target" in
          address-rebound:%11) printf '%%11\\tdemo/foreign\\t1:1\\n' ;;
          address-rebound:demo/seat:0.0) printf '%%99\\n' ;;
          crew-gone:%12|crew-gone:demo/seat:1.0|absent-*:* ) printf '\\n' ;;
          *:%12) printf '%%12\\n' ;;
          *) printf '%%11\\n' ;;
        esac
        ;;
      *pane_pid*) printf '999\\n' ;;
      *pane_current_command*)
        [ "\${TAP_LIVENESS_CASE:-}" = shell ] && printf 'zsh\\n' || printf 'codex\\n'
        ;;
      *pid*start_time*)
        [ "\${TAP_LIVENESS_CASE:-}" = restart-between-probes ] && printf '2:2\\n' || printf '1:1\\n'
        ;;
      *) printf '\\n' ;;
    esac
    ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
afterAll(() => rmSync(livenessRoot, { recursive: true, force: true }));

interface LivenessCase {
  label: string; expected: string; caseName: string; expectedReason?: string;
  rowEpoch?: string; rowBoot?: string; nowBoot?: string; harness?: string;
  pane?: string; paneId?: string; legacyBoot?: string;
}

const livenessStates = (over: Partial<LivenessCase> = {}): LivenessCase =>
  ({ label: "", expected: "", caseName: "live", rowEpoch: "srv:1:1", rowBoot: "boot:1", nowBoot: "boot:1", harness: "codex", ...over });

const livenessMatrix: LivenessCase[] = [
  livenessStates({ label: "live designated agent", expected: "active" }),
  livenessStates({ label: "observed absent, current epoch", expectedReason: "session_absent", expected: "gone", caseName: "absent-current" }),
  livenessStates({ label: "observed absent, stale epoch", expectedReason: "server_epoch_stale", expected: "offline", caseName: "absent-stale", rowEpoch: "srv:0:0" }),
  livenessStates({ label: "live name, stale epoch", expectedReason: "server_epoch_stale", expected: "offline", rowEpoch: "srv:0:0" }),
  livenessStates({ label: "live name, stale boot", expectedReason: "boot_id_stale", expected: "offline", rowBoot: "boot:0" }),
  livenessStates({ label: "address rebound", expectedReason: "address_rebound", expected: "unknown", caseName: "address-rebound" }),
  livenessStates({ label: "stored pane live only in another session", expectedReason: "designated_pane_missing", expected: "unknown", caseName: "pane-live-elsewhere" }),
  livenessStates({ label: "positive shell", expectedReason: "harness_exited", expected: "offline", caseName: "shell" }),
  livenessStates({ label: "shell-fronted foreground harness", expected: "active", caseName: "shell-foreground", harness: "cursor" }),
  livenessStates({ label: "background harness stays offline", expectedReason: "harness_exited", expected: "offline", caseName: "shell-background", harness: "cursor" }),
  livenessStates({ label: "bare shell stays offline", expectedReason: "harness_exited", expected: "offline", caseName: "shell-bare", harness: "cursor" }),
  livenessStates({ label: "harness probe unobservable", expectedReason: "harness_unobservable", expected: "unknown", caseName: "harness-unobservable", harness: "cursor" }),
  livenessStates({ label: "crew member is designated", expected: "active", caseName: "crew-alive", pane: "demo/seat:1.0", paneId: "%12" }),
  livenessStates({ label: "crew member gone while driver lives", expectedReason: "designated_pane_missing", expected: "unknown", caseName: "crew-gone", pane: "demo/seat:1.0", paneId: "%12" }),
  livenessStates({ label: "tmux unobservable", expectedReason: "session_unobservable", expected: "unknown", caseName: "tmux-unobservable" }),
  livenessStates({ label: "malformed name snapshot", expectedReason: "session_unobservable", expected: "unknown", caseName: "malformed-name" }),
  livenessStates({ label: "server restarts between observations", expectedReason: "pane_set_unobservable", expected: "unknown", caseName: "restart-between-probes" }),
];

function observedLiveness(c: LivenessCase): string[] {
  const env: NodeJS.ProcessEnv = {
    PATH: `${livenessBin}:${process.env.PATH}`, TMUX: "/fake/socket",
    TAP_BOOT_ID: c.nowBoot!, TAP_LIVENESS_CASE: c.caseName,
  };
  if (c.legacyBoot !== undefined) env.TAP_BOOT_ID_LEGACY = c.legacyBoot;
  return compactObservedRow({
    status: "active", delivery: "pane", pane: c.pane ?? "demo/seat:0.0", pane_id: c.paneId ?? "%11",
    session: "demo/seat", registered_at: "2026-08-05T00:00:00Z", server_epoch: c.rowEpoch!,
    boot_id: c.rowBoot!, harness: c.harness!,
  }, env);
}

test("compactObservedRow classifies name authority plus designated-pane liveness", () => {
  for (const c of livenessMatrix) {
    const record = observedLiveness(c);
    expect(record[0], `${c.label}: case ${c.caseName} record=${JSON.stringify(record)}`).toBe(c.expected);
    // The reason is part of the classification: a future env or fixture break
    // that falls into the catch must not turn these rows vacuously green.
    if (c.expectedReason !== undefined) {
      expect(record[1], `${c.label}: case ${c.caseName} record=${JSON.stringify(record)}`).toBe(c.expectedReason);
    }
  }
});

// A legacy boot stamp within the slew tolerance stays live; a real legacy boot
// mismatch reads as the reboot it is (offline), never as the same seat.
test("compactObservedRow splits legacy-boot slew from a real reboot", () => {
  const slew = observedLiveness(livenessStates({ label: "legacy slew", expected: "active", rowBoot: "boot:1785910737", nowBoot: "bootuuid:current", legacyBoot: "boot:1785910738" }));
  expect(slew[0], `slew record=${JSON.stringify(slew)}`).toBe("active");
  const reboot = observedLiveness(livenessStates({ label: "real reboot", expected: "offline", rowBoot: "boot:1785910700", nowBoot: "bootuuid:current", legacyBoot: "boot:1785910738" }));
  expect(reboot[0], `reboot record=${JSON.stringify(reboot)}`).toBe("offline");
});
