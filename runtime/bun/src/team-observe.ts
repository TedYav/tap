import { observeRows, parsePanes, type PaneRecord, type ObserveEngine, type ObservePayload } from "./observe";
import { clockFields, gather } from "./observe-gather";
const US = "\x1f";
function str(value: unknown): string { return typeof value === "string" ? value : ""; }

export interface RegistryRow {
  /** The seat's `tap role` label, carried to the roster. */
  role?: unknown;
  model?: unknown;
  launch_tuning?: unknown;
  team: unknown;
  handle: unknown;
  harness: unknown;
  pane: unknown;
  status: unknown;
  status_reason: unknown;
  delivery: unknown;
  pane_id: unknown;
  unattended: unknown;
  session: unknown;
  registered_at: unknown;
  crew: unknown;
  server_epoch: unknown;
  server_socket?: unknown;
  boot_id: unknown;
  preset: unknown;
  harness_session_id?: unknown;
  transcript_path?: unknown;
  /** Dated evidence `tap team --recent` reads; present only when the stored row has it. */
  last_launched?: unknown;
  exited_at?: unknown;
}


/**
 * ONE tmux/process snapshot, classified by the shared engine.
 *
 * Exported (tap-nyvty) so `tap team refresh` consumes the SAME observation the
 * roster does rather than growing a second answer to "is this seat gone". The
 * The incumbent made the same choice in bash: lib.sh's N=1 wrapper and the
 * roster's batch call both reached tap_observe_seats.py. Both now reach
 * `observe.ts` — the N=1 wrapper as a child through `tap_bun_call`, this door
 * in-process — and the rule the comment at lib.sh stated still holds: agreement
 * between roster, attach and refresh is mechanical, not two implementations
 * that happen to match.
 */
export function observe(
  rows: RegistryRow[],
  scriptsDir: string,
  fast = false,
  diagnostic: (text: string) => void = text => { process.stderr.write(text); },
  engine: ObserveEngine = observeRows,
): { code: number; rows: Map<string, string[]>; serverEpoch: string; panePids?: Map<string,string>; panes?: Map<string, PaneRecord> } {
  const g = gather({ fast, env: process.env });
  const serverEpoch = g.serverEpoch;

  const payload: Record<string, unknown> = {
    rows: rows.map((row) => ({
      key: str(row.handle),
      status: str(row.status),
      delivery: str(row.delivery),
      pane: str(row.pane),
      pane_id: str(row.pane_id),
      session: str(row.session),
      registered_at: str(row.registered_at),
      row_epoch: str(row.server_epoch),
      row_boot: str(row.boot_id),
      harness: str(row.harness),
      status_reason: str(row.status_reason),
    })),
    sessions_rc: g.sessions_rc,
    sessions_text: g.sessions_text,
    panes_rc: g.panes_rc,
    panes_text: g.panes_text,
    ps_rc: g.ps_rc,
    ps_text: g.ps_text,
    ...clockFields({ env: process.env }),
  };
  if (process.env.TAP_SERVER_EPOCH !== undefined) payload.server_epoch_pin = process.env.TAP_SERVER_EPOCH;

  // The classification runs HERE. It was a child process on the seats observer
  // child fed this payload as JSON on stdin; the payload keeps its wire shape
  // because the classifier contract and the refresh differential are defined
  // on it, not because any door still sends it.
  //
  // WHAT THE PROCESS BOUNDARY TOOK WITH IT, stated rather than discovered at
  // review: the two doors no longer share a failure. The retired Bash door
  // spawned a child (`tap_bun_call` → `bun observe.ts --from-env`, both since
  // deleted) and could see it exit nonzero; this door can only see the engine
  // throw. An assertion that they
  // fail byte-identically would be asserting a property production does not
  // have, so the arm that made that comparison is deleted rather than re-aimed.
  // The two agree on the CODE — `tap_bun_call` reports 1, and so does a throw —
  // but that is agreement, not a shared mechanism.
  const out = new Map<string, string[]>();
  let records: string[];
  try {
    records = engine(payload as ObservePayload);
  } catch (error) {
    // A classification that could not complete never becomes a roster. The
    // failure is a diagnostic, never part of a caller's JSON receipt, and `out`
    // stays empty so no half-answer can be read as rows.
    diagnostic(`${error instanceof Error ? error.message : String(error)}\n`);
    return { code: 1, rows: out, serverEpoch };
  }
  for (const line of records) {
    const fields = line.split(US);
    const key = fields.shift() ?? "";
    if (key) out.set(key, fields);
  }
  const panes = new Map<string, PaneRecord>();
  for (const records of parsePanes(g.panes_text, g.panes_rc, process.env.TAP_SERVER_EPOCH ?? null).bySession.values()) {
    for (const pane of records) if ("pane_id" in pane) panes.set(pane.pane_id, pane);
  }
  const panePids = new Map([...panes].map(([id, pane]) => [id, pane.pane_pid]));
  return { code: 0, rows: out, serverEpoch, panePids, panes };
}
