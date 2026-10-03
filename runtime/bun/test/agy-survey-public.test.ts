import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { removeScratchTree } from "./support/scratch";
const ROOT = resolve(import.meta.dir, "../../..");
const scripts = join(ROOT, "skills/tap/scripts");
const survey = join(ROOT, "runtime/bun/test/fixtures/agy-survey/current-running.txt");
const scratch: string[] = [];
afterEach(() => { for (const root of scratch.splice(0)) removeScratchTree(root); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-agy-public.")); scratch.push(root);
  const wt = join(root, "team"), bus = join(wt, ".tap/bus"), index = join(root, "index");
  const registry = join(wt, ".tap/team-registry.json"), bin = join(root, "bin");
  const config = join(root, "config/tap");
  for (const dir of [join(bus, "payloads"), join(bus, "receipts"), index, bin, config]) mkdirSync(dir, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", wt]).exitCode).toBe(0);
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "flip", worktree_root: wt }, seats: {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
    ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "agy" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    flip: { root: wt, registry_location: registry, state: "registered" },
  } }));
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case " $* " in
  *"list-sessions"*) printf 'ua\\t123:456\\nub\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n' ;;
  *"list-panes"*)
    case " $* " in
      *"=ub"*|*" ub:"*|*" ub "*) printf 'ub\\tub:0.0\\t%%7\\tagy\\t4242\\t123:456\\t0\\n' ;;
      *) printf 'ua\\tua:0.0\\t%%6\\tclaude\\t4242\\t123:456\\t0\\n' ;;
    esac ;;
  *"#{pane_id}"*"#{session_name}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*) printf '%%6\\tua\\t4242\\tclaude\\t0\\n' ;;
      *) printf '%%7\\tub\\t4242\\tagy\\t0\\n' ;;
    esac ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    case " $* " in *" ub:"*|*"=ub"*|*" %7 "*) printf 'ub\\t123:456\\n' ;; *) printf 'ua\\t123:456\\n' ;; esac ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_current_command}"*) printf 'agy\\n' ;;
  *"#{pane_in_mode}"*|*"#{pane_dead}"*) printf '0\\n' ;;
  *"#{pane_pid}"*) printf '4242\\n' ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*) printf '%%7\\n' ;;
  *"capture-pane"*)
    if [ -f "$FX/fail-attempt-evidence" ]; then chmod 500 "$TAP_HOME/receipts"; fi
    if [ ! -f "$FX/skipped" ]; then cat "$SURVEY";
    elif [ -f "$FX/no-composer" ]; then printf 'Redrawing...\\n';
    else
      printf '────────────────────────────────────────────────────────────────────────────────────────────\\n> '
      if [ -f "$FX/band" ] && [ ! -f "$FX/submitted" ]; then cat "$FX/band"; fi
      printf '\\n────────────────────────────────────────────────────────────────────────────────────────────\\nesc to cancel                                                        Gemini 3.8 Flash · high\\n'
    fi ;;
  *"send-keys"*)
    printf '%s\\n' "$*" >> "$FX/keys"
    case " $* " in
      *" -l 0 "*|*" -l -- 0 "*) : > "$FX/skipped" ;;
      *" -l "*) for last do :; done; printf '%s' "$last" > "$FX/band"; rm -f "$FX/submitted" ;;
      *" Enter "*) : > "$FX/submitted" ;;
    esac ;;
  *"select-pane"*) printf 'STYLE %s\\n' "$*" >> "$FX/keys" ;;
esac
exit 0
`, { mode: 0o755 });
  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  writeFileSync(socketPath, "socket\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(root, "config"), TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"), OPENCODE_DB_PATH: join(root, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(root, "version.json"), TAP_LOCK_DIR: join(root, "locks"), TAP_SELF: "ua",
    TAP_TMUX_SOCKET_PATH: socketPath, TAP_SPOOL_DISABLE_DELIVERER: "1",
    TAP_TUI_SETTLE_SCALE: "0.1", FX: root, SURVEY: survey, TAP_BUN_ROUTE_TRACE: join(root, "route"),
  };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_DRIVER_FORCE_TMUX", "TAP_EPOCH", "TAP_SPOOL_DRAIN_ACTIVE"]) delete env[key];
  const mode = (value: string) => writeFileSync(join(config, "config.toml"), `[recovery]\naggressiveness = "${value}"\n`, { mode: 0o600 });
  const keys = () => existsSync(join(root, "keys")) ? readFileSync(join(root, "keys"), "utf8") : "";
  return { root, wt, bus, env, mode, keys };
}

for (const native of [false, true]) for (const scenario of ["restored", "report-only", "no-composer", "spool", "prior-attempt", "attempt-evidence-failure"]) {
  test(`public agy survey ${native ? "MAIN" : "Bash"}: ${scenario}`, () => {
    const fx = fixture();
    fx.mode(["report-only", "spool", "prior-attempt"].includes(scenario) ? "report-only" : "cautious");
    if (scenario === "no-composer") writeFileSync(join(fx.root, "no-composer"), "1");
    if (scenario === "attempt-evidence-failure") writeFileSync(join(fx.root, "fail-attempt-evidence"), "1");
    const args = ["send", "ub", "--ask", "-m", "survey test", "--from", "ua", ...native ? [] : ["--json"]];
    const result = Bun.spawnSync(native ? [process.execPath, join(ROOT, "runtime/bun/main.ts"), ...args] : ["bash", join(scripts, "../../../bin/tap"), ...args], {
      cwd: fx.wt, env: { ...fx.env, TAP_SPOOL_DRAIN_ACTIVE: "1",
        ...scenario === "attempt-evidence-failure" ? { TAP_JSON: "1" } : {} },
      stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    if (scenario === "attempt-evidence-failure") {
      chmodSync(join(fx.bus, "receipts"), 0o700);
      expect(result.exitCode, result.stderr.toString()).toBe(1);
      const refusal = result.stdout.toString().trim().split("\n").findLast(line => line.startsWith("{"));
      expect(JSON.parse(refusal ?? "").error_class).toBe("attempt_evidence_unwritable");
      expect(fx.keys()).toBe("");
      if (native) expect(readFileSync(join(fx.root, "route"), "utf8")).toBe("native send\n");
      return;
    }
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    if (!native) expect(JSON.parse(result.stdout.toString()).status).toBeTruthy();
    const id = readdirSync(join(fx.bus, "receipts")).find(name => name.endsWith(".placed"))!.replace(/\.placed$/, "");
    expect(id).toBeTruthy();
    if (native) expect(readFileSync(join(fx.root, "route"), "utf8")).toBe("native send\n");
    const sent = () => existsSync(join(fx.bus, "receipts", `${id}.sent`));
    const attempted = () => existsSync(join(fx.bus, "receipts", `${id}.attempted`));
    const drain = () => Bun.spawnSync(["bash", "-c", '. "$1/smoke/runtime-helpers.sh"; . "$1/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once', "drain", scripts], {
      cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    if (["report-only", "spool", "prior-attempt"].includes(scenario)) {
      expect(fx.keys()).toBe(""); expect(sent()).toBe(false);
      expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(true);
      expect(attempted()).toBe(false);
    }
    if (scenario === "spool" || scenario === "prior-attempt") {
      // An overdue report-only drain must not mint a possible-effect marker.
      const metaPath = join(fx.bus, "spool", `${id}.meta.json`);
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.deadline_epoch = Math.floor(Date.now() / 1000) - 1;
      writeFileSync(metaPath, JSON.stringify(meta));
      const held = drain(); expect(held.exitCode, held.stderr.toString()).toBe(0);
      expect(fx.keys()).toBe("");
      expect(attempted()).toBe(false);
      fx.mode("cautious");
      if (scenario === "prior-attempt") writeFileSync(join(fx.bus, "receipts", `${id}.attempted`), JSON.stringify({ id, effect: "possible" }));
      const drained = drain(); expect(drained.exitCode, drained.stderr.toString()).toBe(0);
    }
    if (scenario === "restored" || scenario === "spool") {
      expect(sent()).toBe(true);
      expect(attempted()).toBe(true);
      const rows = fx.keys().trim().split("\n");
      expect(rows.filter(row => / -l (?:-- )?0$/.test(row))).toHaveLength(1);
      const skip = rows.findIndex(row => / -l (?:-- )?0$/.test(row));
      const paste = rows.findIndex(row => row.includes("[[TAP"));
      const enter = rows.findIndex(row => / Enter$/.test(row));
      expect(skip).toBeLessThan(paste); expect(paste).toBeLessThan(enter);
      expect(rows.filter(row => / Enter$/.test(row))).toHaveLength(2);
      const before = fx.keys(); expect(drain().exitCode).toBe(0); expect(fx.keys()).toBe(before);
    } else if (scenario === "no-composer") {
      expect(fx.keys().trim().split("\n")).toHaveLength(1);
      expect(fx.keys()).toMatch(/ -l (?:-- )?0\n$/);
      expect(fx.keys()).not.toContain("[[TAP"); expect(sent()).toBe(false);
      expect(attempted()).toBe(true);
    } else if (scenario === "prior-attempt") {
      expect(fx.keys()).toBe(""); expect(sent()).toBe(false);
    }
  }, 90000);
}
