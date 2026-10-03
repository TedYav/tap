// The ONE writer, stamper and reaper of the courier-owned digest index,
// `spool/digests/<digest-id>.json` (CONTRACT.md § Index, § Retention). Ported
// from lib.sh `tap_digest_write_index`, `tap_digest_stamp_injected` and
// `tap_digest_reap_settled` — three inline Python programs, the first of which
// shelled BACK into lib.sh to reach `digest-items.ts` for numbering — and from
// `owner.ts`'s second copy of the writer and the GC, which had drifted from the
// courier's bytes (unsorted keys, raw non-ASCII) and from its retention RULE
// (an un-injected all-terminal index was reaped at once; the contract says
// publication time supplies the minimum window). Two answers to "may this
// digest be reaped" in one runtime is the parallel engine the epic forbids;
// this module is the only answer now. The dormant owner has been retired;
// the live courier and its Bash adapters still use these helpers.
//
// Byte-fidelity to the Python programs is the point of the differential in the
// PR, not a nicety: `json.dump(indent=2, sort_keys=True)` bytes, Python
// `str.splitlines()` and `str.strip()` in the frontmatter reader, Python
// truthiness on carried values, `int()` truncation of file mtimes computed the
// way CPython computes them, and the incumbent's tolerance shapes (which
// malformed inputs are skipped, which abort).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { numberDigestItems } from "./digest-items";
import { pyPrint } from "./spool-sidecar";
import { PyFloat, PyInt, isDict, metaBytes, parseJsonPreserving, pyInt, pyStrCompare, pyStrip, pyTruthy } from "./spool-publication";

/** Matches lib.sh `TAP_DIGEST_RETAIN_DEFAULT`. */
export const DIGEST_RETAIN_DEFAULT = 86400;

export function digestIndexPath(spoolDir: string, digestId: string): string {
  return join(spoolDir, "digests", `${digestId}.json`);
}

/**
 * Python `str.splitlines()`: every line boundary Python recognizes, not just
 * `\n` — `\r`, `\r\n`, `\v`, `\f`, FS/GS/RS, NEL, LS, PS. A trailing boundary
 * yields no empty last line in Python; here it yields one, which no test below
 * can distinguish (an empty line is neither a fence nor a key).
 */
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/**
 * The incumbent's `field(payload, key)`: first `---`..`---` block, one
 * `key: value` scalar per line matched by PREFIX (`key:` with no space
 * required), value `.strip()`ped. A missing or unopenable file is "" (Python
 * caught `OSError`); an undecodable one is NOT — `UnicodeDecodeError` is not
 * an `OSError`, so it took the whole publication down, and still does.
 */
function pyField(path: string, key: string): string {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { return ""; } // `except OSError: return ""`
  // A leading U+FEFF is kept, as Python keeps it; `str.strip()` does not remove
  // it (it is Cf, not whitespace), so a payload that begins with a BOM has no
  // fence and every field reads "". A non-UTF-8 payload throws, as
  // `UnicodeDecodeError` did — it is not an `OSError`.
  const lines = pyDecode(bytes).split(PY_LINE_BREAK);
  if (lines.length === 0 || pyStrip(lines[0]!) !== "---") return "";
  for (const line of lines.slice(1)) {
    if (pyStrip(line) === "---") break;
    if (line.startsWith(`${key}:`)) return pyStrip(line.slice(key.length + 1));
  }
  return "";
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Python's `open(path, encoding="utf-8").read()`: a byte sequence that is not
 * UTF-8 raises rather than becoming U+FFFD, and a leading BOM is kept. The
 * caller's disposition of the throw is the incumbent's at that call site.
 */
function pyDecode(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function pyReadText(path: string): string {
  return pyDecode(readFileSync(path));
}

/** `tempfile.mkstemp(dir=d, prefix=".digest.")` + `os.replace`: mode 0600, same directory. */
function replaceIndex(path: string, bytes: string): void {
  const dir = dirname(path) || ".";
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.digest.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  // Only a temp THIS call created is ours to remove: when `wx` refuses with
  // EEXIST the bytes at that name belong to another writer.
  let created = false;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (error) { if (created) rmSync(tmp, { force: true }); throw error; }
}

export interface DigestMember {
  id: string;
  /** The caller observed a settlement receipt for this id: `settled: true`, `reply: none`. */
  presettled: boolean;
}

export interface WriteDigestIndexInput {
  indexPath: string;
  digestId: string;
  toTeam: string;
  handle: string;
  courier: string;
  spoolDir: string;
  payloadsDir: string;
  members: DigestMember[];
}

/**
 * Publish (or REWRITE) the index. Frontmatter is read from whichever copy of
 * each payload exists, spool first: after the move only the canonical is
 * there, and a spool-only reader would default every `reply` to `expected`.
 * A rewrite replaces the document, so `injected_at_epoch` stamped on the
 * earlier version is carried across explicitly — losing it would make a
 * delivered index instantly reapable. Membership on a rewrite is decided by
 * `numberDigestItems`: members may drop, never join, and each keeps its
 * ordinal.
 */
export function writeDigestIndex(input: WriteDigestIndexInput): void {
  const items: Array<Record<string, unknown>> = [];
  for (const member of input.members) {
    const spoolCopy = join(input.spoolDir, `${member.id}.md`);
    const canonical = join(input.payloadsDir, `${member.id}.md`);
    const source = isFile(spoolCopy) ? spoolCopy : canonical;
    const item: Record<string, unknown> = {
      id: member.id,
      from: pyField(source, "from"),
      kind: pyField(source, "kind") || "discuss",
      reply: pyField(source, "reply") || "expected",
      path: canonical,
    };
    const preview = pyField(source, "sentinel_preview");
    if (preview) item.sentinel_preview = preview;
    if (member.presettled) {
      // The caller observed a recipient or historical settlement receipt.
      // Do not ask the recipient to settle that same item again.
      item.settled = true;
      item.reply = "none";
    }
    items.push(item);
  }
  writeDigestIndexDoc(input.indexPath, {
    v: 1,
    digest_id: input.digestId,
    kind: "digest",
    from: `${input.toTeam}/${input.courier}`,
    to: input.handle,
    to_team: input.toTeam,
    count: items.length,
    instructions: digestInstructions(input.digestId, items),
    items,
  });
}

/** The non-collapse contract, inline for the reading agent. One text; the dark owner renders the same one. */
export function digestInstructions(digestId: string, items: Array<Record<string, unknown>>): string {
  const n = items.length;
  const expected = items.filter(item => item.reply === "expected").length;
  const presettled = items.filter(item => pyTruthy(item.settled)).length;
  let instructions =
    `TAP digest: ${n} spooled payload(s) delivered in ONE wake. This digest id ` +
    `(${digestId}) records its own read separately from its items. ` +
    `Use \`tap read ${digestId} --all\` to read its items, then obey EACH item's reply= — ` +
    `\`tap reply <id> -f <file>\` for an ask, \`tap read <id>\` for a note. ` +
    `One reply never covers the batch; ${expected} of ${n} still owe a reply.`;
  if (presettled) {
    instructions +=
      ` ${presettled} of ${n} carry \`settled: true\` and \`reply: none\`: they already ` +
      `have settlement receipts. READ them, do the work they assign, ` +
      `and settle NOTHING. Reply to such an item only ` +
      `to report a problem; that still works.`;
  }
  return instructions;
}

export interface DigestIndexDoc {
  v: 1;
  digest_id: string;
  kind: "digest";
  from: string;
  to: string;
  to_team: string;
  count: number;
  instructions: string;
  items: Array<Record<string, unknown>>;
  injected_at_epoch?: number;
}

/**
 * Publish or rewrite an index DOCUMENT: members numbered against the prior
 * index (drop, never join; ordinals kept), the prior `injected_at_epoch`
 * carried unless the caller stamps its own, and the courier's bytes. Both the
 * Bash courier (through `writeDigestIndex`) and the dark owner write through
 * here, which is what makes "the courier's bytes" one thing.
 */
export function writeDigestIndexDoc(indexPath: string, doc: DigestIndexDoc): void {
  let previous: unknown = null;
  const out: Record<string, unknown> = { ...doc };
  if (existsSync(indexPath)) {
    const prior = parseJsonPreserving(pyReadText(indexPath));
    if (!isDict(prior) || !Array.isArray(prior.items)) throw new Error("invalid previous digest items");
    // The incumbent's prior items crossed a Python→JSON→Bun boundary that
    // handed the numbering validator primitive numbers; the preserving parser
    // hands it wrappers. Unwrap the ordinal only — the validator keeps its
    // safe/positive/unique checks (`1.5` and `2^53+1` still refuse).
    previous = prior.items.map(item => {
      if (!isDict(item) || !Object.hasOwn(item, "ordinal")) return item;
      const ordinal = item.ordinal;
      if (ordinal instanceof PyFloat) return { ...item, ordinal: ordinal.value };
      if (ordinal instanceof PyInt) return { ...item, ordinal: Number(ordinal.source) };
      return item;
    });
    if (out.injected_at_epoch === undefined && pyTruthy(prior.injected_at_epoch)) out.injected_at_epoch = prior.injected_at_epoch;
  }
  out.items = numberDigestItems(doc.items, previous);
  replaceIndex(indexPath, metaBytes(out as Record<string, never>));
}

/**
 * Stamp the verified submit. `false` where the incumbent returned 1: no index
 * file, or one that does not parse. The rest of the document is re-rendered
 * from the preserving parser, so nothing it carried changes type.
 */
export function stampInjected(indexPath: string, now: Date = new Date()): boolean {
  if (!isFile(indexPath)) return false;
  let doc: Record<string, unknown>;
  try {
    const parsed = parseJsonPreserving(pyReadText(indexPath));
    // Python `doc["injected_at_epoch"] = …` on a non-dict raises past the
    // try, which here is the same exit 1 the parse failure took. A scalar
    // wrapper is a non-dict: `1.0` cannot carry a stamp.
    if (!isDict(parsed)) return false;
    doc = parsed;
  } catch { return false; }
  doc.injected_at_epoch = Math.floor(now.getTime() / 1000);
  replaceIndex(indexPath, metaBytes(doc as Record<string, never>));
  return true;
}

/** lib.sh's `case "$retain" in ''|*[!0-9]*) retain="$TAP_DIGEST_RETAIN_DEFAULT"`, then Python `int()`. */
export function retainSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.TAP_DIGEST_RETAIN_SECONDS ?? "";
  if (raw === "" || /[^0-9]/.test(raw)) return DIGEST_RETAIN_DEFAULT;
  return Number(raw);
}

/**
 * CPython's `os.path.getmtime`: `sec + 1e-9 * nsec` in a double. `Number(
 * mtimeMs) / 1000` rounds differently at the nanosecond boundary, and the
 * retention comparison truncates this value to whole seconds, so the two can
 * disagree by one second exactly where a fixture pins the boundary.
 */
function pyMtime(path: string): number {
  const ns = statSync(path, { bigint: true }).mtimeNs;
  return Number(ns / 1_000_000_000n) + 1e-9 * Number(ns % 1_000_000_000n);
}

/**
 * The incumbent's `shell_words(value)`: `str()`, tabs and spaces to
 * newlines, empty words dropped, each word glob-expanded RELATIVE TO THE
 * PROCESS CWD with the literal word kept when nothing matches. A valid id
 * carries no glob character, so for every id this tree writes the result is
 * the id itself; the expansion is reproduced because the function is graded,
 * not the callers.
 */
function shellWords(value: unknown): string[] {
  const text = typeof value === "string" ? value : pyPrint(value);
  const out: string[] = [];
  for (const word of text.replaceAll("\t", "\n").replaceAll(" ", "\n").split("\n")) {
    if (!word) continue;
    if (/[*?[]/.test(word)) {
      const matches = [...new Bun.Glob(word).scanSync({ cwd: process.cwd(), onlyFiles: false })];
      if (matches.length > 0) { out.push(...matches); continue; }
    }
    out.push(word);
  }
  return out;
}

/** Python `int(x)` over a parsed JSON value, or `null` where it raises. */
function pyIntOf(value: unknown): number | null {
  if (value instanceof PyFloat) return Number.isFinite(value.value) ? Math.trunc(value.value) : null;
  if (value instanceof PyInt) return Number(value.source);
  return pyInt(value);
}

/**
 * Python's `dict.get(key, default)`: the default applies only when the key is
 * ABSENT. A key present with `null` returns `None` — `??` would substitute the
 * default for it and turn `{"items": null}` (kept forever by the incumbent,
 * because iterating `None` raises) into an empty list that ages out.
 */
function pyGet(dict: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(dict, key) ? dict[key] : fallback;
}

/**
 * Every listed id has a `.done` or `.cancelled`. CONTRACT.md § Retention:
 * "only after EVERY listed item is terminal". The incumbent gathered ids
 * until the first malformed row and proved terminality over that prefix
 * (`except Exception: pass`), so `[terminal a, 5, live b]` licensed the
 * unlink of b's pointer. A membership that cannot be read in full is not a
 * proof — declared as a courier delta, the contract outranking the
 * incumbent under the lane's oracle order. `{"items": null}`, a non-object
 * index and a non-dict row all land here: retained, as before.
 */
function allTerminal(doc: unknown, receiptsDir: string): boolean {
  const ids: string[] = [];
  try {
    if (!isDict(doc)) throw new Error("not a dict");
    const items = pyGet(doc, "items", []);
    if (!Array.isArray(items)) throw new Error("items is not iterable the way a list is");
    for (const item of items) {
      if (!isDict(item)) throw new Error("item is not a dict");
      const ident = item.id;
      if (pyTruthy(ident)) ids.push(...shellWords(ident));
    }
  } catch { return false; }
  return ids.every(ident => isFile(join(receiptsDir, `${ident}.done`)) || isFile(join(receiptsDir, `${ident}.cancelled`)));
}

/**
 * CONTRACT.md § Retention, as the incumbent decided it. Verified indexes use
 * `injected_at_epoch`; a `courier-auto` receipt's mtime is the fallback
 * witness for old indexes; otherwise publication (index mtime) supplies the
 * minimum window — EXCEPT that settled rows with no delivery witness at all
 * stay retained rather than being guessed terminal on age alone. Any
 * exception on the way is "not elapsed": a malformed index is kept.
 */
function retentionElapsed(doc: Record<string, unknown>, indexPath: string, receiptsDir: string, nowArg: string, retain: number): boolean {
  try {
    let injected: unknown = doc.injected_at_epoch;
    if (!pyTruthy(injected)) {
      let latest: number | null = null;
      const items = pyGet(doc, "items", []);
      if (!Array.isArray(items)) throw new Error("items is not iterable the way a list is");
      for (const item of items) {
        if (!isDict(item)) throw new Error("item is not a dict");
        const id = pyGet(item, "id", ""); // a present null is `None.done`, as `"%s.done" % None` spells it
        const path = join(receiptsDir, `${typeof id === "string" ? id : pyPrint(id)}.done`);
        try {
          const receipt = parseJsonPreserving(pyReadText(path));
          if (!isDict(receipt)) continue;
          const via = receipt.via;
          if ((pyTruthy(via) ? via : "") === "courier-auto") {
            const stamp = pyMtime(path);
            latest = latest === null ? stamp : Math.max(latest, stamp);
          }
        } catch { continue; }
      }
      if (latest === null) {
        if (items.some(item => pyTruthy((item as Record<string, unknown>).settled))) return false;
        latest = pyMtime(indexPath);
      }
      injected = latest;
    }
    const now = nowArg ? pyInt(nowArg) : Math.floor(Date.now() / 1000);
    const injectedInt = pyIntOf(injected);
    if (now === null || injectedInt === null) return false;
    return now >= injectedInt + retain;
  } catch { return false; }
}

/**
 * GC every index whose items are all terminal and whose retention has
 * elapsed; an index that does not parse is removed (the incumbent's
 * unreadable-index rule). `TAP_SPOOL_NOW` pins "now" for fixtures.
 */
export function reapSettledDigests(digestDir: string, receiptsDir: string, env: NodeJS.ProcessEnv = process.env, now?: number, candidates?: readonly string[]): void {
  let names: string[];
  try { names = candidates ? [...candidates].filter(n => !n.includes("/") && n !== "." && n !== "..") : readdirSync(digestDir); } catch { return; }
  const retain = retainSeconds(env);
  // The dark owner passes its loop's clock; the courier pins through the env.
  const nowArg = now !== undefined ? String(Math.floor(now)) : (env.TAP_SPOOL_NOW ?? "");
  // `glob("*.json")`: dotfiles excluded, Python string order.
  for (const name of names.filter(n => n.endsWith(".json") && !n.startsWith(".")).sort(pyStrCompare)) {
    const indexPath = join(digestDir, name);
    if (!isFile(indexPath)) continue;
    let reap: boolean;
    let doc: unknown;
    try { doc = parseJsonPreserving(pyReadText(indexPath)); reap = false; } catch { reap = true; }
    if (!reap) reap = allTerminal(doc, receiptsDir) && (isDict(doc) ? retentionElapsed(doc, indexPath, receiptsDir, nowArg, retain) : false);
    if (reap) { try { unlinkSync(indexPath); } catch { /* OSError: pass */ } }
  }
}

if (import.meta.main) {
  const [mode, ...rest] = Bun.argv.slice(2);
  try {
    if (mode === "write" && rest.length >= 8) {
      // write <indexPath> <digestId> <toTeam> <handle> <courier> <spoolDir> <payloadsDir> <presettled-ids> <id>...
      const [indexPath, digestId, toTeam, handle, courier, spoolDir, payloadsDir, presettled, ...ids] = rest as [string, string, string, string, string, string, string, string, ...string[]];
      // The incumbent matched `case " $presettled " in *" $id "*`: ids are
      // separated by spaces, and only spaces — a tab is part of an id there.
      const settled = new Set(presettled.split(" ").filter(Boolean));
      writeDigestIndex({ indexPath, digestId, toTeam, handle, courier, spoolDir, payloadsDir, members: ids.map(id => ({ id, presettled: settled.has(id) })) });
    } else if (mode === "stamp" && rest.length === 1) {
      // The word is the receipt and both words exit 0: a missing or unparseable
      // index is routine (`unstamped`), and the status stays the runtime's.
      process.stdout.write(`${stampInjected(rest[0]!) ? "stamped" : "unstamped"}\n`);
    } else if (mode === "reap" && rest.length === 2) {
      reapSettledDigests(rest[0]!, rest[1]!);
    } else {
      process.stderr.write("digest-index: expected write|stamp|reap with its arguments\n");
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`tap: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
