// Shared read/show address resolution. One resolver, every door, on purpose: an
// id that pastes into `tap show` must paste into `tap read`,
// `tap provenance` and native reply, and two copies of this logic would drift the
// moment either verb grew a form the other did not. Native verbs call
// `resolvePayloadAddress` directly.
import { validId } from "./ids";
import { busHomeForRoot, resolveBus } from "./bushome";
import { isOldStoreRefusal } from "./register-authority";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { addresseeGrant, historyDirForBus } from "./addressee-grant";
import { envelopeField, validateEnvelope } from "./envelope";
import { TapError, type Context } from "./context";
import { markerSelectedIndex, readIndexJson } from "./index-home";
import { archiveRows, archivedHistoryPayload, type ArchiveRow } from "./bus-archive-index";
import { digestPlan } from "./digest-items";
import { digestView, type DigestMember } from "./verbs/digest-view";
import { tapScriptsDir } from "./scripts-dir";

export const viewScripts = tapScriptsDir();
export interface PayloadView { path: string; team: string; residency: string; id: string; busHome: string }

export type ResolveMode = "payloads" | "show" | "read-recipient";
export type Residency = "payloads" | "digest" | "spool" | "history" | "archive" | "quarantine";
type Refusal<S extends string> = { status: S; detail: string };
export type Resolution =
  | { status: "found"; path: string; team: string; residency: Residency }
  | Refusal<"missing"> | Refusal<"badid"> | Refusal<"badteam"> | Refusal<"noteam"> | Refusal<"badselector"> | Refusal<"notrecipient"> | Refusal<"spool_address">
  | { status: "ambiguous"; candidates: string[] };

// The MINTED shape, in the CURRENT handle grammar. What makes a suffix
// right-anchorable is the two fixed-width trailing fields — the 16-character UTC
// stamp and the terminal 12 hex — not the charset of the handle in front of them.
// The id minter (ids.ts mintId) validates its sender against TAP_ID_RE and prints it
// VERBATIM, so real minted ids carry uppercase and dotted handles; spelling this
// `[a-z0-9][a-z0-9_-]*` imported §13's future narrowing a release early and made
// `tap show <hex>` miss a payload the courier had just minted.
const MINTED_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*-\d{8}T\d{6}Z-[0-9a-f]{12}$/;
// lib.sh TAP_ID_RE — what an id may actually be on this bus today.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX_RE = /^[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
// RESIDENCY PRECEDENCE: payloads > digest > spool > history > archive > quarantine.
// One id can legitimately name a file in more than one residency — a re-send or
// a corrected retry at the same id coexists with the older artifact. Refusing
// that pair as ambiguous left the recipient unable to read OR settle a valid
// obligation: this resolver serves `tap read`, so an unresolvable id is a STUCK
// MESSAGE, not merely an unhelpful `tap show`. The order is by what the reader
// owes: `payloads/` holds a live obligation somebody is waiting on; `archive/`
// one already withdrawn; `.quarantine/` the bytes of something that never
// parsed. It is a PREFERENCE, not a filter, and it never crosses buses.
const RESIDENCY_RANK: Residency[] = ["payloads", "digest", "spool", "history", "archive", "quarantine"];

/**
 * `os.path.realpath(strict=False)`, component by component.
 *
 * The order is the whole point and a lexical shortcut gets it wrong: a symlink
 * must be followed BEFORE the `..` that follows it is interpreted, because `..`
 * means the parent of the link's TARGET, not of the link. `resolve()` collapses
 * `link/..` textually, so `path=<bus>/link/../note.md` selected the caller's own
 * `note.md` instead of the foreign one the pointer actually names — two
 * different files, both exit 0 (partner review, R1). A dangling link is followed
 * too: its target is a real address whose residency the resolver still decides.
 */
function realpathLoose(path: string): string {
  const seen = new Map<string, string | null>();
  const walk = (start: string, input: string): [string, boolean] => {
    let base = start, rest = input;
    if (rest.startsWith("/")) { rest = rest.slice(1); base = "/"; }
    while (rest) {
      const cut = rest.indexOf("/");
      const name = cut === -1 ? rest : rest.slice(0, cut);
      rest = cut === -1 ? "" : rest.slice(cut + 1);
      if (!name || name === ".") continue;
      if (name === "..") {
        if (base) base = basename(base) === ".." ? join(base, "..") : dirname(base);
        else base = "..";
        continue;
      }
      const next = base ? join(base, name) : name;
      let link = false;
      try { link = lstatSync(next).isSymbolicLink(); } catch { link = false; }
      if (!link) { base = next; continue; }
      if (seen.has(next)) {
        const cached = seen.get(next)!;
        if (cached !== null) { base = cached; continue; }
        // A symlink loop stops resolution and keeps the remainder verbatim.
        return [rest ? join(next, rest) : next, false];
      }
      seen.set(next, null);
      const [target, ok] = walk(base, readlinkSync(next));
      if (!ok) return [rest ? join(target, rest) : target, false];
      seen.set(next, target);
      base = target;
    }
    return [base, true];
  };
  return resolve(walk("", path)[0]);
}
function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function isDir(path: string): boolean { try { return statSync(path).isDirectory(); } catch { return false; } }
/** Python's default string order is by code point; JS compares UTF-16 units. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
function escapeRe(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** The id a resolved file is a version OF — the thing the rank is allowed to rank.
 *
 * Grouping by bus alone was not enough. A 12-hex argument is a SUFFIX, so two
 * genuinely different logical ids can share it, and folding them together let a
 * live `alice-...-<hex>` silently displace a quarantined `bob-...-<hex>` — two
 * different messages, one dropped without a word. The rank chooses between
 * VERSIONS of one id; it must never choose between ids.
 */
export function logicalId(path: string, residency: string): string {
  let name = basename(path);
  if (residency === "digest") return name.slice(0, -5);
  if (residency === "quarantine") name = name.replace(/\.md\.[0-9]+$/, ".md");
  if (residency === "archive" && name.endsWith(".cancelled.md")) return name.slice(0, -".cancelled.md".length);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** The enrolled-team map of a machine index; a missing or unparseable file is empty. */
function indexTeams(indexPath: string): Record<string, unknown> {
  if (!indexPath || !isFile(indexPath)) return {};
  let teams: unknown;
  try { teams = (readIndexJson(indexPath) as { teams?: unknown })?.teams || {}; } catch { return {}; }
  if (typeof teams !== "object" || teams === null || Array.isArray(teams)) throw new Error("machine index teams is not an object");
  return teams as Record<string, unknown>;
}
function teamRoot(entry: unknown): string {
  if (!entry) return "";
  if (typeof entry !== "object") throw new Error("machine index team entry is not an object");
  const root = (entry as { root?: unknown }).root;
  if (!root) return "";
  if (typeof root !== "string") throw new Error("machine index team root is not a string");
  return root;
}
function busOfRoot(root: string): string {
  return busHomeForRoot(root);
}

class Resolver {
  private readonly tried: string[] = [];
  private readonly includeSpool: boolean;
  private readonly archiveCache = new Map<string, Map<string, ArchiveRow>>();
  constructor(
    private readonly localBus: string, private readonly indexPath: string, private readonly mode: ResolveMode,
    private readonly actor: string, private readonly grant?: GrantContext,
  ) { this.includeSpool = mode === "show" || mode === "read-recipient"; }

  /** Every bus this machine can reach, local first, each with its team name. */
  private buses(): Array<[string, string]> {
    const seen = new Set<string>(), out: Array<[string, string]> = [];
    const add = (name: string, bus: string) => {
      const real = realpathLoose(bus);
      if (seen.has(real) || !isDir(real)) return;
      seen.add(real);
      out.push([name, real]);
    };
    add("", this.localBus);
    const teams = indexTeams(this.indexPath);
    for (const name of Object.keys(teams).sort(byCodePoint)) {
      const root = teamRoot(teams[name]);
      if (!root) continue;
      const bus = resolveBus(root, {});
      if (bus.rule !== "old_store") add(name, bus.home);
    }
    return out;
  }
  private teamBus(name: string): string | null {
    if (!this.indexPath || !isFile(this.indexPath)) return null;
    let root: string;
    try { root = teamRoot(indexTeams(this.indexPath)[name]); } catch { return null; }
    if (!root) return null;
    return realpathLoose(busOfRoot(root));
  }
  /** The team whose ENROLLED bus is exactly this one, or null. Enrollment
   * follows the repository's definition (relaunch census, register-offline):
   * a row that is not historical, with an acting registry that is a readable
   * regular file. */
  private enrolledForeignBus(bus: string): string | null {
    let teams: Record<string, unknown>;
    try { teams = indexTeams(this.indexPath); } catch { return null; }
    for (const name of Object.keys(teams)) {
      if (name === "") continue;
      const entry = teams[name];
      if (!entry || typeof entry !== "object") continue;
      const row = entry as { state?: unknown; registry_location?: unknown };
      if (String(row.state ?? "registered") === "historical") continue;
      const loc = row.registry_location;
      if (typeof loc !== "string" || !loc || !isFile(loc)) continue;
      let doc: unknown;
      try { doc = JSON.parse(readFileSync(loc, "utf8")); } catch { continue; }
      if (typeof doc !== "object" || doc === null) continue;
      const root = teamRoot(entry);
      if (!root) continue;
      const candidate = resolveBus(root, {});
      if (candidate.rule !== "old_store" && realpathLoose(candidate.home) === bus) return name;
    }
    return null;
  }
  private archiveIndex(bus: string): Map<string, ArchiveRow> {
    let rows = this.archiveCache.get(bus);
    if (!rows) { rows = archiveRows(bus); this.archiveCache.set(bus, rows); }
    return rows;
  }
  private quarantineSiblings(quar: string): string[] {
    const dir = dirname(quar), base = basename(quar), out: string[] = [];
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    const sibling = new RegExp("^" + escapeRe(base) + "\\.[0-9]+$");
    for (const name of names) if (sibling.test(name)) out.push(realpathLoose(join(dir, name)));
    return out;
  }

  /** Every file one logical id has on ONE bus, whatever its residency: the
   *  show-only disclosure scan reads this beside the fold, never through it. */
  copiesOn(bus: string, ident: string): Array<[string, string, Residency]> {
    return this.candidatesFor([["", bus]], ident);
  }

  /** (path, team, residency) for every file this argument could name. */
  private candidatesFor(search: Array<[string, string]>, ident: string): Array<[string, string, Residency]> {
    const hits: Array<[string, string, Residency]> = [];
    for (const [name, bus] of search) {
      const live = join(bus, "payloads", ident + ".md");
      if (isFile(live)) hits.push([realpathLoose(live), name, "payloads"]);
      const digest = join(bus, "spool", "digests", ident + ".json");
      this.tried.push(live, digest);
      if (isFile(digest)) hits.push([realpathLoose(digest), name, "digest"]);
      let queued = "";
      if (this.includeSpool) {
        queued = join(bus, "spool", ident + ".md");
        this.tried.push(queued);
        if (isFile(queued)) hits.push([realpathLoose(queued), name, "spool"]);
      }
      const active = isFile(live) || isFile(digest) || (this.includeSpool && isFile(queued));
      const history = active ? undefined : this.archiveIndex(bus).get(ident);
      if (history) hits.push([archivedHistoryPayload(bus, history), name, "history"]);
      const arch = join(bus, "archive", ident + ".cancelled.md");
      this.tried.push(arch);
      if (isFile(arch)) hits.push([realpathLoose(arch), name, "archive"]);
      // Quarantined malformed payloads stay inspectable. "Listable, bytes
      // preserved" is only true if something can read them back — a quarantine
      // nothing can open is a delete with a longer path. A RE-quarantined name
      // collides to `<id>.md.N` (bytes preserved, never overwritten); those
      // siblings are evidence too — the newest N is what show must surface,
      // chosen by the collapse below.
      const quar = join(bus, "payloads", ".quarantine", ident + ".md");
      this.tried.push(quar);
      if (isFile(quar)) hits.push([realpathLoose(quar), name, "quarantine"]);
      for (const sib of this.quarantineSiblings(quar)) hits.push([sib, name, "quarantine"]);
    }
    return hits;
  }

  resolve(rawArg: string, rawExplicit: string): Resolution {
    let arg = rawArg, explicit = rawExplicit;
    if (arg.startsWith("path=")) { explicit = arg.slice(5); arg = ""; }
    // Split the address only; the digest policy owns ordinal validity and selection.
    let selector: string | null = null;
    if (!explicit && arg.includes(":")) {
      const cut = arg.lastIndexOf(":");
      const parent = arg.slice(0, cut), candidate = arg.slice(cut + 1);
      const parts = parent.split("/");
      if (parts.length <= 2 && parts.every(part => TOKEN_RE.test(part))) { arg = parent; selector = candidate; }
    }
    const result = this.resolveAddress(arg, explicit);
    if (result.status !== "found") return result;
    if (result.residency === "spool" && this.mode === "read-recipient") {
      const refusal = this.recipientRefusal(result.path);
      if (refusal) return refusal;
    }
    if (selector === null) return result;
    if (result.residency !== "digest") return { status: "badselector", detail: "item selectors require a digest" };
    let member: string;
    try {
      const doc = JSON.parse(readFileSync(result.path, "utf8"));
      member = digestPlan({ doc, path: result.path, verb: "read", all: false, selected: "", ordinal: selector, verbose: false }).items[0]!.path;
    } catch (error) {
      return { status: "badselector", detail: String((error as Error).message ?? error) };
    }
    // Resolve the selected canonical pointer with the existing residency,
    // ambiguity and archive rules. No selector remains, so this cannot loop.
    return new Resolver(this.localBus, this.indexPath, this.mode, this.actor, this.grant).resolve("path=" + member, "");
  }

  /** Foreign parked bytes stay on the sender's bus: the recipient predicate is
   *  the native grant decision, resolved from the CALLER's context, then applied
   *  on the RESOLVED bus. */
  private recipientRefusal(path: string): Resolution | null {
    const id = basename(path).slice(0, -3);
    if (!this.actor) return { status: "notrecipient", detail: id };
    let target: unknown = null;
    try { target = (JSON.parse(readFileSync(path.slice(0, -3) + ".meta.json", "utf8")) as { target?: unknown })?.target ?? null; } catch { target = null; }
    if (target === this.actor) return null;
    if (!this.grant) return { status: "notrecipient", detail: id };
    return spoolAuthorized(path, this.actor, this.grant) ? null : { status: "notrecipient", detail: id };
  }

  private resolveAddress(arg: string, explicit: string): Resolution {
    let scope: string | null = null, ident = arg;
    if (arg.includes("/")) {
      const cut = arg.indexOf("/");
      scope = arg.slice(0, cut); ident = arg.slice(cut + 1);
      if (!TOKEN_RE.test(scope)) return { status: "badteam", detail: scope };
    }
    let search: Array<[string, string]>;
    if (scope !== null) {
      const bus = this.teamBus(scope);
      if (bus === null && !explicit) return { status: "noteam", detail: scope };
      search = bus === null ? [] : [[scope, bus]];
    } else search = this.buses();

    let hits: Array<[string, string, Residency]> = [];
    if (ID_RE.test(ident)) {
      // Preserve exact-local precedence without consulting unrelated archive indexes.
      if (scope === null && !HEX_RE.test(ident) && search.length && realpathLoose(search[0]![1]) === realpathLoose(this.localBus)) {
        const local = this.candidatesFor(search.slice(0, 1), ident);
        hits.push(...local);
        if (!local.some(h => h[2] === "payloads" || h[2] === "digest" || h[2] === "spool")) hits.push(...this.candidatesFor(search.slice(1), ident));
      } else hits.push(...this.candidatesFor(search, ident));
    }

    // A 12-hex argument is a suffix as well as a possible literal id, so both doors
    // are opened and the union decides. Collapsing them the other way would let a
    // file literally named <hex>.md silently shadow the suffix match, or vice versa.
    if (HEX_RE.test(ident)) {
      const suffix = "-" + ident + ".md";
      for (const [name, bus] of search) {
        for (const [archivedId, history] of this.archiveIndex(bus)) {
          if (archivedId.endsWith("-" + ident) && MINTED_RE.test(archivedId)) hits.push([archivedHistoryPayload(bus, history), name, "history"]);
        }
        const residencies: Array<[string, string, Residency]> = [
          ["payloads", ".md", "payloads"], [join("spool", "digests"), ".json", "digest"],
          ["archive", ".cancelled.md", "archive"], [join("payloads", ".quarantine"), ".md", "quarantine"],
        ];
        if (this.includeSpool) residencies.push(["spool", ".md", "spool"]);
        for (const [sub, , residency] of residencies) {
          const pdir = join(bus, sub);
          let names: string[];
          try { names = readdirSync(pdir); } catch { continue; }
          for (const fn of names.sort(byCodePoint)) {
            if (fn.startsWith("_")) continue;
            let stem: string;
            if (residency === "digest") {
              if (!fn.endsWith("-" + ident + ".json")) continue;
              stem = fn.slice(0, -5);
            } else if (residency === "payloads" || residency === "quarantine" || residency === "spool") {
              if (fn.endsWith(suffix)) stem = fn.slice(0, -3);
              else if (residency === "quarantine" && new RegExp("^.*" + escapeRe(suffix) + "\\.[0-9]+$").test(fn)) {
                // Collision sibling `<minted-id>.md.N`. The match must be against the
                // WHOLE filename, not the bare suffix: `fn` is the full minted name, so
                // anchoring on `-<hex>.md.N` alone never matched and the hex door kept
                // selecting the older unsuffixed artifact. The stem is the filename
                // minus `.md.N` — a bare 12-hex stem fails MINTED_RE two lines later.
                stem = fn.slice(0, fn.lastIndexOf(suffix)) + suffix.slice(0, -3);
              } else continue;
            } else {
              if (!fn.endsWith("-" + ident + ".cancelled.md")) continue;
              stem = fn.slice(0, -".cancelled.md".length);
            }
            if (!MINTED_RE.test(stem)) continue;
            hits.push([realpathLoose(join(pdir, fn)), name, residency]);
          }
        }
      }
    }

    // A quarantined name is EVIDENCE, not an address that must satisfy the live-id
    // grammar. Malformed payloads are exactly where arbitrary filenames occur — a
    // canonical literally named `bad id.md` quarantines fine, and the notice tells
    // the reader to `tap show` it — so applying ID_RE before the quarantine search
    // made the prescribed recovery command unable to reach the bytes it points at.
    // `.quarantine` is looked up by EXACT basename only: no suffix scan, no globbing,
    // and a path separator or a `..` component is refused rather than joined, so this
    // widens what can be NAMED without widening where the resolver can look.
    if (ident && !ID_RE.test(ident) && !HEX_RE.test(ident)) {
      if (!ident.includes("/") && !ident.includes("\\") && ident !== "." && ident !== "..") {
        for (const [name, bus] of search) {
          const quar = join(bus, "payloads", ".quarantine", ident + ".md");
          if (isFile(quar)) hits.push([realpathLoose(quar), name, "quarantine"]);
          // RE-quarantine collides to `<name>.md.N`, and a name that fails the
          // live-id grammar re-quarantines exactly like one that passes it.
          for (const sib of this.quarantineSiblings(quar)) hits.push([sib, name, "quarantine"]);
        }
      }
      if (!hits.length) return { status: "badid", detail: ident };
    }

    // An explicit sentinel pointer is a fallback, after normal address resolution.
    // It can also be supplied alone as path=<absolute-path>.
    if (!hits.length && explicit) {
      const path = realpathLoose(explicit);
      this.tried.push(path);
      const parent = dirname(path);
      // `tap read` settles obligations through the id, so a read-recipient
      // address that IS the queue entry bypasses every adoption gate (target,
      // addressee, reply expectation) that id lookup passes through. Two
      // exceptions keep the door honest: the bus behind the address must be an
      // ENROLLED foreign bus — the one shape `tap poll` renders as a foreign
      // address — and the logical id must not be live on the local bus, where
      // the local canonical copy owns settlement. Everything else refuses
      // here, before any custody is compared; the canonical pointer
      // `payloads/<id>.md` keeps following the id to wherever it currently
      // lives, and `tap show path=` keeps its forensic spool view.
      if (basename(parent) === "spool" && this.mode === "read-recipient") {
        const id = path.endsWith(".md") ? basename(path).slice(0, -3) : "";
        const bus = realpathLoose(dirname(parent));
        const enrolled = id ? this.enrolledForeignBus(bus) : null;
        // "Not live locally" is the resolver's own live residency set —
        // canonical, queued spool, digest — not just the canonical file.
        // Archive/history/quarantine evidence is not live and never blocks.
        const localLive = id ? this.candidatesFor([["", this.localBus]], id)
          .some(([, , residency]) => residency === "payloads" || residency === "digest" || residency === "spool") : false;
        if (!enrolled || localLive) return { status: "spool_address", detail: path };
        hits.push(...this.candidatesFor([[enrolled, bus]], id));
      } else if (basename(parent) === "payloads" && basename(dirname(dirname(parent))) === "archive" && MONTH_RE.test(basename(dirname(parent)))) {
        hits.push(...this.candidatesFor([["", dirname(dirname(dirname(parent)))]], basename(path).slice(0, -3)));
      } else if (basename(parent) === "payloads" && path.endsWith(".md")) {
        hits.push(...this.candidatesFor([["", dirname(parent)]], basename(path).slice(0, -3)));
      } else if (isFile(path)) {
        let residency: Residency = path.endsWith(".json") ? "digest" : path.endsWith(".cancelled.md") ? "archive" : "payloads";
        if (basename(parent) === "spool" && path.endsWith(".md")) residency = "spool";
        if (basename(parent) === ".quarantine") residency = "quarantine";
        hits.push([path, "", residency]);
      }
    }

    // Collapse quarantine siblings (exact `.md` + numbered `.md.N`) to ONE hit per
    // bus — the NEWEST evidence (highest N; the base name is N=-1) — so a
    // requarantined id resolves to its latest preserved bytes instead of tripping
    // the ambiguity guard.
    const qnum = (p: string) => { const m = /\.md\.([0-9]+)$/.exec(p); return m ? Number(m[1]) : -1; };
    const qbest = new Map<string, [string, string, Residency]>();
    for (const h of hits) {
      if (h[2] !== "quarantine") continue;
      const key = h[1] + "\0" + h[0].replace(/\.md\.[0-9]+$/, ".md");
      const best = qbest.get(key);
      if (!best || qnum(h[0]) > qnum(best[0])) qbest.set(key, h);
    }
    hits = [...hits.filter(h => h[2] !== "quarantine"), ...qbest.values()];

    // Fold per (bus, logical id): one bus never suppresses another, and within a bus
    // one id never suppresses a different one. Ambiguity then runs across whatever
    // survives, so a real collision — two buses, or two logical ids under one
    // suffix — is still reported rather than resolved by accident. A global fold
    // let a caller whose own bus held quarantined evidence be handed another
    // team's live payload with nothing said about the local artifact.
    const groups = new Map<string, Array<[string, string, Residency]>>();
    for (const h of hits) {
      const key = h[1] + "\0" + logicalId(h[0], h[2]);
      const group = groups.get(key);
      if (group) group.push(h); else groups.set(key, [h]);
    }
    hits = [];
    for (let group of groups.values()) {
      for (const rank of RESIDENCY_RANK) {
        if (group.some(h => h[2] === rank)) { group = group.filter(h => h[2] === rank); break; }
      }
      hits.push(...group);
    }

    // Exact local addresses win before machine-wide fallback. Short suffixes still
    // inspect every bus and refuse ambiguity.
    if (scope === null && ident && !HEX_RE.test(ident)) {
      const localReal = realpathLoose(this.localBus);
      const local = hits.filter(h => (h[2] === "payloads" || h[2] === "digest" || h[2] === "spool")
        && localReal === (h[2] === "digest" ? dirname(dirname(dirname(h[0]))) : dirname(dirname(h[0]))));
      if (local.length) hits = local;
    }

    const uniq = [...new Set(hits.map(h => h[0]))].sort(byCodePoint);
    const missing = (): Resolution => ({ status: "missing", detail: ident + "\ntried:\n  " + this.tried.join("\n  ") });
    if (!uniq.length) return missing();
    if (uniq.length > 1) return { status: "ambiguous", candidates: uniq };
    for (const [path, team, residency] of hits) if (path === uniq[0]) return { status: "found", path, team, residency };
    return missing();
  }
}

/**
 * Resolve one payload argument — `<id>`, `<team>/<id>`, `<12hex>`, `<digest>:<n>`,
 * `path=<file>` — to one file. `mode` widens what may be named: `payloads` (reply,
 * done, provenance) never sees queued mail; `show` inspects it; `read-recipient`
 * inspects it and refuses foreign parked bytes for `actor`. `explicit` is the
 * sentinel pointer fallback consulted after address resolution finds nothing.
 */
export function resolvePayloadAddress(arg: string, localBus: string, indexPath: string, mode: ResolveMode, explicit = "", actor = "", grant?: GrantContext): Resolution {
  return new Resolver(localBus, indexPath, mode, actor, grant).resolve(arg, explicit);
}

/** The parked-recipient predicate the read door and the resolver share: a valid
 *  envelope naming its file, queue metadata aimed at the envelope's addressee,
 *  a team-local destination, and the caller-context addressee grant. */
export interface GrantContext { registryPath: string; marker: "absent" | "live"; team: string; historyDir: string }
export function spoolAuthorized(payload: string, actor: string, grant: GrantContext): boolean {
  const id = basename(payload).slice(0, -3);
  let raw: string;
  try { raw = readFileSync(payload, "utf8"); } catch { return false; }
  if (!validateEnvelope(raw).ok) return false;
  const field = (key: string) => envelopeField(raw, key) ?? "";
  if (field("id") !== id) return false;
  const to = field("to");
  let target = "";
  try { target = (JSON.parse(readFileSync(payload.slice(0, -3) + ".meta.json", "utf8")) as { target?: unknown }).target as string ?? ""; } catch { target = ""; }
  if (target !== to) return false;
  const toTeam = field("to_team");
  if (toTeam && toTeam !== grant.team) return false;
  return addresseeGrant({
    registryPath: grant.registryPath, adoptionRegistryPath: grant.registryPath, marker: grant.marker, team: grant.team, historyDir: grant.historyDir,
    id, from: field("from"), actor, to, adoptedFrom: field("to_adopted_from"), recipientInstance: field("recipient_instance"),
  }).ok;
}

/** The wire line Bash callers parse: `<status>\x1f<fields...>`. */
export function resolutionLine(result: Resolution): string {
  switch (result.status) {
    case "found": return ["found", result.path, result.team, result.residency].join("\x1f");
    case "ambiguous": return ["ambiguous", result.candidates.join("\x1e")].join("\x1f");
    default: return [result.status, result.detail].join("\x1f");
  }
}

/** One residency that holds a lower-ranked copy of a resolved logical id. */
export interface LowerRankedCopies { residency: Residency; count: number; example: string }

/**
 * What `tap show` discloses beside the winner of the residency fold: the
 * residencies BELOW it that hold the same logical id on the same bus, grouped
 * per residency with a count and one example path (bus-relative; the newest
 * numbered sibling for quarantine). A sibling scan, not a resolver output: the
 * winner, ambiguity and settlement behavior stay exactly what the fold chose.
 */
export function lowerRankedCopies(view: PayloadView): LowerRankedCopies[] {
  const rank = RESIDENCY_RANK.indexOf(view.residency as Residency);
  if (rank < 0) return [];
  const copies = new Resolver(view.busHome, "", "show", "").copiesOn(view.busHome, view.id)
    .filter(([path, , residency]) => RESIDENCY_RANK.indexOf(residency) > rank && logicalId(path, residency) === view.id
      // The shared scan names numbered quarantine siblings without a type check; a disclosure counts only real files.
      && isFile(path));
  const out: LowerRankedCopies[] = [];
  for (const residency of RESIDENCY_RANK.slice(rank + 1)) {
    const group = copies.filter(h => h[2] === residency).map(h => h[0]);
    if (!group.length) continue;
    const newest = (p: string) => { const m = /\.md\.([0-9]+)$/.exec(p); return m ? Number(m[1]) : -1; };
    const example = group.reduce((a, b) => (newest(b) > newest(a) ? b : a));
    const rel = relative(view.busHome, example);
    out.push({ residency, count: group.length, example: rel.startsWith("..") ? example : rel });
  }
  return out;
}

export function resolveView(ctx: Context & Pick<GrantContext, "marker">, arg: string, verb: "read" | "show", actor = "", explicit = ""): PayloadView {
  const index = markerSelectedIndex(process.env.TAP_INDEX_HOME);
  const grant: GrantContext = { registryPath: ctx.registryPath, marker: ctx.marker, team: ctx.team, historyDir: historyDirForBus(ctx.bus.home) };
  return resolvePayloadView(ctx.bus.home, index.marker === "live" ? index.path : "", arg, verb, actor, explicit, grant);
}

function resolvePayloadView(busHome: string, index: string, arg: string, verb: "read" | "show" | "reply", actor = "", explicit = "", grant?: GrantContext): PayloadView {
  let result: Resolution;
  try { result = resolvePayloadAddress(arg, busHome, index, verb === "show" ? "show" : verb === "read" ? "read-recipient" : "payloads", explicit, actor, grant); }
  catch (error) { if (isOldStoreRefusal(error)) throw error; throw new TapError(1, "resolution_failed", "tap doctor", `could not resolve '${arg}'`); }
  const next = `tap ${verb} <id|team/id|12hex>`;
  const detail = result.status === "found" || result.status === "ambiguous" ? "" : result.detail;
  if (result.status === "badselector") throw new TapError(1, "usage_error", "tap read <digest-id> --all", detail);
  if (result.status === "badteam") throw new TapError(1, "usage_error", next, `'${detail}' is not a valid team name (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
  if (result.status === "noteam") throw new TapError(1, "not_found", "tap teams", `no enrolled team '${detail}' on this machine`);
  if (result.status === "badid") throw new TapError(1, "usage_error", next, (verb === 'show' ? `'${detail}' is neither a full payload id (<handle>-<UTC ts>-<12hex>) nor a 12-hex suffix` : `'${detail}' is neither a valid payload id nor a 12-hex suffix`));
  if (result.status === "notrecipient") throw new TapError(1, "not_recipient", `tap show ${detail}`, `parked payload '${detail}' is not queued for '${actor}'`);
  if (result.status === "spool_address") throw new TapError(1, "usage_error", next, `'${detail}' is a delivery-queue address; settle it by id (${next}) or inspect the parked bytes with tap show 'path=${detail}'`);
  if (result.status === "missing") throw new TapError(1, "not_found", verb === "read" ? `tap poll ${actor}` : verb === "reply" ? "tap poll; tap teams; ask the sender for the payload id or path; with that path in hand, tap reply <id> --payload <abs-path-from-sentinel> -f <file>" : "tap poll  OR  tap show <team>/<id>", `no payload '${detail}' on this bus or any enrolled team bus`.replace(/[\r\n]/g,' '));
  if (result.status === "ambiguous") throw new TapError(1, "ambiguous_id", `tap ${verb} <full-id>${verb === "show" ? "  (pick one of the candidates below)" : ""}`, `'${arg}' matches more than one payload${verb === 'show' ? ' — a suffix is only an address while it is unique' : ''}:\n${result.candidates.map(p => `  ${p}`).join("\n")}`.replace(/[\r\n]/g," "));
  const { path, team, residency } = result;
  const resolvedBus = residency === "history" ? dirname(dirname(dirname(dirname(path)))) : residency === "digest" || residency === "quarantine" ? dirname(dirname(dirname(path))) : dirname(dirname(path));
  return { path, team, residency, id: logicalId(path, residency), busHome: resolvedBus };
}

// Digest indexing and member dispatch remain one implementation across doors.
export function renderDigest(verb: "read" | "show", path: string, all: boolean, selected: string, forward: string[] = [], address = "", member?: DigestMember): number {
  return digestView([verb, path, all ? "1" : "0", selected, viewScripts, ...forward, ...(address ? ["--digest-address", address] : [])], member);
}

/** Reply shares read/show lookup, but never adopts parked or archived custody. */
export function resolveReplyReference(ref: string, bus: string, index: string, explicit = ""): PayloadView {
  const path = explicit || (ref.startsWith("path=") ? ref.slice(5)
    : existsSync(ref) || /^(?:\/|\.\.?\/)/.test(ref) || ref.endsWith(".md") ? ref : "");
  // A pane-rendered payload path is external input. Keep reply aligned with
  // done: validate the address before realpathLoose can make it look absolute.
  if (path && !isAbsolute(path)) throw new TapError(1, "usage_error", "tap help reply",
    `--payload must be an absolute path (got: ${path})`);
  // An explicit path is authoritative, not a fallback behind a colliding local id.
  const view = resolvePayloadView(bus, index, path ? "" : ref, "reply", "", path);
  if (explicit && (!validId(ref) || view.id !== ref)) throw new TapError(1, "usage_error", "tap reply <id> --payload <matching-path> -f <body-file>",
    `explicit payload id '${view.id}' does not match '${ref}'`);
  if (view.residency !== "payloads") throw new TapError(1, "not_obligation", `tap read ${ref}`,
    `reply requires a canonical payload; '${ref}' resolves to ${view.residency}`);
  return view;
}

if (import.meta.main) {
  const [operation, ...rest] = Bun.argv.slice(2);
  if (operation === "resolve") {
    // <arg> <bus> <index> [<mode> [<explicit> [<actor>]]]: one status line, exit 0;
    // a thrown error (unsafe archive, unreadable index) is the only non-zero exit.
    const [arg, bus, index, mode = "payloads", explicit = "", actor = ""] = rest;
    if (arg === undefined || bus === undefined || index === undefined || !["payloads", "show", "read-recipient"].includes(mode)) process.exit(2);
    try { process.stdout.write(resolutionLine(resolvePayloadAddress(arg, bus, index, mode as ResolveMode, explicit, actor)) + "\n"); }
    catch (error) { process.stderr.write(`tap: payload resolve: ${String((error as Error).message ?? error)}\n`); process.exit(1); }
  } else if (operation === "reply-reference") {
    const [ref, bus, index, explicit = ""] = rest;
    if (!ref || !bus || index === undefined) process.exit(2);
    try {
      const item = resolveReplyReference(ref, bus, index, explicit);
      process.stdout.write(["found", item.path, item.id].join("\x1f") + "\n");
    } catch (error) {
      if (!(error instanceof TapError)) throw error;
      process.stdout.write(["error", error.errorClass, error.action, error.detail.replace(/[\r\n]/g, " ")].join("\x1f") + "\n");
    }
  } else process.exit(2);
}
