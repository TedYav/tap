# Crew ownership and native capture

**Durable crew parentage.** New crews persist `crew_owner` (the parent's handle)
and `crew_owner_instance` (its retained seat instance). Bootstrap registration
pins the unique current non-crew row for the observed caller pane under registry
custody, on the same session and server generation; it never walks up from a
crew caller. Direct new `register --crew` without that parent evidence refuses
and points to `crew add`. SessionStart preserves the link rather than deriving
one from the shared session name. A retained crew name refuses a new add,
even when stopped; resume it or explicitly remove it first. Same-pane
registration preserves the existing owner link and native conversation.

Owner handle and retained instance select the family across sessions and server
restarts. Pane, process, epoch and socket proofs still guard every live effect.
Bootstrap registration requires the caller's observed socket and an active,
non-poll parent. Legacy rows without a durable link may be selected for explicit
teardown only when their session and server generation have one unique owner.

`crew_identity_capture` records the latest native capture observation, with
`at` and `decision`: `not_started` during shell bootstrap, `accepted` with
`observed_harness_session_id`, `quarantined` with the observed id and `reason`,
or `unavailable` with a concrete `reason`. Crew add attempts registration for up
to five seconds after launch (each child call has a two-second timeout); the
last in-flight call and bounded outcome-write locks can extend that deadline.
It strips the parent's identity environment and pins the crew instance and pane.
Only the existing registration identity checks may accept an id. Native
SessionStart may later supersede an unavailable observation. This field records
an observation, not a promise that the conversation remains resumable. If the
registry becomes unreadable or cannot accept the final write, add reports that
failure on stderr; `not_started` can remain until a later registration succeeds.
Conversely, a post-add capture-only probe with no native identity preserves an
accepted or quarantined hook result on the same crew instance, pane and harness.
Missing evidence from that probe does not undo an authoritative observation.

## Native conversation adoption

`tap crew add <preset|harness> <name> --resume <native-id>` creates a crew on one
existing conversation. Its explicit id must be non-empty and exact. The native
artifact is checked before pane creation against the launch child's cwd and
effective environment, using the same store readers as the ask receipt. The
original cwd and preset/environment matter; another native store is not searched
as a fallback. A missing or unverifiable artifact refuses
`no_exact_resume_identity`. There is no picker, latest-session or fresh fallback.

The existing machine-wide registration owner census refuses
`duplicate_identity_owner` before creation and rechecks under recipe-write
custody. Before the harness starts, the crew row records the selected
`harness_session_id` and existing `identity_capture` fields with mode
`exact_resume` and `expected_harness_session_id`. SessionStart accepts only that
id; mismatch and duplicate-owner observations retain the normal quarantine
behavior. The selected id is an expectation until native capture accepts it.
Hermes supports exact native resume but has no native SessionStart hook, so its
capture may remain unavailable and it cannot receive an automatic first assignment.

The selector is not part of the replayable recipe. An explicit fresh relaunch
still starts fresh. Harness-tail conversation selectors refuse, except that fresh
OpenCode strips them. Exact adoption also refuses preset/policy selectors that
could select another conversation.
Native resume preserves the tuning axes the harness restores itself, while
permissions remain those selected by crew launch policy. Adoption removes the
inherited `TAP_STATELESS` marker so this new crew can bind normally.

Relaunch and surviving-crew revival require the durable handle and instance to
match the retained parent. A missing link, wrong handle or stale instance is
never repaired by shared-session inference or a reused handle. Repair explicitly
with `tap crew remove <crew>`, then `tap crew add ... --resume <native-id>` from
the intended parent. Named removal does not require a surviving owner row.
Plain `out <parent>` leaves crew processes running but removes owner authority;
continuation cannot infer that a new row with the same handle is the old owner.

## Independent lifetime and retention

Natural parent exit, crash or process replacement leaves crews running. A stopped
crew retains its instance, owner link, launch recipe and native id, including
through `refresh --hard`. Roster and doctor report its observed offline state;
they do not reap it because its parent is offline. Ordinary send queue behavior
still applies. Explicit crew removal and parent/team shutdown retain their
obligation gates and stop the selected family's exact processes across vessels.

Session-wide restart or fresh replacement refuses `crew_session_shared` while
a registered crew occupies that session, including legacy/unlinked crews and
with `--force`. The shared transaction checks this before reservation and again
under teardown custody. Use `tap session relaunch <team/owner>` for an in-place
parent process replacement. Crews are not moved automatically to another vessel.

New crews start no parent-death helper. Touching a live pre-upgrade crew through
refresh, relaunch, owner revival or removal fences its exact pane-local helper
token before stopping that recorded helper generation. The old binding remains
as evidence. An unverifiable transition refuses with an inspection action. Refresh retains
that crew with a warning and continues its siblings; explicit lifecycle effects
still refuse.
Untouched pre-upgrade helpers retain their old lifetime until fenced; installation
does not rewrite registries or promise immediate conversion. `crew rearm` is a
non-mutating tombstone.

## Resuming retained crews

`tap crew resume <crew|team/crew>` continues the exact recorded native id from
its saved recipe. `--owner <seat|team/seat>` snapshots all linked crews of one
owner; repeat it for several owners in the same resolved team. Missing native
artifacts, recipes, owner rows or matching owner instances refuse per crew.
An unchanged live crew with accepted matching capture is an idempotent no-op.
`crew relaunch <crew> --resume` explicitly replaces a live process on that same
conversation; plain relaunch stays fresh.

A live owner places the resumed crew in its current session. An offline retained
owner gets one dedicated session, identified by that owner instance. Positive
boot loss permits recovery on a new socket; unknown evidence never proves loss.
A retained sibling-worktree cwd must belong to the same Git repository and must
not select another enrolled team. Existing launch tokens pin SessionStart to
the chosen registry, and become launch witnesses after accepted capture.

Resume uses existing reset/registry custody and one operation lock per crew.
Authority, row and owner instance are rechecked before effects; native ownership
is checked before launch and again by registration. The exact native expectation
is published before respawn. A timed-out or interrupted possible effect keeps
its row and reports `started_unverified`; it is never silently retried or killed.

Bulk runs sequentially with a 30-second deadline per crew and continues after
individual failures. Human receipts stream as each crew finishes; JSON emits
one `{ok, team, results}` value. Results name `resumed`, `already_live`,
`would_resume`, `refused`, `started_unverified` or `untouched`. SIGINT/SIGTERM
stop future launches and report untouched rows (exits 130/143). Other partial
runs exit 1; all-ready or empty cohorts exit 0. `--dry-run` validates and previews
without creating a pane or changing a row. Hermes can start an exact conversation
but lack accepted native capture; that remains an unverified start.

## Worktree anchoring

The caller's current registered pane selects the team. If the crew cwd has no
enrollment, its preflight may use the existing pane anchor: a canonical
session, a unique current row, and the same Git repository. This changes the
selected registry, not the crew cwd. A cwd enrolled to a different team still
refuses, as does a caller pin naming another team's registry. A missed anchor
names the required pane and repository evidence; it does not create a new bus.

## Shutdown obligations

`crew shutdown`, `crew remove` and `out <crew>` leave outbound settle-only notes
and replies on the bus without waiting for recipients to read them. Receipts
list recorded delivery as delivered, unread by the recipient. A payload only
placed is labelled placed; a queued message is labelled queued, with delivery
unconfirmed. Queued messages retain the transport's expiry rules: after sender
retirement, escalation can end retries and promote the body to canonical
storage; autosettle expiry can also mark delivery cancelled. Content remains
readable with `tap read <id>`. Ordinary promoted notes remain in recipient poll;
cancelled notes do not promise another doorbell or poll entry.

These notices use stderr with JSON output. Unanswered inbound asks and outbound
asks awaiting a reply continue to block; delivered inbound notes still require
`tap read`. Queued inbound mail remains sender-owned under the existing rule.

## Creation and first assignment

`crew add --assign <brief-file>` reuses creation's bounded native-capture wait.
Before dispatch, it verifies the created handle, instance, pane and parent link,
requested harness, model and preset, and an accepted capture matching the row's
native session id. Send rechecks that row under its authorization and publication
custody; a replacement cannot receive the original crew's assignment. The model
check verifies the launch recipe, not which backend later answers.

The brief must be a readable regular file, checked before launch. It is sent
unchanged as `kind: order`, `reply: expected`; `--reply-to <handle|team/handle>`
selects a durable answer destination and requires `--assign`. Include `tap whoami`
and the expected handle in the brief's first-receipt instructions. A separate
identity-only exchange remains optional for sensitive briefs.

Reply destinations are checked for address grammar and current deliverability
before a window is created; send checks them again before publication. The
capture deadline is not a startup-time guarantee for any harness family. If
capture completes later, verify the existing crew and use `tap assign <crew>
-f <brief-file> [--reply-to <seat>]` after its capture is accepted.

An unverified row receives no assignment. Creation is not rolled back when
identity verification or assignment fails: the error names the started crew.
An accepted assignment has its own transport receipt; queued means accepted,
not processed. A failed or unconfirmed send retains the normal send exit and
pending-message evidence. Inspect the existing crew and its outstanding message
before retrying `tap assign`; do not retry `crew add` to recover an assignment.
