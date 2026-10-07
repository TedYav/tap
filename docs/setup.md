# Install TAP for a human

You are helping a human install TAP, a way for agents on one machine to talk to
each other. It is a pre-release preview. Start your session outside any TAP
clone: a clone's contributor instructions are for changing TAP itself, not for
installing it.

1. Clone over HTTPS into a permanent directory the human will keep:
   `git clone https://github.com/TedYav/tap.git`. The installed command points
   into this clone, so do not use a temporary or disposable directory. If
   cloning fails with a permission error, STOP and tell the human to ask the
   maintainer for access. Do not retry with other URLs.
2. Read `<clone>/docs/AGENT-SETUP.md` and follow that installation runbook.
3. Finish only after one agent shows the human the other's actual reply. Name
   any startup prompt that needs the human. A queued message is not success.
4. When done, open `<clone>/docs/cheatsheet.html` for the human.

The human stays in control of:

- Account sign-in and trust prompts. Do not sign in for them.
- Permission mode. Ask before enabling permission bypass.
- Their existing config and shell startup files. Preserve them; show any change
  as a preview and apply it only after they say yes.
