import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The SDK is optional at runtime: the installed plugin is a plain v2 definition.
const plugin = (await import(new URL("../../../hooks/tap-opencode-session-start.ts", import.meta.url).pathname)).default;
const KEY = "session-context/ses_root";
const CONTEXT = "TAP: registered as oc-seat on team t.";
const PARKED = "tap register: 2 parked message(s) for you; next: tap poll oc-seat";
type Synthetic = { sessionID: string; id: string; text: string; resume: boolean; metadata: Record<string, unknown> };
type NativeEvent = { type: string; data: Record<string, any> };

// Delivery acknowledges after the plugin consumes an event, including its async work.
function stream() {
  let next: ((value: IteratorResult<NativeEvent>) => void) | undefined;
  let consumed: (() => void) | undefined;
  return {
    subscribe: ({ signal }: { signal: AbortSignal }) => ({
      [Symbol.asyncIterator]() {
        signal.addEventListener("abort", () => { next?.({ done: true, value: undefined }); consumed?.(); });
        return { next: () => { consumed?.(); consumed = undefined;
          return new Promise<IteratorResult<NativeEvent>>(resolve => { next = resolve; }); } };
      },
    }),
    send: (value: NativeEvent) => new Promise<void>(resolve => {
      if (!next) throw new Error("subscription not started");
      consumed = resolve;
      const deliver = next; next = undefined; deliver({ done: false, value });
    }),
  };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 4000;
  while (!predicate() && Date.now() < end) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

type Options = {
  parked?: boolean; context?: string; contextDelay?: boolean; slow?: boolean; failBind?: boolean;
  readFails?: boolean; postFails?: boolean; updateFails?: boolean;
  metadata?: Record<string, any>; parentID?: string; stateless?: boolean; shared?: boolean;
  parentArgs?: string; foreignDirectory?: boolean;
};
async function fixture(run: (f: {
  prompt: (sessionID?: string) => Promise<void>; event: (e: NativeEvent) => Promise<void>;
  posts: Synthetic[]; updates: Record<string, any>[]; count: () => number;
  release: () => void; succeed: () => void; metadata: Record<string, any>;
  setContext: (text: string) => void;
  approval: () => any; stop: () => Promise<void>; contextArgs: () => string;
}) => Promise<void>, options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "oc-bind-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const calls = join(root, "calls"), released = join(root, "release"), status = join(root, "status");
  writeFileSync(status, options.failBind ? "1" : "0");
  if (!options.slow) writeFileSync(released, "");
  writeFileSync(join(bin, "resolver"), '#!/bin/sh\nprintf "%s\\n" "$TAP_TEST_BIND_ROOT"\n', { mode: 0o755 });
  writeFileSync(join(bin, "tap"), `#!/bin/sh
printf '%s\\n' "$OPENCODE_SESSION_ID" >> "$TAP_TEST_BIND_ROOT/calls"
while [ ! -f "$TAP_TEST_BIND_ROOT/release" ]; do sleep 0.02; done
${options.parked ? `echo '${PARKED}'` : "true"}
exit "$(cat "$TAP_TEST_BIND_ROOT/status")"
`, { mode: 0o755 });
  writeFileSync(join(root, "context-text"), options.context ?? "");
  writeFileSync(join(bin, "context"), `#!/bin/sh
printf '%s\\n' "$@" >> "$TAP_TEST_BIND_ROOT/context-calls"
[ "$1" = ${options.shared ? "context-shared" : "context-private"} ] && [ "$3" = "$TAP_TEST_BIND_ROOT" ] || exit 1
${options.shared ? 'while [ ! -f "$TAP_TEST_BIND_ROOT/release" ]; do sleep 0.02; done\n[ "$(cat "$TAP_TEST_BIND_ROOT/status")" = 0 ] || exit 1\n' : '[ "$2" = ses_root ] || exit 1\n'}${options.contextDelay ? "sleep 0.2" : "true"}
cat "$TAP_TEST_BIND_ROOT/context-text"
`, { mode: 0o755 });
  const overrides = { PATH: `${bin}:${process.env.PATH}`, TMUX: "/nonexistent/oc-bind-test,1,0", TMUX_PANE: "%7",
    TAP_TEST_BIND_ROOT: root, TAP_SESSION_ROOT_RESOLVER: join(bin, "resolver"),
    TAP_SESSION_CONTEXT_ENTRY: join(bin, "context"), TAP_INDEX_HOME: join(root, "index"),
    TAP_STATELESS: options.stateless ? "1" : "0" };
  const before = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const events = stream(), posts: Synthetic[] = [], updates: Record<string, any>[] = [];
  const metadata = structuredClone(options.metadata ?? {});
  let prompt: ((sessionID?: string) => Promise<void>) | undefined;
  let stop: (() => Promise<void> | void) | undefined;
  const originalSpawn = childProcess.spawnSync;
  const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath")!, originalArgv = process.argv;
  if (options.shared) {
    Object.defineProperty(process, "execPath", { ...originalExecPath, value: "/path with spaces/opencode" });
    process.argv = ["/path with spaces/opencode", "serve", "--service"];
  }
  const ps = spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[], opts: any) => {
    if (command !== "ps") return originalSpawn(command, args, opts);
    const own = args[1] === String(process.pid);
    const stdout = own ? `opencode serve ${options.shared ? "--service" : "--stdio --port 0"}` : options.parentArgs ?? "opencode --standalone";
    return { status: 0, stdout, stderr: "", pid: 1, output: [], signal: null };
  }) as typeof childProcess.spawnSync);
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      if (options.readFails) throw new Error("session unreadable");
      return { id: sessionID, parentID: options.parentID, location: { directory: options.foreignDirectory ? join(root,"other") : root }, metadata };
    },
    synthetic: async (input: Synthetic) => {
      if (options.postFails) throw new Error("admission refused");
      posts.push(input); return { data: { id: input.id } };
    },
    hook: async (name: string, callback: (e: { sessionID: string }) => Promise<void>) => {
      expect(name).toBe("prompt"); prompt = (sessionID = "ses_root") => callback({ sessionID });
    },
  };
  try {
    stop = await plugin.setup({ app: { version: "2.1.2" }, location: { directory: root }, session, event: events,
      storage: {
        get: async (key: string) => { if (options.readFails) throw new Error("storage unreadable"); return metadata[key]; },
        set: async (key: string, value: any) => {
          if (options.updateFails) throw new Error("write refused");
          updates.push(value); metadata[key] = value;
        },
      },
    });
    await run({ prompt: async sessionID => { await prompt?.(sessionID); }, event: events.send, posts, updates, metadata,
      count: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0,
      release: () => writeFileSync(released, ""), succeed: () => writeFileSync(status, "0"),
      setContext: text => writeFileSync(join(root, "context-text"), text),
      approval: () => JSON.parse(readFileSync(join(root, "index/approval-timeout/opencode/7.json"), "utf8")),
      contextArgs: () => existsSync(join(root, "context-calls")) ? readFileSync(join(root, "context-calls"), "utf8") : "",
      stop: async () => { await stop?.(); stop = undefined; } });
  } finally {
    writeFileSync(released, ""); await stop?.(); ps.mockRestore();
    Object.defineProperty(process, "execPath", originalExecPath); process.argv = originalArgv;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("v2 plugin loads as a stable definition and stateless setup has no effects", async () => {
  expect(plugin.id).toBe("tap.session-start");
  await fixture(async f => { await f.prompt(); expect(f.count()).toBe(0); expect(f.posts).toHaveLength(0); }, { stateless: true });
});

test("root prompt binds once and injects one synthetic without starting a reply", async () => {
  await fixture(async f => {
    await f.prompt(); await until(() => f.posts.length === 1); await f.prompt();
    expect(f.count()).toBe(1);
    expect(f.posts[0]).toMatchObject({ sessionID: "ses_root", resume: false, text: `${CONTEXT}\n\n${PARKED}` });
    expect(f.posts[0]!.id).toMatch(/^msg_/);
    expect(f.metadata[KEY]).toMatchObject({ context: CONTEXT, parked: PARKED });
    expect(f.metadata.other).toEqual({ keep: true });
  }, { parked: true, context: CONTEXT, metadata: { other: { keep: true } } });
});

test("session.created binds a root but a child never binds or receives context", async () => {
  await fixture(async f => {
    await f.event({ type: "session.created", data: { sessionID: "ses_root" } });
    await until(() => f.posts.length === 1); expect(f.count()).toBe(1);
  }, { context: CONTEXT });
  await fixture(async f => { await f.prompt(); expect(f.count()).toBe(0); expect(f.posts).toHaveLength(0); },
    { context: CONTEXT, parentID: "ses_parent" });
});

test("failed bind backs off for a minute while successful bind stays single-flight", async () => {
  const realNow=Date.now;let offset=0;const clock=spyOn(Date,"now").mockImplementation(()=>realNow()+offset);
  try {
    await fixture(async f => {
      await f.prompt(); expect(f.count()).toBe(1); expect(f.posts).toHaveLength(0);
      for(let i=0;i<4;i++)await f.prompt();expect(f.count()).toBe(1);
      f.succeed();offset=60001;await f.prompt();await until(()=>f.posts.length===1);
      await f.prompt();expect(f.count()).toBe(2);
    }, {failBind:true,context:CONTEXT});
  } finally {clock.mockRestore()}
});

test("-s init binds and admits context before setup resolves without a prompt",async()=>{
  await fixture(async f=>{expect(f.count()).toBe(1);expect(f.posts).toHaveLength(1);expect(f.posts[0]?.text).toBe(CONTEXT)},
    {parentArgs:"opencode --standalone -s ses_root",context:CONTEXT});
});

test("a prompt joins an event's in-flight bind and context before returning", async () => {
  await fixture(async f => {
    const event = f.event({ type: "session.created", data: { sessionID: "ses_root" } });
    await until(() => f.count() === 1);
    await f.prompt();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.text).toBe(CONTEXT);
    expect(f.count()).toBe(1);
    await event;
  }, { context: CONTEXT, contextDelay: true });
});
test("init refuses non-TUI parents, child sessions and foreign directories",async()=>{
  for(const parentArgs of ["bash -s ses_root","opencode serve --stdio -s ses_root"])
    await fixture(async f=>{await f.prompt();expect(f.count()).toBe(0);expect(f.posts).toHaveLength(0)}, {parentArgs,context:CONTEXT});
  for(const option of [{parentID:"ses_parent"},{foreignDirectory:true}])
    await fixture(async f=>{expect(f.count()).toBe(0);expect(f.posts).toHaveLength(0)},
      {parentArgs:"opencode --standalone -s ses_root",context:CONTEXT,...option});
});

test("bind beyond the startup guard records late success without a second child", async () => {
  await fixture(async f => {
    const started = Date.now(); await f.prompt();
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    await Promise.all(Array.from({ length: 12 }, () => f.prompt())); expect(f.count()).toBe(1);
    f.release(); await until(() => f.posts.length === 1); await f.prompt(); expect(f.count()).toBe(1);
  }, { slow: true, parked: true });
}, 20000);

test("durable session storage suppresses an unchanged block after restart or compaction", async () => {
  let metadata: Record<string, any> = {};
  await fixture(async f => { await f.prompt(); await until(() => f.updates.length === 1); metadata = f.metadata; },
    { context: CONTEXT, parked: true });
  await fixture(async f => { await f.prompt(); await Bun.sleep(100); expect(f.posts).toHaveLength(0); },
    { context: CONTEXT, metadata });
});

test("changed identity announces once; unchanged parked hint is independent", async () => {
  await fixture(async f => {
    await f.prompt(); await until(() => f.posts.length === 1);
    expect(f.posts[0]!.text).toBe(CONTEXT);
    expect(f.metadata[KEY].parked).toBe(PARKED);
  }, { context: CONTEXT, parked: true, metadata: { [KEY]: { id: "msg_old", context: "old identity", parked: PARKED } } });
});

test("new parked hint posts alone without restacking unchanged identity", async () => {
  await fixture(async f => {
    await f.prompt(); await until(() => f.posts.length === 1); expect(f.posts[0]!.text).toBe(PARKED);
  }, { context: CONTEXT, parked: true, metadata: { [KEY]: { id: "msg_old", context: CONTEXT } } });
});

test("no context or parked line means no synthetic input", async () => {
  await fixture(async f => { await f.prompt(); await Bun.sleep(100); expect(f.count()).toBe(1); expect(f.posts).toHaveLength(0); });
});

test("context retries after a successful bind never repeat registration", async () => {
  const realNow = Date.now; let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  try {
    await fixture(async f => {
      await f.prompt(); expect(f.count()).toBe(1); expect(f.posts).toHaveLength(0);
      offset = 60001; await f.prompt();
      expect(f.count()).toBe(1); expect(f.posts).toHaveLength(0);
      f.setContext(CONTEXT); offset = 120002;
      await f.prompt();
      expect(f.count()).toBe(1); expect(f.posts[0]?.text).toBe(CONTEXT);
    });
    offset = 0;
    await fixture(async f => {
      await f.prompt(); expect(f.count()).toBe(1);
      offset = 60001; await f.prompt();
      expect(f.count()).toBe(1); expect(f.posts).toHaveLength(0);
    }, { context: CONTEXT, postFails: true });
  } finally { clock.mockRestore(); }
});

test("unreadable session fails closed and failed admission does not advance dedupe", async () => {
  await fixture(async f => { await f.prompt(); expect(f.count()).toBe(0); expect(f.posts).toHaveLength(0); },
    { readFails: true, context: CONTEXT });
  await fixture(async f => { await f.prompt(); await Bun.sleep(100); expect(f.updates).toHaveLength(0); },
    { postFails: true, context: CONTEXT });
});

test("storage-write failure retries the same native id after restart", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    await fixture(async f => {
      await f.prompt(); await until(() => f.posts.length === 1); ids.push(f.posts[0]!.id);
      expect(f.updates).toHaveLength(0);
    }, { updateFails: true, context: CONTEXT });
  }
  expect(ids[0]).toBe(ids[1]);
});

test("v2 permission events track resources and clean up the heartbeat on unload", async () => {
  const intervals = spyOn(globalThis, "setInterval"), clears = spyOn(globalThis, "clearInterval");
  try {
    await fixture(async f => {
      await f.event({ type: "session.created", data: { sessionID: "ses_root" } });
      await f.event({ type: "permission.asked", data: { id: "per_a", sessionID: "ses_root", action: "shell", resources: ["ls"] } });
      expect(f.approval()).toMatchObject({ version: "2.1.2", root: true, session: "ses_root", pending: [{ id: "per_a", summary: "ls" }] });
      expect(intervals).toHaveBeenCalledTimes(1);
      await f.event({ type: "permission.asked", data: { id: "per_b", sessionID: "ses_other", action: "shell", resources: ["pwd"] } });
      expect(f.approval()).toMatchObject({ session: "ses_other", root: false, other_sessions_pending: 1 });
      await f.event({ type: "permission.replied", data: { requestID: "per_b", sessionID: "ses_other", reply: "reject" } });
      expect(f.approval()).toMatchObject({ session: "ses_root", root: true, other_sessions_pending: 0 });
      await f.stop(); expect(clears).toHaveBeenCalledTimes(1);
    });
  } finally { intervals.mockRestore(); clears.mockRestore(); }
});

// A shared server can inherit another pane's TMUX state. It must never bind here.
test("shared service admits context per native root without binding or pane approval files", async () => {
  await fixture(async f => {
    await f.prompt(); await f.prompt(); await f.prompt("ses_other");
    expect(f.count()).toBe(0); expect(f.posts.map(p => p.sessionID)).toEqual(["ses_root", "ses_other"]);
    expect(f.contextArgs()).toContain("context-shared\nses_root\n");
    expect(() => f.approval()).toThrow();
  },
    { context: CONTEXT, shared: true });
});
test("shared first prompt awaits launcher context and concurrent prompts join that admission", async () => {
  await fixture(async f => {
    const first = f.prompt(), second = f.prompt();
    await Bun.sleep(50); expect(f.posts).toHaveLength(0); expect(f.count()).toBe(0);
    f.release(); await Promise.all([first, second]); expect(f.posts).toHaveLength(1);
  }, { context: CONTEXT, shared: true, slow: true });
});
test("failed shared verification cannot fabricate registration context", async () => {
  await fixture(async f => { await f.prompt(); expect(f.posts).toHaveLength(0); expect(f.count()).toBe(0); },
    { context: CONTEXT, shared: true, failBind: true });
});
