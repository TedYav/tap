// Native half of the addressee differential. The team fixture, the door that
// derives inputs the way verbs/read.ts does, and the 26 rows that carry a
// native expectation all ship with the public tree. The one row without a
// native expectation — a malformed registry with a binding — stays on the
// base-program parity differential, which is the only place that compares
// the two doors. Two rows are ratified native refusals; their notes name
// why the base program still grants.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addresseeGrant, historyDirForBus, NO_CLEARING_PATH } from "../../src/addressee-grant";
import { resolveContext } from "../../src/context";
import { removeScratchTree } from "./scratch";

export interface Seat { instance?: string; status?: string; adopted_handles?: string[]; adopted_instances?: Record<string, string>; [extra: string]: unknown }
export interface FixtureOpts {
  /** A null value is a JSON null row (the incumbent's `.get(h) is not None` reads it as absent). */
  seats: Record<string, Seat | null>;
  forwardings?: Array<Record<string, unknown>>;
  /** Tombstones under .tap/team-history as `<handle>.<n>.json` bodies; `fifo: true` makes a writerless FIFO instead. */
  history?: Array<{ name: string; body?: Record<string, unknown> | string; fifo?: boolean }>;
  historyDir?: "absent" | "file" | "unreadable";
  marker?: "live" | "absent";
  /** Break the enrolled registry file (unparseable JSON). */
  registry?: "malformed";
}
export interface AddresseeFixture {
  root: string;
  wt: string;
  bus: string;
  registry: string;
  history: string;
  index: string;
  env: Record<string, string | undefined>;
}

export interface AddresseeScratch {
  tmp(): string;
  fixture(opts: FixtureOpts): AddresseeFixture;
  /** Paths whose mode the caller changed and must be restored at reap time. */
  restoreModes: string[];
  reap(): void;
}

export function addresseeScratch(prefix: string): AddresseeScratch {
  let scratchRoot = "";
  const restoreModes: string[] = [];
  const tmp = (): string => {
    if (!scratchRoot) scratchRoot = mkdtempSync(join(tmpdir(), prefix));
    return mkdtempSync(join(scratchRoot, "fx."));
  };
  const fixture = (opts: FixtureOpts): AddresseeFixture => {
    const root = tmp();
    const wt = join(root, "team");
    const bus = join(wt, ".tap", "bus");
    const registry = join(wt, ".tap", "team-registry.json");
    const history = join(wt, ".tap", "team-history");
    const index = join(root, "index");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    mkdirSync(join(bus, "receipts"), { recursive: true });
    mkdirSync(index, { recursive: true });
    const doc: Record<string, unknown> = {
      schema: "0.20",
      team: { name: "flip", worktree_root: wt },
      seats: opts.seats,
    };
    if (opts.forwardings) doc.seat_forwardings = opts.forwardings;
    writeFileSync(registry, opts.registry === "malformed" ? "{ not json" : JSON.stringify(doc));
    // The legacy-shaped copy the Bash lookups also accept.
    writeFileSync(join(bus, "registry.json"), readFileSync(registry));
    if ((opts.marker ?? "live") === "live") {
      writeFileSync(join(index, "global-registry.json"), JSON.stringify({
        schema: "0.20",
        teams: { flip: { root: wt, registry_location: registry, state: "registered" } },
      }));
    }
    if (opts.historyDir === "file") writeFileSync(history, "not a directory\n");
    else if (opts.historyDir !== "absent") {
      mkdirSync(history, { recursive: true });
      for (const row of opts.history ?? []) {
        if (row.fifo) { if (Bun.spawnSync(["mkfifo", join(history, row.name)]).exitCode !== 0) throw new Error("mkfifo failed"); continue; }
        writeFileSync(join(history, row.name), typeof row.body === "string" ? row.body : JSON.stringify(row.body ?? {}));
      }
      if (opts.historyDir === "unreadable") { chmodSync(history, 0o000); restoreModes.push(history); }
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: root,
      TAP_HOME: bus,
      TAP_INDEX_HOME: index,
      TAP_SESSION_MANIFEST: join(root, "sessions.json"),
      OPENCODE_DB_PATH: join(root, "opencode.db"),
      TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
      TAP_LOCK_DIR: join(root, "locks"),
      TAP_SELF: "actor",
      TMUX: undefined,
      TMUX_PANE: undefined,
    };
    return { root, wt, bus, registry, history, index, env };
  };
  const reap = () => {
    for (const p of restoreModes) { try { chmodSync(p, 0o755); } catch { /* gone */ } }
    if (scratchRoot) removeScratchTree(scratchRoot);
  };
  return { tmp, fixture, restoreModes, reap };
}

export interface Args { id: string; from: string; actor: string; to: string; adopted: string; rinst: string; quiet: boolean }
export interface View { rc: number; out: string; GRANT: string; AINST: string; CLASS: string; DETAIL: string; NEXT: string; MISMATCH: string; RKIND: string; RNEXT: string; RDETAIL: string }
export interface NativeExpectedRow {
  label: string;
  fx: FixtureOpts;
  args: Args;
  expect: Partial<View>;
  deviation?: { base: Partial<View>; note: string };
}

/** The native door: same argv and JSON shape the differential has always spawned. */
export function nativeDoor(fx: AddresseeFixture, a: Args): View {
  const r = Bun.spawnSync(["bun", import.meta.path, a.id, a.from, a.actor, a.to, a.adopted, a.rinst], { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (r.exitCode !== 0 || r.stderr.toString() !== "") {
    throw new Error(`native door failed: exit=${r.exitCode} err=${r.stderr.toString()}`);
  }
  const g = JSON.parse(r.stdout.toString());
  // The native door prints nothing; the incumbent printed the fork only
  // without --quiet, and every production caller passes --quiet.
  return { rc: g.ok ? 0 : 1, out: a.quiet ? "" : g.grant, GRANT: g.grant, AINST: g.actorInstance, CLASS: g.errorClass, DETAIL: g.detail, NEXT: g.next,
    MISMATCH: g.instanceMismatch ? "1" : "0", RKIND: g.remedy.kind, RNEXT: g.remedy.next, RDETAIL: g.remedy.detail };
}

export function normalizeView(fx: AddresseeFixture, view: View): View {
  const o: Record<string, unknown> = { ...view };
  for (const k of Object.keys(o)) if (typeof o[k] === "string") o[k] = (o[k] as string).split(fx.root).join("<ROOT>");
  return o as unknown as View;
}

export function pick(v: View, keys: Partial<View>): Partial<View> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(keys)) o[k] = (v as unknown as Record<string, unknown>)[k];
  return o as Partial<View>;
}

/** The field and value a ratified native refusal must name. */
export function deviationDetailFragment(row: NativeExpectedRow): string {
  return row.label.includes("float") ? "'0.5' at field 'observer_metadata'" : "'9007199254740992' at field 'observer_metadata'";
}

const ACT = { instance: "actor|CUR" };

export const nativeExpectedRows: NativeExpectedRow[] = [
  { label: "own mail, no binding", fx: { seats: { actor: ACT } }, args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "", quiet: true }, expect: { rc: 0, AINST: "" } },
  { label: "own mail, binding matches the current instance", fx: { seats: { actor: ACT } }, args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|CUR", quiet: true }, expect: { rc: 0, AINST: "actor|CUR" } },
  { label: "own mail bound to a retired instance, tombstone present: mismatch + 'tap team' door", fx: { seats: { actor: ACT }, history: [{ name: "actor.1.json", body: { handle: "actor", instance: "actor|OLD" } }] },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, CLASS: "not_addressee", MISMATCH: "1", RKIND: "command", RNEXT: "tap team" } },
  { label: "own mail bound to a retired instance, no tombstone: no clearing path", fx: { seats: { actor: ACT } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, MISMATCH: "1", RKIND: "none", RNEXT: NO_CLEARING_PATH } },
  { label: "own mail bound to a retired instance, history dir absent", fx: { seats: { actor: ACT }, historyDir: "absent" },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, RKIND: "none" } },
  { label: "own mail bound to a retired instance, history is a file, not a dir", fx: { seats: { actor: ACT }, historyDir: "file" },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, RKIND: "none" } },
  { label: "own mail bound to a retired instance, history unreadable: the list-history door", fx: { seats: { actor: ACT }, historyDir: "unreadable" },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, RKIND: process.getuid?.() === 0 ? "none" : "command" } },
  { label: "own mail with a binding but no row for the actor: instance_unresolved", fx: { seats: { other: { instance: "other|X" } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, CLASS: "instance_unresolved" } },
  { label: "own mail with a binding, no --by in the remedy when FROM is empty", fx: { seats: { actor: ACT } },
    args: { id: "ID1", from: "", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, NEXT: "tap cancel ID1" } },
  { label: "own mail adopted from a predecessor whose instance the binding names: granted as the predecessor",
    fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"], adopted_instances: { pred: "pred|OLD" } } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "pred", rinst: "pred|OLD", quiet: true }, expect: { rc: 0, GRANT: "pred" } },
  { label: "predecessor's mail, no binding, actor adopted the handle", fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"] } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "", quiet: true }, expect: { rc: 0, GRANT: "pred" } },
  { label: "predecessor's mail, no binding, actor adopted the handle, printed without --quiet", fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"] } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "", quiet: false }, expect: { rc: 0, GRANT: "pred", out: "pred" } },
  { label: "predecessor's mail bound to the adopted instance", fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"], adopted_instances: { pred: "pred|OLD" } } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "pred|OLD", quiet: true }, expect: { rc: 0, GRANT: "pred" } },
  { label: "predecessor's mail bound to a DIFFERENT instance than the grant records", fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"], adopted_instances: { pred: "pred|OLD" } } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "pred|OLDER", quiet: true },
    expect: { rc: 1, MISMATCH: "1", DETAIL: "'ID1' is bound to recipient instance 'pred|OLDER', not the adopted 'pred' instance 'pred|OLD'" } },
  { label: "someone else's mail, no grant of any kind", fx: { seats: { actor: ACT, other: { instance: "other|X" } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "other", adopted: "", rinst: "", quiet: true }, expect: { rc: 1, CLASS: "not_addressee", DETAIL: "'ID1' is addressed to 'other', not 'actor'", NEXT: "tap cancel ID1 --by bob", MISMATCH: "0" } },
  { label: "someone else's mail bound to their instance: mismatch, no grant", fx: { seats: { actor: ACT, other: { instance: "other|X" } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "other", adopted: "", rinst: "other|X", quiet: true }, expect: { rc: 1, CLASS: "not_addressee", MISMATCH: "1" } },
  { label: "explicit forwarding from the predecessor's retired instance to the actor: forwarded grant",
    fx: { seats: { actor: ACT }, forwardings: [{ source: "pred", source_instance: "pred|OLD", destination: "actor", destination_instance: "actor|CUR", at: "2026-09-16T00:00:00Z", address_active: true }] },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "pred|OLD", quiet: true }, expect: { rc: 0, GRANT: "pred", AINST: "actor|CUR" } },
  { label: "explicit forwarding, but the binding names a different retired instance",
    fx: { seats: { actor: ACT }, forwardings: [{ source: "pred", source_instance: "pred|OLD", destination: "actor", destination_instance: "actor|CUR", at: "2026-09-16T00:00:00Z", address_active: true }] },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "pred|OLDER", quiet: true }, expect: { rc: 1, MISMATCH: "1" } },
  { label: "malformed registry, own mail without a binding", fx: { seats: { actor: ACT }, registry: "malformed" },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "", quiet: true }, expect: { rc: 0 } },
  // Review (fb6e8a52a HOLD 1): presence is an OWN, non-null row.
  { label: "a handle that names an inherited property ('constructor'), no row, tombstone present: the free --restore door", fx: { seats: { other: { instance: "other|X" } }, history: [{ name: "constructor.1.json", body: { handle: "constructor", instance: "constructor|OLD" } }] },
    args: { id: "ID1", from: "bob", actor: "constructor", to: "constructor", adopted: "", rinst: "constructor|OLD", quiet: true }, expect: { rc: 1, CLASS: "instance_unresolved" } },
  { label: "a JSON null row for the actor with a binding: absent, not present", fx: { seats: { actor: null, other: { instance: "other|X" } }, history: [{ name: "actor.1.json", body: { handle: "actor", instance: "actor|OLD" } }] },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, CLASS: "instance_unresolved" } },
  // Review (fb6e8a52a HOLD 2): the native registry reader's
  // value domain (canonical integers only, registry.ts loadRegistry) is
  // narrower than the incumbent's Python json.load. A registry carrying a
  // float or an unsafe integer ANYWHERE is unreadable to every native reader
  // on main already; through the adapter the Bash door now inherits that.
  // Measured, pinned, and carried as a deviation for the leader's ruling.
  { label: "adoption grant beside an unrelated float field: the native value domain refuses what the incumbent granted, naming the value", fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"], observer_metadata: 0.5 } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "", quiet: true }, expect: { rc: 1, CLASS: "registry_unreachable", NEXT: "tap doctor" },
    deviation: { base: { rc: 0, GRANT: "pred" }, note: "the incumbent's json.load accepted 0.5; loadRegistry refuses the value domain (registry.ts) — ratified 06:13Z, the refusal names the value" } },
  { label: "adoption grant beside an unsafe integer field, with a binding: the native value domain refuses what the incumbent granted, naming the value", fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"], adopted_instances: { pred: "pred|OLD" }, observer_metadata: 9007199254740992 } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "pred|OLD", quiet: true }, expect: { rc: 1, CLASS: "registry_unreachable", NEXT: "tap doctor" },
    deviation: { base: { rc: 0, GRANT: "pred" }, note: "2^53 exceeds the safe-integer range; loadRegistry refuses — ratified 06:13Z, the refusal names the value" } },
  { label: "an ordinary integer field beside the grant: all three doors grant", fx: { seats: { actor: { ...ACT, adopted_handles: ["pred"], observer_metadata: 7 } } },
    args: { id: "ID1", from: "bob", actor: "actor", to: "pred", adopted: "", rinst: "", quiet: true }, expect: { rc: 0, GRANT: "pred" } },
  // Review (HOLD 3): a writerless FIFO named like a tombstone is skipped, never opened.
  { label: "own mail bound to a retired instance, the only 'tombstone' is a writerless FIFO: no clearing path, no hang", fx: { seats: { actor: ACT }, history: [{ name: "actor.1.json", fifo: true }] },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, MISMATCH: "1", RKIND: "none" } },
  { label: "a writerless FIFO beside a real tombstone: the real one still opens the door", fx: { seats: { actor: ACT }, history: [{ name: "actor.1.json", fifo: true }, { name: "actor.2.json", body: { handle: "actor", instance: "actor|OLD" } }] },
    args: { id: "ID1", from: "bob", actor: "actor", to: "actor", adopted: "", rinst: "actor|OLD", quiet: true }, expect: { rc: 1, MISMATCH: "1", RKIND: "command", RNEXT: "tap team" } },
];

if (import.meta.main) {
  const [id = "", from = "", actor = "", to = "", adoptedFrom = "", recipientInstance = ""] = process.argv.slice(2);
  const ctx = resolveContext();
  const result = addresseeGrant({
    registryPath: ctx.registryPath, adoptionRegistryPath: ctx.registryPath, marker: ctx.marker, team: ctx.team,
    historyDir: historyDirForBus(ctx.bus.home), id, from, actor, to, adoptedFrom, recipientInstance,
  });
  process.stdout.write(JSON.stringify({ ...result, registryPath: ctx.registryPath, marker: ctx.marker, historyDir: historyDirForBus(ctx.bus.home) }) + "\n");
}
