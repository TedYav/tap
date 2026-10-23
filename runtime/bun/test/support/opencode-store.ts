// OpenCode 2.1.2 DDL captured from a sandboxed native store. Type and sequence
// are columns; message JSON contains neither its id nor its type.
import { Database } from "bun:sqlite";

export const OPENCODE_STORE_DDL = `
CREATE TABLE project_directory (
          project_id text NOT NULL,
          directory text NOT NULL,
          type text,
          strategy text,
          time_created integer NOT NULL,
          CONSTRAINT project_directory_pk PRIMARY KEY(project_id, directory),
          CONSTRAINT fk_project_directory_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
        );
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
          time_active integer DEFAULT 0 NOT NULL,
          time_archived integer,
          sandboxes text NOT NULL,
          commands text
        );
CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL,
          CONSTRAINT fk_session_message_session_id_session_v2_id_fk FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
        );
CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          workspace_id text,
          parent_id text,
          fork_session_id text,
          fork_boundary text,
          slug text NOT NULL,
          directory text NOT NULL,
          path text,
          title text,
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
          time_idle integer,
          time_viewed integer,
          idle_outcome text,
          time_compacting integer,
          time_archived integer,
          time_suspended integer,
          resume_attempts integer DEFAULT 0 NOT NULL,
          CONSTRAINT fk_session_v2_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
        );
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id,seq);
CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id,type,seq);
CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id,time_created,id);
CREATE INDEX session_message_time_created_idx ON session_message (time_created);
CREATE INDEX session_v2_project_idx ON session_v2 (project_id);
CREATE INDEX session_v2_workspace_idx ON session_v2 (workspace_id);
CREATE INDEX session_v2_parent_idx ON session_v2 (parent_id);
CREATE INDEX session_v2_time_suspended_idx ON session_v2 (time_suspended) WHERE "session_v2"."time_suspended" is not null;`;

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
  const { sessionID, type, ...data } = row;
  const ordinal = ++seq;
  const id = opts.id ?? `msg_${String(ordinal).padStart(8, "0")}`;
  const created = typeof data.time?.created === "number" ? data.time.created : seq;
  db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, opts.session ?? sessionID ?? "s1", type, seq, created, data.time?.completed ?? created, JSON.stringify(data));
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
    "INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, 't', '2.1.2', ?, ?)",
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
