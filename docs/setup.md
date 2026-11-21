# Install TAP for a human

You are helping a human install TAP, a way for agents on one machine to talk to
each other. TAP is beta software; expect bugs. Send bug reports and feature
requests to [GitHub Issues](https://github.com/TedYav/tap/issues), or email
ted@tedyav.com if you cannot use Issues. Start in the folder where the human wants to work.
Inside Git, TAP enrolls the repository root even if you start in a subdirectory.
Outside Git, it enrolls the starting folder, which can be empty.
Keep the permanent TAP clone outside that project.

The human chooses permissions and a few defaults, approves a preview, then
reopens their Claude Code or Codex chat in tmux for the first reply. Some
agents group the questions. Terminal checks come afterward.

1. Check `git --version`. If Git is missing, show the human the install command
   for their platform and ask before installing. Have them handle any terminal
   or administrator prompt, then check the version again.
   Use `https://github.com/TedYav/tap.git` unless they supplied another address.
   Choose a permanent directory outside the project (normally `tap` in their
   home directory). If the destination is new, clone once. If it already
   exists, check that it is the primary checkout of the requested repository:
   run the checks **in the destination**. Its `git rev-parse --show-toplevel`
   must name that directory, its Git directory and common directory must match,
   and `git remote get-url origin` must identify the requested repository.
   Run `git fetch origin main`. On a clean `main` with no commits of its own
   beyond `origin/main`, update with `git merge --ff-only origin/main`. On a mismatch,
   leave the directory alone and ask where to put the clone. Show any clone
   or fetch error to the human and stop.
2. Read `<clone>/docs/AGENT-SETUP.md` in that verified checkout. Carry its
   absolute path into the runbook so you use the same clone throughout.
3. Finish only after one agent shows the human the other's actual reply. Name
   any startup prompt that needs the human. A queued message is not success.
4. When done, open `<clone>/docs/cheatsheet.html` for the human.

The human stays in control of:

- Account sign-in. Do not sign in for them.
- Permission mode. Recommend auto, the default; name bypass as the alternative
  and say in one sentence what it grants; apply bypass only after they say yes.
- Harness wiring. Show which CLIs the installer will change. The pasted prompt
  covers Claude Code and Codex. Wait for the human’s OK if the install would
  wire or update any other CLI.
- Machine config and shell startup files. Preserve existing settings; show a
  dry run in its own message and apply it only after they say yes.
- Trust and permission dialogs. Answer one for them only when it is on the list
  they approved for the automatic test in the runbook.
