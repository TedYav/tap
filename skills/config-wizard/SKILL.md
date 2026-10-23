---
name: config-wizard
description: "When a person wants TAP set up or reconfigured (presets, permissions, shell aliases, notifier), walk them through every knob; name one setting for a targeted change."
argument-hint: '[setting or preset]'
allowed-tools: 'Bash, Read, Grep, Edit, Write'
---

# Configure TAP with a person

Your objective: the person ends with a TAP configuration they chose and
understand, and knows they can run `/tap:config-wizard` again whenever they want
to change it instead of editing TOML by hand.

With no argument, run the walkthrough below. With a named setting or preset,
change only that, through the same writer. `--wizard` is the walkthrough's old
spelling and still means it; this is a skill, not a `tap config wizard` verb.

Three things hold throughout:

- **The answers are theirs.** Ask one small question per preference and skip
  what they already told you. In structured dialogs, group independent questions
  up to the harness's question limit and split the rest into later dialogs.
  Give each question its own answer and put its recommended option first.
  Without a structured dialog, ask one question per turn. Wait for an answer
  before asking a question that depends on it. A recommendation or an unanswered
  default is not consent. Never answer a preference for them.
- **One writer.** Every choice the table below represents goes through
  `tap setup --machine --answers`: collect the decisions, preview them with
  `--dry-run`, show the preview, then apply the identical object. Do not script
  replies to the terminal wizard, and do not hand-edit TOML for these choices.
  Never edit a shell startup file yourself; the writer owns one managed block,
  after consent.
- **Check before you suggest.** Read
  [harness-knobs.toml](../tap/config/harness-knobs.toml) before proposing a
  model, effort, context, compaction, permission or resume flag, and verify the
  entry against the installed CLI's help. Never invent a flag or assume a listed
  model is available to this account.

[example-operator-config.toml](../tap/config/example-operator-config.toml) is
one operator's real configuration with private details removed. Read it for how
presets, calibration notes and roles can be written down. It is not a default
and not a recommendation; do not copy it over anyone's config.

## Walkthrough

### 1. Find the harnesses

TAP supports six harnesses. Check which executables are installed:

```bash
for exe in claude codex cursor-agent agy opencode hermes; do command -v "$exe" || echo "not found: $exe"; done
```

| Harness name | Executable | What it is |
|---|---|---|
| `claude` | `claude` | Claude Code |
| `codex` | `codex` | Codex CLI |
| `cursor` | `cursor-agent` | Cursor's agent CLI, not the editor's `cursor` command |
| `agy` | `agy` | Antigravity |
| `opencode` | `opencode` | OpenCode |
| `hermes` | `hermes` | Hermes Agent; no session-start hook, so its launch briefing carries the protocol |

Tell the person what you found and confirm which to configure. Installed is not
signed in, and found is not launch-ready: `tap launch` needs the executable on
the `PATH` of the shell that runs it.

Anything else is unsupported today. Say so plainly and invite them to request
it by opening an issue at <https://github.com/TedYav/tap/issues>, naming the
harness and how it is started.

### 2. Choose how they want to launch

Offer these three, in their words, and let them pick:

- **Common models.** One preset per model for each vendor harness they use, so
  `tap launch opus` or `tap launch sol` starts that model. This is `"simple"`:
  Claude gets `sonnet`, `opus` and `fable`; Codex gets `astra`, `sol` and
  `luna`; Antigravity gets `gemini`; Cursor gets `grok`. OpenCode has no
  starter, because its models depend on the providers the person configured:
  ask which models they like (`opencode models` lists what this installation
  offers) and save each as a custom preset with the edit procedure below.
- **One preset.** A single named catalog preset, for someone who wants to try
  the idea first: `"presets": ["opus"]`. `tap presets` after setup, or
  `skills/tap/config/config.v3.toml` before it, lists the catalog names.
- **Bare.** No presets: `"skip"`. They launch a harness directly with
  `tap launch claude` and choose model and effort inside it. This is the
  shortest route to a first reply, and presets can be added on any later run.

A preset is a saved model-and-tuning combination under a name. Preset names
that already exist in their config are kept exactly as they are.

Catalog model names go stale. Before applying, check each selected preset's
`params.model` against the CLI's own model list, and replace a stale one with a
custom preset rather than saving a name the account cannot launch.

### 3. Choose the effort

Ask only when they chose presets for Claude or Codex:

> Load these at the vendor's default effort, or pin one (low, medium, high,
> xhigh)?

`"starterEffort": "default"` pins nothing in the preset, so the harness chooses,
as it does on a bare launch. Say what that means precisely: the vendor's
shipped default applies unless their own harness settings, environment or a
`[harness.<name>]` policy in the TAP config already set an effort.

Starters arrive with basic calibration and role notes (`metadata.*`): what the
model tends to be good at, which team roles suit it, and a pronoun teammates
use for that model's seat (`metadata.pronouns`), which the preview will show. With a pinned effort
that matches a catalog entry, the notes are that entry's. With `default`, the
roles and summary stay as a labelled prior and the effort-specific ratings
(intelligence tier, cost level, speed) are left out, because nobody measured
that tuning. Tell them these notes are one operator's starting opinions, meant
to be edited as they learn their own models.

`starterEffort` is required for `"simple"` and also applies to a starter named
explicitly. Any other named catalog variant, such as `opus-high`, keeps the
catalog's tuning.

### 4. Permissions

For each selected harness, explain auto and the bypass flag's actual effect
from the knob library, then ask once. Recommend auto, the default, and name
bypass as the alternative with its consequence in one sentence: bypass lets the
agent run commands and edit files without asking, with the person's own
permissions; auto keeps the harness's approval checks. Claude, Codex, Cursor
and Antigravity record `"auto"` or `"bypass"`; a new Claude/Codex config needs
an explicit answer, and bypass records the person's consent. Codex auto keeps Codex's file sandbox and its automatic approval review, not a
human approval dialog, and TAP turns on Codex's network proxy with no allowed domains so seats can reach the tmux socket (other destinations stay blocked for commands the sandbox runs); Cursor auto uses `--auto-review`, which still prompts for
calls its classifier will not run. Antigravity has no automatic mode: auto stops
the seat on every permission request, which TAP shows as blocked. In a new
folder, Claude, Codex and Antigravity auto seats first ask to trust it. Say so
before they choose. OpenCode and Hermes
bypass parameters are advanced edits (below).

### 5. Two questions every new user answers once

- **First use in a new project** (`onboarding.init`): `ask` before creating a
  team, or `auto`.
- **Messages that arrive while typing** (`injection.behavior`): `clobber`
  may clear a draft to deliver and keeps the text TAP can capture; pasting it
  back is conditional, and when it does not happen `tap draft` recovers it
  (OpenCode drafts always need that, and pasted content or images may not be
  captured). Typing `WAIT` in capitals holds deliveries for two minutes. `wait`
  parks arrivals until the input is empty.

### 6. Optional extras

Offer these once each and move on if they pass: the notifier (`system` or a
literal `command` argv using the whole-token `{title}`, `{body}` and `{urgency}`
placeholders), the full skill kit (`fullKit`), plugins, and the tmux lookup key
(`tap keybinding status`, then `tap keybinding install`): prefix + C-g opens a
popup that fuzzy-finds a teammate and types its `team/handle` where they were
writing. It needs tmux 3.2+; a binding already on that key is shown, never
replaced, so offer `--key <other>`. On a first installation, leave them for a
later run unless the person raises one.

### 7. Shell aliases

Offer this last. With `"shellIntegration": true` the writer adds one managed
block to their shell startup file with PATH setup, completion, and an alias for
every preset selected in these answers, so typing `opus`, `fable`, `sol` or
`astra` runs `tap launch` for that preset. A second word names the seat:
`opus reviewer` launches the `opus` preset as `opus-reviewer`.

Detect the shell from `$SHELL`. Bash writes `~/.bashrc` and Zsh writes
`~/.zshrc`. For any other shell, say that managed aliases are not available and
show the equivalent line for them to add themselves, for example
`alias opus 'tap launch opus'` in fish.

Aliases come from the presets named in the same answers object: catalog
presets being added, and presets already saved in their config, including
custom ones such as every OpenCode preset. To add aliases on a later run, name
those presets again under their harness; saved presets are not rewritten. The
write is idempotent: a name that already has an alias line anywhere in the
startup file, theirs or TAP's, is left alone, and a block the person edited is
preserved untouched.

### 8. Preview, confirm, apply

Build one answers object holding every decision, and preview it:

```bash
answers_file="$(mktemp)"
cat > "$answers_file" <<'JSON'
{
  "harnesses": {
    "claude": {"presets": "simple", "permissions": "auto"},
    "codex": {"presets": "simple", "permissions": "auto"}
  },
  "starterEffort": "default",
  "shellIntegration": true,
  "write": "apply"
}
JSON
tap setup --machine --answers "$answers_file" --dry-run
```

This example assumes a person who chose common models for Claude and Codex,
default effort, auto permissions and aliases. Substitute their answers.

The dry run changes nothing. Send the preview as a message of its own: a
summary in the person's words (harnesses, presets, effort, permission per
harness, the two new-user answers, aliases), then for shell integration the
startup file and the managed block exactly as the dry run prints it, verbatim,
with a note when an alias would take precedence over an existing command of
the same name. The dry run shows a starter's calibration notes as one line per
preset; `--verbose` lists every key, on request. End that turn with "Reply yes to
apply, or tell me what to change"; a question dialog in the same turn hides the
preview above it. Only after a yes, run the same command without `--dry-run`. If
they change an answer, preview again.

### 9. Close

Report the config path (`tap config path`), any backup path, what changed, and
the exact launch command for one thing they set up, such as
`tap launch opus` or `tap launch claude`. If aliases were written, say they
work in a new terminal. Run `tap presets` when presets changed.

End by telling them: run `/tap:config-wizard` again any time to change any of
this; there is no need to edit the config file by hand.

## Answers reference

`tap setup --machine --answers <file>` works from a non-TTY agent shell;
`--answers -` reads JSON on stdin. The object is a patch: omitted fields
preserve state and cause no effects. It has no version field. Unknown fields
refuse before effects.

| Field | Accepted choice |
|---|---|
| `harnesses` | Map of `claude`, `codex`, `cursor`, `opencode`, `agy`, `hermes` to decisions |
| `harnesses.<name>.presets` | `"skip"`, `"simple"`, or an array of names: shipped catalog presets to add, or presets already saved for that harness (selected for aliases, never rewritten) |
| `harnesses.<name>.permissions` | `"auto"` or `"bypass"` for Claude, Codex, Cursor and AGY only; required for a selected Claude/Codex without a saved valid choice (omitted Cursor/AGY save nothing and launch with auto, the default); bypass records explicit human consent |
| `starterEffort` | `"default"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`; required for newly added simple Claude/Codex starters and applied to a starter named explicitly; `default` pins no effort; other named presets keep catalog tuning |
| `write` | `"apply"` or `"candidate"`, required when config bytes change |
| `replaceCandidate` | `true` to replace an existing inactive candidate |
| `shellIntegration` | `true` for the managed Bash/Zsh PATH/completion block and aliases for the presets selected in this object; false or omission does nothing; not allowed with candidate |
| `fullKit` | `true` installs optional prefixed skills for flat hosts; `false` keeps their seven defaults and removes only unchanged owned optional links/stubs; Claude/Codex always use the complete native TAP plugin; saved as `skills.full_kit`; omission has no effect |
| `plugins` | Map of `claude`/`codex` to arrays containing `ponytail`, `compound-engineering`, or `superpowers`; explicit installs only, never uninstall by omission |
| `notifications` | `notifier: "system" | "command"` and optional literal `command` argv; command mode requires a new command or a valid saved one |
| `onboarding` | `init: "ask" | "auto"` |
| `injection` | `behavior: "clobber" | "wait"` |

Claude and Codex load all public TAP skills from the native plugin, as `tap:lead`,
`tap:drive`, and `tap:tap`. Flat hosts start with `tap`, `tap-in`, `tap-send`,
`tap-escalate`, `tap-config-wizard`, `tap-help` and `tap-extend`; the full-kit choice adds their
remaining prefixed skills. `tap help skill tap-config` still locates this skill.
The full-kit question defaults to No and gates optional third-party plugin questions.
Direct `plugins` answers remain independent. Candidate and dry-run choices never
change installed skills. Omitted full-kit preference preserves owned optional flat
skills during upgrade. An observed disabled native plugin is left unrefreshed.


Config changes preserve comments and unrelated settings and keep a backup when
applying over an existing file. Candidate config stays inactive; plugin installs
are independent explicit effects, so omit them when only reviewing a candidate.
Setup never sends a notification. No-op input reports no changes, not complete
onboarding. Answers failures exit 1; JSON failures use the standard
`{ok:false,error_class,action,detail}` envelope with empty stderr. The distinct
`setup_partial` class names retained effects. Successful JSON uses
`{exit_code, notes}`. The existing terminal-attention exit 2 remains outside
`--answers`. In a terminal, `tap setup --machine` asks the same questions
itself, defaults preset selection to skip, and prints the startup file and
alias lines before asking whether to write them.

Custom presets, arbitrary model/effort/context knobs, OpenCode/Hermes bypass
parameters, notifier timeouts and deletions are not represented by this
contract. Use the edit procedure below only for those.

## Edit procedure

1. Run `tap config path`. Its normal location is
   `${XDG_CONFIG_HOME:-$HOME/.config}/tap/config.toml`. Read that file and parse
   the TOML before making any change. Require integer `version = 3`. If another
   version, no version, malformed TOML or unreadable bytes are present, explain
   the problem and stop edits rather than guessing a migration. If genuinely
   absent, explain that you will create a minimal version-3 file. Before adding
   the first nonempty `[presets]` entry, inspect the sibling `presets.toml` and
   `tap presets`: if the legacy file still supplies presets, stop the preset
   edit and explain that its catalog must be migrated first. Leave both files
   intact; a new config-based entry would hide the legacy catalog.
2. Resolve what the human wants and show the exact proposed change. A request
   for a particular change authorizes it; do not ask for the same choice again.
   Ask for missing preferences, and ask once per harness before enabling bypass
   when not already authorized. Explain effective behavior, including that a
   harness without a `permissions` key launches with auto, and that a bypass
   flag left in its `params` then refuses the launch until the key says
   `bypass` or the flag is removed. Do not claim an unsupported opt-out works.
   Validate a proposed preset name against `[A-Za-z0-9][A-Za-z0-9._-]*` before
   writing; choose a distinct non-harness name. Quote the TOML key when it
   contains a dot (for example `[presets."review.high"]`) so it stays one name.
   Show a separate non-dotted seat name when launching such a preset, for
   example `tap launch review.high reviewer`; its dotted name cannot be the
   native launcher's default seat handle.
3. **Before every write**, copy the existing file's exact bytes to
   `config.toml.bak-<UTC stamp>` beside it, using a unique UTC timestamp and
   refusing to overwrite a backup. For a new file there are no prior bytes to
   back up; record that fact. Re-read immediately before editing and account for
   intervening changes. Preserve comments, unrelated keys and existing presets.
4. Use `tap config set <dotted.key> <value>` for a supported scalar
   (boolean, integer or string). For example,
   `tap config set harness.claude.permissions bypass`. Arrays, tables, deletions
   and grouped preset changes use a small direct TOML edit after the backup.
   Use that same targeted direct edit for a scalar inside an inline table
   (such as `params = { auto = true }`), or when `config set` refuses a valid
   table shape. Re-read first; do not mistake a refused setter for a saved change.
   Do not serialize and replace the whole user's config or copy the shipped
   reference catalog over it. Keep the file private and avoid printing secrets.
5. After **every write**, parse and read the resulting file back. Show the diff
   against that write's backup (redact secret values if present), including the
   backup path. If validation fails, restore the prior bytes and report it;
   preserve the failed bytes as well, and back up any existing destination before
   a restoration write. Never report an unparsed edit as successful.
6. Run `tap presets` for a preset change and show a launch command that consumes
   it. Preset changes apply only to new launches: existing seats resume with
   their stored tuning and do not reread the preset. Harness policy is reread
   on launch/resume under the existing precedence rules. Neither edit changes
   an already-running process. Explain how to return to the previous value
   using the saved backup without overwriting unrelated later edits.

## Custom presets

When the catalog has no entry for what the person wants, including every
OpenCode model, write a preset with the edit procedure:

- **Name and description:** a `harness` and a plain `description`. Preserve an
  existing same-named entry unless its edit was requested. Canonical harness
  names are reserved: use a distinct preset name such as `claude-review`, not
  `claude`. Roles describe the work; they are not proof of the chosen model.
- **Model and effort:** offer the harness's own defaults first, then values
  verified for that CLI and account. Store flags as `params.<long-flag-name>`.
  Boolean true emits a flag, false omits it; a string supplies its value. A
  string array repeats that flag. Codex config assignments belong in
  `params.config`, for example `['model_reasoning_effort="high"']`; preserve
  unrelated assignments. Do not copy another harness's effort vocabulary. With
  no model or effort pinned, those choices belong inside the harness; another
  agent cannot infer capability from the config, only from a role or by asking.
- **Context and compaction:** explain whether the native setting limits the
  context window, chooses a compaction trigger, or reserves room for compaction.
  They are different controls. Use only the library's verified `params`/`env`
  mapping. Preserve the harness default when no supported setting exists;
  report an unsupported requested knob explicitly. Do not promise a threshold
  larger than the model's context or ignore native clamping.
- **Extra arguments and environment:** use `params` for verified named CLI
  options and `env` for supported environment settings. These tables contain
  harness tuning, never seat identity, team, cwd, bus, authentication or `TAP_*`.
  There is no generic `extra_args` field. Decline a requested positional or
  configuration shape this schema cannot represent rather than inventing one.
- **Permissions:** Claude, Codex, Cursor and AGY use `[harness.<name>] permissions`,
  not preset bypass flags. Check the library for other harnesses and inspect the effective
  launcher behavior. A false parameter does not remove a flag the launcher owns.

```toml
[presets.claude-review]
harness = "claude"
description = "Claude review seat at high effort"
params.effort = "high"
```

Launch it with `tap launch claude-review reviewer`. `tap launch claude reviewer`
selects the bare harness; `--preset claude` cannot bypass the reserved-name rule.
The name `reviewer` is the whole seat handle. End with the changed settings,
backup paths, exact launch command and any unsupported request left unchanged.
