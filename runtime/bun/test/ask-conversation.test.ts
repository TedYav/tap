import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const id = "11111111-2222-4333-8444-555555555555";
const answer = "literal answer `tick` $(no)\n第二行\n";
function fixture() {
  if (!process.env.TAP_HOME) throw new Error("requires isolated TAP runner");
  const dir = mkdtempSync(join(process.env.TAP_HOME, "ask-conversation-"));
  for (const part of ["bin", "home", "index", "bus", "config/tap", "native", "temp", "work space"]) mkdirSync(join(dir, part), { recursive: true });
  symlinkSync(process.execPath, join(dir, "bin/bun"));
  const cwd = realpathSync(join(dir, "work space"));
  const env = { ...process.env, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "native"),
    TAP_HOME: join(dir, "bus"), TAP_INDEX_HOME: join(dir, "index"), TMPDIR: join(dir, "temp"),
    CLAUDE_CONFIG_DIR: join(dir, "native/claude"), CODEX_HOME: join(dir, "native/codex"),
    CURSOR_HOME: join(dir, "native/cursor"), GEMINI_HOME: join(dir, "native/gemini"), HERMES_HOME: join(dir, "native/hermes"),
    PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ASK_FIXTURE: dir, TAP_JSON: undefined, TAP_VERBOSE: undefined,
    TAP_CLAUDE_HOME: undefined, TAP_CODEX_HOME: undefined, TAP_CURSOR_HOME: undefined, TAP_GEMINI_HOME: undefined, OPENCODE_DB_PATH: undefined };
  const native = (name: string, contents = "") => { const path = join(dir, "native", name); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, contents); return path; };
  native(`codex/sessions/2026/10/28/rollout-2026-10-28T00-00-00-${id}.jsonl`, JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "exec" } }) + "\n");
  native(`cursor/chats/${createHash("md5").update(cwd).digest("hex")}/${id}/store.db`);
  native(`gemini/antigravity-cli/conversations/${id}.db`);
  const opencode = new Database(native("opencode/opencode.db"));
  opencode.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)");
  opencode.query("INSERT INTO session_v2 VALUES (?, ?)").run("ses_askfixture", cwd); opencode.close();
  const hermes = new Database(native("hermes/state.db"));
  hermes.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)"); hermes.query("INSERT INTO sessions VALUES (?)").run(id); hermes.close();
  const stub = `#!${process.execPath}
import {writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
const args=process.argv.slice(2), binary=basename(process.argv[1]);
const value=(flag)=>args.find(x=>x.startsWith(flag+'='))?.slice(flag.length+1) ?? args[args.indexOf(flag)+1];
const has=(flag)=>args.some(x=>x===flag||x.startsWith(flag+'='));
writeFileSync(join(process.env.ASK_FIXTURE,'argv'),JSON.stringify(args));
const answer=${JSON.stringify(answer)}, id=${JSON.stringify(id)};
if(binary==='claude') {
  const session=value('--session-id');
  if(has('--session-id')&&!has('--no-session-persistence')) {
    const file=join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'),session+'.jsonl');
    mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,JSON.stringify({type:'user',sessionId:session,cwd:process.cwd()})+'\\n');
  }
  process.stdout.write(answer);
} else if(binary==='codex'&&has('--json')) {
  console.log(JSON.stringify({type:'thread.started',thread_id:id}));
  console.log(JSON.stringify({type:'item.completed',item:{id:'i1',type:'agent_message',text:'intermediate commentary'}}));
  if(has('--output-last-message')) writeFileSync(value('--output-last-message'),answer);
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
} else if(binary==='cursor-agent'&&has('--output-format')) {
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:answer,session_id:id,duration_ms:1,duration_api_ms:1}));
} else if(binary==='agy'&&has('--output-format')) {
  console.log(JSON.stringify({conversation_id:id,status:'SUCCESS',response:answer,duration_seconds:1,num_turns:1,usage:{}}));
} else if(binary==='opencode'&&has('--format')) {
  console.log(JSON.stringify({type:'step_start',timestamp:1,sessionID:'ses_askfixture',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',timestamp:2,sessionID:'ses_askfixture',part:{type:'text',text:answer}}));
  console.log(JSON.stringify({type:'step_finish',timestamp:3,sessionID:'ses_askfixture',part:{type:'step-finish',reason:'stop'}}));
} else {
  if(binary==='hermes'&&has('--usage-file')) writeFileSync(value('--usage-file'),JSON.stringify({session_id:id,completed:true,failed:false}));
  process.stdout.write(answer);
}
`;
  for (const binary of ["claude", "codex", "cursor-agent", "opencode", "agy", "hermes"]) writeFileSync(join(dir, "bin", binary), stub, { mode: 0o755 });
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(root, "runtime/bun/main.ts"), "ask", ...args], {
    cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
  return { dir, cwd, env, run, close: () => removeScratchTree(dir) };
}

test.each(["claude", "codex", "cursor", "opencode", "agy", "hermes"])("%s ask preserves the answer and prints its exact persisted conversation", harness => {
  const f = fixture();
  try {
    const result = f.run([harness, "--model", "fixture-tier", "-m", "question"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(answer);
    const args = JSON.parse(readFileSync(join(f.dir, "argv"), "utf8")) as string[];
    expect(args).not.toContain("--ephemeral"); expect(args).not.toContain("--no-session-persistence");
    const nativeId = harness === "claude" ? args[args.indexOf("--session-id") + 1] : harness === "opencode" ? "ses_askfixture" : id;
    expect(nativeId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    expect(result.stderr).toContain(`tap ask: ${harness} session ${nativeId};`);
    expect(result.stderr).toContain(`tap crew add ${harness} <name> --model fixture-tier --resume ${nativeId} --cwd '${f.cwd}'`);
    expect(readdirSync(join(f.dir, "temp"))).toEqual([]);
    expect(readdirSync(join(f.dir, "bus"))).toEqual([]);
    expect(readdirSync(join(f.dir, "index"))).toEqual([]);
  } finally { f.close(); }
});

test("preset receipt carries the same preset and working directory", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "config/tap/config.toml"), 'version=3\n[presets.review]\nharness="claude"\n[presets.review.params]\nmodel="fixture-tier"\n');
    const result = f.run(["review", "-m", "question"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("tap crew add claude <name> --preset review --resume ");
    expect(result.stderr).toContain(`--cwd '${f.cwd}'`);
  } finally { f.close(); }
});

test.each(["claude", "codex"])("%s --ephemeral keeps native persistence disabled", harness => {
  const f = fixture();
  try {
    const result = f.run([harness, "--ephemeral", "-m", "question"]);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe(answer);
    const args = JSON.parse(readFileSync(join(f.dir, "argv"), "utf8"));
    expect(args).toContain(harness === "claude" ? "--no-session-persistence" : "--ephemeral");
    expect(args).not.toContain("--session-id");
    expect(result.stderr).not.toContain("continue it as a crew");
    expect(readdirSync(join(f.dir, "temp"))).toEqual([]);
  } finally { f.close(); }
});

test("missing native artifacts preserve the answer without advertising resume", () => {
  const f = fixture();
  try {
    const result = f.run(["codex", "-m", "question"], { CODEX_HOME: join(f.dir, "empty-store") });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe(answer);
    expect(result.stderr).toContain(`codex session ${id}; persisted conversation could not be verified`);
    expect(result.stderr).not.toContain("tap crew add");
  } finally { f.close(); }
});

test.each(["malformed", "invalid-id", "conflicting-ids"])("%s native output never advertises a guessed conversation", mode => {
  const f = fixture();
  try {
    const events = mode === "malformed" ? "not json\n"
      : mode === "invalid-id" ? JSON.stringify({ type: "text", sessionID: "ses_bad;command", part: { text: answer } }) + "\n"
      : JSON.stringify({ type: "step_start", sessionID: "ses_first" }) + "\n" + JSON.stringify({ type: "text", sessionID: "ses_second", part: { text: answer } }) + "\n";
    writeFileSync(join(f.dir, "bin/opencode"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(events)});\n`, { mode: 0o755 });
    const result = f.run(["opencode", "-m", "question"]);
    expect(result.status).toBe(mode === "malformed" ? 1 : 0);
    expect(result.stdout).toBe(mode === "malformed" ? "" : answer);
    expect(result.stderr).not.toContain("tap crew add");
  } finally { f.close(); }
});

test.each(["", "answer without newline"])("Codex final file is authoritative, including empty output and exact bytes %j", final => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "bin/codex"), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(id)}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'not the final answer'}}));
writeFileSync(args[args.indexOf('--output-last-message')+1],${JSON.stringify(final)});
`, { mode: 0o755 });
    const result = f.run(["codex", "-m", "question"]);
    expect(result.status, result.stderr).toBe(final ? 0 : 1); expect(result.stdout).toBe(final);
    if (!final) expect(result.stderr).toContain("produced no output");
    expect(readdirSync(join(f.dir, "temp"))).toEqual([]);
  } finally { f.close(); }
});

test.each(["output-format", "session-id", "no-session-persistence", "resume"])("preset cannot replace ask-owned %s", key => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "config/tap/config.toml"), `version=3\n[presets.conflict]\nharness="claude"\n[presets.conflict.params]\n${key}="value"\n`);
    const result = f.run(["conflict", "-m", "question"]);
    expect(result.status).toBe(1); expect(result.stderr).toContain("tap ask already fixes");
    expect(existsSync(join(f.dir, "argv"))).toBe(false);
    expect(readdirSync(join(f.dir, "temp"))).toEqual([]);
  } finally { f.close(); }
});

test("Codex timeout removes its invocation-private output file and emits no adoption command", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "bin/codex"), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
writeFileSync(args[args.indexOf('--output-last-message')+1],'partial');
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(id)}}));
await Bun.sleep(30000);
`, { mode: 0o755 });
    const result = f.run(["codex", "-m", "question"], { TAP_ASK_TIMEOUT_SECONDS: "0.2" });
    expect(result.status).toBe(124); expect(result.stderr).not.toContain("tap crew add");
    expect(readdirSync(join(f.dir, "temp"))).toEqual([]);
  } finally { f.close(); }
});

test.each(["cursor", "opencode", "agy", "hermes"])("%s refuses unsupported --ephemeral before starting a child", harness => {
  const f = fixture();
  try {
    const result = f.run([harness, "--ephemeral", "-m", "question"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not provide a verified no-persistence mode");
    expect(existsSync(join(f.dir, "argv"))).toBe(false);
  } finally { f.close(); }
});
