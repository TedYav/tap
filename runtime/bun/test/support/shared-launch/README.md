# Shared launch pre-cut oracle

`precut-source.tar.gz` is test evidence from commit `85ff0defcac121a8a98c11a492363a528976f470`, covering `skills/tap/scripts`, `runtime/bun/src`, and `hooks`. SHA-256: `ea55dd6da9be1b81850a5718885c8959a20ff9b8b8b997ad4d75478826499214`.

The isolated test runner extracts it beneath its scratch root. It is never imported by production. Keeping the original source and dependencies prevents a retired Python oracle from becoming a wrapper around the candidate it is supposed to challenge. Expected differences are the explicitly authorized identity-bound failure cleanup, pinned-store refusal, cancellation handling, and pre-stop recovery-backup policy.

Do not regenerate it from the candidate. Its source is the commit above; generation uses `git archive --format=tar` over the three paths (tar SHA-256 `7e484d40057f90be72cadcb01d85c78c766135acf528dc2dce683aa3a771cbd6`), then a same-length byte map over the tar stream that neutralizes private paths and names without moving any size, offset, mode, modification time or member (three member names that embed a real seat handle are renamed in the same pass, with their header checksums recomputed; two terminal-capture members also had a seat handle rewritten in place at the same length) (tar SHA-256 `18ba3461cf6d8b371f979d34a23b80ab173cd0050d1169d7e0f02086e74eb6fa`), then `gzip -n -9` (Apple gzip 479). The map is kept with the export pipeline, which is not part of the published tree. The byte archive is retained so CI does not depend on a full Git history or network fetch.

## Migrated controls

Python selectors, cohort reporting and attach tests stop at the whole `_native_launch` boundary. Moved mutation controls run against the native owner. Epoch tests keep their original cases but supply fake tmux frames through the real bridge, so they no longer mock a Python reader that the worker cannot call.

| Control family | Current executable controls |
| --- | --- |
| All callers and harnesses | `shared-launch-transaction.test.ts`: pinned pre-cut caller matrix and six real fresh bridge launches |
| Claim/recipe and capture modes | claim recipe/new/exact/picker/opencode/family-change/legacy matrix; full DTO in `test_launch_callers.py`; pending expiry/token and malformed write tests in `launcher-l1.test.ts` |
| Incumbent stop authorization | destructive-target pinned truth table, chosen-name fresh exception matrix; original cases in `test_server_epoch.py` use actual native observation |
| Lossless displaced data / failed stops | real backup→restore; failed incumbent stop for fresh and restart; post-stop failure restoration with wide integer/float and instance |
| Locks and signals | unbounded legacy waits beyond native limits; stop/readiness lock probes from a separate process; EOF/SIGKILL holder release; SIGTERM→EOF/SIGINT during unwind; actual PTY attach-after-release |
| Callback and hook order | standalone delayed worker after coordinator exit, token/instance/ready/vessel refusal matrix; failure hook and bound row observed before first harness instruction |
| Readiness | actual late Codex zero-result screen; native consecutive-frame and retained replacement frame matrix; actual process/executable checks in launcher-l1 |
| Fork refusal | native fork-retry table + real tmux started-child discriminator in launcher-fork-retry smoke |
| Cursor mint | real bridge fake-Cursor success, skip, malformed, failed/unavailable, timeout, cancellation; clear wipe→mint→replacement |
| Retained public tails | Python whole-transaction DTO/cohort/nonzero+exception/interrupt/attach controls; retained selector and relaunch tests |
| Seat up | real codex/claude down/up with live/absent server; six-family pinned caller; row/identity/recipe/registry/live-vessel refusal matrix; literal Python entry test |
