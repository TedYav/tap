// Digest viewing and member dispatch, for both `tap read` and `tap show` and
// for both doors. `digest-items.ts` already owns selection, numbering and the
// rendered lines; what lives here is the rest of what the Python leaf did — the
// recipient gates, the digest's own `.read`, and the per-member dispatch.
//
// The digest itself is never settled: `tap read <digest-id>` records that the
// recipient observed the ENVELOPE, and each member keeps its own obligation,
// settled by its own `tap read` for a note and by a reply for an ask.
// Courier-written `.done` is retired everywhere, and nothing
// here writes one.
import { digestPlan, type DigestItem } from "../digest-items";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { TapError } from "../context";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";
import { completeHarnessQueued } from "../harness-queue";
import { assertResetUnfenced, markResetGenerationReused } from "../reset";
import { tapErrorLine } from "../error-line";
import { StdoutClosed, writeStdout } from "../stdout-sync";

const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Only actor/context flags reach a member. A body or index string is never
 *  reinterpreted as shell text, and a member is never treated as a digest. */
const FORWARD_VALUE = new Set(["--by", "--epoch", "--team"]);
const FORWARD_FLAG = "--force";
const DROP_VALUE = new Set(["--item", "--digest-address"]);

export function forwardedArgs(argv: readonly string[]): string[] {
  const forward: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (FORWARD_VALUE.has(arg)) { if (i + 1 < argv.length) forward.push(arg, argv[++i]!); else i++; }
    else if (arg === FORWARD_FLAG) forward.push(arg);
    else if (DROP_VALUE.has(arg)) i++;
  }
  return forward;
}
/**
 * The LAST occurrence, because that is the effective value everywhere else.
 * The incumbent read parser overwrote ACTOR and TEAM_FLAG as each spelling
 * was parsed and then appended the effective pair to the digest argv, and the
 * incumbent Python leaf read the last one too. Taking the first let
 * `--by reader --by impostor` pass the addressee gate under `reader` while
 * the effective caller was `impostor`, and then publish the immutable first
 * observation attributing the read to `reader` — an unauthorized read and a
 * misattributed audit record, not merely an unwanted refusal
 * (partner review, D2-R1).
 */
function flagValue(forward: readonly string[], name: string): string {
  const at = forward.lastIndexOf(name);
  return at === -1 ? "" : forward[at + 1] ?? "";
}

/**
 * Publish the digest's first `.read` if it is absent, and say whether THIS call
 * created it. `link()` is the CAS: two readers race, one wins, and the loser's
 * observation leaves the first receipt's bytes untouched.
 */
function publishFirstRead(receipts: string, ident: string, record: unknown): boolean {
  mkdirSync(receipts, { recursive: true });
  // A sibling FILE, as the incumbent's mkstemp made: `receipts/` is scanned by
  // name elsewhere, so a scratch DIRECTORY there would be a new shape for every
  // reader of that directory to know about.
  let temp = "", fd = -1;
  for (let attempt = 0; fd === -1; attempt++) {
    temp = join(receipts, `.digest-read.${process.pid}.${randomBytes(6).toString("hex")}`);
    try { fd = openSync(temp, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 8) throw error; }
  }
  try {
    // `writeFileSync`, not `writeSync`: the latter returns a byte count that a
    // caller must check, and ignoring it linked a SHORT write into place as the
    // immutable first observation — under a 100-byte file limit the receipt
    // ended mid-token and was not JSON, while the incumbent refused and
    // published nothing (partner review, D2-R2). writeFileSync finishes the
    // write or throws.
    try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, join(receipts, ident + ".read")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  } finally {
    try { unlinkSync(temp); } catch { /* the receipt is linked or was never written */ }
  }
}

/** In-process member dispatch: the verb's callback renders one member itself —
 *  no Bash oracle, no import cycle; non-zero marks the aggregate failed. */
export type DigestMember = (path: string, forward: string[]) => number;

export function digestView(argv: string[], member?: DigestMember): number {
  const [verb, path, allItems, selected, scripts, ...rest] = argv;
  if (verb !== "read" && verb !== "show") return 2;
  if (path === undefined || allItems === undefined || selected === undefined || scripts === undefined) return 2;

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
    if (!doc || typeof doc !== "object" || (doc as Record<string, unknown>).kind !== "digest" || !Array.isArray((doc as Record<string, unknown>).items))
      throw new Error("expected a digest object with an items array");
    for (const item of (doc as { items: unknown[] }).items) {
      if (!item || typeof item !== "object" || typeof (item as DigestItem).id !== "string" || typeof (item as DigestItem).path !== "string")
        throw new Error("each digest item needs an id and path");
    }
  } catch (error) {
    process.stderr.write(`tap ${verb}: invalid digest ${path}: ${message(error)}\n`);
    return 1;
  }

  const addressAt = rest.indexOf("--digest-address");
  const address = addressAt === -1 ? "" : rest[addressAt + 1] ?? "";
  let plan;
  try {
    plan = digestPlan({ doc, path, verb, all: allItems === "1", selected, address, verbose: process.env.TAP_VERBOSE === "1" });
  } catch (error) {
    process.stderr.write(`tap ${verb}: ${message(error)}\n`);
    return 1;
  }

  const forward = forwardedArgs(rest);
  if (verb === "read" && !selected) {
    const refusal = observeDigestEnvelope(doc as Record<string, unknown>, path, forward);
    if (refusal !== 0) return refusal;
  }

  // Read settles members as it goes, so its output must fail at the write site (writeStdout);
  // show never writes state and keeps the stream.
  const emit = verb === "read" ? writeStdout : (text: string): void => { process.stdout.write(text); };
  for (const line of plan.lines) emit(line + "\n");
  let status = 0;
  for (const item of plan.items) {
    // A member whose filename and id disagree is not dispatched, and the
    // siblings still are: one malformed row does not strand the rest.
    if (basename(item.path) !== item.id + ".md") {
      process.stderr.write(`tap ${verb}: item ${item.id} path does not match its payload id\n`);
      status = 1;
      continue;
    }
    let rc: number;
    try {
      if (!member) throw new Error("no in-process member dispatcher");
      rc = member(item.path, forward);
    } catch (error) {
      // A closed stdout is not the member's failure: stop here, for the verb's own disposition.
      if (error instanceof StdoutClosed) throw error;
      // An in-process member's UNEXPECTED failure: bounded render, siblings still dispatch.
      const msg = String((error as Error)?.message ?? error).replace(/[\r\n]/g, " ");
      process.stderr.write(`tap ${verb}: could not dispatch '${item.id}': ${msg}\n`);
      rc = 1;
    }
    if (rc !== 0) status = 1;
  }
  return status;
}

/** The recipient gates and the digest's own observation receipt. Returns 0 to
 *  continue, or the exit status the verb must take instead. */
function observeDigestEnvelope(doc: Record<string, unknown>, path: string, forward: string[]): number {
  const actor = flagValue(forward, "--by"), team = flagValue(forward, "--team");
  const forced = forward.includes("--force");
  const ident = typeof doc.digest_id === "string" ? doc.digest_id : "";
  if (!IDENT_RE.test(ident) || basename(path) !== ident + ".json") {
    process.stderr.write("tap read: invalid digest identity\n");
    return 1;
  }
  if (!actor || doc.to_team !== team || (doc.to !== actor && !forced)) {
    process.stderr.write("tap read: not_addressee: digest belongs to another recipient; inspect with tap show\n");
    return 1;
  }
  const bus = dirname(dirname(dirname(resolve(path))));
  try { assertResetUnfenced(bus,"tap read digest"); }
  catch (error) {
    if (!(error instanceof TapError)) throw error;
    process.stderr.write(tapErrorLine(error,"tap read"));
    return error.code;
  }

  let created: boolean;
  try {
    created = publishFirstRead(join(bus, "receipts"), ident, {
      id: ident, status: "read", via: "read", by: actor,
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), digest: true, forced, to: doc.to,
    });
  } catch (error) {
    process.stderr.write(`tap read: could not record the digest observation: ${message(error)}\n`);
    return 1;
  }
  if (created) {
    try { markResetGenerationReused(bus,"read digest"); }
    catch (error) {
      if (!(error instanceof TapError)) throw error;
      process.stderr.write(tapErrorLine(error,"tap read"));
      return error.code;
    }
  }
  completeHarnessQueued(bus, ident);
  // Match ordinary forced reads: record every override, even after a prior
  // envelope observation. The immutable first .read remains unchanged.
  if (forced) {
    appendRegistryEventOrWarn("tap read", {
      log: registryEventsPath(bus), actor, action: "read_forced",
      handle: typeof doc.to === "string" ? doc.to : "", pane: "", team,
      detail: `id=${ident} digest=1`,
    });
  }
  return 0;
}

function message(error: unknown): string { return String((error as Error)?.message ?? error); }

if (import.meta.main) process.exitCode = digestView(Bun.argv.slice(2));
