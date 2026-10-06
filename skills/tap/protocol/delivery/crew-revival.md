# Reviving a seat beside its surviving crews (tap-9rrat)

A crew outlives its parent only when its helper is gone too, as after a stray
kill. The parent's tmux session then survives, held by crew windows with no pane
running the seat's harness. The launcher classifies that session `seat-gone`: a
seat-aware classification counts only a pane of the seat's own harness that is
not a registered crew pane. Launch's chooser reports it ("<harness> exited;
other windows still hold the session") and its `[r]` resumes; without a
terminal, launch exits 2 naming `tap session resume <handle>`.

Resume revives a `seat-gone` seat into that session in a new window and stops
nothing. It requires the seat's recorded native id to resolve as its exact
resume target; otherwise it refuses `no_exact_resume_identity` and the crews
keep running. A failed revival, synchronous or through the pane-died callback,
removes only the window it created.

After the revival binds, each crew snapshotted before the launch moves to the
revived harness generation. This is the one continuation of a crew past its
original parent generation, and it refuses unless the seat row keeps the same
instance, the crew's row, pane and process are unchanged, the binding's original
parent process is provably gone, and its old helper is gone or is stopped
(TERM, then KILL, of that exact process generation) and confirmed gone. The new
token voids the old helper's guarded stop. Only this resume path reclaims: a
fresh replacement stops the session instead, and an unreadable registry or a
crew that changed since the snapshot refuses. A refused reclaim leaves the crew
running unsupervised and says so.

The base crew lifetime contract is in
[crew process lifetime](./cli-surface-the-whole-thing-part-03.md).
