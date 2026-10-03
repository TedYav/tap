// Atomic writes and receipt JSON. Both exist so a torn file can never appear on
// the bus: readers see either the previous bytes or the complete new ones.

import { closeSync, constants, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * A staging name in `dir`: `.tap.<pid36>.<8 hex>.tmp`. The shape is a contract
 * with smoke-all's operator-state tripwire, which parses the PID back out so a
 * LIVE non-wave process's staging file vanishing mid-wave is a note, while a
 * wave process's is still a deletion (tap-c7whh). Keep the two in step: the
 * separators and the fixed-length suffix are what make the PID recoverable.
 */
export function stagingPath(dir: string, pid: number = process.pid): string {
  return join(dir, `.tap.${pid.toString(36)}.${randomBytes(4).toString("hex")}.tmp`);
}

/**
 * Temp + rename, with the temp file in the DESTINATION directory so the rename
 * is a same-filesystem atomic operation rather than a copy. An explicit mode
 * preserves an existing file's permissions; the default stays 0600.
 */
export function atomicWrite(dest: string, contents: string | Buffer, mode: number | undefined = 0o600): void {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = stagingPath(dir);
  try {
    writeFileSync(tmp, contents, { mode });
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Byte-compatible with the incumbent's `tap_json_obj`, which pipes through
 * python's `json.dumps(..., separators=(",", ":"))` and `print`.
 *
 * Two differences from a bare `JSON.stringify` are load-bearing, both measured
 * rather than assumed (`tap_json_obj preview "café ☕"`):
 *
 *   - python's json.dumps defaults to `ensure_ascii=True`, so it emits
 *     `café ☕`. JS emits raw UTF-8. Unicode bodies are a pre-named
 *     robustness probe and receipts cross the interop boundary, so non-ASCII is
 *     escaped here to the same form.
 *   - `print` appends a newline; the incumbent's receipts therefore end with
 *     `\n`.
 *
 * Values are encoded as given, INCLUDING an empty string — checked against the
 * incumbent, which emits `{"id":"x","epoch":"","status":"done"}`. Omission is the
 * caller's decision (pass `undefined`), exactly as it is in bash, where every
 * receipt site appends optional fields only when present.
 */
export function jsonObj(fields: Record<string, string | undefined>): string {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) out[k] = v;
  }
  return ensureAscii(JSON.stringify(out));
}

/**
 * Escape every non-ASCII character, and DEL (U+007F), as \uXXXX, matching
 * python's ensure_ascii.
 *
 * ITERATES CODE UNITS, and that is the whole subtlety. `for...of` over a string
 * yields whole CODE POINTS, so an astral character (an emoji) arrives as one
 * two-unit string and reading only its first unit emits half the character.
 * python emits both surrogates. The registry serializer had exactly that bug
 * with a `for...of` loop; this is the single shared implementation so the two
 * cannot drift apart again.
 */
export function ensureAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x7f ? s[i] : `\\u${c.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** A receipt line as the incumbent writes it: compact JSON plus the trailing newline. */
export function receiptBytes(fields: Record<string, string | undefined>): string {
  return `${jsonObj(fields)}\n`;
}

/**
 * A STRING FIELD FROM UNTRUSTED JSON, or "" — never a coercion.
 *
 * `String(v)` turns `{decoy: true}` into the literal `"[object Object]"`, which
 * is a plausible-looking string that then flows onward as if it were data.
 * The partner reviewer's probe: a registry whose `team.name` was an object made the
 * poll header render `[object Object]/me`, and that value also drives `to_team`
 * receive and settlement filtering — a coerced label deciding message routing.
 *
 * The incumbent gets this for free: python `.strip()` on a dict raises inside
 * its caught block, so a malformed value yields nothing and the caller takes its
 * documented fallback. JS coerces instead of raising, so the check has to be
 * written. This is a TRUST BOUNDARY — registry files are read, not authored,
 * here — and the rule is the same at every one of them: a wrong type is missing
 * data, never data of a different shape.
 *
 * SCOPE: `team.name`, and nothing else. This started as a class sweep over
 * every `String(x ?? "")` on untrusted registry JSON, and the sweep was
 * SUBTRACTED (the lieutenant's ruling, the partner reviewer's finding) for two
 * reasons worth keeping next to the code:
 *
 *   1. It trimmed. `root`, `registry_location` and `pane` are exact filesystem
 *      and tmux fields; a leading or trailing space is a legal path byte, and
 *      removing it selects a DIFFERENT path. Reproduced here against the
 *      incumbent: an input root of `" /tmp/root "` came back `"/tmp/root"` from
 *      this implementation and `" /tmp/root "` from
 *      `registry_v20.resolve_team_from_global`. This lane's deliverable is
 *      FIDELITY, so hardening that diverges from the incumbent is the defect —
 *      and worse than the original, because it ships as an improvement.
 *   2. The class claim was false anyway: `send.ts` still coerced `toSeat.pane`
 *      and handed the result to tmux as a target. A "fixed as a class" commit
 *      with a site of the class untouched is the same object as a rule written
 *      down without its boundary.
 *
 * The remaining hardening is filed, not abandoned — raw byte-preserving guards,
 * the direct-send pane site, and focused parity arms are its acceptance
 * criteria. Widening this helper without them re-creates defect 1.
 */
export function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Write every byte, or throw. `writeSync` reports a PARTIAL write by returning
 * the count, so a caller that ignores the result can publish a truncated file
 * and still succeed — measured on a `.cancelled` receipt that reached its
 * authoritative name holding `{"id":"s` at exit 0.
 * `write` is injectable so the short-count path has a real control.
 */
export function writeAllSync(
  fd: number,
  buf: Uint8Array,
  write: (fd: number, b: Uint8Array, off: number, len: number) => number = writeSync,
): void {
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    // A non-advancing write would spin forever; refuse rather than hang.
    if (!(n > 0)) throw new Error(`short write: wrote ${off} of ${buf.length} bytes`);
    off += n;
  }
}

/**
 * Can this lock NAME exist on this filesystem? The incumbent's
 * `open(meta + ".lock", "w")` raised ENAMETOOLONG for a 245-byte id — the meta
 * name fits the 255-byte filename limit, its `.lock` does not. Today's
 * `openLockFd` raises the same error, and a bounded `acquirePathLock` turns it
 * into `null` at once, which a caller reads as "lock held past Nms": a
 * misdiagnosis, not a timeout burn. Callers that fall through (the sidecar
 * family) or refuse by name (publication) ask here first, and publication does
 * so before writing a body it would then orphan.
 *
 * ONLY ENAMETOOLONG is answered `false`. It is the one failure that proves no
 * lock inode can exist and therefore that no holder can exist. Every other
 * open failure propagates: EACCES can be an existing, HELD lock whose mode
 * changed, and EMFILE is this process's own limit while another process holds
 * the inode — classifying either as "no lock possible" would be the unlocked
 * fallback CONTRACT.md forbids, wearing a probe's clothes.
 */
export function lockNameFits(path: string): boolean {
  // O_RDWR with mode 0600, exactly `openLockFd`'s open (remind-lock.ts): a write-only
  // open of a FIFO blocks until a reader appears, so the probe must see the node as
  // the real acquire does or it adds a hang the acquire does not have.
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENAMETOOLONG") return false;
    throw error;
  }
}
