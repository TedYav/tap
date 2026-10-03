// Per-handle archives are separate from team-reset checkpoints. They preserve
// one incarnation and its mail, including session-kill backups made by launcher.
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, readSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { requireActingRegistry, resolveContext, TapError, type ResolvedContext } from "../context";
import { renderRefusals, runEntry } from "../error-line";
import { appendRegistryEventOrWarn } from "../events";
import { reservedSeatName, utcStamp, validToken } from "../ids";
import { frontmatterFields } from "../payload-fields";
import { loadRegistry, pyJson, saveRegistry, seatMap } from "../registry";
import { withActingRegistry } from "../registry-tx";
import { acquireResetMutationLock, markResetGenerationReused } from "../reset";
import { parseRecord, pruneHandle, readHandleEntry, restoreHandle, undoHandleMerge } from "../watch-lease";

type Verb = "teardown" | "restore";
export interface TeardownOptions { handle: string; archive: string; yes: boolean; json: boolean }
const stores = ["payloads", "receipts", "spool", "input-backups", "handoff", "seat-state"] as const;
const leases = [["watch", "blocked_map"], ["goalie", "seats"]] as const;
const notRemoved = "harness transcripts (Claude/Codex/opencode session files) remain on disk — TAP does not delete them";
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(verb: Verb, klass: string, detail: string, action = `tap help ${verb}`): never {
  throw new TapError(1, klass, action, detail, `tap ${verb}`);
}
export function parseTeardownOptions(verb: Verb, args: string[]): TeardownOptions {
  const out = { handle: "", archive: "", yes: false, json: process.env.TAP_JSON === "1" || args.includes("--json") };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--yes") out.yes = true;
    else if (arg === "--archive") {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(verb, "usage_error", "--archive needs a value");
      out.archive = value;
    } else if (arg.startsWith("--")) fail(verb, "unknown_option", `unknown option '${arg}'`);
    else if (!out.handle) out.handle = arg;
    else fail(verb, "usage_error", `unexpected argument '${arg}'`);
  }
  if (!out.handle) fail(verb, "usage_error", `${verb} requires a handle`);
  if (!validToken(out.handle)) fail(verb, "invalid_handle", `invalid handle '${out.handle}'`);
  return out;
}
function storePath(ctx: ResolvedContext, store: string): string {
  return store === "input-backups" ? process.env.TAP_INPUT_BACKUPS || join(ctx.bus.home, store) : join(ctx.bus.home, store);
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function directory(path: string): boolean { return present(path) && lstatSync(path).isDirectory(); }
function leaves(path: string): string[] {
  if (!present(path)) return [];
  if (!directory(path)) throw new Error(`store is not a directory: ${path}`);
  return readdirSync(path).sort().filter(name => {
    const st = lstatSync(join(path, name));
    return st.isFile() || st.isSymbolicLink();
  });
}
function objectFile(path: string): Record<string, unknown> {
  if (!lstatSync(path).isFile()) throw new Error(`not a regular metadata file: ${path}`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(value)) throw new Error(`not an object: ${path}`);
  return value;
}
// Exclusive publication never overwrites live state. Links themselves move,
// never their targets; external input-backup stores can cross filesystems.
export function moveExclusive(source: string, target: string): void {
  try {
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else {
      try { linkSync(source, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        copyFileSync(source, target, constants.COPYFILE_EXCL);
      }
    }
    unlinkSync(source);
  } catch (error) {
    // A failed unlink can leave both copies. Name both recovery locations.
    throw new Error(`move ${source} -> ${target}: ${String(error)}`);
  }
}

function selectedFiles(ctx: ResolvedContext, handle: string): Map<string, string[]> {
  const owned = (value: unknown, team?: unknown) => value === `${ctx.team}/${handle}` || value === `${ctx.team}:${handle}`
    || value === handle && (!team || team === ctx.team);
  const fieldsOwned = (fields: Record<string, unknown>) => owned(fields.from, fields.from_team)
    || owned(fields.to, fields.to_team) || owned(fields.handle, fields.team) || owned(fields.target, fields.to_team ?? fields.team);
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const outbound = new RegExp(`^${escaped}-[0-9]{8}T[0-9]{6}Z-[^.]+`);
  const legacyDraft = new RegExp(`^[0-9]{8}T[0-9]{6}Z-${escaped}-.+\\.md$`);
  const handoff = new RegExp(`^${escaped}-[0-9]{8}T[0-9]{6}Z\\.md$`);
  // Anchored on the 16-hex binding key: `ann` never matches a seat named `ann.x`.
  const stallEpisode = new RegExp(`^${escaped}\\.[0-9a-f]{16}\\.stall\\.json$`);
  const selected = new Map<string, Set<string>>(), all = new Map<string, string[]>(), ids = new Set<string>();
  const knownOwners = new Set<string>();
  const mailStores = ["payloads", "receipts", "spool"];
  const idOf = (name: string) => name.replace(/\.(?:meta\.json(?:\.lock)?|md|sent|done|cancelled|placed|claim)$/, "");
  for (const store of stores) {
    const names = leaves(storePath(ctx, store)); all.set(store, names);
    const picked = new Set<string>(); selected.set(store, picked);
    for (const name of names) {
      const path = join(storePath(ctx, store), name);
      let matches = store === "seat-state" && (name === `${handle}.hash` || stallEpisode.test(name))
        || store === "handoff" && handoff.test(name)
        || store === "input-backups" && legacyDraft.test(name);
      let fields: Record<string, unknown> = {};
      if (lstatSync(path).isFile()) {
        if (name.endsWith(".md")) {
          fields = frontmatterFields(readFileSync(path, "utf8"));
        } else if (name.endsWith(".meta.json")) {
          fields = objectFile(path);
        }
      }
      matches ||= fieldsOwned(fields);
      if (mailStores.includes(store) && ["from", "to", "handle", "target"].some(key => typeof fields[key] === "string" && fields[key])) knownOwners.add(idOf(name));
      if (!matches) continue;
      picked.add(name);
      if (mailStores.includes(store)) {
        const id = idOf(name);
        if (id !== name) ids.add(id);
      }
    }
  }
  // A filename can recover an orphaned sender receipt, but cannot overrule
  // a canonical envelope naming a foreign same-spelled handle. Excluding too
  // eagerly here only leaves an orphan behind (never sweeps a foreign file
  // in), so the broad textual prefix stays; the risk is one-directional and
  // sits in the inclusion sweep below.
  for (const store of mailStores) for (const name of all.get(store)!) {
    if (outbound.test(name) && ![...knownOwners].some(id => name === id || name.startsWith(`${id}.`))) {
      selected.get(store)!.add(name);
      if (idOf(name) !== name) ids.add(idOf(name));
    }
  }
  // Payload ids carry the inbound sidecars too, including receipts whose names
  // identify the sender rather than the handle being torn down. IDs may
  // legally contain dots, so a bare `${id}.` prefix would also sweep in an
  // unrelated canonical envelope like `${id}.followup.md` (ID `job.followup`).
  // Only refuse the match when idOf's recognized-suffix strip reveals that
  // distinct id. An opaque, unrecognized extension (idOf leaves it as-is,
  // e.g. a forensic `.extra` sidecar) rides the plain prefix, but the SAME
  // opaque name can also textually extend a longer, distinct, known-owned id
  // (`job.followup.extra` starting with `job.` while really belonging to
  // `job.followup`) — the longest owning prefix among `ids` and every known
  // envelope owner wins; only a win FOR this handle's own `ids` carries it.
  for (const store of mailStores) for (const name of all.get(store)!) {
    const stripped = idOf(name);
    if (stripped !== name) { if (ids.has(stripped)) selected.get(store)!.add(name); continue; }
    const candidates = [...ids, ...knownOwners].filter(id => name === id || name.startsWith(`${id}.`));
    if (!candidates.length) continue;
    const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
    if (ids.has(longest)) selected.get(store)!.add(name);
  }
  return new Map([...selected].map(([store, names]) => [store, [...names].sort()]));
}
function newArchive(ctx: ResolvedContext, handle: string): string {
  const root = join(ctx.bus.home, "archive", "teardown"); mkdirSync(root, { recursive: true });
  const suffix = process.env.TAP_TEARDOWN_ARCHIVE_SUFFIX;
  if (suffix && !validToken(suffix)) fail("teardown", "usage_error", "invalid TAP_TEARDOWN_ARCHIVE_SUFFIX");
  const stem = suffix ? `19700101T000000Z-${suffix}-${handle}` : `${utcStamp(new Date())}-${handle}`;
  for (let i = 1; i < 100; i++) {
    const path = join(root, `${stem}${i === 1 ? "" : `-${i}`}`);
    try { mkdirSync(path); return path; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return fail("teardown", "archive_busy", `could not create teardown archive under ${root}`, "retry");
}
export function runTeardown(ctx: ResolvedContext, opts: TeardownOptions, move = moveExclusive): string {
  requireActingRegistry(ctx, 1);
  if (!Object.hasOwn(seatMap(loadRegistry(ctx.registryPath)), opts.handle)) fail("teardown", "not_registered", `'${opts.handle}' is not registered`, `tap register ${opts.handle}`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) fail("teardown", "needs_confirmation", `permanent teardown archives and removes TAP-visible residue for '${opts.handle}'; pass --yes non-interactively`, `tap teardown ${opts.handle} --yes`);
    process.stderr.write(`tap teardown: permanently archive TAP-visible state for '${opts.handle}'? [y/N] `);
    let answer = ""; const byte = Buffer.alloc(1);
    while (readSync(0, byte, 0, 1, null) > 0 && byte[0] !== 10) answer += byte.toString();
    if (!/^(y|yes)$/i.test(answer)) fail("teardown", "cancelled", "teardown cancelled", "retry");
  }
  const fence = acquireResetMutationLock(ctx.bus.home, "tap teardown");
  let archive = "";
  try {
    withActingRegistry(ctx, (doc, rows) => {
      if (!Object.hasOwn(rows, opts.handle)) fail("teardown", "not_registered", `'${opts.handle}' is not registered`);
      const files = selectedFiles(ctx, opts.handle);
      markResetGenerationReused(ctx.bus.home, "teardown", 0);
      archive = newArchive(ctx, opts.handle);
      // Both recovery records precede the first destructive move; the row is
      // held until every store has archived successfully.
      writeFileSync(join(archive, "registry-row.json"), pyJson({ team: doc.team ?? null, agent: rows[opts.handle] }, 0) + "\n");
      writeFileSync(join(archive, "meta.json"), pyJson({ kind: "handle_teardown", handle: opts.handle, team: ctx.team,
        archive: basename(archive), at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), not_removed: notRemoved }, 0) + "\n");
      writeFileSync(join(archive, "NOT_REMOVED.txt"), notRemoved + "\n");
      // Existing bidirectional smoke control, not a second selection policy.
      const skip = new Set((process.env.TAP_TEARDOWN_SKIP ?? "").split(","));
      for (const [store, names] of files) {
        if (skip.has(store) || !names.length) continue;
        mkdirSync(join(archive, store));
        for (const name of names) move(join(storePath(ctx, store), name), join(archive, store, name));
      }
      for (const [store, top] of leases) if (!skip.has(store)) pruneHandle(join(ctx.bus.home, store, "arm.json"), top, opts.handle, join(archive, store));
      delete rows[opts.handle]; saveRegistry(ctx.registryPath, doc);
    }, 0); // Structural EX never waits on another resource.
  } catch (error) {
    if (!archive) throw error;
    fail("teardown", "teardown_incomplete", `${String(error)}; recovery archive retained at ${archive}; registry row was not removed`, `inspect ${archive} before retrying teardown`);
  } finally { fence.release(); }
  appendRegistryEventOrWarn("tap teardown", { log: join(ctx.bus.home, "registry-events.log"), actor: opts.handle, action: "teardown", handle: opts.handle, pane: "", team: ctx.team, detail: "" });
  return archive;
}

function resolveArchive(ctx: ResolvedContext, opts: TeardownOptions): string {
  const root = join(ctx.bus.home, "archive", "teardown");
  if (opts.archive) {
    for (const path of [resolve(opts.archive), join(root, opts.archive)]) if (directory(path)) return path;
  } else if (directory(root)) {
    // Metadata identifies the handle exactly; a hyphenated neighbour is not a
    // candidate just because its directory name begins with this handle.
    const matches = readdirSync(root).sort().filter(name => {
      try { return directory(join(root, name)) && objectFile(join(root, name, "meta.json")).handle === opts.handle; } catch { return false; }
    });
    if (matches.length) return join(root, matches.at(-1)!);
  }
  return fail("restore", "archive_not_found", `teardown archive '${opts.archive || opts.handle}' not found under ${root}`, `tap teardown ${opts.handle}`);
}
function validateArchive(archive: string, handle: string): { kind: string; row: Record<string, unknown>; files: Map<string, string[]> } {
  try {
    const meta = objectFile(join(archive, "meta.json"));
    if (!["handle_teardown", "session_kill_backup"].includes(String(meta.kind)) || meta.handle !== handle) throw new Error("archive kind or handle mismatch");
    objectFile(join(archive, "registry-row.json"));
    const row = loadRegistry(join(archive, "registry-row.json"));
    if (meta.kind === "session_kill_backup") {
      if (!present(join(archive, "COMPLETE")) || !lstatSync(join(archive, "COMPLETE")).isFile()) fail("restore", "archive_incomplete", `session-kill backup is incomplete: ${archive}`, "retry the fresh launch");
      const launcher = objectFile(join(archive, "launcher-session-record.json"));
      if (launcher.record !== null && !isObject(launcher.record)) throw new Error("invalid launcher record");
      if (row.agent === null) fail("restore", "archive_no_seat_state", "no seat state existed before the kill; this archive is forensic only and cannot restore a seat", `inspect ${archive}/tmux-forensics.json`);
    }
    if (!isObject(row.agent)) throw new Error("archive agent is not an object");
    const files = new Map<string, string[]>();
    for (const store of stores) {
      const dir = join(archive, store), names = leaves(dir);
      if (directory(dir) && names.length !== readdirSync(dir).length) throw new Error(`unexpected nested archive member in ${dir}`);
      files.set(store, names);
    }
    for (const [store, top] of leases) {
      const dir = join(archive, store);
      if (!present(dir)) continue;
      if (!directory(dir)) throw new Error(`not a slice directory: ${dir}`);
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name !== `${top}.${handle}.json` || !lstatSync(path).isFile()) throw new Error(`unexpected slice: ${path}`);
        const slice = parseRecord(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
        if (!isObject(slice) || Object.keys(slice).length !== 1 || !Object.hasOwn(slice, handle)) throw new Error(`invalid handle slice: ${path}`);
      }
    }
    return { kind: String(meta.kind), row, files };
  } catch (error) {
    if (error instanceof TapError) throw error;
    return fail("restore", "archive_invalid", `${String(error)}: ${archive}`, `inspect ${archive}`);
  }
}
export function runHandleRestore(ctx: ResolvedContext, opts: TeardownOptions, move = moveExclusive): { archive: string; kind: string } {
  // A pre-reservation seat archived as `user` must not come back as a seat:
  // register and launch already refuse the name (tap-gridx).
  const reserved = reservedSeatName(opts.handle);
  if (reserved) fail("restore", "reserved_handle", `handle '${opts.handle}' ${reserved} and cannot name a seat; archive unchanged`);
  const archive = resolveArchive(ctx, opts);
  requireActingRegistry(ctx, 1);
  const fence = acquireResetMutationLock(ctx.bus.home, "tap restore");
  let kind = "";
  const moved: [string, string][] = [];
  const mergedLeases: [store: string, top: string, expected: unknown][] = [];
  try {
    withActingRegistry(ctx, (doc, rows) => {
      try {
        if (Object.hasOwn(rows, opts.handle)) fail("restore", "handle_live", `handle_live: an existing registry row holds '${opts.handle}'; archive unchanged. Tear down that row before restoring the selected archive`, `tap teardown ${opts.handle} --yes`);
        const validated = validateArchive(archive, opts.handle); kind = validated.kind;
        for (const [store, names] of validated.files) {
          const dest = storePath(ctx, store);
          if (present(dest) && !directory(dest)) fail("restore", "restore_conflict", `not a store directory: ${dest}`);
          for (const name of names) if (present(join(dest, name))) fail("restore", "restore_conflict", `live file already exists: ${join(dest, name)}; archive unchanged`, `inspect ${archive}`);
        }
        markResetGenerationReused(ctx.bus.home, "restore", 0);
        for (const [store, names] of validated.files) {
          if (!names.length) continue;
          mkdirSync(storePath(ctx, store), { recursive: true });
          for (const name of names) {
            const source = join(archive, store, name), target = join(storePath(ctx, store), name);
            move(source, target); moved.push([source, target]);
          }
        }
        for (const [store, top] of leases) if (directory(join(archive, store))) {
          const armPath = join(ctx.bus.home, store, "arm.json");
          restoreHandle(armPath, top, join(archive, store));
          mergedLeases.push([store, top, readHandleEntry(armPath, top, opts.handle)]);
        }
        const agent = { ...(validated.row.agent as Record<string, unknown>), status: "suspended",
          status_reason: kind === "session_kill_backup" ? "restored_from_archive" : "restored_teardown" };
        if (kind === "session_kill_backup" && !Object.hasOwn(agent, "delivery")) Object.assign(agent, { delivery: "pane" });
        rows[opts.handle] = agent;
        if (!doc.team && validated.row.team) doc.team = validated.row.team;
        saveRegistry(ctx.registryPath, doc);
      } catch (error) {
        // Put consumed files back on a failed restore. Never overwrite a newly
        // occupied archive name; both paths are named in the recovery refusal.
        const retained: string[] = [];
        for (const [source, target] of moved.reverse()) {
          try { moveExclusive(target, source); } catch { retained.push(target); }
        }
        // restoreHandle releases its lock before the next lease merge and before
        // saveRegistry, so a live watch/goalie writer can update this same handle
        // in that window before a later step fails here. undoHandleMerge only
        // removes the entry if it still matches what THIS restore merged in
        // (`expected`, captured right after the merge under the same lock) --
        // a changed value means someone else has a stake in it now, so the live
        // entry and the archive's original slice both stay untouched and the
        // path is named for inspection rather than guessed at.
        for (const [store, top, expected] of mergedLeases.reverse()) {
          const armPath = join(ctx.bus.home, store, "arm.json");
          try {
            if (undoHandleMerge(armPath, top, opts.handle, expected) === "conflict") retained.push(armPath);
          } catch { retained.push(armPath); }
        }
        if (!moved.length && !mergedLeases.length && error instanceof TapError) throw error;
        fail("restore", "restore_incomplete", `${String(error)}; recovery archive retained at ${archive}${retained.length ? `; also inspect ${retained.join(", ")}` : ""}`, `inspect ${archive} before retrying restore`);
      }
    }, 0); // Structural EX never waits on another resource.
  } finally { fence.release(); }
  appendRegistryEventOrWarn("tap restore", { log: join(ctx.bus.home, "registry-events.log"), actor: opts.handle, action: "restore", handle: opts.handle, pane: "", team: ctx.team, detail: "" });
  return { archive, kind };
}
export function cmdTeardown(verb: Verb, args: string[]): number {
  const json = args.includes("--json") || process.env.TAP_JSON === "1";
  return renderRefusals(`tap ${verb}`, () => {
    const opts = parseTeardownOptions(verb, args), ctx = resolveContext();
    if (verb === "teardown") {
      const archive = runTeardown(ctx, opts);
      if (json) console.log(JSON.stringify({ ok: true, handle: opts.handle, archive: basename(archive), archive_path: archive, not_removed: notRemoved }));
      else console.log(`tap teardown: archived '${opts.handle}' to ${archive}\ntap teardown: note: ${notRemoved}\ntap teardown: restore: tap restore ${opts.handle} --archive ${basename(archive)}`);
    } else {
      const { archive, kind } = runHandleRestore(ctx, opts);
      if (json) console.log(JSON.stringify({ ok: true, handle: opts.handle, archive: basename(archive) }));
      else console.log(`tap restore: restored '${opts.handle}' from ${archive}\ntap restore: next: ${kind === "session_kill_backup" ? `tap session resume ${opts.handle}` : `tap register ${opts.handle} --pane <tmux-target>`}  # row is suspended until rebound`);
    }
    return 0;
  }, { ...process.env, TAP_JSON: json ? "1" : "0" });
}
if (import.meta.main) {
  const [verb, ...args] = process.argv.slice(2);
  process.exitCode = runEntry("tap teardown", () => verb === "teardown" || verb === "restore" ? cmdTeardown(verb, args) : fail("teardown", "usage_error", "expected teardown or restore"));
}
