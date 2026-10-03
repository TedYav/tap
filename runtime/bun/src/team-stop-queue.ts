import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function stat(path: string) {
  try { return statSync(path); } catch { return undefined; }
}

// Match the retired Python reader: Unicode whitespace, but only LF anchors.
const whitespace = "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const toPattern = new RegExp(`(?:^|\\n)to:[${whitespace}]*([^${whitespace}]+)[${whitespace}]*(?=\\n|$)`);
const teamPattern = new RegExp(`(?:^|\\n)to_team:[${whitespace}]*([^${whitespace}]+)[${whitespace}]*(?=\\n|$)`);

/** Read-only shutdown advisory counts. Keep the historic two denominators:
 * bus unsettled excludes regular .done/.cancelled files; seat warnings also
 * exclude .resent and accept any existing terminal receipt path.
 */
export function teamStopQueueSummary(
  payloads: string, receipts: string, team: string, handles?: readonly string[],
): { unsettled: number; counts: Map<string, number> } {
  const counts = new Map<string, number>(handles?.map(handle => [handle, 0]));
  let unsettled = 0;
  if (!stat(payloads)?.isDirectory()) return { unsettled, counts };
  for (const name of readdirSync(payloads)) {
    if (!name.endsWith(".md") || name.startsWith("_")) continue;
    const id = name.slice(0, -3);
    const done = stat(join(receipts, `${id}.done`));
    const cancelled = done?.isFile() ? undefined : stat(join(receipts, `${id}.cancelled`));
    // Bash's old glob omitted dotfiles; the Python seat counter included them.
    if (!name.startsWith(".") && !done?.isFile() && !cancelled?.isFile()) unsettled++;
    if (!handles || done || cancelled || stat(join(receipts, `${id}.resent`))) continue;
    const text = readFileSync(join(payloads, name), "utf8").replace(/\r\n?/g, "\n");
    const target = toPattern.exec(text)?.[1];
    if (!target) continue;
    const handle = target.includes("/") ? target.slice(target.indexOf("/") + 1) : target;
    if (!counts.has(handle) || (target !== handle && target !== `${team}/${handle}`)) continue;
    const toTeam = teamPattern.exec(text)?.[1];
    if (toTeam && toTeam !== team) continue;
    counts.set(handle, counts.get(handle)! + 1);
  }
  return { unsettled, counts };
}

if (import.meta.main) {
  try {
    const [payloads, receipts, team, rows] = process.argv.slice(2);
    if (!payloads || !receipts || team === undefined) throw new Error("expected payloads, receipts, team, optional rows");
    const handles = rows ? readFileSync(rows, "utf8").split("\n").slice(1)
      .filter(line => line.includes("\x1f")).map(line => line.split("\x1f", 1)[0]!) : undefined;
    const summary = teamStopQueueSummary(payloads, receipts, team, handles);
    // This line is a Bash integer, not terminal presentation.
    console.log(String(summary.unsettled));
    for (const [handle, count] of summary.counts) console.log(`${handle}\x1f${count}`);
  } catch (error) {
    console.error(`team stop queue summary failed: ${error}`);
    process.exitCode = 1;
  }
}
