# CLI surface (the whole thing) — source part 1 of 11

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0075 start=482991 end=483437 sha256=4b205a9ce37df011f882fd9e10ed667ad607d43c17c0aaa15515b80ddf7d0631 fragment=1/11 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## CLI surface (the whole thing)

**Registry authority:** With the global `schema: "0.20"` marker live, every current lifecycle verb resolves the enrolled root's acting team registry and refuses before mutation when that authority is invalid or unreachable. No current verb falls back to the bus mirror or archived launcher journal. Retired lifecycle spellings are absent from dispatch and help rather than retained as deferred implementations.

**Help before effects:** `--help` and reserved `-h` before a `--` separator
print the command page on stdout and exit 0 before onboarding, journaling,
refusal recording or command effects. The public wrapper suppresses Bun
startup-cache writes for help. A known family subcommand selects its page;
resource operands are ignored when selecting a page. A positional `help`
remains data wherever it could name a resource. Launch retains its more
specific argument-ownership rules below.
Renamed `roster` and `reset` retain their exact help exceptions; all other
argv reaches their documented refusal.

**Launch help:** `tap launch` and `tap session launch` recognize `-h`/`--help`
before onboarding, public debug journaling or launch effects. Help uses the
launch grammar: option values remain values; explicit `--` and the existing
implicit harness tail retain their arguments. Thus `tap launch codex --help`
shows TAP help, while `tap launch codex -- --help` requests harness help.
Help-looking launch argv suppresses Bun startup-cache writes before native
routing decides ownership. Both spellings share the dedicated launch page;
the short overview leads with launch, attach and team, with detailed help on demand.

**Detached launch/resume receipts:** launch success does not prove attachment.
Receipts name `tap attach <team/handle>` using the registered seat address even
when its tmux session name differs. No-terminal and foreground-ownership outcomes
request a foreground terminal; an in-tmux caller gets a terminal handoff or
Ctrl-b d detachment hint. Attachment authority and nesting refusals are unchanged.
