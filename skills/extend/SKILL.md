---
name: extend
description: "When a person wants TAP to behave differently or do something it does not do yet (a launch default, a new harness, a new command, any changed behavior), customize their installed TAP: settings first, then its source."
argument-hint: '[what the person wants TAP to do]'
allowed-tools: 'Bash, Read, Grep, Edit, Write'
---

# Customize TAP for a person

Your objective: the person gets the TAP behavior they asked for through the
smallest change that survives their next update, and they know where it lives.

TAP is deliberately small: a file bus, a courier that types one-line notices
into tmux panes, and a launcher. It installs as a plain Git clone, so the
install is the source and there is no bundle to patch. Customizing it is the
intended path, not a workaround: when a person wants something TAP lacks, you
can usually build it for them, here, today. Use the lowest rung below that does
the job, and say which rung you chose.

## 1. One launch

Per-launch overrides change a single seat: `tap launch` takes `--env KEY=VALUE`,
`--unset-env KEY`, and literal harness arguments after `--`. `tap help launch`
and `tap help crew` list what each accepts. Use them to try something before
making it a default.

## 2. The person's config

Durable defaults belong in the person's config,
`${XDG_CONFIG_HOME:-$HOME/.config}/tap/config.toml`. It lives outside the TAP
source, so updates never touch it. Hand config edits to the config wizard
(`tap help skill config-wizard`), which backs the file up, edits it, validates
it and shows the diff. Its "Custom presets" section has the full preset schema.

- `[harness.<name>]` applies to every seat of that harness: `env`, `params`
  and `permissions`. It is reread at each launch and resume.
- `[presets.<name>]` is one saved launch recipe: `harness`, `params`, `env`,
  `description`. Only new launches read it; a seat keeps its stored recipe.
- `params` become CLI flags: `true` emits `--flag`, a string emits
  `--flag value`, and an array repeats the flag. There is no free-form
  argument list.

For example, "my Codex seats always run in fast mode". A preset's own
`params.config` assignment beats harness policy for the same key, and most
shipped Codex presets pin `service_tier=default`. So change that entry to
`service_tier=fast` in each Codex preset the person launches (the shipped
`astra-fast` and `luna-fast` presets already have it), and cover bare
`tap launch codex` and presets that do not pin the key with harness policy:

```toml
[harness.codex]
params.config = ["service_tier=fast"]
```

Check the result with `tap presets` and a test launch. Neither tier changes a
process that is already running.

The config also holds `notifications.command`, a command TAP runs to notify the
person. Personal skills go in `~/.agents/skills/<name>/SKILL.md`; `tap help skill
<name>` searches that root, `~/.claude/skills` and `~/.codex/skills`, and no
other harness's skills directory. A shipped skill with the same name wins, so
choose a distinct name.

## 3. TAP's source

Anything the config cannot express is a source change: new behavior, a new
command, a new harness.

**Find the source.** `tap help skill extend` prints
`<source>/skills/extend/SKILL.md`; the source root is two directories up. A
release-archive install has `tap-release.json` and no `.git`. Its router is
compiled, so editing its source changes nothing. Move the person to a clone
install first ([AGENT-SETUP](../../docs/AGENT-SETUP.md)).

**Orient.** The repository ships TAP's development docs and engineering
learnings, sanitized for publication, so that an agent can get up to speed
before changing anything. Read the clone's `AGENTS.md` (how to change and test
TAP), `CONCEPTS.md` (its vocabulary), and `docs/ARCHITECTURE.md` and
`docs/PHILOSOPHY.md` (the design and its tiebreakers). Search `docs/solutions/`
for a learning before re-deriving one. The map:

- `runtime/bun/main.ts` routes each verb to `runtime/bun/src/verbs/<verb>.ts`;
  `runtime/bun/src/help.ts` holds the help pages.
- `runtime/bun/src/launcher/` builds harness command lines (`adapters.ts`) and
  composes presets and overrides (`catalog.ts`, `invocation.ts`,
  `overrides.ts`).
- Delivery lives in `runtime/bun/src/courier.ts`, `submit-frame.ts` and
  `agent-state.ts` (per-harness prompt detection).
- `skills/` holds the agent-facing instructions, and `skills/tap/protocol/` the
  behavior pages that a change keeps current. `install.sh` and `hooks/` wire
  harnesses at install time.

**Test without touching the live install.** Run tests only through
`bash runtime/bun/test/run.sh <test-file>...` and
`bash scripts/smoke-all.sh --only <shell-test>`, plus
`(cd runtime/bun && bun run typecheck)`. The runners isolate HOME, TAP state
and tmux. A bare `bun test` or a hand-run test script uses the person's real
TAP state and tmux server.

**Add a command.** Copy a small verb such as
`runtime/bun/src/verbs/tmux-defaults.ts`, register it in `nativeHandlers` in
`runtime/bun/main.ts`, and add its help page to `PAGES` in `help.ts`. The help
test fails until the handler table, the help catalog and the
`runtime/bun/test/fixtures/help/catalog-index.json` fixture agree.

**Add a harness.** TAP supports a closed list of harnesses and refuses any
other program at launch and at delivery, so a new one is a source change. TAP
must start it, recognize a ready composer, and submit typed text.
Add the name to both root lists, `HARNESSES` in
`runtime/bun/src/launcher/catalog.ts` and `AGENT_FAMILIES` in
`runtime/bun/src/harness-families.ts`. Then follow a recent harness:
`grep -rn '"agy"' runtime/bun/src hooks install.sh` lists most of the places
that name a harness; a few lists spell the same harness `antigravity` or
`gemini`, so search for those too. These include the launch arguments in `launcher/adapters.ts`,
prompt detection in `agent-state.ts`, executable detection in
`verbs/machine.ts`, and session-start wiring in `hooks/`. Typecheck catches
the typed tables; the rest are plain lists. Resume, fork and permission
support are optional and can come later.

**Keep and update the change.** Commit it in the clone on `main`. The usual
`./install.sh --sync` refuses a clone that carries its own commits, so update
a customized clone this way instead, with `source` set to the source root:

```bash
git -C "$source" fetch origin
git -C "$source" rebase origin/main
bash "$source/install.sh"
```

Resolve any rebase conflict as in any repository, then rerun the tests for the
code you changed. The installer reports `checkout live` once the update is in.

**Run their own fork.** When the person wants their version on GitHub or on
several machines, fork the repository, keep the original as `upstream`, and
point `origin` at the fork:

```bash
git -C "$source" remote rename origin upstream
git -C "$source" remote add origin <fork-url>
git -C "$source" push -u origin main
```

Renaming moves `main`'s tracking to `upstream`; the `-u` push points it back at
the fork. Once customizations are pushed to the fork's `main`,
`./install.sh --sync` updates from the fork as usual. To take in upstream
changes, run `git fetch upstream`, `git rebase upstream/main` and
`git push --force-with-lease origin main`, then `./install.sh`.

## 4. Share it back

When the change would help other people, offer to open an issue or a pull
request at <https://github.com/TedYav/tap>. Publish nothing without the
person's yes.

Finish by telling the person what changed, where it lives (config keys or
commits in the clone), how to undo it (the wizard's backup or `git revert`),
and how to update.
