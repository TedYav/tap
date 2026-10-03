// validate_locked_registry_authority's native shape (tap-yn2y line, lib.sh
// :4637), extracted from the offline-mutation script so every in-process
// registry WRITE under a held lock can re-check that the locked path is still
// the index's acting authority before it mutates. One snapshot, one verdict;
// callers own the refusal voice.
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadGlobalRegistry } from "../index-home";

function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

export type AuthorityVerdict = { ok: true } | { ok: false; retry: boolean; message: string };

export function validateLockedRegistryAuthority(
  locked: string, root: string, indexHome?: string,
  opts: { allowUnenrolledCanonical?: boolean; requireLive?: boolean } = {},
): AuthorityVerdict {
  const REFUSE = false, RETRY = true;
  const snap = loadGlobalRegistry(indexHome ?? process.env.TAP_INDEX_HOME); // ONE machine-index snapshot: marker and teams from the same parse
  if (snap.marker === "absent" && !opts.requireLive) return { ok: true };
  if (snap.marker !== "live") {
    return { ok: false, retry: REFUSE, message: "tap: registry flip marker is present but unreadable or wrong schema — refusing membership mutation" };
  }
  const rootReal = real(root), lockedReal = real(locked);
  if (rootReal === null || lockedReal === null) {
    return { ok: false, retry: REFUSE, message: `tap: cannot realpath registry paths for authority check (realpath failed for '${root}' or '${locked}')` };
  }
  const teams = snap.doc?.teams;
  if (!teams || typeof teams !== "object" || Array.isArray(teams)) {
    return maybeAllowFreshCanonical(locked, root, opts, `tap: acting registry unreachable for root '${rootReal}' (status=live_unenrolled) — refusing membership mutation on '${locked}'`);
  }
  let match: string | null = null, ambiguous = false;
  for (const ent of Object.values(teams as Record<string, unknown>)) {
    const row = ent as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || Array.isArray(row) || String(row.state ?? "registered") === "historical") continue;
    const entRoot = real(String(row.root ?? ""));
    if (entRoot === null || entRoot !== rootReal) continue;
    if (match !== null) { ambiguous = true; break; }
    match = String(row.registry_location ?? "");
  }
  let status: string, acting: string | null;
  if (ambiguous) { status = "live_unreachable"; acting = null; } else if (match === null) {
    status = "live_unenrolled"; acting = null;
  } else {
    let ok = false;
    try { ok = statSync(match).isFile(); } catch { ok = false; }
    status = ok ? "live" : "live_unreachable"; acting = ok ? match : (match || null);
  }
  if (status !== "live" || !acting) {
    return maybeAllowFreshCanonical(locked, root, status === "live_unenrolled" ? opts : {}, `tap: acting registry unreachable for root '${rootReal}' (status=${status}) — refusing membership mutation on '${locked}'`);
  }
  if (lockedReal !== real(acting)) {
    return { ok: false, retry: RETRY, message: `tap: registry authority moved to '${acting}' during flip (locked '${locked}'); retry` };
  }
  return { ok: true };
}

/** Register's fresh-team allowlist (incumbent `allow_unenrolled_canonical`):
 *  the first register in an enrolled worktree bootstraps the canonical
 *  `<root>/.tap/team-registry.json`, which no row can point at yet, so the
 *  locked path being exactly that canonical sibling licenses the write. */
function maybeAllowFreshCanonical(
  locked: string, root: string, opts: { allowUnenrolledCanonical?: boolean }, refusal: string,
): AuthorityVerdict {
  if (!opts.allowUnenrolledCanonical) return { ok: false, retry: false, message: refusal };
  let lockedReal: string | null, canonReal: string | null;
  try { lockedReal = real(locked); } catch { lockedReal = null; }
  try { canonReal = real(join(root, ".tap", "team-registry.json")); } catch { canonReal = null; }
  if (lockedReal !== null && lockedReal !== "" && lockedReal === canonReal) return { ok: true };
  return { ok: false, retry: false, message: refusal };
}
