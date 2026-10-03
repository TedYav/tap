import type { Seat } from "./registry";

/** Unknown/malformed facts retain custody. A live session always retains it, including across boot pins. */
export function reservationExpired(row: Seat, sessions: Set<string> | null, now: number,
  boot: string | null, legacyBoot: string | null): boolean {
  if (!(row.status === "pending" || (row.status === "active" && row.status_reason === "launching" && row.launch_id))) return false;
  if (row.pane_id && (typeof row.pane_id !== "string" || !/^%[0-9]+$/.test(row.pane_id))) return false;
  if (typeof row.session !== "string" || !row.session || sessions?.has(row.session)) return false;
  if (row.boot_id !== undefined && row.boot_id !== null && boot !== null) {
    const storedSeconds = /^boot:(\d+)$/.exec(String(row.boot_id))?.[1];
    const currentSeconds = /^boot:(\d+)$/.exec(legacyBoot ?? "")?.[1];
    const same = row.boot_id === boot || (storedSeconds !== undefined && currentSeconds !== undefined &&
      Math.abs(Number(storedSeconds) - Number(currentSeconds)) <= 5);
    if (!same) return true;
  }
  if (sessions === null || typeof row.registered_at !== "string") return false;
  const stamp = registryTimestamp(row.registered_at);
  return stamp !== null && now - stamp >= 60;
}

/** Registry ISO calendar stamps; unknown spellings remain protected rather than normalized by Date.parse. */
function registryTimestamp(raw: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone = "Z"] = match;
  if (+year! < 1 || +month! < 1 || +month! > 12 || +day! < 1 || +hour > 23 || +minute > 59 || +second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(+year!, +month! - 1, +day!);
  date.setUTCHours(+hour, +minute, +second, 0);
  if (date.getUTCMonth() !== +month! - 1 || date.getUTCDate() !== +day!) return null;
  const offset = zone === "Z" ? 0 : (+zone.slice(1,3) * 60 + +zone.slice(4,6)) * (zone[0] === "+" ? 1 : -1);
  if (zone !== "Z" && (+zone.slice(1,3) > 23 || +zone.slice(4,6) > 59)) return null;
  return date.getTime() / 1000 + Number(`0.${fraction || "0"}`) - offset * 60;
}
