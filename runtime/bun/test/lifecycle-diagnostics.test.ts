import {test,expect} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {lifecycleDiagnostic} from "../src/lifecycle-diagnostics";

test("developer diagnostics are opt-in, file-only and redact via shared writer",()=>{
 const home=mkdtempSync(join(tmpdir(),"lifecycle-diag-"));const config=join(home,".config/tap");mkdirSync(config,{recursive:true});
 const env={...process.env,HOME:home,TAP_INDEX_HOME:join(home,"index"),XDG_CONFIG_HOME:join(home,".config")};
 const log=join(env.TAP_INDEX_HOME,"logs/launch-debug.jsonl");
 lifecycleDiagnostic("excluded",{team:"sample"},env);expect(existsSync(log)).toBe(false);
 writeFileSync(join(config,"config.toml"),'[diagnostics]\nlevel="off"\n');lifecycleDiagnostic("excluded",{team:"sample"},env);expect(existsSync(log)).toBe(false);
 writeFileSync(join(config,"config.toml"),'[diagnostics]\nlevel="verbose"\n');lifecycleDiagnostic("excluded",{team:"sample",API_TOKEN:"secret",prompt:"private"},env);
 const row=JSON.parse(readFileSync(log,"utf8"));expect(row.team).toBe("sample");expect(row.API_TOKEN).toBe("<redacted>");expect(row.prompt).toBeUndefined();
 writeFileSync(join(config,"config.toml"),'not valid = [');expect(()=>lifecycleDiagnostic("excluded",{},env)).not.toThrow();
});

const src = join(import.meta.dir, "../src");
function operationRun(level: string | null, body: string) {
 const home = mkdtempSync(join(tmpdir(), "lifecycle-op-")); const config = join(home, ".config/tap"); mkdirSync(config, { recursive: true });
 if (level !== null) writeFileSync(join(config, "config.toml"), `[diagnostics]\nlevel="${level}"\n`);
 const script = `import { withStartupTrace } from ${JSON.stringify(join(src, "startup-trace.ts"))};
  import { beginLifecycleOperation } from ${JSON.stringify(join(src, "lifecycle-diagnostics.ts"))};
  import { launchCommand } from ${JSON.stringify(join(src, "launcher/process.ts"))};
  import { rmSync } from "node:fs";
  ${body}`;
 const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000,
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TAP_INDEX_HOME: join(home, "index"), CAPTURE_TOKEN: "planted-token" } });
 const log = join(home, "index/logs/launch-debug.jsonl");
 return { child, config, rows: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

const strip = (rows: Record<string, unknown>[]) => rows.map(({ timestamp, pid, schema, cwd, socket, emitted_at, ...rest }) => rest);
const lifecycle = `await withStartupTrace(async () => {
  beginLifecycleOperation({ verb: "new", cwd: "/x", target: null, boot_id: null });
  await launchCommand(["sh", "-c", "echo failed planted-token >&2; exit 3"]);
  rmSync(process.env.XDG_CONFIG_HOME + "/tap/config.toml");
  await launchCommand(["sh", "-c", "true", "display-message"]);
  try { await launchCommand(["/nonexistent/tap-probe"]); } catch {}
 });`;

test("a diagnosed lifecycle operation announces itself and captures each command, redacted", () => {
 const r = operationRun("verbose", lifecycle);
  expect(r.child.status, r.child.stderr).toBe(0);
  // Every diagnostic record carries the emission clock in the stamp's shape.
  expect(r.rows.every(row => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/.test(String(row.emitted_at)))).toBe(true);
  // The config is read once, at the operation's start: deleting it mid-operation keeps capture on.
 expect(strip(r.rows)).toEqual([
  { event: "diagnostics_start", console: false, tmux_trace: false },
  { event: "command" }, { event: "command_exit", status: 3, stderr: "failed <redacted>\n" },
  { event: "command" }, { event: "command_exit", status: 0, stderr: "" }, { event: "pane_output" },
  { event: "command" },
  { event: "command_error", status: null, error: "Error: ENOENT: no such file or directory, posix_spawn '/nonexistent/tap-probe'", stderr: "" },
 ]);
 expect(r.rows.every(row => typeof row.cwd === "string" || row.event === "diagnostics_start" || row.event !== "command")).toBe(true);
});

test("diagnostics stay off by default, when not verbose, and in an operation that never began", () => {
 for (const level of [null, "off"]) expect(operationRun(level, lifecycle).rows).toEqual([]);
 const unbegun = operationRun("verbose", `await withStartupTrace(async () => { await launchCommand(["sh", "-c", "true"]); });`);
 expect(unbegun.child.status, unbegun.child.stderr).toBe(0);
 expect(unbegun.rows).toEqual([]);
});
