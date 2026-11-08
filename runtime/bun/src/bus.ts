// Bus layout. CONTRACT.md §Bus layout: payloads/<id>.md is the message blob and
// receipts/<id>.done is the AUTHORITATIVE settlement mark.
//
// The only authoritative state is `payload exists` + `.done exists`. There is no
// `.started` and no deferral marker: deferral is simply the absence of a `.done`,
// so the item stays unprocessed and resurfaces on the next poll.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { containerRefusal } from "./bushome";
import { isFile } from "./watch-lease";
import { scheduleBusMaintenance } from "./bus-maintenance-trigger";

export const BUS_AUTHORITY_MARKER = ".tap-bus-authority";

export class Bus {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  get payloadsDir(): string { return join(this.home, "payloads"); }
  get receiptsDir(): string { return join(this.home, "receipts"); }
  get stagingDir(): string { return join(this.home, "tmp"); }

  payloadPath(id: string): string { return join(this.payloadsDir, `${id}.md`); }
  donePath(id: string): string { return join(this.receiptsDir, `${id}.done`); }
  placedPath(id: string): string { return join(this.receiptsDir, `${id}.placed`); }
  sentPath(id: string): string { return join(this.receiptsDir, `${id}.sent`); }
  cancelPath(id: string): string { return join(this.receiptsDir, `${id}.cancelled`); }

  /**
   * Validate the resolved bus, THEN create payloads/ + receipts/ on demand.
   *
   * The container check runs before the first mkdir on purpose: refusing after
   * bootstrapping has already left the decoy tree behind, and the next lookup
   * there would read it as real.
   */
  ensureDirs(): void {
    const expected = containerRefusal(this.home);
    if (expected) {
      const e = new Error(`TAP_HOME='${this.home}' does not name a bus; expected '${expected}'`);
      (e as Error & { tapErrorClass?: string }).tapErrorClass = "not_a_bus";
      (e as Error & { tapAction?: string }).tapAction = "unset TAP_HOME or point it at the bus dir";
      throw e;
    }
    try {
      mkdirSync(this.payloadsDir, { recursive: true });
      mkdirSync(this.receiptsDir, { recursive: true });
    } catch (error) {
      // A read-only or sandboxed caller (a harness shell that may not write the bus) refuses. The two mkdirs are
      // sequential and not rolled back, so payloads/ may already exist when receipts/ is the one denied.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EROFS") throw error;
      const e = new Error(`cannot write the bus at '${this.home}' (${code}); this shell is not allowed to create its payloads/receipts directories`);
      (e as Error & { tapErrorClass?: string }).tapErrorClass = "bus_unwritable";
      (e as Error & { tapAction?: string }).tapAction = "run tap where this bus is writable; a sandboxed harness shell may be denied it";
      throw e;
    }
    if (this.home.endsWith("/.tap/bus")) {
      const ignore = join(dirname(this.home), ".gitignore");
      if (!existsSync(ignore)) {
        writeFileSync(ignore,
          "# TAP bus — ephemeral, machine-local runtime state (payloads, receipts, registry,\n" +
          "# input backups). Never committed. `.tap/config` IS committed.\n" +
          "bus/\n");
      }
    }
    // A one-time marker stamping this bus as genuinely bootstrapped. Written
    // here because every real write path crosses ensureDirs first.
    const authority = join(this.home, BUS_AUTHORITY_MARKER);
    if (!existsSync(authority)) {
      try {
        writeFileSync(authority, `bootstrapped_at_epoch=${Math.floor(Date.now() / 1000)}\n`);
      } catch {
        const e = new Error(
          `could not write ${authority} — a bus whose root cannot be stamped ` +
          "will accept sends now and silently refuse to redeliver them later",
        );
        (e as Error & { tapErrorClass?: string }).tapErrorClass = "bus_authority_unwritable";
        (e as Error & { tapAction?: string }).tapAction = "fix TAP_HOME's own permissions, not just its children";
        throw e;
      }
    }
    scheduleBusMaintenance(this.home);
  }

  /** Settled: a `.done`, or a `.cancelled` for an obligation the sender cleared.
   *  Active files only. `tap bus archive` unlinks a payload before its receipts,
   *  so an id whose payload is still active keeps its settlement receipt here;
   *  the archive index is history, never consulted on this hot path. */
  isDone(id: string): boolean {
    return isFile(this.donePath(id)) || isFile(this.cancelPath(id));
  }

  /**
   * Courier mail: `.placed` (place-time, the authority) or a legacy `.sent`.
   * Never use this to HIDE mail — only to LABEL it, so a hand-written payload is
   * reported as unattributed rather than silently dropped.
   */
  isCourierAttributed(id: string): boolean {
    return isFile(this.placedPath(id)) || isFile(this.sentPath(id));
  }

  /**
   * Canonical payload ids. `_*.md` is reserved for drafts and is ignored, so an
   * id-less draft dropped into payloads/ by hand cannot jam a peer's inbox.
   */
  canonicalIds(): string[] {
    if (!existsSync(this.payloadsDir)) return [];
    return readdirSync(this.payloadsDir)
      .filter(isCanonicalPayloadName)
      .map((n) => n.slice(0, -3))
      .sort();
  }
}

/**
 * Canonical payload filename predicate: `.md` only, `_*.md` reserved for
 * drafts and ignored by contract. Shared by every briefing scan so a draft
 * can never read as mail. Leading-dot files are excluded one layer up, in
 * recapMessages — this predicate still admits them (as the spool scan did
 * before the share).
 */
export function isCanonicalPayloadName(n: string): boolean {
  return n.endsWith(".md") && !n.startsWith("_");
}
