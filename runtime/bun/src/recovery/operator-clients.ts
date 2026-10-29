import { tmuxReadOnly, type Run } from "../tmux";
import type { OperatorClient } from "./operator-admission";

/** Include every session containing the target window, not only its original session. */
export function readOperatorClients(pane: string, read: (args: string[]) => Run = tmuxReadOnly): OperatorClient[] | null {
  const get = (args: string[]): string => {
    const r = read(args);
    if (r.code !== 0 || r.rateLimited) throw new Error("client census unavailable");
    return r.stdout;
  };
  try {
    const window = get(["display-message", "-p", "-t", pane, "#{window_id}"]).trim();
    if (!/^@\d+$/.test(window)) return null;
    const sessions = new Set<string>();
    for (const line of get(["list-windows", "-a", "-F", "#{session_name}\t#{window_id}"]).trimEnd().split("\n")) {
      const fields = line.split("\t");
      if (fields.length !== 2 || !fields[0] || !/^@\d+$/.test(fields[1]!)) return null;
      if (fields[1] === window) sessions.add(fields[0]);
    }
    if (!sessions.size) return null;
    const raw = get(["list-clients", "-F", "#{client_name}\t#{client_session}\t#{client_activity}\t#{client_created}"]);
    const ids = new Set<string>(), result: OperatorClient[] = [];
    for (const line of raw.trimEnd() ? raw.trimEnd().split("\n") : []) {
      const fields = line.split("\t");
      if (fields.length !== 4 || !fields[0] || !fields[1] || !/^\d+$/.test(fields[2]!) || !/^\d+$/.test(fields[3]!)) return null;
      const [id, session] = fields as [string, string, string, string];
      if (ids.has(id)) return null;
      ids.add(id);
      const activity = Number(fields[2]) * 1000, created = Number(fields[3]) * 1000;
      if (!Number.isSafeInteger(activity) || !Number.isSafeInteger(created)) return null;
      if (sessions.has(session)) result.push({ id, session, activity, created });
    }
    return result;
  } catch { return null; }
}
