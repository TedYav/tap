/**
 * The result carrier every Bun slice hands its Bash adapter: NUL-separated
 * `key\0value\0` pairs in a 0600 file the adapter reads back with
 * `tap_bun_read_pairs` (lib.sh). Keys are Bash variable names; booleans are
 * `1`/`0`. One encoder here, one reader there — the contract has one owner on
 * each side (message-construction was the first slice to carry it, the
 * addressee grant the second).
 */
import { writeFileSync } from "node:fs";

export type ResultPairs = Record<string, string | boolean | number>;

/**
 * The completion sentinel: the LAST pair of every carrier, so a stream cut
 * short anywhere — even at a pair boundary — is malformed rather than a
 * shorter, still-positive result (partner review, D2-u1: a complete positive
 * prefix plus a dangling key read as "authorized"). The reader requires it
 * exactly last and refuses it anywhere else; a slice cannot emit it as data.
 */
export const PAIRS_END_KEY = "_TAP_PAIRS_END";
export const PAIRS_END_VALUE = "end";

export function pairs(out: ResultPairs): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(out)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k === PAIRS_END_KEY) throw new Error(`result-pairs: refusing key '${k}'`);
    parts.push(Buffer.from(k, "utf8"), Buffer.from([0]));
    parts.push(Buffer.from(typeof v === "boolean" ? (v ? "1" : "0") : String(v), "utf8"), Buffer.from([0]));
  }
  parts.push(Buffer.from(PAIRS_END_KEY, "utf8"), Buffer.from([0]), Buffer.from(PAIRS_END_VALUE, "utf8"), Buffer.from([0]));
  return Buffer.concat(parts);
}

export function writeResult(path: string, out: ResultPairs): void {
  writeFileSync(path, pairs(out), { mode: 0o600 });
}

/**
 * The positional carrier contract: `<op> --result <path> -- <args…>`. Bun
 * strips a leading `--` from its own argv, so `--result` is read by POSITION,
 * never scanned for: an operand that spells `--result` stays data.
 */
export function carrierArgs(argv: string[], usage: string): { op: string; result: string; rest: string[] } | null {
  const [op, resultFlag, result, sep, ...rest] = argv;
  if (!op || resultFlag !== "--result" || !result || sep !== "--") {
    process.stderr.write(`${usage}\n`);
    return null;
  }
  return { op, result, rest };
}
