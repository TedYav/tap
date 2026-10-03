# Codex 0.160 status footer without a Context item (tap-21bdj)

`idle-staged-default.txt` is a plain `tmux capture-pane` of a Codex 0.160.0 seat (200 columns, clean scratch HOME, `permissions = "auto"`) holding one staged TAP ask sentinel, taken by the first-hour lane D rerun on source `3f260fc` (its `21-south-staged.txt`). The only edit is the scratch workspace name in the status row and banner, `~/project-auto3` to `~/project`; seat names, row geometry, the status row `GPT-6.1-Sol default · ~/project · Run identity check` and the right-aligned `⚠ 1 warning · f2 to view` row are as captured.

Before the fix the courier's Codex footer grammar knew only `<model> <effort> · Context N% left …`, so this status row was read as composer input. AUTO's strict reader then saw the sentinel plus two extra rows (`changed`), `enterReady` withheld Enter (`enter_count 0`, `verify-result unverified`), and `tap nudge` refused "expected staged sentinel changed" for the same reason.
