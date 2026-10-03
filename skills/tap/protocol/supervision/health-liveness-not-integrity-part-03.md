# Health (liveness, not integrity) — source part 3 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0106 start=709710 end=711037 sha256=4745493e599fad40bad84eaa5036f39e001ccae3c3977c498df9ad4e81608726 fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
On an OpenCode seat whose turn is active, watch determines turn-state **deterministically from opencode's SQLite DB** (`~/.local/share/opencode/opencode.db`, WAL mode, read-only — tap-n40f): `time.completed IS NULL` on the latest assistant message = in-turn. When the DB confirms an active turn and the pane's body hash (animated spinner collapsed, token counter kept) stays stable for at least `TAP_WATCH_OPENCODE_WEDGE_SECONDS` (default 120), watch sends one advisory `notice` to the armer with `turn_source=db`. If the DB is unreachable or the seat has no `harness_session_id`, the TUI scrape path is the **fallback** (`turn_source=tui-fallback`): the `esc interrupt` busy indicator keys the live-turn check, same hash and threshold. The fallback is never deleted (tiering doctrine). **This is a detector only:** it reports the suspected provider wedge to the armer / goalie / operator, who performs the graduated recovery (interrupt + resubmit, or a fresh session) **manually**. Watch itself never nudges, interrupts, resubmits, or relaunches the wedged seat — no keystroke is ever sent to it. A moving token counter (real progress) or a seat the DB says is idle (turn completed, `finish='stop'`) is excluded; one advisory per wedge episode, on the same latch-and-re-baseline semantics as the context-freeze advisory.

### Dead letters (tap-s1dqn)

A payload is unsettled until a regular-file `.done` or `.cancelled` receipt (or an archive row) exists, so mail withdrawn in place is terminal here exactly as in `tap outstanding`. An unsettled canonical payload is a **dead letter** only on positive evidence, in one of three classes. The bus's own registry must first be complete: it exists and parses with `team.name` equal to the selected (enrolled) team, an object `seats` map whose rows are all objects, and valid `seat_forwardings`; otherwise nothing is a dead letter. The envelope must validate and name its file. The addressed team is `to_team`, or the local team when it is empty.
- **seat_gone** (tap-s1dqn): the addressed team's registry has that same completeness and `to` has no row; no live forwarding edge has `to` as its source, and no seat lists `to` in `adopted_handles`. For a foreign `to_team`, the registry consulted is the one at that team's enrolled `registry_location`, never a same-named seat in any other team.
- **team_gone** (tap-sr6da): `to_team` names another team, and the live machine index shows that team not enrolled (no key), `state: historical`, or nothing at its absolute `registry_location` (ENOENT, tap cancel's tap-fcd3 rule).
- **instance_retired** (tap-sr6da): the row is present, but the payload carries `reply: expected` (any other value, including an unsanctioned one, stays live), carries a `recipient_instance` that differs from the row's non-empty `instance`, has no `to_adopted_from`, no forwarding edge or adoption grant carries `to`, and no spool sidecar exists for the id (spool residency is the courier's own instance-retirement tier). A settle-only note to a predecessor instance is live: its successor settles it with `tap read` (`reason: instance_retired` on the `.done`).

Dead letters raise no attention and are omitted from `unsettled`; the report carries `dead_letters: {count, action}` (JSON, present only when the count is nonzero) and one text line with the count and `tap cancel --dead-letters --dry-run`. Everything uncertain stays an `unsettled-payload` attention item. That includes:
- no bus registry, or a partial one;
- an absent, invalid or unreadable machine index;
- a bare, malformed or relative-path enrollment entry (a `root` that is not an absolute string, or a non-string `registry_location` or `state`);
- anything but a regular file at a foreign `registry_location`, or a foreign registry that fails completeness;
- a manual relay (`cross_worktree: true` with no `to_team`), whose addressee's team is unknowable;
- a present row whose instance cannot be compared.
