/**
 * tap-opencode-session-start.ts — OpenCode SessionStart-equivalent adapter:
 * ensure-bound + shared context injection (tap-9kvd bind, tap-sh9g context).
 *
 * Claude, Codex, and Cursor share runtime/bun/src/session-start.ts (see
 * tmp/design/35m-reachability-routability.md §7). OpenCode has no SessionStart
 * hook, so a native OpenCode resume leaves the seat REACHABLE (its pane is
 * alive) but UNROUTABLE (the registry seat is unbound or stale): the tap-35m
 * orphan class, worst for the glm seat. This plugin closes that gap by porting
 * the SHIPPED Part-1 ensure-bound fallback verbatim: a bare, idempotent
 * `tap in` at the SessionStart-equivalent.
 *
 * CONTEXT INJECTION (tap-sh9g). On the first successful bind of a root session
 * the plugin produces the SAME context the other harnesses get — through the
 * one shared producer, never a second one: it spawns
 * `runtime/bun/src/session-start.ts context <root>` (empty stdin, so the
 * producer's shouldBind stays false and this plugin's bind remains the only
 * bind) and posts the lines into the session as ONE noReply user message. The
 * write path is the documented plugin `client` SDK; the parked-mail line from
 * the bind receipt rides in the same message as its own part,
 * replacing the separate parked-hint post. System-prompt injection
 * (`experimental.chat.system.transform`) is deliberately NOT used: tap-a51
 * recorded mutations that never reached the model (1.17.18/1.18.4; re-test
 * trigger not fired), while the noReply prompt path is the one this plugin has
 * always trusted.
 *
 * Title and dedupe semantics (both load-bearing):
 *   - The posted part is `synthetic: true` (sdk TextPartInput). An ordinary
 *     user part would make the TAP block a second "real" user message and
 *     suppress session title generation forever (opencode generates a title
 *     only when history holds exactly one real user message). Synthetic parts
 *     still reach the model; only `ignored` parts are dropped from history.
 *   - Injected parts carry `metadata: { tap: "session-context" }` (stable
 *     identity) or `{ tap: "session-parked" }` (transient hint). Before
 *     posting, the plugin lists session messages and posts only what changed:
 *     the identity block restacks when its tagged text differs, the hint when
 *     it differs from the last hint surfaced. The hint is drained by poll, so
 *     folding it into the context key would restack the whole block on the
 *     next resume after a poll. An identical hint text stays
 *     suppressed by design: without session state a same-string hint is
 *     indistinguishable from the one already surfaced, and `tap poll` still
 *     finds the mail. A resume into a fresh process (new plugin instance,
 *     empty in-memory state) must not restack the block, and an identity
 *     CHANGE must announce itself with one fresh block. Dedupe lives in the
 *     session, never in process-local state.
 *   - Scan failure fails CLOSED (no post; the next process retries): a missed
 *     injection is recovered on the next resume, a double injection is noise
 *     in every conversation. Post failure fails open (never surfaces into
 *     OpenCode's event loop).
 *
 * Skills discovery is deliberately NOT copied from codex's CODEX_SKILLS text
 * line: opencode surfaces install.sh-linked skills natively, and a static
 * root list would drift from link_user_skills reality.
 *
 * ARRIVAL TIMING (honest shape): on the launcher's preminted `--session` arm
 * the post lands before any user turn exists — the block precedes the first
 * model request by construction (not wire-probed). A session created by its
 * first submit (bare TUI, one-shot `opencode run`) binds and posts WHILE the
 * first turn is in flight, so the model first sees the block on the extra
 * turn the stored noReply message causes: opencode's turn loop runs one more
 * model turn whenever the latest user message is newer than the last
 * assistant reply (session/prompt.ts:1111-1129 @ 1.18.31). The wire smoke's
 * 3.5s hold exists to make exactly that follow-up request deterministic.
 *
 * OpenCode's SessionStart-equivalent is the first lifecycle event that carries
 * this pane's ROOT session id. OpenCode always carries a session id, so every
 * such fire is identity-bearing — the trigger matrix's (§3.1) "resume|clear|
 * startup WITH identity -> bind (identity path)" row. We therefore do not (and
 * cannot) distinguish resume from a fresh start, and do not need to. What we
 * DO honor from the matrix LAW:
 *
 *   - No identity, no bind. `tap in` never runs at plugin init when no session
 *     id exists yet (bare splash), or on any non-session event — the "startup
 *     WITHOUT identity -> NO bind" floor. Attaching to a preminted `--session`
 *     IS identity: session.created/updated do not fire on that path (tap-cpfu),
 *     and Bun rewrites process.argv to the worker script, so init reads
 *     `--session` from the kernel argv of this pid.
 *   - Root sessions only. Sub-agent sessions carry a parentID; binding one
 *     would restamp the pane seat with a child's id, so we skip anything with
 *     a parentID. The same skip governs injection.
 *   - Ladder inherited VERBATIM. `tap in` IS the shared register path; this
 *     plugin invents no hook-only reclaim and never attests identity (bind !=
 *     trust; a quarantined id stays quarantined — a quarantine is not laundered by a
 *     SessionStart fire).
 *   - No consent machinery / sticky markers (that call is still undecided — bead
 *     tap-9kvd).
 *   - Bare `tap in` (registry bind only). This plugin never writes the launcher
 *     manifest and does not call the launcher restamp verb.
 *
 * Fail-open always: outside tmux (no pane to bind), outside a TAP repo (no
 * bus), or on any error, every event is a silent no-op. It must never brick an
 * OpenCode start.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const BIND_TIMEOUT_MS = 5000
const CONTEXT_TIMEOUT_MS = 5000
// The text-mode receipt line from runtime/bun/src/verbs/register.ts.
const PARKED_HINT = /^tap register: \d+ parked message\(s\) for you; next: tap poll \S+$/m
// metadata tags marking THIS plugin's injected parts; the dedupe keys. The
// stable identity context and the transient parked-mail hint dedupe
// separately (see the header: a drained hint must never read as a context
// change, and a fresh hint must surface without restacking the context).
const CONTEXT_TAG = "session-context"
const PARKED_TAG = "session-parked"
// Test/override pin for the shared context producer (session-start.ts).
const CONTEXT_ENTRY_OVERRIDE = "TAP_SESSION_CONTEXT_ENTRY"

// tap-cpfu: preminted `--session` is startup WITH identity; session.created does
// not fire. Bun's process.argv is the worker script (`bun /$bunfs/.../worker.js`),
// not opencode's flags. The sibling helper reads `--session` from argv or from
// this pid's kernel args. Fail CLOSED: missing helper, nonzero, or empty stdout
// means no init bind — the plugin waits for session.created/updated as before.
function sessionIdFromHelper(args: string[]): string {
  try {
    const sibling = join(dirname(fileURLToPath(import.meta.url)), "tap-opencode-session-id")
    if (!existsSync(sibling)) return ""
    const out = spawnSync(sibling, args, { encoding: "utf8", timeout: 2000 })
    if (out.error || out.status !== 0) return ""
    return (out.stdout || "").trim()
  } catch {
    return ""
  }
}

function sessionIdAtInit(): string {
  return (
    sessionIdFromHelper(["from-argv", ...process.argv]) ||
    sessionIdFromHelper(["from-pid", String(process.pid)])
  )
}

// A resolver is an argv prefix: the install wrapper (or an override) runs as a
// program; a checkout's native entry runs under bun with its `resolve` mode.
type Resolver = string[]
const NATIVE_ENTRY = join("runtime", "bun", "src", "session-start.ts")
const nativeResolver = (entry: string): Resolver => ["bun", entry, "resolve"]

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

  if (rootResolver && rootResolver.length === 3 && rootResolver[2] === "resolve") {
    const entry = rootResolver[1]
    if (entry && entry.endsWith("session-start.ts") && existsSync(entry)) return ["bun", entry]
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

type PromptPart = { type: "text"; text: string; synthetic?: boolean; metadata?: Record<string, unknown> }

// The shared producer: `context <root>` with stdin ignored. Empty stdin keeps
// shouldBind false (session-start.ts), so THIS plugin's bind stays the only
// bind and the producer never restamps identity. No OPENCODE_SESSION_ID here:
// the producer binds nothing and reads no session id. Bounded, fail-open.
function runContextEntry(entry: Resolver, root: string): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof Bun.spawn>
    try {
      const [program, ...prefix] = entry
      child = Bun.spawn([program!, ...prefix, "context", root], {
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

// The latest injected part's text per tag, or undefined when the scan fails
// (fail CLOSED on dedupe: a missed injection is retried by the next process;
// a double injection is conversation noise). Assumes the API's chronological
// message order: the last tagged part across the listing is the newest.
async function latestTaggedTexts(
  client: unknown,
  sessionID: string,
): Promise<{ context?: string; parked?: string } | undefined> {
  const res = await (client as { session: { messages: (o: unknown) => Promise<{ data?: unknown }> } })
    .session.messages({ path: { id: sessionID } })
  // The generated SDK resolves { error } instead of throwing on HTTP failures.
  // An error response (or any non-array listing) is an unreadable scan — the
  // caller must treat it as "unknown" and NOT post, or the fail-closed dedupe
  // becomes a double-injection engine.
  if (!Array.isArray(res?.data)) return undefined
  const rows = res.data
  let context: string | undefined
  let parked: string | undefined
  for (const row of rows) {
    const parts = (row as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const p = part as { type?: unknown; text?: unknown; metadata?: unknown }
      if (p?.type !== "text" || typeof p.text !== "string") continue
      const meta = p.metadata as { tap?: unknown } | undefined
      if (meta && meta.tap === CONTEXT_TAG) context = p.text
      else if (meta && meta.tap === PARKED_TAG) parked = p.text
    }
  }
  return { context, parked }
}

/**
 * APPROVAL STATE (tap-rlebf.2 U8). OpenCode's Reject answers every pending
 * permission in the session, so TAP's approval timeout may press Escape only
 * when this plugin proves the timed request is the only one pending, in a
 * root session. The plugin records the pending set per pane under the TAP
 * index home, rewritten on asked/replied events and on a 30 s heartbeat while
 * anything is pending (a prompt waiting out its timeout emits no events). One
 * timer, started on the first pending request and cleared when none remain.
 * Any failure writes nothing, and the watcher then reads "unproven".
 */
// OpenCode invokes every runtime export as a plugin factory. Keep helpers
// private; exercise them through the default plugin's event hook in tests.
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
    onEvent(event: { type?: string; properties?: Record<string, unknown> }): void {
      const p = event.properties ?? {}
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = p.info as { id?: string; parentID?: string } | undefined
        if (info?.id) roots.set(info.id, !info.parentID)
        return
      }
      if (event.type === "permission.asked") {
        const id = String(p.id ?? ""), sessionID = String(p.sessionID ?? "")
        if (!id || !sessionID) return
        const patterns = Array.isArray(p.patterns) ? p.patterns.map(String) : []
        pending.set(id, { sessionID, summary: patterns[0] ?? String(p.permission ?? "") })
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

export default (async ({ client, directory, worktree, $ }) => {
  if (process.env.TAP_STATELESS === "1") return {};
  const statePath = approvalStatePath(process.env)
  let openCodeVersion: string | null = null
  const approvals = statePath === null ? null : approvalStateTracker({
    path: statePath, pid: process.pid, ppid: process.ppid, now: () => Math.floor(Date.now() / 1000),
    version: () => {
      if (openCodeVersion === null) {
        try {
          const r = spawnSync(process.execPath, ["--version"], { encoding: "utf8", timeout: 5000 })
          openCodeVersion = r.status === 0 ? (r.stdout ?? "").trim() : ""
        } catch { openCodeVersion = "" }
      }
      return openCodeVersion
    },
  })
  // Resolved once per process: the bus root, the context entry, and whether we
  // have a pane to bind. If root or tmux is absent, every event is a cheap
  // no-op (self-silence outside TAP / tmux).
  const root =
    findBusRoot(directory, directory, worktree || "") ??
    (worktree ? findBusRoot(worktree, directory, worktree) : undefined)
  const inTmux = !!process.env.TMUX
  const contextEntry = resolveContextEntry(resolveSessionRootResolver(directory, worktree || ""))

  const bound = new Set<string>() // root session ids proven bound (exit 0) — steady state
  const inflight = new Set<string>() // binds in progress — guards concurrent duplicates

  // Posts the shared context (plus the bind's parked-mail line) into the root
  // session once, as ONE noReply message, on the bind that first succeeds.
  // Called exactly once per session per process — the `bound` set gates the
  // success continuation — so cross-process dedupe is the in-session scan.
  // Unawaited so the bind continuation never waits on the server.
  function surfaceContext(sessionID: string, receipt: string): void {
    const run = (async (): Promise<void> => {
      if (!root) return
      const parked = PARKED_HINT.exec(receipt)?.[0] ?? ""
      const lines = contextEntry ? (await runContextEntry(contextEntry, root)).trim() : ""
      if (!lines && !parked) return
      const latest = await latestTaggedTexts(client, sessionID)
      if (latest === undefined) return
      // Each stream dedupes on its own tag; one noReply message carries only
      // what changed.
      const parts: PromptPart[] = []
      if (lines && latest.context !== lines)
        parts.push({ type: "text", text: lines, synthetic: true, metadata: { tap: CONTEXT_TAG } } satisfies PromptPart)
      if (parked && latest.parked !== parked)
        parts.push({ type: "text", text: parked, synthetic: true, metadata: { tap: PARKED_TAG } } satisfies PromptPart)
      if (!parts.length) return
      try {
        await (client as { session: { prompt: (o: unknown) => Promise<unknown> } }).session.prompt({
          path: { id: sessionID },
          body: { noReply: true, parts },
        })
      } catch {
        // fail-open: delivery is advisory; `tap poll` still finds the mail
      }
    })()
    run.catch(() => {})
  }

  async function ensureBound(sessionID: string): Promise<void> {
    if (!sessionID || bound.has(sessionID) || inflight.has(sessionID)) return
    if (!root || !inTmux) return
    inflight.add(sessionID)
    try {
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
      const bind: Promise<number> = (async (): Promise<{ code: number; text: string }> => {
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
      })().catch(() => ({ code: -1, text: "" })).then(({ code, text }) => {
        // The guard releases OpenCode startup, not the running bind. Observe
        // late success and suppress duplicates until the actual child exits;
        // a late bind still surfaces its context (and parked line) here.
        if (code === 0) {
          bound.add(sessionID)
          surfaceContext(sessionID, text)
        }
        inflight.delete(sessionID)
        return code
      })
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

  const argvSession = sessionIdAtInit()
  if (argvSession) {
    await ensureBound(argvSession)
  }

  return {
    event: async ({ event }) => {
      try {
        approvals?.onEvent(event as { type?: string; properties?: Record<string, unknown> })
      } catch {
        // fail-open: approval bookkeeping never surfaces into OpenCode's event loop
      }
      try {
        // Only session lifecycle events that carry full info (root/child + directory).
        // session.idle/status carry only a sessionID with no parentID, so we cannot
        // prove they are root — created/updated are the identity-bearing triggers.
        if (event.type === "session.created" || event.type === "session.updated") {
          const info = event.properties.info
          if (!info || info.parentID) return // no info, or a sub-agent session -> skip
          await ensureBound(info.id)
        }
      } catch {
        // fail-open: a bind error must never surface into OpenCode's event loop
      }
    },
  }
}) satisfies Plugin
