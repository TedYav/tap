# Trust model

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0026 start=158555 end=159464 sha256=ba71e267f894a6869a31c210e1670776f820b7c46161a25af8964c3d4b7baf69 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Trust model

TAP teams assume **same-human, same-local-folder trust**: all registered agents are operated by the same person inside the same git worktree or folder, so there is no authentication layer on the bus. The register-time scope check (`tap register` rejects a pane whose `pane_current_path` is outside the caller's git worktree root, unless `--override-worktree` is passed) enforces the local-scope precondition when the caller is in a git worktree. When the caller is not in git, register anchors the bus to the target pane's current folder; a non-git folder enrolls in the machine index only when its owner consented through `tap init` or a first launch. Cross-worktree relay is an explicit opt-in that relaxes the scope for a single send but does not extend the trust model — the bus and receipts still live on the sender's bus, and the recipient resolves the qualified id with `tap read` or `tap reply`; an absolute payload path remains a fallback.

