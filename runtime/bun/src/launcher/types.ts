// Minimal record the dark argv planner needs. Extra SessionRecord fields exist
// on the Python dataclass; G1 does not read them.

export type SessionRecord = {
  name: string;
  harness: string;
  cwd: string;
  launch_workdir?: string;
  base: string;
  model?: string | null;
  launch_tuning?: import("./tuning").LaunchTuning;
  harness_session_id?: string | null;
  /** `tap launch --resume` only, consumed by the fresh-launch argv: "picker" opens the harness's native
   *  conversation picker and mints no id; "exact" resumes `harness_session_id`. Never stored on a row, so
   *  restart and relaunch replay the bound conversation and never re-offer the picker. */
  launch_resume?: "picker" | "exact" | null;
  /** `tap session fork` only: the source conversation the harness's native fork copies. Never a stored identity. */
  fork_source_session_id?: string | null;
  transcript_path?: string | null;
  quarantined_harness_session_id?: string | null;
  harness_env?: Record<string, string>;
  permissions?: "auto" | "bypass" | null;
  harness_passthrough?: string[];
  passthrough_from_config?: boolean;
  harness_unset_env?: string[];
  harness_tail?: string[];
};

export type Invocation = {
  argv: string[];
  env: Record<string, string>;
  unset_env?: string[];
};

// Shared config readers and launcher doors use the same refusal identity.
export { LauncherError } from "../config-error";

/** Python's `_UNBOUND_RESUME_IDENTITY` sentinel. G1 tests bind explicitly. */
export const UNBOUND_RESUME_IDENTITY: unique symbol = Symbol("unbound_resume_identity");
export type ResumeIdentity = string | null | typeof UNBOUND_RESUME_IDENTITY;
