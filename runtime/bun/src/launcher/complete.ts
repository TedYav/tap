// `tap session complete handles|harnesses` — the read-only zsh completion
// producer behind `_tap_session_handles` in the bundled completion template
// (launcher.py ZSH_COMPLETION). Port of session/complete.py plus
// completion.read_team_entries/completion_handles, deleted in the same PR.
//
// A completion keystroke must be side-effect-free: nothing here writes, and the
// only child process is git's read-only rev-parse. Every path exits 0 with
// possibly-empty stdout — an authority refusal, an unreadable registry and an
// internal error all render as "no candidates", never as a traceback in the TAB
// display. Only a malformed argv is a usage error (exit 2), as argparse did.
//
// Resolution is the launcher's: worktree root by git, acting registry through
// the machine index (TAP_INDEX_HOME), env TAP_HOME deliberately NOT honored.
// The offered set is a deliberate team-scoped SUBSET of what `tap session
// resume` accepts (no departed history, no bare-harness picker grammar, no full
// session names); the value is one relaunch predicate, not set-equality.

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../bushome";
import { enrollmentAtFromDoc, loadGlobalRegistry } from "../index-home";
import { HARNESSES } from "./catalog";
import { LauncherError } from "./types";
import { isOldStoreRefusal, teamRegistryRefusal } from "../register-authority";

type Row = Record<string, unknown>;

const RETRY_REASONS = new Set(["pane_gone", "session_replaced", "repair_failed", "restart_failed"]);
const RELAUNCHABLE_SUSPENDED_REASONS = new Set([
  "session_stopped",
  "restored_from_archive",
  "resurrectable",
  "server_restarted",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A seat row still carrying pane identity (legacy pane-only proof). */
function seatHasPaneCoords(row: Row): boolean {
  return nonEmptyString(row.pane) || nonEmptyString(row.pane_id);
}

/**
 * Twin of registry_v20.seat_is_relaunchable — the one relaunch predicate shared
 * by resume membership, synthesize and migrate session-assert. The Python
 * original stays live for those callers until the last of them ports; the
 * parity arm in launcher-complete.test.ts runs it as the oracle over the same
 * row matrix so the two cannot drift silently.
 *
 * Excluded: crew, explicit poll, user_removed. Absent `delivery` is not a
 * blanket unknown: session_stopped rows were pane-backed (stop strips delivery,
 * poll seats never enter stop); restored_from_archive without delivery is the
 * real poll hazard; pane coordinates plus a non-empty session prove pane-ness
 * and resumability together; anything else (a delivery-less pending
 * reservation, a coords-only corpse) is excluded.
 */
export function seatIsRelaunchable(entry: unknown, explicitResume = false): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const row = entry as Row;
  if (row.crew === true || row.crew === 1) return false;
  const status = row.status;
  // Only equality with literal reasons is consulted, so a non-string value
  // compares like Python's falsy-or-unmatched value: never equal.
  const reason = typeof row.status_reason === "string" ? row.status_reason : "";
  let delivery: unknown = row.delivery;
  if (!nonEmptyString(delivery)) {
    if (status === "suspended" && reason === "session_stopped") delivery = "pane";
    else if (status === "suspended" && reason === "restored_from_archive") return false;
    else if (seatHasPaneCoords(row) && nonEmptyString(row.session)) delivery = "pane";
    else return false;
  }
  if (delivery === "poll") return false;
  if (status === "suspended") {
    // Named resume is an explicit retry of retained operational failures;
    // bulk startup keeps its exclusions and removal is never a retry.
    if (explicitResume && RETRY_REASONS.has(reason)) return true;
    return RELAUNCHABLE_SUSPENDED_REASONS.has(reason);
  }
  return true;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The acting registry a completion may read, or null when nothing may be
 * offered: an invalid marker, an unenrolled or ambiguous root, and an enrolled
 * root whose stored registry is unreachable all refuse (never a legacy
 * fallback, never a stored-but-missing location). With no machine index there
 * is no enrollment, so nothing is offered.
 */
export function completionRegistryPath(root: string, indexHome?: string): string | null {
  const snapshot = loadGlobalRegistry(indexHome);
  if (snapshot.marker === "invalid" || (snapshot.marker === "live" && !snapshot.doc)) return null;
  const rootReal = realpathOrSelf(root);
  if (snapshot.marker !== "live") return null;
  const enrollment = enrollmentAtFromDoc(snapshot.doc!, rootReal);
  return enrollment.status === "ok" ? enrollment.registryLocation : null;
}

/**
 * Relaunchable current handles from one acting registry, sorted by code point.
 * An unresolvable registry (no path, unreadable, invalid UTF-8 or JSON,
 * non-object document, no seats|agents axis) offers nothing; a valid registry
 * with zero relaunchable rows also offers nothing — the two are the same
 * completion answer, so the tri-state completion.py kept collapses here.
 */
export function completionHandles(registryPath: string | null): string[] {
  if (!registryPath) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(registryPath)));
  } catch {
    return [];
  }
  // An old-format registry is refused, never offered as "no handles": the command exits non-zero.
  const refusal = teamRegistryRefusal(registryPath, doc);
  if (refusal) throw new LauncherError(refusal.detail, refusal.errorClass, refusal.action, refusal.detail);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [];
  const registry = doc as Row;
  const axis = registry.seats;
  if (typeof axis !== "object" || axis === null || Array.isArray(axis)) return [];
  return Object.entries(axis)
    .filter(([, entry]) => seatIsRelaunchable(entry))
    .map(([handle]) => handle)
    // Python's sorted() orders by code point and JS's default comparator by
    // UTF-16 code unit. They differ only for an astral character compared
    // against U+E000-U+FFFD, and a handle is `^[A-Za-z0-9][A-Za-z0-9._-]*$`
    // (lib.sh TAP_ID_RE / ids.ts TOKEN_RE), so no registration path can create
    // a key that tells the two apart. A hand-edited key outside that charset
    // would sort differently and its display order is not a contract.
    .sort();
}

interface CompleteArgs {
  kind: "handles" | "harnesses";
  root?: string;
  registry?: string;
}

function parseArgs(argv: string[]): CompleteArgs | null {
  let kind: CompleteArgs["kind"] | undefined;
  let root: string | undefined;
  let registry: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const valued = arg.match(/^--(root|registry)(?:=(.*))?$/);
    if (valued) {
      const value = valued[2] ?? argv[++i];
      if (value === undefined) return null;
      if (valued[1] === "root") root = value;
      else registry = value;
      continue;
    }
    if (arg.startsWith("-") || kind !== undefined || (arg !== "handles" && arg !== "harnesses")) return null;
    kind = arg;
  }
  if (kind === undefined) return null;
  return { kind, root, registry };
}

export function cmdSessionComplete(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write("usage: tap session complete {handles,harnesses} [--root ROOT] [--registry REGISTRY]\n");
    return 2;
  }
  try {
    const lines = args.kind === "harnesses"
      ? [...HARNESSES].sort()
      // The index home stays implicit here: every reader below resolves it the
      // same way through globalRegistryPath, so threading a second copy would
      // be a seam no caller can reach.
      // `--root ''` falls back to the git root, as argparse's falsy default did;
      // `--registry ''` stays a refusal on both sides, so it keeps `??`.
      : completionHandles(args.registry ?? completionRegistryPath(args.root || repoRoot()));
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  } catch (error) {
    // A completion helper must never spew into the TAB display; an old store still fails.
    if (isOldStoreRefusal(error)) return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = cmdSessionComplete(process.argv.slice(2));
