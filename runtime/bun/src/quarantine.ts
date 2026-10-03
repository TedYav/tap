// The one quarantine owner (the lib.sh tap_quarantine_payload twin is retired).
// Scanners hold the obligation lock while revalidating and publishing.
import { appendFileSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envelopeField, validateEnvelope } from "./envelope";
import { acquireObligationLock } from "./panelock";
import { markResetGenerationReused } from "./reset";
import { utcStamp } from "./ids";

export function quarantinePayload(src: string, reason: "invalid_envelope" | "id_mismatch"): 0 | 1 | 2 {
  const base = basename(src);
  let linked = false;
  let lock: ReturnType<typeof acquireObligationLock>;
  try { lock = acquireObligationLock(base.slice(0, -3)); } catch { return 2; }
  if (!lock) return 2;
  try {
    const raw = readFileSync(src, "utf8");
    if (reason === "invalid_envelope" && validateEnvelope(raw).ok) return 1;
    if (reason === "id_mismatch" && envelopeField(raw, "id") === base.slice(0, -3)) return 1;
    const qdir = join(dirname(src), ".quarantine");
    mkdirSync(qdir, { recursive: true });
    for (let n = 0; ; n++) {
      try {
        linkSync(src, join(qdir, n === 0 ? base : `${base}.${n}`));
        linked = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    unlinkSync(src);
    try { appendFileSync(join(qdir, ".log"), `${utcStamp()}\t${reason}\t${base}\n`); } catch { /* diagnostic only */ }
    markResetGenerationReused(dirname(dirname(src)), "quarantine");
    return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing destination is not a missing source. After publication even
      // source disappearance is degraded: generation marking has not completed.
      try { lstatSync(src); } catch (sourceError) {
        if ((sourceError as NodeJS.ErrnoException).code === "ENOENT" && !linked) return 1;
      }
    }
    return 2;
  } finally {
    lock.release();
  }
}
