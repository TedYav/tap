# Install TAP for a human

You are helping a human install TAP, a way for agents on one machine to talk to
each other. It is a pre-release preview. The folder your session runs in becomes
the human's first TAP project, so start in that folder (an empty one is fine)
and keep the TAP clone outside it: a clone's contributor instructions are for
changing TAP itself, not for installing it.

Expect the agent to stop and ask roughly 6 to 8 times: package installs,
permission mode, config, tmux settings and a restart. Picking the recommended
option is fine for a first try.

1. Clone over HTTPS into a permanent directory outside this folder:
   `git clone https://github.com/TedYav/tap.git ~/tap`. If the human gave you a
   different TAP address, use theirs. The installed command points into this
   clone, so do not use a temporary or disposable directory. If cloning fails
   with a permission error or "Repository not found", STOP and tell the human
   to ask the maintainer for access, or to sign in to GitHub in this terminal.
   Do not retry with other URLs.
2. Read `<clone>/docs/AGENT-SETUP.md` and follow that installation runbook.
3. Finish only after one agent shows the human the other's actual reply. Name
   any startup prompt that needs the human. A queued message is not success.
4. When done, open `<clone>/docs/cheatsheet.html` for the human.

The human stays in control of:

- Account sign-in. Do not sign in for them.
- Permission mode. Recommend auto, the default; name bypass as the alternative
  and say in one sentence what it grants; apply bypass only after they say yes.
- Harness wiring. The installer's `--report` output previews the hooks and
  plugins it will wire; the pasted installation prompt is consent to that install.
- Machine config and shell startup files. Preserve existing settings; show a
  dry run in its own message and apply it only after they say yes.
- Trust and permission dialogs. Answer one for them only when it is on the list
  they approved for the automatic test in the runbook.
