import { ServerUnresponsive, tmuxReadOnly } from "./tmux";
import { parseUnicodeDecimal } from "./unicode-decimal";

// The refresh/lib.sh clock has no boot override. Launcher reservations continue
// to use reservationExpired, whose boot-aware contract is deliberately separate.
/** Live tmux session names; null when unobservable (an unobservable snapshot
 * never expires a reservation). The shared gatherer for reservation expiry and
 * the register chooser — the one tmux list-sessions reader. */
export function liveSessionNames(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  try {
    const result = tmuxReadOnly(["list-sessions", "-F", "#S"], env);
    return result.code === 0
      ? new Set(result.stdout.replace(/\n+$/, "").split("\n").filter((line) => line !== ""))
      : null;
  } catch (error) {
    if (error instanceof ServerUnresponsive) return null;
    throw error;
  }
}

function sessions(): Set<string> | null {
  return liveSessionNames();
}

// Match the incumbent strptime calendar, including its unpadded fields, without
// Date.parse normalizing malformed dates into valid reservations.
function timestamp(raw: string): bigint | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}| [1-9])T(\d{1,2}):(\d{1,2}):(\d{1,2})Z$/i.exec(raw);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return BigInt(date.getTime() / 1000);
}

function remaining(registeredAt: string): bigint | null {
  const stamp = timestamp(registeredAt);
  const raw = (process.env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000)))
    .replace(/^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "")
    .replace(/\p{Nd}/gu, digit => String(parseUnicodeDecimal(digit)));
  // Python int accepts signs, surrounding whitespace and digit separators.
  if (stamp === null || !/^[+-]?\d(?:_?\d)*$/.test(raw)) return null;
  return 60n - (BigInt(raw.replaceAll("_", "")) - stamp);
}

export function pendingExpired(session: string, registeredAt: string): boolean {
  if (!session || !registeredAt) return false;
  const live = sessions();
  if (live === null || live.has(session)) return false;
  const left = remaining(registeredAt);
  return left !== null && left <= 0n;
}

export function pendingGrace(session: string, registeredAt: string): string {
  if (sessions()?.has(session) && session) return "alive";
  const left = remaining(registeredAt);
  return `grace:${left === null ? 60n : left > 0n ? left : 0n}`;
}

if (import.meta.main) {
  const [mode, session = "", registeredAt = ""] = Bun.argv.slice(2);
  if (mode === "expired") console.log(pendingExpired(session, registeredAt));
  else if (mode === "grace") console.log(pendingGrace(session, registeredAt));
  else { console.error("pending-reservation: expected expired or grace"); process.exit(2); }
}
