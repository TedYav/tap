# Antigravity conversation capture

TAP installs `tap-session-identity` hooks for `PreInvocation` and
`PostInvocation` in `~/.gemini/config/hooks.json`. Capture requires the native
`ANTIGRAVITY_CONVERSATION_ID` to match stdin `conversationId`.

Subagents fire the same hooks in their parent's pane. Before accepting a new id,
TAP reads only that id's row in `conversation_summaries.db`: it must have
`nesting_depth = 0` and an empty `parent_conversation_id`. Missing, ambiguous,
malformed or unreadable lineage refuses capture. **The native store may refuse
an id; it never supplies one.** There is no workspace/time search for candidates.
The connection is read-only with a 50 ms busy timeout; `TAP_GEMINI_HOME`, then
`GEMINI_HOME`, then `~/.gemini` selects its home.

In agy 1.4.5, a fresh root's summary can be absent at `PreInvocation` but is
present at its first `PostInvocation`. That second event captures a simple
one-call turn. Existing `--conversation` resumes and in-app `/resume` switches
can bind before their first model call. An idle new seat has no id until its
first turn. `SessionStart` alone misses exact resumes.

Validated launch evidence selects the launching team; otherwise `workspacePaths`
selects an enrolled root. The hooks directory is never an enrollment fallback.
The existing `tap in` path records environment attribution, retains duplicate
ownership and initial resume-mismatch quarantine, consumes answered resume
expectations, and handles later same-pane root conversation changes.

An accepted unchanged id skips the database. With no pending launch, clear or
capture expectation, it also skips registration and its locks. Errors leave the
model turn running and retry on a later hook: registration has a 2.5-second
bound and 200 ms lock waits; agy bounds each hook at four seconds. A failed
registration writes a brief stderr diagnostic without payload or environment data. Each hook
returns `{}` without adding conversation context.

Installation preserves unrelated hooks and symlinked configuration files. The
manifest records the identity namespace separately. For teams with agy seats,
`tap doctor` diagnoses missing/disabled/stale hook wiring and unreadable or
schema-drifted native stores. Child refusals are silent.

The harness contract is documented in [Antigravity lifecycle hooks](https://www.agy.dev/docs/hooks/).
