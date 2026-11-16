# Optional tmux configuration

```text
tap keybinding install [--key <k>] [--tap <abs-path>] [--dry-run] | remove [--dry-run] | status [--json]   # owns ~/.config/tap/tmux.conf (prefix C-g -> run-shell -> display-popup running tap pick) plus exactly one marked source-file line in the user's tmux.conf; refuses a key already bound in the user's config (sourced files included) or the running server; remove deletes only TAP's exact line and file and unbinds only TAP's live binding; needs tmux >= 3.2; exit 0 (status included, installed or not) / 1 refusal
```

`tap keybinding install` and `tap tmux-defaults install` preserve symlinks in
user configuration paths and edit their real targets. Dry runs and install
receipts disclose the target (`user_conf_target` in JSON).

The defaults source line precedes the user's settings. On a running server,
a changed install loads TAP's file and re-sources the user config only when it
contains plain option and binding commands and passes a parse-only check.
Plugins, append or toggle settings, unknown options, sourced files, conditional commands and other syntax require a manual
reload; install leaves live settings untouched and prints the user-config
reload command. A dry run previews that same choice as `live_plan`. Install
reports `live_changed` options set by TAP and `live_reasserted` options changed
back by the user config. The managed history default preserves a larger live
limit. Removal cannot undo already loaded values.

When TAP starts a server it sets `exit-empty off`, keeping the server alive
after its last session closes; existing servers retain their value. Doctor
reports an observed `off` value as informational, without recommending repair.
