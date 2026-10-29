# Reviving a seat beside its surviving crews (tap-9rrat)

Crew windows can keep a parent's session alive after its harness exits. The
launcher classifies that session `seat-gone`: it counts only a pane of the
seat's own harness that is not a registered crew pane. Launch's chooser offers
resume; without a terminal it names `tap session resume <handle>`.

Resume revives the retained seat into a new window and stops nothing. It requires
the seat's exact native conversation; otherwise `no_exact_resume_identity`
leaves the crews running. Failed revival removes only the window it created.
The owner instance remains unchanged, so linked crews keep their owner authority
without acquiring a new process lifetime.

Before revival, the launcher snapshots linked live crews and fences any exact
pre-upgrade helper. Changed crew identity or an unverifiable helper refuses;
it never infers ownership from a shared session. Legacy crews without a matching
durable link need explicit removal and recreation from the intended parent.

See [crew ownership and independent lifetime](../identity/crew-ownership.md).
