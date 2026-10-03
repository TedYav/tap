// A fixture of OpenCode's real `session`/`project`/`project_directory`/`message`/`part` tables (the
// DDL `.schema` prints on a live v1.18.33 store), so the readers' queries run against the same
// columns and indexes as production. The session table is indexed on project_id, workspace_id and
// parent_id only -- never on directory.
// `data` omits id/sessionID exactly as OpenCode's projector stores it: the columns are authoritative.
import { Database } from "bun:sqlite";

export const OPENCODE_STORE_DDL = `
CREATE TABLE project (
  id text PRIMARY KEY,
  worktree text NOT NULL,
  vcs text,
  name text,
  icon_url text,
  icon_url_override text,
  icon_color text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_initialized integer,
  sandboxes text NOT NULL,
  commands text
);
CREATE TABLE project_directory (
  project_id text NOT NULL,
  directory text NOT NULL,
  type text,
  strategy text,
  time_created integer NOT NULL,
  CONSTRAINT project_directory_pk PRIMARY KEY(project_id, directory),
  CONSTRAINT fk_project_directory_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE TABLE session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text,
  parent_id text,
  slug text NOT NULL,
  directory text NOT NULL,
  path text,
  title text NOT NULL,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  metadata text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text,
  permission text,
  agent text,
  model text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer,
  CONSTRAINT fk_session_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX session_project_idx ON session (project_id);
CREATE INDEX session_workspace_idx ON session (workspace_id);
CREATE INDEX session_parent_idx ON session (parent_id);
CREATE TABLE message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE TABLE part (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
CREATE INDEX part_session_idx ON part (session_id);`;

export function createOpenCodeStore(path: string): Database {
  const db = new Database(path);
  db.exec(OPENCODE_STORE_DDL);
  return db;
}

let seq = 0;

/**
 * Insert a message the way the projector does: `session_id` and `time_created` become
 * columns, and the JSON keeps neither `sessionID` nor `id`. `row` may still name
 * `sessionID` (legacy fixture shape); it only picks the column.
 */
export function addMessage(db: Database, row: Record<string, any>, opts: { id?: string; session?: string } = {}): string {
  const { sessionID, ...data } = row;
  const id = opts.id ?? `msg_${String(++seq).padStart(8, "0")}`;
  const created = typeof data.time?.created === "number" ? data.time.created : seq;
  db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(id, opts.session ?? sessionID ?? "s1", created, created, JSON.stringify(data));
  return id;
}

/** Insert a session row the way OpenCode files it: under `project`, at its own `directory`. */
export function addSession(
  db: Database,
  id: string,
  directory: string,
  opts: { project?: string; created?: number; updated?: number } = {},
): void {
  const created = opts.created ?? 1;
  db.query(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, 't', '1.18.33', ?, ?)",
  ).run(id, opts.project ?? "global", id, directory, created, opts.updated ?? created);
}

/** Insert a project and the directories OpenCode records for it (worktree, sandboxes, opened dirs). */
export function addProject(
  db: Database,
  id: string,
  worktree: string,
  opts: { sandboxes?: string[]; opened?: string[] } = {},
): void {
  db.query("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, 'git', 1, 1, ?)")
    .run(id, worktree, JSON.stringify(opts.sandboxes ?? []));
  for (const d of opts.opened ?? []) {
    db.query("INSERT INTO project_directory (project_id, directory, time_created) VALUES (?, ?, 1)").run(id, d);
  }
}
