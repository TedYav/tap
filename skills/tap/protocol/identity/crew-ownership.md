# Crew ownership and native capture

**Durable crew parentage.** New crews persist `crew_owner` (the parent's handle)
and `crew_owner_instance` (its retained seat instance). Bootstrap registration
pins the unique current non-crew row for the observed caller pane under registry
custody, on the same session and server generation; it never walks up from a
crew caller. Direct new `register --crew` without that parent evidence refuses
and points to `crew add`. SessionStart preserves the link rather than deriving
one from the shared session name. When add replaces a dead residue row in a
new pane, it pins the current caller's owner link, mints a fresh crew instance,
and removes the old native identity, attestation, quarantine and attribution.
The new capture starts at `not_started`; same-pane registration preserves the
existing link.

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

Rearm, relaunch and surviving-crew revival require the durable handle and
instance to match the current parent. Every crew present before this addition
is legacy until recreated: a missing link, a wrong handle or a stale parent
instance is never repaired by shared-session inference or a reused handle.
Repair both missing and wrong links explicitly with `tap crew remove <crew>`
then `tap crew add ...` from the intended parent. Named removal does not consult
the link. Teardown and refresh selection keep their existing behavior. This
addition enables no crew resume or unexpected-loss retention.
