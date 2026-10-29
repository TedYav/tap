type Row = Record<string, unknown>;
const field = (row: Row, key: string): string => typeof row[key] === "string" ? row[key] as string : "";

/** Session names and pane ids are local to a tmux server generation. */
export function sameCrewSession(a: Row, b: Row): boolean {
  return field(a, "session") !== "" && field(a, "session") === field(b, "session")
    && field(a, "server_epoch") === field(b, "server_epoch")
    && (!field(a, "server_socket") || !field(b, "server_socket")
      || field(a, "server_socket") === field(b, "server_socket"));
}

export function isCrew(row: Row | undefined): boolean { return row?.crew === true || row?.crew === 1 || row?.crew === 1n; }

/** Durable links select a family across vessels. Session inference is teardown-only for unlinked legacy rows. */
export function crewFamilyHandles(rows: Record<string, Row>, owner: string, legacy = true): string[] {
  const parent = rows[owner];
  if (!parent || isCrew(parent)) return [];
  const uniqueLegacyOwner = legacy && Object.entries(rows).filter(([, row]) => !isCrew(row) && sameCrewSession(row, parent)).length === 1;
  return Object.keys(rows).filter(handle => {
    const row = rows[handle]!;
    if (!isCrew(row)) return false;
    const named = field(row, "crew_owner"), instance = field(row, "crew_owner_instance");
    if (named || instance) return named === owner && instance !== "" && instance === field(parent, "instance");
    return uniqueLegacyOwner && sameCrewSession(row, parent);
  }).sort();
}
