import { accessSync, constants, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { physicalSocketPath } from "./tmux";
import { shellQuote } from "./shell-quote";

export interface ViewerSeat { handle: string; session: string }
/** Nearly square rows, with the short final rows distributed rather than nested. */
export function gridRows(count: number): number[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("viewer needs at least one seat");
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: rows }, (_, i) => Math.floor(count / rows) + (i < count % rows ? 1 : 0));
}

/** Bun owns the layout and quoting; AppleScript is only the iTerm platform adapter. */
export function itermViewerScript(seats: ViewerSeat[], cwd: string, socket: string, tabs = false): string {
  if (!seats.length) throw new Error("viewer needs at least one seat");
  const binary = Bun.which("tmux");
  if (!binary) throw new Error("tmux is unavailable");
  const command = (seat: ViewerSeat) => JSON.stringify(`/bin/sh -c ${shellQuote(`unset TMUX TMUX_PANE; cd ${shellQuote(cwd)} && exec ${shellQuote(binary)} -S ${shellQuote(socket)} attach-session -t ${shellQuote(`=${seat.session}`)}`)}`);
  // The reusable iTerm startup command must launch only a shell. iTerm can
  // inherit it when the operator splits a pane; tmux is typed separately.
  // userInfo().shell reads the OS user record, which some runner accounts
  // carry stale or unexecutable (e.g. a service account's directory-services
  // entry pointing at a shell that was never installed) -- verify it exists
  // and is executable before trusting it, rather than execing a path that
  // fails the whole viewer launch with an opaque shell "command not found".
  const recordedShell = userInfo().shell;
  let shell = "/bin/sh";
  if (recordedShell) { try { accessSync(recordedShell, constants.X_OK); shell = recordedShell; } catch { /* fall back to /bin/sh */ } }
  const startup = JSON.stringify(`/bin/sh -c ${shellQuote(`unset TMUX TMUX_PANE; cd ${shellQuote(cwd)} && exec ${shellQuote(shell)} -l`)}`);
  const lines = ['tell application "iTerm2"', `  set w to (create window with default profile command ${startup})`, '  set t to current tab of w', '  set p1 to current session of t'];
  const rowSizes = gridRows(seats.length);
  if (tabs || seats.length >= 8) {
    for (let i = 1; i < seats.length; i++) {
      lines.push(`  tell w to set t${i + 1} to (create tab with default profile command ${startup})`, `  set p${i + 1} to current session of t${i + 1}`);
    }
  } else {
    lines.push('  set totalColumns to columns of p1', '  set totalRows to rows of p1');
    // Build full-width rows first; splitting one row must not subdivide its neighbour.
    let offset = rowSizes[0]!;
    const firstInRow = [1];
    for (let row = 1; row < rowSizes.length; row++) {
      const n = offset + 1;
      lines.push(`  tell p${firstInRow[row - 1]} to set p${n} to (split horizontally with default profile command ${startup})`);
      firstInRow.push(n); offset += rowSizes[row]!;
    }
    rowSizes.forEach((width, row) => {
      const first = firstInRow[row]!;
      for (let col = 1; col < width; col++) {
        const n = first + col;
        lines.push(`  tell p${n - 1} to set p${n} to (split vertically with default profile command ${startup})`);
      }
    });
    rowSizes.forEach((width, row) => {
      for (let col = 0; col < width; col++) {
        const n = firstInRow[row]! + col;
        lines.push(`  set columns of p${n} to (totalColumns div ${width})`, `  set rows of p${n} to (totalRows div ${rowSizes.length})`);
      }
    });
  }
  seats.forEach((seat, i) => lines.push(
    `  set name of p${i + 1} to ${JSON.stringify(seat.handle)}`,
    `  tell p${i + 1} to write text ${command(seat)}`,
  ));
  lines.push('  return id of w', 'end tell');
  return lines.join('\n') + '\n';
}

if (import.meta.main) {
  const [path, layout, cwd] = Bun.argv.slice(2);
  if (!path || !cwd || !["panes", "tabs"].includes(layout ?? "")) throw new Error("viewer rows, layout and cwd required");
  const seats = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => {
    const [session, handle] = line.split("\x1f");
    if (!session || !handle) throw new Error("invalid viewer row");
    return { session, handle };
  });
  process.stdout.write(itermViewerScript(seats, cwd, physicalSocketPath(), layout === "tabs"));
}
