import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notices } from "../src/launcher/catalog-notices";
import { launchInvocation } from "../src/launcher/invocation";
import type { SessionRecord } from "../src/launcher/types";

// tap-4tclq: `codex resume <id>` from a directory other than the rollout's saved cwd stops at Codex's "Working directory · resume"
// prompt (codex-cli 0.159.3, observed live), and a relaunched seat has no one to answer it. `--cd` overrides tui.resume_cwd, so every
// Codex resume the launcher composes names its destination. A resume by explicit id is not cwd-keyed, so naming the folder the seat
// already starts in is redundant at worst, and nothing reads the saved transcript.
const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-resume-cwd-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = "01a0f7d8-6ccd-7580-90ff-62526bca1870";
const A = join(root, "A"), B = join(root, "B");

let n = 0;
/** A machine whose tap config says exactly this. */
function machine(policy = "version=3\n"): NodeJS.ProcessEnv {
  const dir = join(root, `config${n++}`);
  mkdirSync(join(dir, "tap"), { recursive: true });
  const file = join(dir, "tap", "config.toml");
  writeFileSync(file, policy);
  chmodSync(file, 0o600);
  return { HOME: "/nonexistent", XDG_CONFIG_HOME: dir };
}

function launch(env: NodeJS.ProcessEnv, extra: Partial<SessionRecord> = {}, action = "resume", workdir: string | null = B): string[] {
  const record: SessionRecord = { name: "seat", harness: "codex", cwd: A, launch_workdir: workdir ?? undefined, base: "team", model: null, harness_session_id: ID, ...extra };
  return launchInvocation(action, record, new Notices(), { env, resume: action === "resume" ? ID : null, notify: false }).argv;
}
const tail = (argv: string[]) => argv.slice(argv.indexOf("resume"));

test("a resume names its destination as --cd, ahead of the session id", () => {
  expect(tail(launch(machine()))).toEqual(["resume", "--cd", B, ID]);
});

test("a same-folder resume names it too: --cd for the folder the seat already starts in is redundant, not harmful", () => {
  expect(tail(launch(machine(), {}, "resume", A))).toEqual(["resume", "--cd", A, ID]);
});

test("a seat with no recorded launch workdir resumes into its cwd", () => {
  expect(tail(launch(machine(), {}, "resume", null))).toEqual(["resume", "--cd", A, ID]);
});

// `tap launch codex <name> --resume=<id>` reopens the conversation under action "new" and is just as unattended when
// the seat is launched detached, so it names its destination too; the bare picker has no id to key on and someone at
// the keyboard to answer, so it stays bare.
test("an exact launch names its destination like a resume; a picker launch stays bare", () => {
  expect(tail(launch(machine(), { launch_resume: "exact" }, "new"))).toEqual(["resume", "--cd", B, ID]);
  expect(tail(launch(machine(), { launch_resume: "picker", harness_session_id: null }, "new"))).toEqual(["resume"]);
  expect(launch(machine(), { launch_resume: "exact" }, "new")).not.toContain("--session-id");
});

test("the destination rides ahead of a trailing prompt, and the model flags stay in place", () => {
  const record: SessionRecord = { name: "seat", harness: "codex", cwd: A, launch_workdir: B, base: "team", model: "gpt-6.1-sol", harness_session_id: ID };
  const argv = launchInvocation("resume", record, new Notices(), { env: machine(), resume: ID, prompt: "carry on", notify: false }).argv;
  expect(argv.slice(-4)).toEqual(["--cd", B, ID, "carry on"]);
});

// A directory chosen anywhere in the FINAL argv is the seat's own choice and is never contradicted, whatever TOML spelling it used.
const OWN: [string, Partial<SessionRecord>][] = [
  ["--cd in the tail", { harness_tail: ["--cd", A] }],
  ["--cd= in the tail", { harness_tail: ["--cd=" + A] }],
  ["-C in the passthrough", { harness_passthrough: ["-C", A] }],
  ["-c tui.resume_cwd=session in the tail", { harness_tail: ["-c", "tui.resume_cwd=session"] }],
  ["-c tui.resume_cwd quoted in the passthrough", { harness_passthrough: ["-c", 'tui.resume_cwd="session"'] }],
  ["joined --config= in the tail", { harness_tail: ['--config=tui.resume_cwd="session"'] }],
  ["whitespace around = in the tail", { harness_tail: ["-c", 'tui.resume_cwd = "session"'] }],
];
test.each(OWN)("a directory the seat's own flags already chose is not contradicted: %s", (_label, own) => {
  const argv = launch(machine(), own);
  expect(argv).not.toContain(B);
  // Exactly what the seat wrote, nothing of ours beside it.
  expect(argv.filter(token => token === "--cd" || token.startsWith("--cd="))).toHaveLength((own.harness_tail ?? []).filter(token => token.startsWith("--cd")).length);
  expect(argv.slice(argv.indexOf("resume"), argv.indexOf(ID) + 1)).toEqual(["resume", ID]);
});

test.each([
  ["a policy --cd param", 'params = { cd = "' + A + '" }', A],
  ["a policy tui.resume_cwd config param", `params = { config = ['tui.resume_cwd="session"'] }`, 'tui.resume_cwd="session"'],
] as const)("a directory chosen by machine policy params is not contradicted: %s", (_label, line, expected) => {
  const argv = launch(machine(`version=3\n[harness.codex]\n${line}\n`));
  expect(argv).not.toContain(B);
  expect(argv).toEqual(expect.arrayContaining([expected]));
  expect(argv.slice(argv.indexOf("resume"), argv.indexOf(ID) + 1)).toEqual(["resume", ID]);
});

test("fresh launches and forks never pass --cd", () => {
  expect(launch(machine(), {}, "new")).not.toContain("--cd");
  expect(launch(machine(), { fork_source_session_id: ID }, "fork")).not.toContain("--cd");
});

test("other harnesses' resumes are untouched", () => {
  for (const harness of ["claude", "opencode"]) expect(launch(machine(), { harness }, "resume")).not.toContain("--cd");
});
