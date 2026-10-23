import { inheritedActor } from "../context";
import { armSelfRecovery } from "../self-rebrief";
// `tap refresh` — native seat refresh cutover (tap-3xj1, Diagnostics U3b).
//
// Ported 1:1 from the deleted skills/tap/scripts/tap-refresh.sh. The verb owns
// its exit surface: 0 refreshed | 1 usage/refusal (nothing happened) | 3 the
// preflight spool scan was unstable | 6 refreshed but a sender notice failed |
// 7 the clear COMPLETED and the retirement was refused (context gone, instance
// retained) | 8 the mechanism replaced the process and could not confirm it
// came back | 9 SELF: clear submitted, wake queued, reset unwitnessable |
// 10 SELF: clear submitted, wake did NOT land. Engine codes pass through
// unchanged except the ones refresh has claimed (7 -> 8 from the peer clear).
//
// Ordering invariant (the two defects this lane fixed): everything that
// RESOLVES THE ROW happens before the instance is retired — A preflight under
// the lock, B the clear with the row intact, C one locked retire+MINT-IN-PLACE,
// D notify. Retirement is a mint, not a deletion.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callingPane, resolveContext, resolveSelf, type ResolvedContext } from "../context";
import { envelopeField } from "../envelope";
import { ensureAscii } from "../fsatomic";
import { mintId } from "../ids";
import { pyReadUtf8 } from "../spool-publication";
import { REGISTRY_MAX_BUFFER } from "../spawn";
import {
  ensureSeatInstance,
  saveRegistry,
  type RegistryDoc,
  type Seat,
} from "../registry";
import { acquireRegistryLock } from "../panelock";
import { withActingRegistry } from "../registry-tx";
import { TapError } from "../context";
import { courierArgv } from "../courier-argv";

const VERB = "tap refresh";

interface Obligation {
  id: string;
  peer: string;
  peerTeam?: string;
  spooled?: boolean;
}

/** Raised inside the registry action; carries refresh's own exit code + stderr. */
class RefreshExit {
  constructor(readonly code: number, readonly stderr = "") {}
}

class SpoolUnstable {
  constructor(readonly ids: string[]) {}
}

// --- incumbent mirror: tap_frontmatter.frontmatter ----------------------------
// A payload file is readable fields ONLY when it opens with a `---` fence;
// anything else (missing, unreadable, unfenced) is an empty read, which is what
// makes the spool residency check below fail closed.
function frontmatterRaw(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  let i = 0;
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return "";
  const kept: string[] = [];
  for (i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (line === "---") return `---\n${kept.join("\n")}\n---`;
    kept.push(line);
  }
  return "";
}

function fieldOf(raw: string, key: string): string {
  return envelopeField(raw, key) ?? "";
}

// tap_frontmatter.list_payload_paths: `*.md`, excluding drafts (`_*.md`) and
// dotfiles, sorted by filename.
function scanPayloads(payloadsDir: string): { ident: string; path: string; raw: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(payloadsDir);
  } catch {
    return [];
  }
  const out: { ident: string; path: string; raw: string }[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name.startsWith("_") || !name.endsWith(".md")) continue;
    const path = join(payloadsDir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ ident: name.slice(0, -3), path, raw: frontmatterRaw(path) });
  }
  return out;
}

// tap_frontmatter.addressed_to_local (tap-18so / tap-w66z): empty `to_team` is
// the legacy handle-only contract; a stamped foreign team is outbound relay and
// never reads as local inbox. The local team is ctx.team from resolveContext —
// never the acting document's team.name and never a worktree basename (the
// Selector seam addendum on this port).
export function addressedToLocalFields(fields: Record<string, string>, handle: string, localTeam: string): boolean {
  if ((fields.to ?? "") !== handle) return false;
  const toTeam = (fields.to_team ?? "").trim();
  if (toTeam && toTeam !== localTeam.trim()) return false;
  return true;
}

function addressedToLocal(raw: string, handle: string, localTeam: string): boolean {
  return addressedToLocalFields({ to: fieldOf(raw, "to"), to_team: fieldOf(raw, "to_team") }, handle, localTeam);
}

// tap_frontmatter.sender_instance_matches: unstamped mail stays visible; when
// instance filtering is live, stamped mail is visible only to the matching
// current instance.
export function senderInstanceMatchesFields(fields: Record<string, string>, handle: string, currentInstance: string, filterInstances: boolean): boolean {
  if ((fields.from ?? "") !== handle) return false;
  if (!filterInstances) return true;
  const bound = fields.sender_instance ?? "";
  return !bound || (Boolean(currentInstance) && bound === currentInstance);
}

function senderInstanceMatches(raw: string, handle: string, currentInstance: string, filterInstances: boolean): boolean {
  return senderInstanceMatchesFields(
    { from: fieldOf(raw, "from"), sender_instance: fieldOf(raw, "sender_instance") },
    handle, currentInstance, filterInstances,
  );
}

// Obligations belong to the CURRENT instance only (KTD-16): unstamped admitted,
// stamped visible only on a bound match, and with no scope to check a filter
// can only hide real mail (poll's polarity).
function mine(raw: string, key: string, scope: string): boolean {
  const bound = fieldOf(raw, key);
  if (!bound || !scope) return true;
  return bound === scope;
}

// tap_frontmatter.scan_spool_sender_rows, natively: enumerate live spool
// identities from the union of `*.meta.json` and non-draft `*.md` names; parse
// each through queued -> canonical -> queued; a payload classifiable from
// neither residency while its sidecar remains is UNSTABLE (fail closed). The
// meta-missing retry covers successful redelivery leaving canonical stable.
function spoolSenderRows(spoolDir: string, payloadsDir: string, handle: string, currentInstance: string, filterInstances: boolean): {
  rows: { ident: string; id: string; peer: string; raw: string }[];
  unstable: string[];
} {
  const identities = new Set<string>();
  if (existsSync(spoolDir)) {
    try {
      for (const name of readdirSync(spoolDir)) {
        if (name.startsWith(".")) continue;
        if (name.endsWith(".meta.json")) identities.add(name.slice(0, -10));
        else if (name.endsWith(".md")) identities.add(name.slice(0, -3));
      }
    } catch {
      return { rows: [], unstable: [] };
    }
  }
  const rows: { ident: string; id: string; peer: string; raw: string }[] = [];
  const unstable: string[] = [];
  for (const ident of [...identities].sort()) {
    const meta = join(spoolDir, `${ident}.meta.json`);
    const queued = join(spoolDir, `${ident}.md`);
    const canonical = join(payloadsDir, `${ident}.md`);
    let raw = "";
    // Recheck the first residency after the second: a single move cannot escape
    // this sequence; promote-then-demote keeps meta present and is caught below.
    for (const candidate of [queued, canonical, queued]) {
      const candidateRaw = frontmatterRaw(candidate);
      if (candidateRaw) {
        raw = candidateRaw;
        break;
      }
    }
    if (!raw && !existsSync(meta)) raw = frontmatterRaw(canonical);
    if (!raw || !fieldOf(raw, "from")) {
      if (existsSync(meta)) unstable.push(ident);
      continue;
    }
    if (senderInstanceMatches(raw, handle, currentInstance, filterInstances)) {
      rows.push({ ident, id: fieldOf(raw, "id") || ident, peer: fieldOf(raw, "to"), raw });
    }
  }
  return { rows, unstable };
}

// The refresh-specific obligation scan: canonical payloads, then spool rows,
// then canonical again — a redelivery's sidecar removal and the canonical
// payload it leaves behind must be observed on one side or the other.
function obligations(
  payloadsDir: string,
  receiptsDir: string,
  spoolDir: string,
  handle: string,
  scope: string,
  localTeam: string,
): { owed: Obligation[]; waiting: Obligation[] } {
  const owed: Obligation[] = [];
  const waiting: Obligation[] = [];
  const seen = new Set<string>();
  const settled = (ident: string) => existsSync(join(receiptsDir, `${ident}.done`));
  const scanned = scanPayloads(payloadsDir);
  for (const { ident, raw } of scanned) {
    if (settled(ident)) continue;
    const idOut = fieldOf(raw, "id") || ident;
    if (addressedToLocal(raw, handle, localTeam) && mine(raw, "recipient_instance", scope)) {
      // from_team rides with the FIRST scan too: rows entered into `seen` here
      // are never re-read by the second scan, so a cross-team sender noticed
      // only there would be notified without its team prefix and misrouted.
      owed.push({ id: idOut, peer: fieldOf(raw, "from"), peerTeam: fieldOf(raw, "from_team") });
    } else if (fieldOf(raw, "from") === handle && mine(raw, "sender_instance", scope)) {
      waiting.push({ id: idOut, peer: fieldOf(raw, "to") });
    }
  }
  for (const m of owed) seen.add(m.id);
  for (const m of waiting) seen.add(m.id);
  const { rows, unstable } = spoolSenderRows(spoolDir, payloadsDir, handle, scope, Boolean(scope));
  if (unstable.length > 0) throw new SpoolUnstable(unstable);
  for (const row of rows) {
    if (settled(row.ident)) continue;
    if (!seen.has(row.ident)) {
      seen.add(row.ident);
      waiting.push({ id: row.ident, peer: row.peer, spooled: true });
    }
  }
  for (const { ident, raw } of scanPayloads(payloadsDir)) {
    if (settled(ident)) continue;
    const idOut = fieldOf(raw, "id") || ident;
    if (seen.has(idOut)) continue;
    if (addressedToLocal(raw, handle, localTeam) && mine(raw, "recipient_instance", scope)) {
      seen.add(idOut);
      owed.push({ id: idOut, peer: fieldOf(raw, "from"), peerTeam: fieldOf(raw, "from_team") });
    } else if (fieldOf(raw, "from") === handle && mine(raw, "sender_instance", scope)) {
      seen.add(idOut);
      waiting.push({ id: idOut, peer: fieldOf(raw, "to") });
    }
  }
  return { owed, waiting };
}

function renderObligations(owed: Obligation[], waiting: Obligation[], withPeerTeam = false): string[] {
  const lines: string[] = [];
  for (const m of owed) {
    const peer = withPeerTeam && m.peer && m.peerTeam ? `${m.peerTeam}/${m.peer}` : m.peer;
    lines.push(`  owed to ${peer || "-"}: ${m.id}  (they are waiting on this seat)`);
  }
  for (const m of waiting) {
    lines.push(`  awaiting ${m.peer || "-"}: ${m.id}  (this seat is waiting on them)`);
  }
  return lines;
}

// registry_v20.write_tombstone, natively: full last row + instance + retired_by
// under <team_dir>/.tap/team-history, one file per retirement event, written
// through the canonical atomic registry writer.
function writeTombstone(teamDir: string, handle: string, row: Seat): string {
  const historyDir = join(teamDir, ".tap", "team-history");
  const instance = row.instance;
  if (typeof instance !== "string" || !instance) {
    throw new TapError(1, "registry_invalid", "tap doctor", "tombstone requires row instance");
  }
  mkdirSync(historyDir, { recursive: true });
  const now = new Date();
  const iso = now.toISOString();
  const ts = iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const retiredAt = iso.replace(/\.\d{3}Z$/, "Z");
  const retiredBy = mintId("refresh");
  const safeEvent = retiredBy.replaceAll("/", "_").replaceAll(" ", "_");
  const path = join(historyDir, `${handle}.${safeEvent}.${ts}.json`);
  saveRegistry(path, {
    handle,
    instance,
    retired_by: retiredBy,
    retired_at: retiredAt,
    row: { ...row },
  });
  return path;
}

/**
 * The peer clear, in-process. `tap clear`'s own output reaches the operator;
 * refresh only claims the EXIT CODE, never the text. The clear selects its scope
 * fresh (revalidated through the index) but pinned to refresh's own team (its
 * --team, or the calling pane's team), so preflight, clear and retirement never
 * mix teams (tap-djlri), and the clear refuses `team_moved` before any effect
 * when that fresh selection differs from this context's, so Phase C never
 * follows a destructive clear against a moved registry; the caller pane still
 * comes from the tty walk, so a refresh run inside the target's own pane still
 * refuses.
 */
async function peerClear(handle: string, ctx: ResolvedContext): Promise<number> {
  const { cmdClearNative } = await import("../launcher/replace");
  // An enrolled team is pinned by name; a custom TAP_HOME bus (authority "bus") has no index row
  // to pin, so the clear re-resolves the same way and the expected scope still guards it.
  const team = ctx.selection?.authority === "enrolled" ? ctx.team : undefined;
  try { return await cmdClearNative([handle], process.env, { team, expect: { root: ctx.root, registryPath: ctx.registryPath, busHome: ctx.bus.home } }); }
  catch (error) {
    console.error(`tap clear: ${error instanceof TapError ? error.detail : String(error)}`);
    return error instanceof TapError ? error.code : 1;
  }
}

function selfClear(ctx: ResolvedContext, scriptsDir: string): number {
  try { return armSelfRecovery({ verb: "clear" }, ctx, scriptsDir); }
  catch (error) {
    // Preserve refresh's exit translation when the in-process engine refuses.
    console.error(`self: ${error instanceof TapError ? error.detail : String(error)}`);
    return error instanceof TapError ? error.code : 1;
  }
}

// The self engine's exit surface, translated (tap-8w0p / tap-utpn): refresh
// owns both arms' codes; anything unclaimed passes through.
function translateSelfRc(clearRc: number, handle: string, fresh: boolean): { code: number; stderr: string } {
  switch (clearRc) {
    case 8:
      return {
        code: 9,
        // Under --fresh "nothing was retired" is not a per-run miss: a self clear
        // can never witness its own reset, so this route never reaches
        // retirement. Say so, and name the route that can (tap-pfkz).
        stderr: `tap refresh: '${handle}' native clear/recovery observer armed; reset remains UNVERIFIED. End the initiating turn and inspect the receipt. Nothing was retired.`
          + (fresh
            ? ` --fresh from the seat itself can never retire its instance: a self refresh re-briefs this instance but cannot witness its own reset, so re-running will not change that. To retire it, after the pending recovery completes, ask a peer to run 'tap refresh ${handle} --fresh' (it still refuses while obligations are unsettled).`
            : ""),
      };
    case 7:
      return {
        code: 10,
        stderr: `tap refresh: '${handle}' WAS told to clear — that half is queued and not undoable — but its recovery wake did NOT land, so nothing will start the seat's next turn. Nothing was retired and no sender was told anything. Send it any message to restart it — use 'tap send --wake'; do not re-run this, which would clear it again.`,
      };
    case 6:
      return {
        code: 1,
        stderr: `tap refresh: '${handle}' was NOT cleared — its harness has no known clear command, so nothing was submitted, nothing was retired, and no sender was told anything. Name the harness explicitly if this is a supported family; otherwise this seat cannot be refreshed in place.`,
      };
    case 3:
      return {
        code: 1,
        stderr: `tap refresh: pane for '${handle}' is gone — nothing was submitted, nothing was retired, and no sender was told anything. Not refresh's own exit 3, which says the spool scan was unstable and to retry; retrying does not bring a pane back.`,
      };
    default:
      return { code: clearRc, stderr: "" };
  }
}

export async function cmdSeatRefresh(argv: string[], scriptsDir: string): Promise<number> {
  let handle = "";
  let fresh = false;
  let force = false;
  let teamFlag = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    // An empty element is a caller bug, not end-of-options: refusing keeps the
    // later --fresh/--force from being silently dropped (a silent drop would
    // run the non-fresh arm with a self-resolved handle instead).
    if (!arg) {
      throw new TapError(1, "usage_error", "tap help refresh", "unexpected empty argument");
    }
    if (arg === "--fresh") fresh = true;
    else if (arg === "--force") force = true;
    else if (arg === "--team") {
      teamFlag = argv[i + 1] ?? "";
      if (!teamFlag) {
        throw new TapError(1, "usage_error", "tap help refresh", "--team needs a value");
      }
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new TapError(1, "unknown_option", "tap help refresh", `unknown option '${arg}'`);
    } else {
      if (handle) throw new TapError(1, "usage_error", "tap help refresh", `unexpected arg '${arg}'`);
      handle = arg;
    }
  }
  if (force && !fresh) {
    throw new TapError(1, "usage_error", "tap help refresh", "--force applies only to --fresh (it clears obligations; there is nothing to force without it)");
  }

  const ctx: ResolvedContext = resolveContext(process.cwd(), process.env, { explicitTeam: teamFlag || undefined });

  // Self identity: the pane-resolved handle when the caller sits in a pane this
  // registry knows; TAP_SELF stays the incumbent's best-effort override (the
  // bash resolver's failure was non-fatal here too).
  let selfHandle = "";
  let selfUnverifiable = false;
  try {
    const pane = callingPane(process.env);
    if (pane && pane.status === "ok") selfHandle = resolveSelf(ctx, pane, 1).handle;
    else if (pane && pane.status === "unverifiable") selfUnverifiable = true;
  } catch {
    selfHandle = "";
  }
  if (!handle) handle = inheritedActor() || selfHandle;
  if (!handle) {
    // The incumbent's generation_unverifiable self-refusal stands on the REAL
    // resolver path too, not only the TAP_SELF_REFUSAL test hook: an
    // unverifiable pane confers no identity, and the remedy is wait-and-retry
    // or name the seat — never "register" (re-registering from an unverifiable
    // pane is exactly what the identity fence forbids).
    if (selfUnverifiable || process.env.TAP_SELF_REFUSAL === "generation_unverifiable") {
      throw new TapError(1, "generation_unverifiable", "wait for tmux to answer and retry, or name the seat: tap refresh <handle>", "refusing refresh because the tmux server generation is unavailable and the caller identity cannot be verified");
    }
    throw new TapError(1, "unregistered", "register_or_pass_handle", "run 'tap register' in this pane, or name the seat: tap refresh <handle>");
  }
  const isSelf = Boolean(selfHandle) && handle === selfHandle;

  if (!fresh) {
    if (isSelf) {
      const clearRc = selfClear(ctx, scriptsDir);
      if (clearRc !== 0) {
        const t = translateSelfRc(clearRc, handle, false);
        if (t.stderr) process.stderr.write(t.stderr + "\n");
        return t.code;
      }
      return 0;
    }
    const clearRc = await peerClear(handle, ctx);
    if (clearRc === 7) {
      process.stderr.write(`tap refresh: '${handle}' WAS cleared — its process was replaced — but the fresh process did not confirm its rebind in time. The pane is the authority: look at it rather than re-running, because this is not a refusal and retrying treats it as one.\n`);
      return 8;
    }
    if (clearRc !== 0) {
      // Passthrough keeps the engine's code but not its silence: the operator
      // must hear that nothing happened (incumbent tap-refresh.sh:366).
      process.stderr.write(`tap refresh: the clear failed (exit ${clearRc}) — '${handle}' is UNCHANGED: still its original instance, no tombstone written, and no sender was told anything. Nothing to undo; re-run when the pane is ready.\n`);
    }
    return clearRc;
  }

  // --fresh: the destructive arm. Refuse to retire from a registry that may be
  // retired itself (acting-registry-reader-enum): resolveContext already fails
  // closed for an unanchored bus, which is this verb's no_acting_registry gate.
  const myInstance = (() => {
    try {
      const doc = JSON.parse(pyReadUtf8(ctx.registryPath)) as RegistryDoc;
      const seats = doc.seats as Record<string, Seat> | undefined;
      const inst = seats?.[handle]?.instance;
      return typeof inst === "string" ? inst : "";
    } catch {
      return "";
    }
  })();

  const localTeam = ctx.team;
  const busHome = ctx.selection?.busHome ?? join(ctx.root, ".tap", "bus");
  const payloadsDir = join(busHome, "payloads");
  const receiptsDir = join(busHome, "receipts");
  const spoolDir = join(busHome, "spool");
  const teamDir = ctx.root;

  // PHASE A — preflight under the registry lock. Decide only; never mutate.
  // Fail fast, so a seat we were going to refuse is never cleared first.
  const lock = acquireRegistryLock(ctx.registryPath);
  if (!lock) {
    throw new TapError(1, "launcher_registry_busy", "retry when the registry lock frees", "could not obtain registry lock");
  }
  let preflight: { owed: Obligation[]; waiting: Obligation[] };
  try {
    preflight = obligations(payloadsDir, receiptsDir, spoolDir, handle, myInstance, localTeam);
  } catch (err) {
    if (err instanceof SpoolUnstable) {
      lock.release();
      process.stderr.write("tap refresh: refusing --fresh — the spool changed while its obligations were being read:\n");
      for (const ident of err.ids) process.stderr.write(`  unstable spool id: ${ident}\n`);
      process.stderr.write("tap refresh: nothing was changed; next: retry --fresh after the courier move completes\n");
      return 3;
    }
    lock.release();
    throw err;
  }
  const blocking = preflight.owed.length + preflight.waiting.length > 0;
  if (blocking && !force) {
    lock.release();
    const lines = [
      "tap refresh: refusing --fresh — this seat has obligations a fresh instance cannot inherit:",
      ...renderObligations(preflight.owed, preflight.waiting),
      "next: settle them, or pass --fresh --force to retire the instance and notify every waiting sender",
    ];
    for (const line of lines) process.stderr.write(line + "\n");
    return 1;
  }
  lock.release();

  // PHASE B — the clear, WITH THE ROW STILL PRESENT. Delegation stays with the
  // engines: pane resolution, refusals, process replacement, and verification
  // are one implementation, not a twin.
  let clearRc: number;
  if (isSelf) {
    clearRc = selfClear(ctx, scriptsDir);
  } else {
    clearRc = await peerClear(handle, ctx);
  }
  if (clearRc === 7 && !isSelf) {
    process.stderr.write(`tap refresh: '${handle}' WAS cleared — its process was replaced — but the fresh process did not confirm its rebind in time. Nothing was retired and no sender was told anything; the instance is intact and every obligation is still settleable by this seat. The pane is the authority: look at it before re-running.\n`);
    return 8;
  }
  if (isSelf && clearRc !== 0) {
    const t = translateSelfRc(clearRc, handle, true);
    if (t.stderr) process.stderr.write(t.stderr + "\n");
    return t.code;
  }
  if (clearRc !== 0) {
    process.stderr.write(`tap refresh: the clear failed (exit ${clearRc}) — '${handle}' is UNCHANGED: still its original instance, no tombstone written, and no sender was told anything. Nothing to undo; re-run when the pane is ready.\n`);
    return clearRc;
  }

  // PHASE C — retire under one lock: re-scan, tombstone, MINT IN PLACE. The
  // scan is atomic with the mint: a payload this scan does not see was written
  // after the new instance existed and belongs to the successor. The in-lock
  // refusal is deliberately asymmetric — the clear is not undoable, so context
  // is gone while IDENTITY IS NOT: the seat keeps its instance and stays
  // settleable (exit 7, not 1).
  // Acting-registry flip, from the RESOLVED CONTEXT: the selector already
  // validated enrollment through the machine index, so `live` there is the
  // incumbent is_flip_live's verdict without re-reading TAP_INDEX_HOME — a
  // default index (env unset) is just as live as an explicit one.
  const flip = ctx.marker === "live" && Boolean(teamDir);

  let tombstone = "";
  let oldInstance = "";
  let newInstance = "";
  let retireScan: { owed: Obligation[]; waiting: Obligation[] } = { owed: [], waiting: [] };
  try {
    withActingRegistry(ctx, (doc, seats) => {
      const row: Seat | undefined = seats[handle];
      if (!row || typeof row !== "object") {
        throw new RefreshExit(1, ensureAscii(JSON.stringify({ ok: false, error_class: "not_registered", handle })) + "\n");
      }
      if (flip) ensureSeatInstance(row, handle);
      oldInstance = flip ? (typeof row.instance === "string" ? row.instance : "") : "";
      const scope = oldInstance || myInstance;
      retireScan = obligations(payloadsDir, receiptsDir, spoolDir, handle, scope, localTeam);
      const late = retireScan.owed.length + retireScan.waiting.length > 0;
      if (late && !force) {
        throw new RefreshExit(-7, JSON.stringify({ instance: oldInstance, owed: retireScan.owed, waiting: retireScan.waiting }));
      }
      if (flip) {
        tombstone = writeTombstone(teamDir, handle, row);
        // The mint: same row, new identity. ensureSeatInstance only fills a
        // MISSING instance, so the pop is what makes it mint rather than keep —
        // the same two-step register uses on its own --fresh path.
        delete row.instance;
        ensureSeatInstance(row, handle);
        newInstance = typeof row.instance === "string" ? row.instance : "";
      }
      seats[handle] = row;
      saveRegistry(ctx.registryPath, doc);
    });
  } catch (err) {
    if (err instanceof RefreshExit) {
      if (err.code === -7) {
        const detail = JSON.parse(err.stderr) as { instance: string; owed: Obligation[]; waiting: Obligation[] };
        const lines = [
          "tap refresh: the clear COMPLETED, but the retirement is refused — mail arrived while it ran:",
          ...renderObligations(detail.owed, detail.waiting, true),
          `tap refresh: the seat KEPT its instance (${detail.instance || "unchanged"}), so every id above is still settleable by it — nothing was orphaned and no sender was told otherwise.`,
          "next: settle them and re-run --fresh, or pass --fresh --force to retire anyway and notify every waiting sender",
        ];
        for (const line of lines) process.stderr.write(line + "\n");
        return 7;
      }
      if (err.stderr) process.stderr.write(err.stderr);
      return err.code;
    }
    if (err instanceof SpoolUnstable) {
      const lines = [
        "tap refresh: the clear COMPLETED, but the retirement is refused — the spool changed while its obligations were being read:",
        ...err.ids.map((ident) => `  unstable spool id: ${ident}`),
        `tap refresh: the seat KEPT its instance (${oldInstance || "unchanged"}), so no obligation was orphaned.`,
        "next: retry --fresh after the courier move completes",
      ];
      for (const line of lines) process.stderr.write(line + "\n");
      return 7;
    }
    throw err;
  }

  if (tombstone) {
    process.stderr.write(`tap refresh: retired instance recorded at ${tombstone} (restore with tap in ${handle} --restore <instance>)\n`);
  }

  // PHASE D — notify each waiting SENDER once, per sender rather than per id.
  // Senders come from the retire scan, so the set is the one true at the mint.
  // Cross-team senders are addressed <team>/<handle>, matching the canonical
  // reply path. A failed send keeps its own error; failures sum to exit 6 AFTER
  // the retirement stands.
  const byPeer = new Map<string, string[]>();
  for (const m of retireScan.owed) {
    let peer = m.peer;
    if (peer && m.peerTeam) peer = `${m.peerTeam}/${peer}`;
    if (!peer) continue;
    const ids = byPeer.get(peer) ?? [];
    ids.push(m.id);
    byPeer.set(peer, ids);
  }
  const peers = [...byPeer.keys()].sort();
  let notifyFailures = 0;
  for (const peer of peers) {
    const ids = (byPeer.get(peer) ?? []).join(",");
    const note = join(tmpdir(), `tap-refresh-note-${process.pid}-${notifyFailures}-${Math.floor(Math.random() * 1e9)}.md`);
    writeFileSync(note, [
      `Seat refreshed fresh: ${handle} was retired and rebound as a new instance.`,
      `These payloads will NOT be settled by that seat: ${ids}`,
      "",
      "Nothing is required of you. Resending is your call, not an instruction — you know whether the request is still live better than this notice does.",
    ].join("\n") + "\n");
    const [cmd, ...argv] = courierArgv(scriptsDir, [peer, "-f", note, "--from", handle, "--fyi", "--wake"]);
    const run = spawnSync(cmd!, argv, {
      encoding: "utf8",
      maxBuffer: REGISTRY_MAX_BUFFER,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const noteErr = `${run.stderr ?? ""}`.trim();
    rmSync(note, { force: true });
    if ((run.status ?? 1) !== 0) {
      process.stderr.write(`tap refresh: warning: could not notify '${peer}' that ${ids} will go unsettled: ${noteErr || "no error output"}\n`);
      notifyFailures += 1;
    }
  }
  if (notifyFailures > 0) {
    process.stderr.write(`tap refresh: ${handle} was refreshed, but ${notifyFailures} sender notice(s) FAILED — those peers are still waiting and do not know\n`);
    return 6;
  }
  return 0;
}
