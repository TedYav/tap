import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envelopeField, stampEnvelope, type Routing } from "../src/envelope";
import { removeScratchTree } from "./support/scratch";

const MAIN = join(import.meta.dir, "..", "main.ts");
const NATIVE_REPLY = join(import.meta.dir, "support", "native-reply-entry.ts");
const SOCKET = `tapbun-reply-race-${Math.random().toString(36).slice(2, 8)}`;
const TEAM = "replyrace";
let root: string;
let wt: string;
let bus: string;
let index: string;
let bindir: string;

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    TAP_HOME: bus,
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(index, "sessions.json"),
    OPENCODE_DB_PATH: join(index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(index, "version-seen.json"),
    TAP_LOCK_DIR: join(root, "locks"),
    TAP_TMUX_SOCKET: SOCKET,
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    TAP_SELF: undefined,
  } as NodeJS.ProcessEnv;
}

function tap(...args: string[]) {
  return Bun.spawnSync(["bun", MAIN, ...args], { cwd: wt, env: env(), stdout: "pipe", stderr: "pipe" });
}

function nativeReply(...args: string[]) {
  return Bun.spawnSync(["bun", NATIVE_REPLY, ...args], { cwd: wt, env: env(), stdout: "pipe", stderr: "pipe" });
}

function tmux(...args: string[]) {
  return Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
}

function waitForPaneReady(seat: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pane = tmux("display-message", "-p", "-t", `${seat}:0.0`, "#{pane_id}");
    const band = tmux("capture-pane", "-p", "-t", `${seat}:0.0`);
    if (pane.exitCode === 0 && band.exitCode === 0 && band.stdout.toString().includes("›")) return;
    Bun.sleepSync(25);
  }
  throw new Error(`pane ${seat}:0.0 did not reach its input prompt within 15s`);
}

function seedInbound(id: string, extra: Partial<Routing> = {}) {
  const path = join(bus, "payloads", `${id}.md`);
  writeFileSync(path, stampEnvelope("---\n---\nquestion\n", {
    id, from: "ua", to: "ub", kind: "discuss", path, reply: "expected", ...extra,
  }));
  return path;
}

function outboundIds(from: string, to: string): string[] {
  return readdirSync(join(bus, "payloads"))
    .filter((name) => name.endsWith(".md"))
    .filter((name) => {
      const raw = readFileSync(join(bus, "payloads", name), "utf8");
      return envelopeField(raw, "from") === from && envelopeField(raw, "to") === to;
    })
    .sort();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tap-reply-race."));
  wt = join(root, TEAM);
  bus = join(wt, ".tap", "bus");
  index = join(root, "index");
  bindir = join(root, "bin");
  for (const dir of [join(bus, "payloads"), join(bus, "receipts"), index, bindir]) mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", wt]);

  const realTmux = Bun.which("tmux");
  if (!realTmux) throw new Error("reply race control requires tmux");
  writeFileSync(join(bindir, "tmux"), `#!/bin/sh\nexec ${realTmux} -L "${SOCKET}" "$@"\n`, { mode: 0o755 });

  const bash = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash",
    ...(process.platform === "linux" ? [Bun.which("bash") ?? ""] : [])].find((path) => path && existsSync(path));
  if (!bash) throw new Error("reply race control requires a copyable bash (non-system on macOS)");
  copyFileSync(bash, join(bindir, "claude"));
  Bun.spawnSync(["chmod", "+x", join(bindir, "claude")]);
  writeFileSync(join(root, "agent.sh"),
    'log="${FAKE_AGENT_LOG:?}"; : > "$log"\n' +
    "printf '\\n\\xe2\\x80\\xba '\n" +
    "while IFS= read -r line; do printf '%s\\n' \"$line\" >> \"$log\"; printf '\\n[submitted]\\n\\n\\xe2\\x80\\xba '; done\n");

  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: { [TEAM]: { root: wt, registry_location: join(wt, ".tap", "team-registry.json"), state: "registered" } },
  }));
  writeFileSync(join(wt, ".tap", "team-registry.json"), JSON.stringify({
    schema: "0.20", team: { name: TEAM, worktree_root: wt }, seats: {},
  }));

  for (const seat of ["ua", "ub"]) {
    tmux("new-session", "-d", "-s", seat, "-c", wt,
      "-e", `FAKE_AGENT_LOG=${join(root, `${seat}.log`)}`,
      `claude ${join(root, "agent.sh")}`);
  }
  waitForPaneReady("ua");
  waitForPaneReady("ub");
  expect(tap("register", "ua", "--pane", "ua:0.0").exitCode).toBe(0);
  expect(tap("register", "ub", "--pane", "ub:0.0").exitCode).toBe(0);
  // This control proves reply serialization and canonical settlement. Keep
  // the outbound on the bus; pane delivery and shared parking have other tests.
  const registryPath = join(wt, ".tap", "team-registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.seats.ua.delivery = "poll";
  writeFileSync(registryPath, JSON.stringify(registry));
}, 30_000);

afterAll(() => {
  tmux("kill-server");
  removeScratchTree(root);
});

describe("reply settlement serialization", () => {
  test("an invalid inbound keeps reply's help action", () => {
    const id = "ua-20260825T035959Z-000000000000";
    const path = join(bus, "payloads", `${id}.md`);
    writeFileSync(path, "not an envelope\n");
    const before = new Set(outboundIds("ub", "ua"));

    const result = nativeReply(id, "-m", "must not escape", "--by", "ub");
    const created = outboundIds("ub", "ua").filter((out) => !before.has(out));

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("next: tap help reply");
    expect(created).toEqual([]);
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("a wrong actor is directed to reply, not settle without answering", () => {
    const id = "ua-20260825T035959Z-111111111111";
    seedInbound(id);

    const result = nativeReply(id, "-m", "must not escape", "--by", "ua");

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`next: tap reply ${id} --by ub`);
    expect(result.stderr.toString()).not.toContain("next: tap done");
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("concurrent replies emit one outbound and one settlement", async () => {
    const id = "ua-20260825T040000Z-dddddddddddd";
    // This control races native replies to an existing canonical ask.
    // Public send may park in the Bash spool before native reply can read it.
    seedInbound(id);

    const readyDir = join(root, "reply-ready");
    const release = join(root, "reply-release");
    mkdirSync(readyDir);
    const children = Array.from({ length: 8 }, (_, i) => {
      const source = `
        import { existsSync, writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(join(readyDir, `ready.${i}`))}, "ready\\n");
        while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(5);
        const result = Bun.spawnSync([
          "bun", ${JSON.stringify(NATIVE_REPLY)}, ${JSON.stringify(id)},
          "-m", ${JSON.stringify(`answer ${i}`)}, "--by", "ub",
        ], { cwd: ${JSON.stringify(wt)}, stdout: "inherit", stderr: "inherit" });
        process.exit(result.exitCode ?? 1);
      `;
      return Bun.spawn(["bun", "-e", source], { env: env(), stdout: "pipe", stderr: "pipe" });
    });
    const deadline = Date.now() + 15_000;
    while (Array.from(new Bun.Glob("ready.*").scanSync(readyDir)).length !== children.length) {
      if (Date.now() >= deadline) throw new Error("reply contenders did not all reach the release barrier");
      Bun.sleepSync(10);
    }
    writeFileSync(release, "go\n");
    const codes = await Promise.all(children.map((child) => child.exited));
    await Promise.all(children.map((child) => new Response(child.stdout).text()));
    const childErrors = await Promise.all(children.map((child) => new Response(child.stderr).text()));

    expect(codes.filter((code) => code === 0), childErrors.join("\n")).toHaveLength(1);
    expect(codes.filter((code) => code !== 0)).toHaveLength(7);

    const outbound = readdirSync(join(bus, "payloads"))
      .filter((name) => name.endsWith(".md") && name !== `${id}.md`)
      .map((name) => readFileSync(join(bus, "payloads", name), "utf8"))
      .filter((raw) => envelopeField(raw, "from") === "ub" && envelopeField(raw, "to") === "ua");
    expect(outbound).toHaveLength(1);
    expect(envelopeField(outbound[0]!, "reply")).toBe("settle-only");

    const done = JSON.parse(readFileSync(join(bus, "receipts", `${id}.done`), "utf8"));
    expect(done.via).toBe("reply");
    expect(outbound[0]).toContain(`id: ${done.reply_id}`);
  }, 30_000);

  test("wrong-team same-handle actor refuses before sending", () => {
    const id = "ua-20260825T090000Z-eeeeeeeeeeee";
    const path = seedInbound(id, { to_team: "foreign" });
    const before = new Set(outboundIds("ub", "ua"));

    const result = nativeReply(id, "-m", "must not escape", "--by", "ub");
    const created = outboundIds("ub", "ua").filter((out) => !before.has(out));

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("addressed to 'foreign/ub'");
    expect(created).toEqual([]);
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("fresh same-handle actor refuses predecessor-bound mail before sending", () => {
    const id = "ua-20260825T090000Z-ffffffffffff";
    const path = seedInbound(id, { recipient_instance: "ub|predecessor" });
    const before = new Set(outboundIds("ub", "ua"));

    const result = nativeReply(id, "-m", "must not escape", "--by", "ub");
    const created = outboundIds("ub", "ua").filter((out) => !before.has(out));

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bound to recipient instance 'ub|predecessor'");
    expect(created).toEqual([]);
    expect(existsSync(join(bus, "receipts", `${id}.done`))).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});
