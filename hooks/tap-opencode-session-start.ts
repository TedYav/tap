/**
 * OpenCode 2 SessionStart adapter: bind the owning pane and admit shared TAP context.
 *
 * Only a private `serve --stdio` child of an OpenCode TUI owns a pane. The default
 * shared service may inherit another client's environment. Shared context uses
 * explicit native root sessions and launcher-owned bindings; it never calls
 * tap in or writes pane approval state. Private seats retain their TUI bind.
 *
 * A verified --session on the parent TUI supplies resume identity. New sessions
 * bind on session.created or prompt admission, after session.get proves they are
 * roots in this plugin's directory. No identity means no bind; children never
 * claim the root seat. `tap in` writes routing only, never the launcher manifest.
 * A first prompt may await the bind for up to five seconds. Failed attempts
 * retry at most once per minute per session. On the bare-TUI path context is
 * admitted asynchronously and may miss the first model step. Prepared-session
 * setup awaits context admission before releasing the TUI.
 *
 * Context comes from the shared session-start.ts producer. One native synthetic
 * input, resume:false and delivery:steer, carries only changed context/hint text.
 * It waits in the durable inbox until the next model step and cannot generate a
 * title or start an idle turn: OpenCode titles use the first `user` message.
 *
 * Dedupe is durable plugin storage keyed by native session ID, not process state
 * or active history (which compaction truncates). Identity and parked hints have
 * separate last-text keys; draining a hint never restacks identity. Forks get a
 * fresh key. The plugin ID is part of the storage address and must stay stable.
 * A deterministic, session-scoped synthetic ID makes an admit followed by a
 * failed storage write safe to retry. Only successful admission advances state.
 * Storage read failure fails closed; every other failure stays advisory. No
 * session metadata is rewritten, so other plugins keep ownership of their keys.
 */
import type { Plugin } from "@opencode/plugin"
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const BIND_TIMEOUT_MS = 5000
const CONTEXT_TIMEOUT_MS = 5000
// The text-mode receipt line from runtime/bun/src/verbs/register.ts.
const PARKED_HINT = /^tap register: \d+ parked message\(s\) for you; next: tap poll \S+$/m
// Test/override pin for the shared context producer (session-start.ts).
const CONTEXT_ENTRY_OVERRIDE = "TAP_SESSION_CONTEXT_ENTRY"

// The v2 server child has no --session flag: inspect its verified TUI parent.
// Never read an ancestor's session in shared-service mode or from an unrelated process.
function privateTuiArgs(): string[] | undefined {
  try {
    const args = (pid: number): string[] => {
      const result = spawnSync("ps", ["-p", String(pid), "-ww", "-o", "args="], { encoding: "utf8", timeout: 2000 })
      return result.status === 0 ? result.stdout.trim().split(/\s+/) : []
    }
    const own = args(process.pid), parent = args(process.ppid)
    const executable = (argv: string[]) => /^(?:opencode|opencode-v2)(?:\.exe)?$/.test(basename(argv[0] ?? ""))
    if (!executable(own) || !own.includes("serve") || !own.includes("--stdio") || own.includes("--service")) return
    if (!executable(parent) || parent.includes("serve") || parent.includes("--server")) return
    return parent
  } catch { return }
}

function sharedService(): boolean {
  return /^(?:opencode|opencode-v2)(?:\.exe)?$/.test(basename(process.execPath)) &&
    process.argv.includes("serve") && process.argv.includes("--service") && !process.argv.includes("--stdio")
}

function sessionIdAtInit(args: string[]): string {
  try {
    const helper = join(dirname(fileURLToPath(import.meta.url)), "tap-opencode-session-id")
    const result = spawnSync(helper, ["from-argv", ...args], { encoding: "utf8", timeout: 2000 })
    return result.status === 0 ? result.stdout.trim() : ""
  } catch { return "" }
}

// A resolver is an argv prefix: the install wrapper (or an override) runs as a
// program; a checkout's native entry runs under bun with its `resolve` mode.
type Resolver = string[]
const NATIVE_ENTRY = join("runtime", "bun", "src", "session-start.ts")
// TAP's own Bun config and no env file: the session's directory is not TAP's
// project (see runtime/bun/tap-bunfig.toml, beside the entry's src/ directory).
// Bun exits on a config path it cannot read, so a missing file becomes the
// empty device. This plugin is copied out of the checkout and cannot import
// the runtime's helper, so it carries the same rule.
const ownBunArgv = (entry: string): string[] => {
  const config = join(dirname(dirname(entry)), "tap-bunfig.toml")
  return ["bun", `--config=${existsSync(config) ? config : "/dev/null"}`, "--no-env-file"]
}
const nativeResolver = (entry: string): Resolver => [...ownBunArgv(entry), entry, "resolve"]

function walkUpCheckoutResolver(start: string): Resolver | undefined {
  let dir = start
  for (let i = 0; dir && i < 40; i++) {
    const cand = join(dir, NATIVE_ENTRY)
    if (existsSync(cand)) return nativeResolver(cand)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function resolverViaTapOnPath(): Resolver | undefined {
  const out = spawnSync(
    "bash",
    [
      "-c",
      `src=$(command -v tap) || exit 1
while [ -h "$src" ]; do
  dir=$(cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd)
  src=$(readlink "$src")
  case "$src" in /*) ;; *) src="$dir/$src" ;; esac
done
here=$(cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd)
echo "$here/../runtime/bun/src/session-start.ts"`,
    ],
    { encoding: "utf8", env: process.env },
  )
  if (out.status !== 0) return undefined
  const path = (out.stdout || "").trim()
  return path && existsSync(path) ? nativeResolver(path) : undefined
}

// Locate the session-root resolver without requiring `tap` on PATH (install bin
// may be off PATH). Order: env override → sibling install wrapper → walk-up
// from session directory hints → optional tap-on-PATH chase. One rule shared
// with Claude/Codex/Cursor: session-start.ts.
function resolveSessionRootResolver(...hints: string[]): Resolver | undefined {
  const override = process.env.TAP_SESSION_ROOT_RESOLVER
  if (override && existsSync(override)) return [override]

  try {
    const sibling = join(dirname(fileURLToPath(import.meta.url)), "tap-resolve-session-root")
    if (existsSync(sibling)) return [sibling]
  } catch {
    // import.meta.url unavailable — fall through
  }

  for (const hint of hints) {
    if (!hint) continue
    const hit = walkUpCheckoutResolver(hint)
    if (hit) return hit
  }

  return resolverViaTapOnPath()
}

// The context producer is the SAME session-start.ts entry, in `context <root>`
// mode. Discovery mirrors the resolver's order: env override → sibling install
// shim (a `context <root>` runner, written by install.sh next to the resolver
// shim) → the native entry derived from an already-resolved root resolver
// (["bun", entry, "resolve"] forms only; a single-program shim resolves roots,
// not contexts). Resolved once per process.
function resolveContextEntry(rootResolver: Resolver | undefined): Resolver | undefined {
  const override = process.env[CONTEXT_ENTRY_OVERRIDE]
  if (override && existsSync(override)) return [override]

  try {
    const sibling = join(dirname(fileURLToPath(import.meta.url)), "tap-session-context")
    if (existsSync(sibling)) return [sibling]
  } catch {
    // import.meta.url unavailable — fall through
  }

  if (rootResolver && rootResolver[0] === "bun" && rootResolver.at(-1) === "resolve") {
    const entry = rootResolver.at(-2)
    if (entry && entry.endsWith("session-start.ts") && existsSync(entry)) return [...ownBunArgv(entry), entry]
  }
  return undefined
}

// Walk up from a starting dir via the shared SessionStart ROOT resolver
// (flip-live enrolled stored loc — never mere .tap/ or a bus registry file).
function findBusRoot(start: string, ...hints: string[]): string | undefined {
  if (!start) return undefined
  const resolver = resolveSessionRootResolver(start, ...hints)
  if (!resolver) return undefined
  const [program, ...prefix] = resolver
  const out = spawnSync(program!, [...prefix, "walk", start], {
    encoding: "utf8",
    env: process.env,
    timeout: 5000,
  })
  if (out.error || (out.status !== null && out.status !== 0)) return undefined
  const root = (out.stdout || "").trim()
  return root || undefined
}

type ContextState = { id?: string; context?: string; parked?: string }

// context-private and context-shared read the launcher-activated native session.
// The producer never registers a seat. A timeout admits no identity text.
function runContextEntry(entry: Resolver, root: string, sessionID: string, mode: "private" | "shared" = "private"): Promise<string> {
  return new Promise((resolve) => {
    let child: Bun.Subprocess<"ignore", "pipe", "ignore">
    try {
      const [program, ...prefix] = entry
      child = Bun.spawn([program!, ...prefix, `context-${mode}`, sessionID, root], {
        cwd: root,
        env: { ...process.env, TAP_SKIP_VERSION_BRIEFING: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
    } catch {
      resolve("")
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, CONTEXT_TIMEOUT_MS)
    new Response(child.stdout).text().then(
      async (text) => {
        clearTimeout(timer)
        // A timed-out or failed child may still close its pipe with partial
        // bytes; only a clean exit earns delivery.
        const code = await child.exited
        resolve(code === 0 ? text : "")
      },
      () => {
        clearTimeout(timer)
        resolve("")
      },
    )
  })
}

/**
 * APPROVAL STATE (tap-rlebf.2 U8). The 2.x Reject key and sibling scope are not
 * attested; the watcher escalates without sending a key. The plugin retains
 * the pending set and root-session evidence per pane under the TAP
 * index home, rewritten on asked/replied events and on a 30 s heartbeat while
 * anything is pending (a prompt waiting out its timeout emits no events). One
 * timer, started on the first pending request and cleared when none remain.
 * Any failure writes nothing.
 */
// Helpers stay private; the only runtime export is the v2 plugin definition.
interface ApprovalStateOptions {
  path: string
  pid: number
  ppid: number
  version: () => string
  now: () => number
  heartbeatMs?: number
}
function approvalStateTracker(o: ApprovalStateOptions) {
  const roots = new Map<string, boolean>() // sessionID -> is a root session (seen info)
  const pending = new Map<string, { sessionID: string; summary: string }>()
  let timer: ReturnType<typeof setInterval> | null = null
  let session = ""
  function write(): void {
    try {
      const own = [...pending.entries()].filter(([, r]) => r.sessionID === session)
      const state = {
        v: 1, version: o.version(), pid: o.pid, ppid: o.ppid, at: o.now(), session,
        root: session !== "" && roots.get(session) === true,
        pending: own.map(([id, r]) => ({ id, summary: r.summary })),
        other_sessions_pending: pending.size - own.length,
      }
      mkdirSync(dirname(o.path), { recursive: true })
      const tmp = `${o.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 })
      renameSync(tmp, o.path)
    } catch {
      // silent: an unwritten proof is an unproven one
    }
  }
  function beat(): void {
    if (pending.size > 0 && timer === null) timer = setInterval(write, o.heartbeatMs ?? 30_000)
    if (pending.size === 0 && timer !== null) { clearInterval(timer); timer = null }
  }
  return {
    onEvent(event: { type?: string; data?: Record<string, unknown> }): void {
      const p = event.data ?? {}
      if (event.type === "session.created") {
        if (typeof p.sessionID === "string") roots.set(p.sessionID, !p.parentID)
        return
      }
      if (event.type === "permission.asked") {
        const id = String(p.id ?? ""), sessionID = String(p.sessionID ?? "")
        if (!id || !sessionID) return
        const resources = Array.isArray(p.resources) ? p.resources.map(String) : []
        pending.set(id, { sessionID, summary: resources[0] ?? String(p.action ?? "") })
        session = sessionID
      } else if (event.type === "permission.replied") {
        pending.delete(String(p.requestID ?? ""))
        // Retarget to the newest remaining request's session, so a request left pending
        // elsewhere can still earn its own single-request proof.
        if (![...pending.values()].some(r => r.sessionID === session)) session = [...pending.values()].pop()?.sessionID ?? session
      } else return
      write()
      beat()
    },
    stop(): void { if (timer !== null) { clearInterval(timer); timer = null } },
  }
}

/** The pane-keyed approval-state file the watcher reads (runtime/bun/src/approval-timeout-real.ts). */
function approvalStatePath(env: NodeJS.ProcessEnv): string | null {
  const pane = env.TMUX_PANE ?? ""
  if (!/^%\d+$/.test(pane)) return null
  return join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "approval-timeout", "opencode", `${pane.slice(1)}.json`)
}

export default {
  id: "tap.session-start",
  async setup(ctx) {
    if (process.env.TAP_STATELESS === "1") return
    const tuiArgs = privateTuiArgs()
    const shared = !tuiArgs && sharedService()
    if (!tuiArgs && !shared) return
    const directory = ctx.location.directory
    const statePath = shared ? null : approvalStatePath(process.env)
    const approvals = statePath === null ? null : approvalStateTracker({
      path: statePath, pid: process.pid, ppid: process.ppid, now: () => Math.floor(Date.now() / 1000),
      version: () => ctx.app.version,
    })
    // Resolved once per process: the bus root, the context entry, and whether we
    // have a pane to bind. If root or tmux is absent, every event is a cheap
    // no-op (self-silence outside TAP / tmux).
    const root = findBusRoot(directory, directory)
    const inTmux = !!process.env.TMUX
    const contextEntry = resolveContextEntry(resolveSessionRootResolver(directory))

    let snapshotAfter = 0
    let snapshotRun: Promise<void> | undefined
    function snapshotModels(): void {
      if ((shared ? bound.size === 0 : !root || !inTmux) || Date.now() < snapshotAfter) return
      snapshotAfter = Date.now() + 60_000
      snapshotRun = (async () => {
        const { data: models } = await ctx.model.list({ location: { directory } })
        const windows: Record<string, number> = {}
        for (const model of models) {
          if (Number.isSafeInteger(model.limit.context) && model.limit.context > 0)
            windows[`${model.providerID}/${model.id}`] = model.limit.context
        }
        const dir = join(process.env.TAP_INDEX_HOME || join(homedir(), ".tap"), "opencode-model-windows.d")
        mkdirSync(dir, { recursive: true })
        const path = join(dir, createHash("sha256").update(directory).digest("hex") + ".json")
        const scratch = `${path}.${process.pid}.tmp`
        writeFileSync(scratch, JSON.stringify({ directory, version: ctx.app.version,
          fetched_at: Math.floor(Date.now() / 1000), windows }) + "\n", { mode: 0o600 })
        renameSync(scratch, path)
      })().catch(() => { snapshotAfter = 0 })
    }

    const bound = new Set<string>() // root session ids proven bound (exit 0) — steady state
    const admitted = new Set<string>() // context delivery never controls registration retries
    const pendingReceipts = new Map<string, string>()
    const inflight = new Map<string, Promise<number>>() // concurrent prompts join the bind and context
    const retryAfter = new Map<string, number>()

    const bindRuns = new Set<Promise<number>>()
    const contextRuns = new Set<Promise<boolean>>()
    const sharedRuns = new Map<string, Promise<void>>()
    function surfaceContext(sessionID: string, receipt: string, supplied?: string): Promise<boolean> {
      const run = (async (): Promise<boolean> => {
        if (!root && !shared) return false
        const parked = PARKED_HINT.exec(receipt)?.[0] ?? ""
        const lines = supplied !== undefined ? supplied : contextEntry ? (await runContextEntry(contextEntry, root!, sessionID)).trim() : ""
        if (!lines && !parked) return false
        const key = `session-context/${sessionID}`
        const stored = await ctx.storage.get(key)
        if (stored !== undefined && (stored === null || typeof stored !== "object" || Array.isArray(stored))) return false
        const previous = (stored ?? {}) as ContextState
        const context = lines && previous.context !== lines ? lines : ""
        const hint = parked && previous.parked !== parked ? parked : ""
        if (!context && !hint) return true
        const text = [context, hint].filter(Boolean).join("\n\n")
        const id = "msg_" + createHash("sha256").update(JSON.stringify([sessionID, previous.id ?? "", text])).digest("hex")
        const metadata = { tap: "session-context", ...(context ? { context } : {}), ...(hint ? { parked: hint } : {}) }
        await ctx.session.synthetic({ sessionID, id, text, metadata, delivery: "steer", resume: false })
        await ctx.storage.set(key, { ...previous, id, ...(context ? { context } : {}), ...(hint ? { parked: hint } : {}) })
        return true
      })().catch(() => false)
      contextRuns.add(run)
      void run.finally(() => contextRuns.delete(run))
      return run
    }

    async function ensureBound(sessionID: string): Promise<void> {
      if (!sessionID || admitted.has(sessionID)) return
      if (!root || !inTmux) return
      try {
        let bind = inflight.get(sessionID)
        if (!bind) {
          if (bound.has(sessionID)) {
            bind = surfaceContext(sessionID, pendingReceipts.get(sessionID) ?? "").then(ok => {
              if (ok) { admitted.add(sessionID); pendingReceipts.delete(sessionID) }
              return 0
            })
          } else {
            // BOUNDARY (do not "complete" this into a restamp): this binds ROUTING ONLY —
            // a bare `tap in` that stamps the registry seat. Do NOT add a launcher manifest
            // restamp here. A hook-side restamp would make this a SECOND manifest writer — the
            // two-authorities failure the corpse/identity machinery exists to prevent (ruling,
            // tap-9kvd). This hook only ensures the pane is reachable→routable again
            // after a native resume.
            //
            // `tap in` reads OPENCODE_SESSION_ID for its registry identity capture; the pane is
            // derived from the inherited TMUX/TMUX_PANE. ONE rung: pick an executable by
            // availability (PATH `tap`, else install sibling `plugins/tap` → checkout
            // bin/tap), run it once, return its exit code unchanged. Never retry a
            // semantic nonzero through a second dispatcher, and never look under the
            // team root for a checkout courier (team root ≠ TAP install).
            const sh = $.env({ ...process.env, OPENCODE_SESSION_ID: sessionID, TAP_SKIP_VERSION_BRIEFING: "1" }).cwd(root).nothrow()
            bind = (async (): Promise<{ code: number; text: string }> => {
              const which = spawnSync("bash", ["-c", "command -v tap"], {
                encoding: "utf8",
                env: process.env,
              })
              let tapCmd = (which.stdout || "").trim()
              if (!tapCmd) {
                try {
                  const sibling = join(dirname(fileURLToPath(import.meta.url)), "tap")
                  if (existsSync(sibling)) tapCmd = sibling
                } catch {
                  // fall through
                }
              }
              if (!tapCmd) return { code: -1, text: "" }
              // Absolute sibling path: invoke via bash so Bun does not require it on PATH.
              //
              // `< /dev/null` is load-bearing (tap-kq65d root cause, 2026-09-02). Bun's `$`
              // hands the child OUR stdin, which under the launcher is the pane tty; stdout and
              // stderr are already sockets under .quiet(). `bin/tap` execs a Bun runtime, and a
              // Bun (or Node) process snapshots the termios of every std fd that is a tty at
              // startup and writes that snapshot back at exit, whether or not it changed the
              // mode (Node src/node.cc ResetStdio; Bun bun_restore_stdio, oven-sh/bun#29592).
              // Under `--session` OpenCode starts this plugin BEFORE the TUI sets raw mode, so
              // when the bind outlives BIND_TIMEOUT_MS (the race does not cancel it) the tap
              // process exits AFTER the TUI went raw and puts the pane back into cooked mode:
              // the kernel echoes every key, Enter arrives as a newline, and the seat is
              // submit-dead from birth. With no tty on any std fd there is nothing to snapshot.
              const out =
                tapCmd.includes("/")
                  ? await sh`bash ${tapCmd} in < /dev/null`.quiet()
                  : await sh`tap in < /dev/null`.quiet()
              return { code: out.exitCode, text: out.stdout.toString() }
            })().catch(() => ({ code: -1, text: "" })).then(async ({ code, text }) => {
              // The guard releases OpenCode startup, not the running bind. Observe
              // late success and suppress duplicates until the actual child exits;
              // a late bind still surfaces its context (and parked line) here.
              if (code === 0) {
                bound.add(sessionID)
                pendingReceipts.set(sessionID, text)
                if (await surfaceContext(sessionID, text)) { admitted.add(sessionID); pendingReceipts.delete(sessionID) }
              }
              return code
            })
          }
          bind = bind.finally(() => inflight.delete(sessionID))
          inflight.set(sessionID, bind)
          const started = bind
          bindRuns.add(started)
          void started.finally(() => bindRuns.delete(started))
        }
        let timer: ReturnType<typeof setTimeout>
        const guard = new Promise<number>((resolve) => {
          timer = setTimeout(() => resolve(-1), BIND_TIMEOUT_MS)
        })
        await Promise.race([bind, guard])
        clearTimeout(timer!)
      } catch {
        // Shell setup failed before a child was started; a later event may retry.
        inflight.delete(sessionID)
      }
    }

    async function bindRoot(sessionID: string): Promise<void> {
      if (shared) {
        if (!sessionID || bound.has(sessionID) || !contextEntry) return
        const existing = sharedRuns.get(sessionID)
        if (existing) return existing
        const run = (async () => {
          const info = await ctx.session.get({ sessionID })
          if (!info || info.parentID || info.location.directory !== directory) return
          // This read-only helper proves service ancestry, then waits boundedly
          // for the launcher's active row. It never registers or promotes it.
          const lines = (await runContextEntry(contextEntry, directory, sessionID, "shared")).trim()
          if (lines && await surfaceContext(sessionID, "", lines)) bound.add(sessionID)
        })().catch(() => {})
        sharedRuns.set(sessionID, run)
        try { await run } finally { sharedRuns.delete(sessionID) }
        return
      }
      try {
        if (!sessionID || admitted.has(sessionID)) return
        if (inflight.has(sessionID)) { await ensureBound(sessionID); return }
        if (Date.now() < (retryAfter.get(sessionID) ?? 0)) return
        retryAfter.set(sessionID, Date.now() + 60_000)
        const info = await ctx.session.get({ sessionID })
        if (!info || info.parentID || info.location.directory !== directory) return
        approvals?.onEvent({ type: "session.created", data: { sessionID } })
        await ensureBound(sessionID)
      } catch { /* no readable root identity, no bind */ }
    }

    const controller = new AbortController()
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          approvals?.onEvent(event)
          if (event.type === "session.created") await bindRoot(event.data.sessionID)
        } catch { /* event bookkeeping never breaks OpenCode */ }
      }
    })().catch(() => {})
    await ctx.session.hook("prompt", async event => { await bindRoot(event.sessionID); snapshotModels() })
    if (tuiArgs) await bindRoot(sessionIdAtInit(tuiArgs))
    await Promise.all(contextRuns)
    return async () => {
      controller.abort()
      approvals?.stop()
      await events
      await Promise.all(bindRuns)
      await Promise.all(sharedRuns.values())
      await Promise.all(contextRuns)
      await snapshotRun
    }
  },
} satisfies Plugin.Plugin
