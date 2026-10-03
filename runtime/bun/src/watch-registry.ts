// The watch layer's registry reads: which pane a handle owns, which tmux session
// the team lives in, and where the team's checkout is. Migration slice W1 moves
// these out of tap-watch.sh (`tap_watch_registry_pane`, `_watch_team_session`,
// `_watch_repo_root`) so the native verbs and the still-Bash tick loop share ONE
// reader; the Bash names stay as `tap_bun_call` bridges until the tick moves (W2).
//
// This module is stamped in the sidecar's source fingerprint (tap-watch.sh head)
// because the loop calls it, so it imports only loop-safe leaves: registry.ts
// for the seat map (C's reader, imported not copied) and tmux.ts for the one
// session probe. It never resolves a context -- the bus and registry paths are
// facts the caller already holds and passes in.
//
// Grammar:  watch-registry.ts pane <registry> <handle|""> [--all]
//           watch-registry.ts session <registry> <armer>
//           watch-registry.ts repo-root <registry>
//
// What is carried from the incumbent:
//   - `pane` prints the wanted handle's pane first (a line even when empty --
//     the incumbent printed `ent.get("pane", "")`), then, with --all, every other
//     ACTIVE seat's non-empty pane; without --all it stops after the first line
//     it can print. A registry that is absent, unreadable, or not an object
//     prints nothing (the incumbent's `except Exception: sys.exit(0)`).
//   - `session` derives the team's tmux session from the armer's pane, else the
//     first active pane that tmux can still name. Empty when none resolves.
//   - `repo-root` is the registry's `team.worktree_root`, else the cwd -- the
//     directory a new sidecar window is started in.


import { loadRegistry, seatMap, type Seat } from "./registry";
import { teamRegistryRefusal } from "./register-authority";
import { isFile } from "./watch-lease";
import { tmuxReadOnly } from "./tmux";

/**
 * The seat map, or null when there is nothing to read: the Bash caller guarded
 * `[ -f "$reg" ] || return 0` before its Python, and the Python exited silently
 * on any load failure -- both are "no record", not "an empty first line".
 */
export function seatsOf(registryPath: string): Record<string, Seat> | null {
  if (!registryPath || !isFile(registryPath)) return null;   // `[ -f registry.json ]` (rule 38, F4)
  let doc;
  try { doc = loadRegistry(registryPath); } catch { return null; }
  // An old-format registry is "no record" here, and the refusal is said, never a silent seat map.
  const refusal = teamRegistryRefusal(registryPath, doc);
  if (refusal) { process.stderr.write(`tap watch: ${refusal.errorClass}: ${refusal.detail}; next: ${refusal.action}\n`); return null; }
  return seatMap(doc);
}

function isSeat(v: unknown): v is Seat {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function active(seat: Seat): boolean {
  return (seat.status ?? "active") === "active";
}

/**
 * `tap_watch_registry_pane`: the preferred handle's pane (printed even when
 * empty), then with `all` every other active seat's non-empty pane. Cluster A
 * ACTS on this list (probe/disarm target), so it reads the acting registry the
 * caller names, seats-first, never a guess.
 */
export function registryPanes(registryPath: string, handle: string, all: boolean): string[] {
  const seats = seatsOf(registryPath);
  if (seats === null) return []; // unreadable: nothing, not an empty first line
  const out: string[] = [];
  if (handle) {
    const ent = seats[handle];
    out.push(isSeat(ent) && typeof ent.pane === "string" ? ent.pane : "");
    if (!all) return out;
  }
  for (const [h, ent] of Object.entries(seats)) {
    if (h === handle || !isSeat(ent) || !active(ent)) continue;
    const pane = ent.pane;
    if (typeof pane !== "string" || !pane) continue;
    out.push(pane);
    if (!all) return out;
  }
  return out;
}

/** `_watch_team_session`: the first registered pane tmux can still place in a session. */
export function teamSession(registryPath: string, armer: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const pane of registryPanes(registryPath, armer, true)) {
    if (!pane) continue;
    const r = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{session_name}"], env);
    if (r.code !== 0) continue;
    const sess = r.stdout.split("\n", 1)[0] ?? "";
    if (sess) return sess;
  }
  return "";
}

/** `_watch_repo_root`: `team.worktree_root` from the registry, else the cwd. */
export function repoRoot(registryPath: string, cwd: string = process.cwd()): string {
  let root = "";
  try {
    const doc = loadRegistry(registryPath);
    // An old-format registry never chooses the watch's working tree; like seatsOf, the refusal is said.
    const refusal = teamRegistryRefusal(registryPath, doc);
    if (refusal) { process.stderr.write(`tap watch: ${refusal.errorClass}: ${refusal.detail}; next: ${refusal.action}\n`); return cwd; }
    const team = doc.team;
    if (typeof team === "object" && team !== null && !Array.isArray(team)) {
      const wr = (team as Record<string, unknown>).worktree_root;
      if (typeof wr === "string") root = wr;
    }
  } catch { root = ""; }
  return root || cwd;
}

export function main(argv: string[]): number {
  const [action, registryPath, ...rest] = argv;
  if (!action || registryPath === undefined) throw new Error("usage: watch-registry.ts <pane <registry> <handle> [--all] | session <registry> <armer> | repo-root <registry>>");
  switch (action) {
    case "pane": {
      const all = rest[rest.length - 1] === "--all";
      const args = all ? rest.slice(0, -1) : rest;
      if (args.length !== 1) throw new Error("pane needs <handle|\"\"> [--all]");
      const lines = registryPanes(registryPath, args[0]!, all);
      if (lines.length) process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    case "session": {
      if (rest.length !== 1) throw new Error("session needs <armer>");
      process.stdout.write(teamSession(registryPath, rest[0]!));
      return 0;
    }
    case "repo-root": {
      if (rest.length) throw new Error("repo-root takes no arguments");
      process.stdout.write(repoRoot(registryPath));
      return 0;
    }
    default:
      throw new Error(`unknown action '${action}'`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tap watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
