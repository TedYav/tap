// tap-gridx: who a nudge note is from. The operator path is a prompt, never a
// flag: only a caller with no derivable seat, at an interactive terminal, who
// answers yes, sends as the reserved `user`. The I/O seams stand in for the
// terminal; nudge-interrupt-live.test.ts answers the real prompt in a tmux pane.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TapError, type ResolvedContext } from "../src/context";
import { OPERATOR_QUESTION, readLine, resolveNudgeSender, type SenderIo } from "../src/verbs/nudge-sender";

const dir = mkdtempSync(join(tmpdir(), "tap-nudge-sender-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const registryPath = join(dir, "team-registry.json");
writeFileSync(registryPath, JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: {
  ua: { status: "active", pane: "ua:0.0" },
  rs: { status: "suspended", pane: "rs:0.0" },
} }));
const ctx = { team: "alpha", registryPath, bus: { home: join(dir, "bus") } } as unknown as ResolvedContext;

function io(opts: { tty?: boolean; answer?: string | null; self?: string; paneSeat?: string; resolve?: () => ResolvedContext } = {}): SenderIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    env: { TAP_HOME: "/pinned", ...(opts.self ? { TAP_SELF: opts.self } : {}) },
    interactive: () => opts.tty ?? false,
    ask: question => { asked.push(question); return opts.answer === undefined ? "" : opts.answer; },
    paneSeat: () => opts.paneSeat ?? "",
    resolve: opts.resolve ?? (() => ctx),
  };
}
const refusal = (fn: () => unknown): string => {
  try { fn(); return ""; } catch (e) { return `${(e as TapError).errorClass}: ${(e as TapError).detail} | next: ${(e as TapError).action}`; }
};

test("a person at a terminal who says yes (Enter, y, yes) sends as the operator", () => {
  for (const answer of ["", "y", "Y", "yes", " y "]) {
    const terminal = io({ tty: true, answer });
    expect(resolveNudgeSender({ from: "" }, ctx, terminal)).toMatchObject({ handle: "user", user: true, team: "alpha" });
    expect(terminal.asked).toEqual([OPERATOR_QUESTION]);
  }
  expect(OPERATOR_QUESTION).toBe("No TAP seat in this terminal. Send this nudge as you (the operator)? [Y/n] ");
});

test("a team that moves while the operator is asked refuses after the answer (Codex)", () => {
  const moved = { ...ctx, bus: { home: "/elsewhere" } } as unknown as ResolvedContext;
  const here = { ...ctx, bus: { home: "/here" } } as unknown as ResolvedContext;
  expect(refusal(() => resolveNudgeSender({ from: "" }, here, io({ tty: true, resolve: () => moved }))))
    .toContain("team_moved: team 'alpha' changed while the operator was asked (bus /here -> /elsewhere); nothing sent");
  const retired = () => { throw new TapError(1, "unknown_team", "", "team 'alpha' is not enrolled"); };
  expect(refusal(() => resolveNudgeSender({ from: "" }, here, io({ tty: true, resolve: retired }))))
    .toContain("team_moved: team 'alpha' changed while the operator was asked (team 'alpha' is not enrolled); nothing sent");
  expect(resolveNudgeSender({ from: "" }, here, io({ tty: true, resolve: () => here }))).toMatchObject({ handle: "user" });
});

test("anything else, or EOF, aborts with nothing sent", () => {
  for (const answer of ["n", "no", "nope", "q", null]) {
    expect(refusal(() => resolveNudgeSender({ from: "" }, ctx, io({ tty: true, answer })))).toContain("cancelled: not sent as the operator; nothing sent");
  }
});

test("the answer is a whole line: EOF before the newline is no answer, never consent", () => {
  const from = (text: string) => {
    const bytes = Buffer.from(text); let at = 0;
    return (buffer: Buffer) => at < bytes.length ? (buffer[0] = bytes[at++]!, 1) : 0;
  };
  expect(readLine(from("y\n"))).toBe("y");
  expect(readLine(from("\n"))).toBe("");
  for (const partial of ["y", "yes", "  ", ""]) expect(readLine(from(partial))).toBeNull();
  expect(readLine(() => { throw new Error("EIO"); })).toBeNull();
});

test("no terminal, no prompt: the refusal names the recoveries that work", () => {
  const terminal = io({ tty: false });
  const why = refusal(() => resolveNudgeSender({ from: "" }, ctx, terminal));
  expect(why).toContain("unregistered_sender: this terminal is not a registered seat and is not interactive");
  expect(why).toContain("next: pass --from <seat|team/seat>, or run from an interactive terminal to send as the operator");
  expect(terminal.asked).toEqual([]);
});

test("a dry run at a terminal previews the operator and asks nothing", () => {
  const terminal = io({ tty: true });
  expect(resolveNudgeSender({ from: "", dryRun: true }, ctx, terminal)).toMatchObject({ handle: "user", wouldPrompt: true });
  expect(terminal.asked).toEqual([]);
});

test("a derivable seat never prompts: --from, then TAP_SELF, then the calling pane", () => {
  const terminal = io({ tty: true, self: "rs", paneSeat: "ua" });
  expect(resolveNudgeSender({ from: "alpha/ua" }, ctx, terminal)).toMatchObject({ handle: "ua", user: false });
  expect(resolveNudgeSender({ from: "" }, ctx, io({ tty: true, paneSeat: "ua" }))).toMatchObject({ handle: "ua", user: false });
  expect(resolveNudgeSender({ from: "" }, ctx, io({ tty: true, self: "ua", paneSeat: "zz" }))).toMatchObject({ handle: "ua" });
  // A derived seat that is not active refuses; it does not fall through to the operator.
  expect(refusal(() => resolveNudgeSender({ from: "" }, ctx, terminal))).toContain("sender 'rs' is not an active seat on team 'alpha'");
  expect(terminal.asked).toEqual([]);
});

test("a team that still has a seat named user refuses the operator before asking", () => {
  const legacyPath = join(dir, "legacy-registry.json");
  writeFileSync(legacyPath, JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: { user: { status: "active", pane: "u:0.0" } } }));
  const terminal = io({ tty: true });
  const why = refusal(() => resolveNudgeSender({ from: "" }, { team: "alpha", registryPath: legacyPath } as unknown as ResolvedContext, terminal));
  expect(why).toContain("reserved_handle: team 'alpha' has a seat named 'user'");
  expect(why).toContain("must re-register under another handle");
  expect(terminal.asked).toEqual([]);
});

test("the operator identity cannot be named as --from", () => {
  expect(refusal(() => resolveNudgeSender({ from: "user" }, ctx, io({ tty: true })))).toContain("reserved_handle: 'user' is the reserved operator identity");
});

test("a target team that still has a seat named user refuses the operator before asking", () => {
  const remote = join(dir, "remote-registry.json");
  writeFileSync(remote, JSON.stringify({ schema: "0.20", team: { name: "beta" }, seats: { user: { status: "active", pane: "u:0.0" } } }));
  const terminal = io({ tty: true });
  const why = refusal(() => resolveNudgeSender({ from: "", targetRegistries: [remote] }, ctx, terminal));
  expect(why).toContain("reserved_handle: team 'beta' has a seat named 'user'");
  expect(terminal.asked).toEqual([]);
});

// Partner review: an unreadable tmux inventory (here permission denied, with
// a controlling tty observed and TMUX unset) must refuse, never read as "no
// seat here" and open the operator prompt. The real paneSeat, in a child whose
// ps and tmux are fakes.
test("a terminal TAP cannot observe refuses rather than offering the operator prompt", () => {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nprintf '1 ttys123\\n'\n", { mode: 0o700 });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\necho 'permission denied' >&2\nexit 1\n", { mode: 0o700 });
  const source = join(import.meta.dir, "../src/verbs/nudge-sender.ts");
  const code = `import { REAL_SENDER_IO } from ${JSON.stringify(source)};
try { console.log("SEAT:" + REAL_SENDER_IO.paneSeat({ team: "alpha", registryPath: ${JSON.stringify(registryPath)} })); }
catch (e) { console.log("REFUSED:" + e.errorClass + ":" + e.detail); }`;
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX; delete env.TMUX_PANE;
  const r = spawnSync(process.execPath, ["--eval", code], { encoding: "utf8", env });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain("REFUSED:unregistered_sender:cannot tell whether this terminal is a seat");
  expect(r.stdout).not.toContain("SEAT:");
});
