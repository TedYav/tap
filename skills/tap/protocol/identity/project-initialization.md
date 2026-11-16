# Project initialization

Normative TAP v0.23 behavior for explicit `tap init`. Enrollment and first-launch
boundaries remain in [initial-launch setup](./initial-launch-fork-refusal-part-02.md).

Before a new enrollment, init refuses `preexisting_tap_state` when an unowned
root already contains a populated canonical team registry or a non-empty bus.
An empty bootstrap skeleton is allowed for retry after interrupted or failed
first initialization: an ordinary unshared authority marker and empty
`payloads/` and `receipts/` directories. Any other bus entry remains refused.
This applies on both fresh and configured machines, including implicit launch
and previews. The refusal names existing paths and asks the operator to inspect
and move the state aside; `--yes` does not bypass it. It neither adopts nor
removes those files. A root already enrolled in this machine's index retains its
normal registry and mail behavior. This uses the existing enrollment boundary,
not a new provenance format or sender-authentication claim.

Inspection does not follow state-directory links and bounds its path sample.
Unsafe bootstrap ignore files are refused too. Bus bootstrap creates its ignore
and authority files exclusively with no-follow opens, preserving existing
ordinary files and refusing links or shared files instead of writing through them.

Public `tap init --dry-run` resolves the same enrollment, ignore, instruction and
accepted folder-trust targets without writing or acquiring locks. It assumes
acceptance of terminal offers and outside-Git consent; without a terminal,
folder-trust targets require `--yes`. `--no-instructions` and
`--no-trust-folders` omit those targets. The preview names its limits: it cannot
predict concurrent edits or later write/lock failures. Internal
`--for-launch --dry-run` keeps its launcher wire. Explicit init disables Bun's
startup cache and pre-dispatch diagnostic recording so these cannot write before
its receipt boundary. Bootstrap defers bus maintenance to later bus activity,
rather than starting a worker that could write after init prints its receipt.

Receipts list actual completed changes after success or partial failure, or no
changes; dry-run lists planned changes. An unchanged file's content is not a
modification. JSON adds `changes:[{path,action}]`, where `action` is `created` or
`modified`, `undo:[string]`, and `dry_run`. Project undo is manual: remove the
case-insensitive `<!-- tap:begin -->` through `<!-- tap:end -->` block added by
this run and only its added `.tap/` ignore line, preserving other content. Init
has no `--undo`; uninstall does not remove these project edits.

Folder-trust consent and receipts name each installed harness, resolved config
path and native setting: Codex `projects[folder].trust_level = "trusted"`, Claude
`projects[folder].hasTrustDialogAccepted = true`, Antigravity
`trustedWorkspaces` includes the folder, and Cursor `.workspace-trusted` names the
folder with `trustMethod = "cli-flag"`. Enter and `--yes` retain their affirmative
behavior, including scripted `--yes`. Each grants the harness's normal folder
trust and any project settings/hooks tied to it; separate approval dialogs and
permission modes remain untouched. Receipt grants include only successful or
already-present trust; partial failures name successful paths too. Dry-run trust
status is `would_trust` rather than claiming an applied grant.

