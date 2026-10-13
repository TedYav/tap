# Writing skills that use TAP

TAP gives a skill teammates: a reviewer from another model family, a driver for a lane, a way to reach the operator. Not every environment can supply them. CI runners, cloud containers and desktop apps often have no tmux, and some have no TAP installed at all. Decide up front what your skill does there.

This page is for skill authors and for agents adapting a skill. It covers how to write the TAP parts, how to detect whether TAP is available, and three ways to fall back when it isn't installed.

## Write the TAP parts so they can be replaced

- **Name roles by capability, not by seat.** Ask for "a reviewer from a different model family" or "a cheap mechanical seat," not a handle or a model name. Rosters change, and a fallback can substitute by strength only if the skill says what strength it needs.
- **Keep the gate separate from the transport.** State what a review must cover and what counts as approval; let TAP route it. A fallback can replace the routing. It can't reconstruct a gate the skill never wrote down.
- **Use each verb for its meaning.** `tap assign` for work that owes a reply, `tap send` for a note, `tap reply` to answer, `tap escalate` when only the operator can unblock. Pass bodies with `-f <file>`: the shell expands backticks and `$(...)` before TAP sees them.
- **Let TAP wake the seat.** Continue independent work instead of sleeping or polling for a reply, and check `tap outstanding <handle>` before yielding.
- **Point at `tap help <verb>` for syntax.** Flags copied into a skill drift; the help stays current.

## Detect whether TAP is available

Run `tap whoami` once, before the first TAP step.

| Result | Do |
|---|---|
| Prints a handle | Use TAP as written |
| `tap` is not found (`command -v tap` fails) | TAP isn't installed: fall back |
| Any refusal | TAP is installed here: follow the refusal's next step (`next:` in human output, the `action` field in JSON), or stop and report it. Don't fall back |

From inside a skill, the refusals of an installed TAP look alike, and their causes differ:
- a registration to repair;
- a seat moved into a background worker;
- a checkout without a team;
- an environment that can never host a seat, such as a desktop app without tmux.

A seat that guesses wrong works alone, losing its reviewers and risking collisions with teammates in a shared tree. So an installed TAP owns the answer, and the skill stops when it can't follow it. Falling back while TAP is installed would need TAP itself to report that it can't run here; until it does, that case stops.

## Choose a fallback

### 1. Hard fail

Refuse when TAP can't run. This is simple, and right when the skill *is* the team: leading, conducting, pairing and managing crew seats have nothing to do alone. Anywhere else it is brittle, because CI, cloud and desktop environments may never support tmux or teams.

Say why and what would work instead:

> This skill coordinates a TAP team and has no single-agent form. Run it from a TAP seat, or ask for the work directly.

### 2. Inline fallback

Write the substitution into the skill body. This suits small, skill-specific changes that don't depend on the environment: holding a landing lease under a session id when there is no TAP handle, or reporting a review as missing instead of routing it. The cost is that each skill invents its own fallback, and none of them knows what a given environment provides, such as which subagents exist or where escalations go.

### 3. Repository fallback file

Load `.tap-fallback.md` from the repository root (`git rev-parse --show-toplevel`). The environment, not the skill, knows what replaces TAP there, so the instructions live with the environment, and one file serves every TAP skill in the repository. Prefer this for any skill that is useful without a team.

When a skill has inline text and the repository has a file, follow the file where they conflict: it describes what this environment can actually do. The inline text still covers skill-specific details the file doesn't mention.

## The `.tap-fallback.md` contract

- **Its presence is the opt-in.** TAP not installed and the file present: read it and follow it. TAP not installed and no file: stop. No environment variable is involved.
- **The environment supplies it.** A person or the environment's setup script writes it. An agent never creates or edits one to get past a skill's check.
- **Tracked or untracked.** Commit it when every TAP-less environment of the repository should behave the same. When it belongs to one environment, have that environment's setup write it and list it in the repository's exclude file, found with `git rev-parse --git-path info/exclude` (in a linked worktree `.git` is a file, not a directory). An untracked file exists only in the worktree it was written to. A cloud environment that snapshots a prepared checkout may not keep untracked files; confirm in a fresh task.
- **It never relaxes a gate.** Tests, security checks and merge approval still apply. When the fallback can't satisfy one, the agent reports it as unmet.

Without the file, the skill stops with a message that names both remedies:

> This skill requires TAP, and this repository has no `.tap-fallback.md`. Add one with instructions if you can't or don't want to use TAP in this environment; otherwise, install TAP to use this skill.

### What the file says

Use these entry names, so a skill can cite one ("follow the Escalation entry"). When a skill needs an entry the file lacks, the agent reports it unmet instead of improvising.

- **Environment:** why there is no TAP and what kind of work runs here.
- **Teammates:** subagents in this runtime, chosen by the strength the skill asks for: the strongest available for frontier work, the cheapest suitable one for mechanical work. Without subagents, fresh-context passes in the same session, labelled as such.
- **Different-family review:** what is reachable. Once a PR exists, review bots from another model family usually are: request them, triage their findings, and name the bot and the reviewed head in the receipt. A subagent on the same model is not a different-family review. When the skill requires one and none is reachable, as before a PR exists, the agent reports it as missing instead of claiming it happened.
- **Escalation:** where a person will read it and what it carries. For a task-based runtime, put the blocker, the PR link and the decision needed on the first line of the run's final message, and keep a durable copy such as a PR comment. Report a notification that failed; don't drop it.
- **Lease:** what identifies this session where a skill would use its TAP handle, such as a landing lease. Usually the session id.
- **Merging:** what the repository's own merge policy allows here.
- **Messages:** sends, replies and `tap outstanding` have nothing to do; there are no peers.
- **Gates:** every test, security and approval step still applies; an unmet one is reported.

### Example

```markdown
# TAP fallback

- **Environment:** this is a cloud container for single-runtime chore work:
  dependency updates and small backlog fixes. TAP and tmux are not available.
- **Teammates:** use this runtime's subagents. Match the strength the skill
  asks for: the strongest available model for a frontier seat, the cheapest
  suitable one for mechanical work.
- **Different-family review:** none in the container. Once the PR exists,
  request the review bots from another model family, triage their findings
  and name each bot and the reviewed head in the receipt. Before a PR exists,
  report the review as missing. Don't describe a same-model subagent review
  as cross-family.
- **Escalation:** stop. Put the blocker, the PR link and the decision needed
  on the first line of your final message, and post the same as a PR comment.
- **Lease:** use the session id wherever a skill names a TAP handle.
- **Merging:** follow the repository's merge policy. Without a standing grant
  for this kind of change, open the PR and stop.
- **Messages:** skip sends, replies and `tap outstanding`; there are no peers.
- **Gates:** run every test, security and approval step the skill names. If
  one can't be met here, say so; don't substitute silently.
```

## Skill header

Paste this at the top of a skill that uses TAP and accepts a repository fallback:

```markdown
> **Uses TAP.** Before the first TAP step, run `tap whoami`.
> - It prints a handle: use TAP as written.
> - `tap` is not found: TAP isn't installed here.
>   - Read `.tap-fallback.md` at the repository root and follow it in place of
>     TAP's transport. Every gate this skill names still applies.
>   - If there is no such file, stop and say: "This skill requires TAP, and
>     this repository has no `.tap-fallback.md`. Add one with instructions if
>     you can't or don't want to use TAP in this environment; otherwise,
>     install TAP to use this skill."
> - It refuses: follow its next step (`next:`, or `action` in JSON), or stop
>   and report the refusal. Don't fall back.
```

For a hard-fail skill, replace the second bullet with its refusal. For an inline fallback, replace the no-file stop with the skill's own substitutions; when the repository also has a file, follow the file where they conflict.

A repository whose conventions keep mechanics out of individual skills can use a compact form. It still has to stand on its own: where TAP isn't installed, neither this guide nor TAP's other docs are there to point at.

```markdown
> **Uses TAP.** If `tap` is not installed, read `.tap-fallback.md` at the repository root in place of TAP's transport; every gate still applies. No file: stop and say this skill requires TAP or a `.tap-fallback.md`. If `tap whoami` refuses, follow its next step or stop; don't fall back.
```
