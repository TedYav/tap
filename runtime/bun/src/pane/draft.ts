/**
 * The ONE draft backup writer.
 *
 * Draft loss is message loss, and until this file there were TWO writers into
 * one directory read by one reader: `tap_write_input_backup` (lib.sh:11819) and
 * `deliver.ts`'s `makeDraftPipeline` (:310). They already disagreed —
 * `recovery_policy` was the caller's in one and the literal `clobber` in the
 * other, and `pane_id` fell back to the tmux target rather than being absent —
 * so the field `tap draft` shows a human about what happened to their text
 * depended on which engine ran. Boundary agreed with lane A's driver,
 * 2026-09-15: the pane-effect half of `deliver.ts` is lane B's, and the hunk
 * that makes it call this module rides this PR.
 *
 * The file format is `input-backup.ts`'s to read; this module is its writer,
 * and the two are pinned to each other by `inputBackupBody`'s fence checks.
 *
 * RESTORE AND THE DRAFT NOTICE ARE NOT HERE. Both are tmux EFFECTS, and they
 * move in B2 with the pane-lock transaction that owns effects (leader's ruling,
 * 2026-09-15). Shipping their native implementations here with no production
 * caller, while the Bash bodies stay live, is the module-only dark draft rule 1
 * calls prep rather than a port — so they are deleted from this slice and
 * reintroduced inside that transaction.
 */
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { textHasPasteCollapse } from "./geometry";
import { atomicWrite, stagingPath } from "../fsatomic";

/**
 * `tap_sanitize_filename_component` (lib.sh:11815) — `tr -c 'A-Za-z0-9._-' '_'`.
 *
 * `tr` operates on BYTES, so a multi-byte character becomes one underscore per
 * byte, not one per character. A handle carrying a non-ASCII glyph produces a
 * longer name than a naive per-character port would, and the name is part of
 * the path `tap draft` lists — so this walks the UTF-8 bytes.
 */
export function sanitizeFilenameComponent(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const b of bytes) {
    const ok = (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39)
      || b === 0x2e || b === 0x5f || b === 0x2d;
    out += ok ? String.fromCharCode(b) : "_";
  }
  return out;
}

/** `date -u +%Y%m%dT%H%M%SZ`. */
export function compactStampUtc(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

export type BackupRequest = {
  directory: string;
  handle: string;
  payloadId: string;
  pane: string;
  paneId: string;
  paneCommand: string;
  inputHash: string;
  /**
   * The CALLER's policy. Empty means the caller had none, which the incumbent
   * wrote as `unspecified` — an honest "nobody said", distinct from a policy
   * named `clobber`. `deliver.ts` used to hardcode the latter for both.
   */
  recoveryPolicy: string;
  text: string;
  /** The visible rows of a composer that may scroll (tap-ipex2): unproven until finalized. */
  scrolledRowsUnproven?: boolean;
};

/** `tap_write_input_backup` (lib.sh:11819). Returns the path written. */
export function writeInputBackup(req: BackupRequest, now: Date = new Date()): string {
  const created = compactStampUtc(now);
  const path = join(req.directory,
    `${created}-${sanitizeFilenameComponent(req.handle)}-${sanitizeFilenameComponent(req.payloadId)}.md`);
  const body = [
    "---",
    "schema_version: 1",
    `created_at: ${created}`,
    "first_capture_at: caller-owned",
    `final_capture_at: ${created}`,
    `handle: ${req.handle}`,
    `payload_id: ${req.payloadId}`,
    `pane: ${req.pane}`,
    `pane_id: ${req.paneId}`,
    `pane_current_command: ${req.paneCommand}`,
    `input_hash: ${req.inputHash}`,
    `recovery_policy: ${req.recoveryPolicy || "unspecified"}`,
    ...(textHasPasteCollapse(req.paneCommand, req.text)
      ? ["capture_status: incomplete", "uncaptured_content: collapsed-paste"]
      : req.scrolledRowsUnproven ? [...SCROLLED_ROWS_UNPROVEN] : []),
    "---",
    "",
    "## Backed-up input",
    "",
    req.text,
    "",
  ].join("\n");
  mkdirSync(req.directory, { recursive: true });
  // NEVER REPLACE A RETAINED DRAFT, and this is a deliberate deviation from both
  // incumbents rather than parity with either. The Bash writer ended in
  // `tap_atomic_write`, whose `mv -f` overwrites; `deliver.ts` used
  // `writeFileSync(…, { flag: "wx" })`, which threw. The key is a
  // SECOND-resolution stamp plus handle plus payload id, so a retry or a
  // concurrent attempt on the same id inside one second collides — and the file
  // is the recovery authority for someone's unsent text. Overwriting it loses
  // the draft; throwing loses the backup. Neither is acceptable, so a collision
  // gets its own path and both drafts survive.
  // PUBLICATION IS THE EXISTENCE CHECK. The first version asked `existsSync`
  // and then called `atomicWrite`, whose `renameSync` REPLACES its destination:
  // two writers both saw the path free, both renamed onto it, both reported
  // success, and one draft was gone. A check followed by a replacing write is
  // not a no-replacement guarantee, however carefully the check is written, and
  // the file key omits pane identity so no pane lock can supply one
  // (reproduced by the reviewer with a two-process interleaving).
  //
  // `link` is the primitive that decides it in the kernel: it fails EEXIST
  // rather than replacing, and it publishes a file that is already COMPLETE,
  // so a reader never sees a half-written backup. Write once to a temp name,
  // then walk suffixes until one link succeeds.
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = stagingPath(dir);
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    for (let n = 0; n <= COLLISION_LIMIT; n++) {
      const target = n === 0 ? path : path.replace(/\.md$/, `-${n}.md`);
      try {
        linkSync(tmp, target);
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    // Refusing loudly beats silently overwriting someone's unsent text.
    throw new Error(`draft backup: ${COLLISION_LIMIT} collisions on ${path}; refusing to replace a retained draft`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const COLLISION_LIMIT = 256;

const SCROLLED_ROWS_UNPROVEN = ["capture_status: incomplete", "uncaptured_content: scrolled-rows"];

/**
 * Finalize a backup THIS door published moments ago as a viewport snapshot,
 * marked incomplete, with the whole draft the clear chain proved (tap-ipex2).
 * This is not the collision case the writer refuses. The path came back from our own
 * `link` in this same call, so no other writer can own it, and the proven body
 * contains every row of the snapshot. Nothing is lost by replacing it. If the chain
 * broke, or the process died before this ran, the snapshot keeps its incomplete mark.
 */
export function finalizeInputBackup(path: string, text: string): void {
  const raw = readFileSync(path, "utf8");
  const fence = raw.indexOf("\n---\n", 4);
  const fields = raw.startsWith("---\n") && fence >= 0 ? raw.slice(4, fence).split("\n") : [];
  if (!SCROLLED_ROWS_UNPROVEN.every(field => fields.includes(field))) throw new Error("not an unproven scrolled-rows backup");
  atomicWrite(path, ["---", ...fields.filter(field => !SCROLLED_ROWS_UNPROVEN.includes(field)).map(field =>
    field.startsWith("input_hash: ") ? `input_hash: ${inputHash(text)}`
      : field.startsWith("final_capture_at: ") ? `final_capture_at: ${compactStampUtc()}` : field),
  "---", "", "## Backed-up input", "", text, ""].join("\n"));
}

export function inputHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
