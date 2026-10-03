/**
 * TAP's fence in Codex's config.toml, and the one repair Codex's own writes
 * force on it.
 *
 * Codex writes config.toml through toml_edit (codex-rs/core/src/config/edit.rs):
 * it parses the file, inserts new tables and renders the whole document again.
 * New tables render after the existing ones and before the document's trailing
 * comments. When TAP's end marker is the file's last line it IS that trailing
 * comment, so every table Codex adds lands inside TAP's fence: [hooks.state]
 * when the user trusts a hook, [projects."…"] when they trust a directory.
 *
 * relocateCodexEndMarker moves the end marker, a comment TAP wrote, back to
 * just after TAP's own lines. Every other byte keeps its place and order, so
 * TAP still never rewrites a byte it does not own (tap-7r3fn.34). Install and
 * uninstall both run it before they judge the fence.
 */
import { CODEX_BEGIN, CODEX_END } from "./install-manifest";

export function splitKeepEnds(raw: Buffer): Buffer[] {
  // bytes.splitlines(keepends=True) parity: \r\n, \n, and a bare \r are each
  // a boundary; the \r stays attached to its line.
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0a) { lines.push(raw.subarray(start, i + 1)); start = i + 1; }
    else if (raw[i] === 0x0d && raw[i + 1] !== 0x0a) { lines.push(raw.subarray(start, i + 1)); start = i + 1; }
  }
  if (start < raw.length) lines.push(raw.subarray(start));
  return lines;
}

export function chompEol(line: Buffer): Buffer {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) end--;
  if (end > 0 && line[end - 1] === 0x0d) end--;
  return line.subarray(0, end);
}

export function asciiTrim(line: Buffer): Buffer {
  let lo = 0, hi = line.length;
  const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
  while (lo < hi && isWs(line[lo]!)) lo++;
  while (hi > lo && isWs(line[hi - 1]!)) hi--;
  return line.subarray(lo, hi);
}

/** A refusal that names the 1-based config.toml lines it is about. */
export class CodexFenceError extends Error {
  /** `fence`: the 1-based begin and end marker lines, when the markers are a valid pair. */
  constructor(message: string, readonly lines: number[], readonly fence?: [number, number]) { super(message); }
}

/** The single, ordered begin/end marker pair as line indexes, or null. */
export function codexFenceLines(lines: Buffer[]): { start: number; stop: number } | null {
  const begin = Buffer.from(CODEX_BEGIN), end = Buffer.from(CODEX_END);
  const starts: number[] = [], stops: number[] = [];
  lines.forEach((line, i) => {
    const bare = chompEol(line);
    if (bare.equals(begin)) starts.push(i);
    if (bare.equals(end)) stops.push(i);
  });
  if (starts.length !== 1 || stops.length !== 1 || stops[0]! < starts[0]!) return null;
  return { start: starts[0]!, stop: stops[0]! };
}

// A header under TAP's own arrays, such as [[hooks.PreToolUse.hooks]], adds to
// TAP's last element. Outside the fence it would outlive TAP's block and attach
// to someone else's, so it refuses. A sibling [[hooks.PreToolUse]] is fine.
const isHeader = (line: Buffer): boolean => /^\[.*\][ \t]*(#.*)?$/.test(asciiTrim(line).toString("utf8"));

function extendsTapArrays(header: string): boolean {
  const key = header.replace(/#.*$/, "").replace(/[\s"'[\]]/g, "");
  return key.startsWith("hooks.SessionStart.") || key.startsWith("hooks.PreToolUse.");
}

/**
 * Moves TAP's end marker to just after the fence's `ownedLineCount`-th
 * non-blank line when whole tables trail TAP's lines inside the fence.
 * `moved` is the 1-based line range those tables held before the move.
 * Returns `raw` unchanged when there is no single ordered marker pair or
 * nothing trails; the caller's own fence checks judge those files.
 * Throws when the trailing bytes do not start with a table header or extend
 * TAP's own arrays.
 */
export function relocateCodexEndMarker(raw: Buffer, ownedLineCount: number): { raw: Buffer; moved: [number, number] | null } {
  const unchanged = { raw, moved: null };
  const lines = splitKeepEnds(raw);
  const fence = codexFenceLines(lines);
  if (!fence) return unchanged;
  const { start, stop } = fence;
  let split = -1;
  for (let i = start + 1, seen = 0; i < stop; i++) {
    if (asciiTrim(lines[i]!).length && ++seen === ownedLineCount) { split = i + 1; break; }
  }
  if (split < 0) return unchanged;
  let first = split;
  while (first < stop && !asciiTrim(lines[first]!).length) first++;
  if (first === stop) return unchanged;
  if (!isHeader(lines[first]!)) {
    throw new CodexFenceError("unknown bytes follow TAP's hooks inside the TAP markers", [first + 1]);
  }
  const extending: number[] = [];
  for (let i = first; i < stop; i++) {
    if (isHeader(lines[i]!) && extendsTapArrays(asciiTrim(lines[i]!).toString("utf8"))) extending.push(i + 1);
  }
  if (extending.length) {
    throw new CodexFenceError("a table inside the TAP markers adds to TAP's own hook arrays", extending);
  }
  let marker = lines[stop]!;
  if (marker[marker.length - 1] !== 0x0a) {
    const previous = lines[stop - 1]!;
    marker = Buffer.concat([marker, Buffer.from(previous.length > 1 && previous[previous.length - 2] === 0x0d ? "\r\n" : "\n")]);
  }
  return {
    raw: Buffer.concat([...lines.slice(0, split), marker, ...lines.slice(split, stop), ...lines.slice(stop + 1)]),
    moved: [first + 1, stop],
  };
}
