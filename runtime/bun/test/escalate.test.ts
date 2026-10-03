// Expectations from tap-escalate.sh at 871ab6140cb0c15e6b73a19dc7e6c54eae5a5178
// and protocol/messages/escalation-tap-escalate-v0-21.md, before retiring Bash.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ESCALATE_COMMAND } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const leaf = join(root, "runtime/bun/src/verbs/escalate.ts");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });
function fixture() {
  const dir = mkdtempSync(join(process.env.TMUX_TMPDIR!, "esc.")); scratch.push(dir);
  const bus = join(dir, ".tap", "bus"), bin = join(dir, "bin"), log = join(dir, "argv.json");
  mkdirSync(bus, { recursive: true }); mkdirSync(bin); mkdirSync(join(dir, "index"));
  // Born live (F1): the fixture team is enrolled under its registry's name.
  writeFileSync(join(dir, "index", "global-registry.json"), JSON.stringify({ schema: "0.20",
    teams: { team: { root: dir, registry_location: join(bus, "registry.json"), state: "registered" } } }));
  const seats = {
    armer: { status: "active", session: "team/armer", pane: "p:0.0", pane_id: "%1", server_epoch: "srv:4242:100" },
    other: { status: "active", session: "Other/session" },
    suspended: { status: "suspended", status_reason: "pane_gone" },
    poll: { delivery: "poll", session: "never/guess" },
    pending: { status: "pending" }, launching: { status_reason: "launching" },
  };
  writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "team" }, seats }));
  const notifier = join(bin, "notify");
  writeFileSync(notifier, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.ESC_LOG,JSON.stringify(process.argv.slice(2)));\nconsole.log('notifier stdout');console.error('notifier stderr');\nif(process.env.ESC_HANG){process.on('SIGTERM',()=>{});writeFileSync(process.env.ESC_PID,String(process.pid));setInterval(()=>{},1000);}else process.exit(Number(process.env.ESC_RC||0));\n`, { mode: 0o700 });
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), TAP_HOME: bus, TAP_INDEX_HOME: join(dir, "index"), TAP_SELF: "", TAP_JSON: "", TAP_NOTIFY_USER_BIN: notifier, ESC_LOG: log, ESC_PID: join(dir, "pid"), PATH: `${bin}:${process.env.PATH}` };
  const run = (argv: string[], extra: NodeJS.ProcessEnv = {}, entry = [process.execPath, leaf]) => spawnSync(entry[0]!, [...entry.slice(1), ...argv], { env: { ...env, ...extra }, cwd: dir, encoding: "utf8", timeout: 6000, killSignal: "SIGKILL" });
  return { dir, bus, bin, log, env, run, args: () => JSON.parse(readFileSync(log, "utf8")) as string[] };
}

test("first question only, CRLF/blank lines, literal text, urgency, preview and clean JSON", () => {
  const f = fixture(), body = join(f.dir, "body");
  writeFileSync(body, '\r\n \t\r\n --hold `touch nope` $(touch nope) \r\nPRIVATE SECOND LINE\n');
  const r = f.run(["-f", body, "--from", "armer", "--urgent", "--preview", "ignored", "--json"]);
  expect(r.status).toBe(0);
  expect(f.args()).toEqual(["--template", "question", "--priority", "urgent", "--", "--hold `touch nope` $(touch nope) — team/armer"]);
  expect(JSON.parse(r.stdout)).toEqual({ ok: true, notified: true, delivery: "accepted", human_received: null, label: f.args().at(-1), from: "armer", team: "team" });
  expect(r.stderr).toContain("notifier stdout"); expect(r.stderr).toContain("notifier stderr");
  expect(existsSync(join(f.dir, "nope"))).toBe(false);
  expect(existsSync(join(f.bus, "payloads"))).toBe(false); expect(existsSync(join(f.bus, "receipts"))).toBe(false);
});

test("body and membership refusals happen before notifier effects", () => {
  const f = fixture(), body = join(f.dir, "body"); writeFileSync(body, "question");
  const cases: [string[], string][] = [
    [[], "usage_error"], [["-m", "q", "-f", body], "usage_error"],
    [["-f", join(f.dir, "missing")], "not_found"], [["-f", f.dir], "usage_error"],
    [["-m", " \r\n\t"], "empty_question"], [["--summary", "q"], "unknown_option"],
    [["-m", "q", "--from", "missing"], "unregistered_from"],
    [["-m", "q", "--from", "pending"], "reserved_from"], [["-m", "q", "--from", "launching"], "reserved_from"],
    [["-m", "q", "--from", "bad/name"], "usage_error"], [["-m", "q", "--from", "toString"], "unregistered_from"],
  ];
  for (const [argv, klass] of cases) {
    const r = f.run(["--json", "--from", "armer", ...argv]);
    expect(r.status, JSON.stringify(argv) + r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).error_class).toBe(klass);
    expect(existsSync(f.log)).toBe(false);
  }
});

test("sender precedence and inactive/poll/session rules use the registered row", () => {
  const f = fixture();
  for (const [from, label] of [["armer", "team/armer"], ["other", "team/other [tmux: Other/session]"], ["suspended", "team/suspended"], ["poll", "team/poll"]]) {
    expect(f.run(["-m", "q", "--from", from!], { TAP_SELF: "missing" }).status).toBe(0);
    expect(f.args()).toEqual(["--template", "question", "--", `q — ${label}`]);
  }
  expect(f.run(["-m", "q"], { TAP_SELF: "poll" }).status).toBe(0);
  expect(f.args().at(-1)).toBe("q — team/poll");
  // Explicit HOME pin defeats even an invalid --team (lib.sh:6061).
  expect(f.run(["-m", "q", "--from", "armer", "--team", "bad/team"]).status).toBe(0);
});

test("missing notifier, raw exit, and spawn failure never claim success", () => {
  const f = fixture();
  const missing = f.run(["-m", "q", "--from", "armer", "--json"], { TAP_NOTIFY_USER_BIN: join(f.dir, "missing") });
  expect(missing.status).toBe(2); expect(JSON.parse(missing.stdout).error_class).toBe("notify_user_missing");
  const failed = f.run(["-m", "q", "--from", "armer", "--json"], { ESC_RC: "7" });
  expect(failed.status).toBe(7); expect(JSON.parse(failed.stdout).error_class).toBe("notify_failed");
  const broken = join(f.dir, "broken"); writeFileSync(broken, "#!/nonexistent/interpreter\n", { mode: 0o700 });
  const fault = f.run(["-m", "q", "--from", "armer", "--json"], { TAP_NOTIFY_USER_BIN: broken });
  expect(fault.status).not.toBe(0); expect(JSON.parse(fault.stdout).ok).toBe(false);
  // Explicit bare executable overrides still resolve through the supplied PATH.
  expect(f.run(["-m", "q", "--from", "armer"], { TAP_NOTIFY_USER_BIN: "notify" }).status).toBe(0);
});

test("deadline kills a TERM-resistant notifier and reports timeout/2", () => {
  const f = fixture(), start = Date.now();
  const r = f.run(["-m", "q", "--from", "armer", "--json"], { ESC_HANG: "1", TAP_NOTIFY_TIMEOUT_SECONDS: "1" });
  expect(r.status).toBe(2); expect(JSON.parse(r.stdout).error_class).toBe("notify_timeout");
  expect(Date.now() - start).toBeLessThan(4000);
  const pid = Number(readFileSync(f.env.ESC_PID, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("an open stdin tail cannot delay a first-question notification", async () => {
  const f = fixture();
  const child = spawn(process.execPath, [leaf, "-f", "-", "--from", "armer", "--json"], { cwd: f.dir, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", b => { out += b; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const done = new Promise<number | null>(r => child.on("close", r));
    child.stdin.write("\r\n"); child.stdin.write("question\nPRIVATE TAIL");
    expect(await done).toBe(0); expect(JSON.parse(out).label).toBe("question — team/armer");
  } finally { clearTimeout(timer); child.stdin.destroy(); }
});

test("all dispatch entrances reach the native owner without bus mutation", () => {
  const f = fixture(); mkdirSync(join(f.dir, "home/.tap"), { recursive: true });
  const before = readFileSync(join(f.bus, "registry.json"), "utf8");
  for (const entry of [[process.execPath, leaf], [process.execPath, join(root, "runtime/bun/main.ts"), "escalate"], ["bash", join(root, "scripts/tap.sh"), "--verbose", "escalate"], ["bash", join(root, "scripts/tap.sh"), "escalate"], ["bash", join(root, "bin/tap"), "escalate"]]) {
    const r = f.run(["-m", "q", "--from", "armer", "--json"], { HOME: join(f.dir, "home") }, entry);
    expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout).label).toBe("q — team/armer");
    expect(readFileSync(join(f.bus, "registry.json"), "utf8")).toBe(before);
  }
});

test("explicit team and custom bus pins read enrolled registry authority, never a decoy", () => {
  const f = fixture(), acting = join(f.dir, "acting.json"), foreign = join(f.dir, "foreign");
  mkdirSync(foreign); mkdirSync(join(foreign, ".tap/bus"), { recursive: true });
  writeFileSync(acting, JSON.stringify({ schema: "0.20", team: { name: "decoy" }, seats: { armer: { delivery: "poll" } } }));
  writeFileSync(join(f.env.TAP_INDEX_HOME, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    real: { root: f.dir, registry_location: acting }, foreign: { root: foreign, registry_location: join(foreign, "registry.json") },
  } }));
  writeFileSync(join(foreign, "registry.json"), JSON.stringify({ seats: { armer: { session: "WRONG" } } }));
  const r = f.run(["-m", "q", "--from", "armer", "--team", "foreign", "--json"]);
  expect(r.status, r.stderr + r.stdout).toBe(0); expect(JSON.parse(r.stdout).label).toBe("q — real/armer");
  const byTeam = f.run(["-m", "q", "--from", "armer", "--team", "real", "--json"], { TAP_HOME: "" });
  expect(byTeam.status, byTeam.stderr + byTeam.stdout).toBe(0); expect(JSON.parse(byTeam.stdout).team).toBe("real");
  // The fixture's enrolled bus exists; escalate must not bootstrap it.
  expect(existsSync(join(f.dir, ".tap/bus/payloads"))).toBe(false);
  expect(existsSync(join(f.dir, ".tap/bus/receipts"))).toBe(false);
});

test("implicit identity maps no-self and missing generation to exit 1; explicit sender bypasses observation", () => {
  const f = fixture();
  writeFileSync(join(f.bin, "ps"), '#!/bin/sh\nprintf "1 ttys001\\n"\n', { mode: 0o700 });
  writeFileSync(join(f.bin, "tmux"), '#!/bin/sh\ncase "$*" in *list-panes*) printf "%%1\\t/dev/ttys001\\n";; *) printf "%%1\\t/dev/ttys001\\tsess\\t%s\\n" "${ESC_EPOCH:-4242:100}";; esac\n', { mode: 0o700 });
  const base = { TAP_TMUX_SOCKET: "", TAP_TMUX_SOCKET_PATH: "", TAP_SELF: "", TMUX: "/fake" };
  let r = f.run(["-m", "q", "--json"], base);
  expect(r.status, r.stdout + r.stderr).toBe(0); expect(JSON.parse(r.stdout).from).toBe("armer");
  r = f.run(["-m", "q", "--json"], { ...base, ESC_EPOCH: "invalid" });
  expect(r.status).toBe(1); expect(JSON.parse(r.stdout).error_class).toBe("generation_unverifiable");
  expect(f.run(["-m", "q", "--json", "--from", "poll"], { ...base, ESC_EPOCH: "invalid" }).status).toBe(0);
  writeFileSync(join(f.bin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  r = f.run(["-m", "q", "--json"], base);
  expect(r.status).toBe(1); expect(JSON.parse(r.stdout).error_class).toBe("unregistered");
});

test("caller cancellation kills the owned notifier group, including resistant descendants", async () => {
  const f = fixture(), notifier = f.env.TAP_NOTIFY_USER_BIN, descendant = join(f.dir, "descendant");
  writeFileSync(notifier, `#!${process.execPath}\nimport {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';\nprocess.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(descendant)},String(child.pid));writeFileSync(process.env.ESC_PID,String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [leaf, "-m", "q", "--from", "armer", "--json"], { cwd: f.dir, env: f.env, stdio: "pipe" });
  let out = ""; child.stdout.on("data", b => { out += b; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    const done = new Promise<number | null>(r => child.on("close", r));
    for (let i = 0; i < 100 && !existsSync(f.env.ESC_PID); i++) await Bun.sleep(10);
    expect(existsSync(f.env.ESC_PID)).toBe(true);
    child.kill("SIGTERM"); expect(await done).toBe(143);
    expect(JSON.parse(out).error_class).toBe("notify_failed");
    expect(JSON.parse(out).detail).toContain("unconfirmed");
    for (const file of [f.env.ESC_PID, descendant]) {
      const pid = Number(readFileSync(file, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally { clearTimeout(timer); }
});

test("compiled native callers run the pinned leaf with no PATH bun and no runtime-mode leak to the notifier", () => {
  const f = fixture(), wrapper = join(f.dir, "caller.ts"), executable = join(f.dir, "caller");
  mkdirSync(join(f.bus, "watch")); writeFileSync(join(f.bus, "watch/arm.json"), '{"armed_by":"armer"}');
  writeFileSync(wrapper, `import {notifyHuman} from ${JSON.stringify(join(root, "runtime/bun/src/watch-notice.ts"))};\nprocess.exitCode=notifyHuman({bus:process.env.TAP_HOME!,scripts:${JSON.stringify(join(root, "skills/tap/scripts"))},reason:'compiled alert',now:'2000'});\n`);
  const built = spawnSync(process.execPath, ["build", "--compile", wrapper, "--outfile", executable], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  // A compiled notifier would boot the Bun CLI if the leaf leaked BUN_BE_BUN.
  writeFileSync(f.env.TAP_NOTIFY_USER_BIN, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';if(process.env.BUN_BE_BUN)process.exit(99);writeFileSync(process.env.ESC_LOG,JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  // Even a regressed watch fallback must not reach the desktop. Keep bun absent.
  for (const name of ["osascript", "notify-send"]) writeFileSync(join(f.bin, name), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const r = f.run([], { PATH: `${f.bin}:/usr/bin:/bin` }, [executable]);
  expect(r.status, r.stderr).toBe(0);
  expect(f.args()).toEqual(["--template", "question", "--", "compiled alert — team/armer"]);
});

test("a selected line that trims empty refuses instead of exposing a later private line", () => {
  const f = fixture(), body = join(f.dir, "body");
  for (const prefix of ["\v", "\f", "\u2003"]) {
    writeFileSync(body, `${prefix}\nPRIVATE DEPTH`);
    const r = f.run(["-f", body, "--from", "armer", "--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).error_class).toBe("empty_question");
    expect(existsSync(f.log)).toBe(false);
  }
  const bom = f.run(["-m", "\ufeffquestion\nPRIVATE", "--from", "armer", "--json"]);
  expect(bom.status).toBe(0); expect(JSON.parse(bom.stdout).label).toBe("\ufeffquestion — team/armer");
});


test("default system transport uses argv literally and never invokes a discovered notify-user", () => {
  const f = fixture();
  for (const name of ["osascript", "notify-send"]) writeFileSync(join(f.bin, name), readFileSync(f.env.TAP_NOTIFY_USER_BIN), { mode: 0o700 });
  writeFileSync(join(f.bin, "notify-user"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const question = '--hold "quoted" `touch nope` $(touch nope)';
  for (const override of ["", undefined]) {
    const r = f.run(["-m", question + "\nPRIVATE", "--from", "armer", "--urgent", "--json"], { TAP_NOTIFY_USER_BIN: override });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).delivery).toBe("accepted");
    expect(f.args().slice(-2)).toEqual(["🚨 TAP escalation", question + " — team/armer"]);
    expect(existsSync(join(f.dir, "nope"))).toBe(false);
  }
});

test("configured command substitutes whole argv tokens once, including repeated and hostile content", () => {
  const f = fixture(), config = join(f.env.XDG_CONFIG_HOME, "tap");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.toml"), '[notifications]\nnotifier="command"\ncommand=' + JSON.stringify([f.env.TAP_NOTIFY_USER_BIN, "{title}", "{urgency}", "--", "{body}", "{body}", "__proto__", "constructor"]) + '\n');
  const question = '--body {title} `touch nope` $(touch nope)';
  const r = f.run(["-m", question + "\nPRIVATE", "--from", "armer", "--json"], { TAP_NOTIFY_USER_BIN: "" });
  expect(r.status, r.stderr).toBe(0);
  expect(f.args()).toEqual(["TAP escalation", "routine", "--", question + " — team/armer", question + " — team/armer", "__proto__", "constructor"]);
  expect(existsSync(join(f.dir, "nope"))).toBe(false);
});

test("exit 143 is a notifier failure, not a deadline, and timeout is unknown delivery", () => {
  const f = fixture();
  const failed = f.run(["-m", "q", "--from", "armer", "--json"], { ESC_RC: "143" });
  expect(failed.status).toBe(143);
  expect(JSON.parse(failed.stdout).error_class).toBe("notify_failed");
  const timeout = f.run(["-m", "q", "--from", "armer", "--json"], { ESC_HANG: "1", TAP_NOTIFY_TIMEOUT_SECONDS: "1" });
  expect(timeout.status).toBe(2);
  expect(JSON.parse(timeout.stdout).detail).toContain("delivery is unknown");
});

test("missing, failed, and timed-out configured commands never try the system transport", () => {
  const f = fixture(), config = join(f.env.XDG_CONFIG_HOME, "tap"), second = join(f.dir, "second-call");
  mkdirSync(config, { recursive: true });
  for (const name of ["osascript", "notify-send"]) writeFileSync(join(f.bin, name), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(second)},'bad');\n`, { mode: 0o700 });
  for (const kind of ["missing", "failed", "timeout"]) {
    writeFileSync(join(config, "config.toml"), '[notifications]\nnotifier="command"\ntimeout_seconds=1\ncommand=' + JSON.stringify([kind === "missing" ? join(f.dir, "absent") : f.env.TAP_NOTIFY_USER_BIN, "{body}"]) + '\n');
    const r = f.run(["-m", "q", "--from", "armer", "--json"], { TAP_NOTIFY_USER_BIN: "", ESC_RC: kind === "failed" ? "7" : "0", ESC_HANG: kind === "timeout" ? "1" : "" });
    expect(r.status).not.toBe(0);
    expect(existsSync(second)).toBe(false);
  }
});

test("the escalate command that pane-identity refusals advise parses once its placeholders are filled", () => {
  // The fixture notifier is a logging stub (TAP_NOTIFY_USER_BIN); nothing real is notified.
  const f = fixture(), body = join(f.dir, "question.md");
  writeFileSync(body, "Which seat owns pane %1?\nsecond line stays local\n");
  const filled = ESCALATE_COMMAND.replace("<team>", "team").replace("<your handle>", "armer").replace("<question-file>", body);
  const [tap, verb, ...argv] = filled.split(" ");
  expect([tap, verb]).toEqual(["tap", "escalate"]);
  expect(ESCALATE_COMMAND).toContain("-f <question-file>");
  const r = f.run(["--json", ...argv]);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, from: "armer", team: "team" });
  expect(f.args().at(-1)).toBe("Which seat owns pane %1? — team/armer");
});
