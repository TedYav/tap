// process-ancestry.ts — the process-row oracles shared by the caller-pane walk
// (context.ts, `ps -o ppid= -o tty= -p <pid>`) and every pane-ownership proof
// that asks "is this pid under that pane's pane_pid" (`ps -o ppid= -p <pid>`,
// the ancestry walk's own spelling), each with the libproc fallback for a
// sandbox that cannot exec ps at all (tap-21bdj).

import { spawnSync } from "node:child_process";
import { libprocRow } from "./proc-row";

/** A process's parent pid and controlling tty, as `ps` spells them. */
export interface ProcessRow { ppid: string; tty: string }

/**
 * The first `ps` record for PID, or null when no record could be read.
 *
 * Bash's IFS, not JavaScript's `\s`. `read -r ppid tty _` splits on the
 * default IFS -- space, tab, newline -- and NOTHING else, while JS `\s` also
 * matches NBSP, U+2000-200A, U+202F, U+205F, U+3000 and U+FEFF. A `ps` row
 * separated by NBSP therefore gave Bash an unusable parent pid (refused) and
 * gave a `\s` split a plausible pid/tty pair (accepted). That divergence was
 * harmless while every non-`ok` answer was `null`; it stopped being harmless
 * the moment one of those answers became positive outside evidence that
 * licenses attach (review, P2).
 *
 * Mirror the incumbent's STRUCTURE, not just its splitting. It guards on the
 * raw row being empty (`[ -n "$row" ]`), then field-splits; a row with only
 * one field therefore leaves `tty` EMPTY, and empty is in the walk's skip set
 * (`""|"?"|"??"|"-"`), so it falls through to the parent-pid check and refuses
 * there. Treating a missing second field as "no row at all" reports the wrong
 * refusal for a row that was read perfectly well -- found by a reviewer's NBSP
 * specimen, which produces exactly that row.
 *
 * Three separate Bash behaviours, and getting two of them right is not enough
 * (review, P2 twice):
 *
 *   `row="$(ps ...)"`            command substitution strips TRAILING
 *                                newlines and nothing else -- a leading
 *                                blank line survives and is meaningful.
 *   `[ -n "$row" ]`              the emptiness guard is on the whole row.
 *   `read -r ppid tty _ <<<`     consumes exactly ONE LINE, then splits it
 *                                on IFS (space, tab) with leading and
 *                                trailing IFS whitespace stripped.
 *
 * Splitting the entire stdout on whitespace matched the IFS CHARACTERS while
 * destroying the RECORD BOUNDARY, so `1\nfaketty` was read as the pair
 * `1 faketty` -- two separate records fused into one plausible observation,
 * which then answered a positive `outside`. The boundary is load-bearing
 * exactly because the walk's one positive answer grants authority.
 *
 * `ps` that cannot run at all (a sandbox forbids exec of setuid binaries)
 * falls back to the OS process table.
 */
export function processRow(pid: number, env: NodeJS.ProcessEnv = process.env): ProcessRow | null {
  const row = spawnSync("ps", ["-o", "ppid=", "-o", "tty=", "-p", String(pid)], { encoding: "utf8", env });
  const raw = (row.error ? libprocRow(pid) ?? "" : row.stdout ?? "").replace(/\n+$/, "");
  if (!raw) return null;
  const firstRecord = raw.split("\n", 1)[0] ?? "";
  const fields = firstRecord.replace(/^[ \t]+|[ \t]+$/g, "").split(/[ \t]+/);
  return { ppid: fields[0] ?? "", tty: fields[1] ?? "" };
}

/**
 * The parent pid alone, as the ancestry walk has always asked for it:
 * `ps -o ppid= -p <pid>`. This is a DIFFERENT spelling from `processRow`'s
 * `-o ppid= -o tty=` on purpose. The two questions have two callers with two
 * failure modes, and the identity fixtures rely on telling them apart: the
 * re-registration smoke's `ps` stub delegates exactly the ancestry spelling to
 * the real `ps` while answering the tty-aware walk with a canned outside row,
 * so a rebind from the seat's own pane proves ancestry while the caller pane
 * stays unobservable. Folding the ancestry proof onto the tty-aware row made
 * that proof read the canned row and refuse every self-attested rebind (full
 * gate on c40af9e16). The libproc fallback still answers when `ps` cannot run.
 */
export function parentPid(pid: number, env: NodeJS.ProcessEnv = process.env): string {
  const row = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", env });
  const raw = row.error ? libprocRow(pid) ?? "" : row.status === 0 ? row.stdout ?? "" : "";
  const first = (raw.replace(/\n+$/, "").split("\n", 1)[0] ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
  return first.split(/[ \t]+/)[0] ?? "";
}

/**
 * tap_pid_has_ancestor: the fail-closed process-ancestry walk. True when PID
 * is ANCESTOR or descends from it within 64 steps; an unreadable row, a
 * non-numeric parent, or reaching init refuses. ANCESTOR that is not a pid
 * refuses without a probe.
 */
export function pidHasAncestor(pid: number, ancestor: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^\d+$/.test(ancestor)) return false;
  let current = pid;
  for (let i = 0; i < 64; i++) {
    if (String(current) === ancestor) return true;
    const parent = parentPid(current, env);
    if (!/^\d+$/.test(parent)) return false;
    const ppid = Number(parent);
    if (ppid <= 1 || ppid === current) return false;
    current = ppid;
  }
  return false;
}
