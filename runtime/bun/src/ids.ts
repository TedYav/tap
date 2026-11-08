// Id discipline. CONTRACT.md §IDs: `<sender>-<utc-compact>-<hex>`, minted by the
// courier, charset-locked so an id can never break the one-line sentinel grammar.

/** The one charset gate. Shared by ids, handles, and envelope from/to/kind. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validId(v: string): boolean {
  return TOKEN_RE.test(v);
}

/**
 * Deliberately the same predicate as `validId`, not an alias of it.
 *
 * The incumbent keeps `tap_valid_id` and `tap_valid_token` as two functions over
 * one regex because they are asked different questions (an id vs. a routing
 * token), and because the reserved-handle rule attaches to handle CLAIMS only —
 * folding it into the charset gate would refuse to settle a payload on behalf of
 * an existing actor. Keeping two names keeps that seam available.
 */
export function validToken(v: string): boolean {
  return TOKEN_RE.test(v);
}

/**
 * May `char` extend a token that is still empty (`atStart`) or already begun? Asks
 * `validToken`, so an editor refusing keystrokes shares the one charset gate.
 */
export function tokenCharAllowed(char: string, atStart: boolean): boolean {
  return validToken(atStart ? char : `a${char}`);
}

/** Digest-envelope identity — tap-ix63. Never a send destination or `--from`. */
export const COURIER_IDENTITY = "courier";
/** Supervision sender — tap_handle_reserved. Native send delegates `--from watcher`. */
export const WATCH_IDENTITY = "watcher";
/** The operator at a terminal that is not a seat (tap-gridx): the sender of a
 * `tap nudge` whose operator prompt was answered yes. Never a seat handle, a
 * destination or a plain `tap send --from`. */
export const USER_IDENTITY = "user";
/** CLI help keyword — tap-7af. Unclaimable as a seat handle. */
export const HELP_HANDLE = "help";

/** Why a launcher-created seat cannot take this handle, or "" when it can. */
export function reservedSeatName(handle: string): string {
  if (handle === HELP_HANDLE) return "is reserved as the CLI help keyword";
  if (handle === USER_IDENTITY) return "is the reserved operator identity";
  return "";
}

/** A path is sentinel-safe iff it carries no whitespace and no `]`. */
export function validPathToken(v: string): boolean {
  return v.length > 0 && !/[\s\]]/.test(v);
}

function utcCompact(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/**
 * 6 bytes of CSPRNG entropy as 12 hex chars — the incumbent's `od -An -N6
 * -tx1 /dev/urandom`. The width is load-bearing: it is what keeps two sends in
 * the same clock second from colliding on an id.
 */
export function mintId(sender: string, now: Date = new Date()): string {
  if (!validId(sender)) {
    throw new Error(`mint_id: sender '${sender}' fails charset ${TOKEN_RE.source}`);
  }
  const rand = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex");
  return `${sender}-${utcCompact(now)}-${rand}`;
}

const ID_STAMP_RE = /-(\d{8})T(\d{6})Z-[^-]*$/;

/**
 * STRICT calendar parse — never `Date.parse`, which normalizes an impossible
 * date into a real one. Verified against the incumbent, whose python
 * `datetime.datetime(...)` RAISES on `20260231` and exits 1; `Date.parse` of the
 * same stamp silently answers 2026-03-03 and would have reported a confident age
 * for an id that carries no valid stamp at all. Returns null on any out-of-range
 * component.
 */
export function parseIdStampEpoch(id: string): number | null {
  const m = ID_STAMP_RE.exec(id);
  if (!m) return null;
  const date = m[1]!;
  const time = m[2]!;
  const [y, mo, d] = [+date.slice(0, 4), +date.slice(4, 6), +date.slice(6, 8)];
  const [h, mi, s] = [+time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6)];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  // NOT a bare Date.UTC(y, ...): for y in 0..99 that argument is interpreted as
  // an OFFSET FROM 1900, so year 1 silently becomes 1901. Verified against the
  // incumbent, which accepts `s-00010101T000000Z-abc` and answers 62135596800 at
  // epoch 0 while Date.UTC(1, 0, 1) constructs 1901 — and the round-trip check
  // below then rejects a stamp the incumbent accepts. setUTCFullYear has no such
  // two-digit-year rule, so the full year is passed explicitly.
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  // Round-trip check: this is what catches Feb 31 rolling into March.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(dt.getTime() / 1000);
}

/**
 * Age in seconds from the id's OWN embedded stamp — never file mtime, so
 * redelivery and spool movement cannot reset it.
 *
 * A future-stamped id (clock drift, hand-mint) clamps to 0 AND warns on stderr,
 * rather than returning a negative age that silently escapes every threshold.
 * The warning is the point: a clamp with no warning turns a broken clock into a
 * permanently young obligation that no staleness check will ever surface.
 *
 * Returns null when the id carries no parseable stamp — the caller's cue to
 * refuse, not to substitute a default.
 */
export function idAgeSeconds(id: string, nowEpoch: number, warn: (m: string) => void = (m) => process.stderr.write(m)): number | null {
  const minted = parseIdStampEpoch(id);
  if (minted === null) return null;
  const age = nowEpoch - minted;
  if (age < 0) {
    warn(`tap: warning: payload id '${id}' is future-stamped (${-age}s ahead of now); treating age as 0\n`);
    return 0;
  }
  return age;
}

export function utcStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Shared injected clock for reader age parity; explicit age arguments still win. */
export function ageNowEpoch(env: NodeJS.ProcessEnv = process.env): number {
  const pinned = env.TAP_SPOOL_NOW;
  return pinned && /^[0-9]+$/.test(pinned) ? Number(pinned) : Math.floor(Date.now() / 1000);
}
