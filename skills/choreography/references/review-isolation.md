# Review isolation

Details for [/tap:choreography](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Scope

TAP distributes whatever skills a team already has across a heterogeneous set of agents. This skill
carries the **distribution mechanics** and has no opinion on the methodology being distributed — the
test for anything here is *would agents on an arbitrary team need this to work in a distributed
manner?*

## Coordinating reviews

Distributed review over TAP goes wrong in one specific way: agents reviewing code others are editing.
What a review must cover, cite, or prove is each repo's business; this is only about keeping several
agents from stepping on each other.

**Mutation is the risk axis — not reviewer count.** Five reviewers reading a frozen artifact need
less coordination than two reading something one of them is editing.

Pairs mostly do not have this problem: two agents pass the baton, and the handoff *is* the
coordination. What follows is for genuine parallelism.

### The invariant: name an exact, retrievable artifact

**A citable review names a source identity that can be retrieved again later.** A verdict about "the
current state" is unrecoverable — nobody can tell afterward what it judged. A SHA alone is not
automatically enough: it has to be reachable by the people who need it, and unreferenced objects can
be pruned.

**Durable identity and isolated view are two different things, and only one of them has to survive.**
The identity is what the verdict cites and must stay retrievable for as long as the verdict may be
cited — the round owner keeps the reviewed commit under a reachable ref, or archives the exact bytes.
The view is the reader's working copy, and is disposable by design. Conflating them is how a round
ends up citing a path that no longer exists: a source SHA plus a deleted copy proves *former*
provenance, not present retrievability, and a rebase or prune can strip a bare SHA the same way.
Keeping the identity durable is what makes reaping a copy or worktree safe.

The options below isolate the *view*, cheapest first. Each assumes the identity is retained
separately:

- **A committed SHA**, when reviewers can fetch it — the plain case, and the only one where view and
  identity coincide. Still needs a reachable ref if the branch may be rebased or the object pruned.
- **The PR**, when reviewers share the remote — lowest-config for a heterogeneous team, and the
  platform renders the diff. It is a **view, not an identity**: a PR reference moves as its head
  advances, and a force-push or rebase can drop the reviewed commit from it entirely. That is this
  section's own failure arriving through the option that looks safest — a verdict citing "PR #N"
  can end up naming bytes that have moved. Review *via* the PR at an exact head SHA, and retain that
  SHA like any other. Cross-repo seats without the remote cannot use this one.
- **A private copy** of the code under review, for the round's duration. Isolates the reader
  completely and needs no git ceremony; the verdict cites the retained source identity, and the
  copied path is a convenience for the reader rather than the thing being cited.
- **A temporary worktree per reviewer**, reaped after. Isolates checkout and build outputs — not
  shared caches, ports, services, locks, or machine contention, which stay contended.

**Naming an artifact is what frees the author to keep working.** Because a review reads a fixed
identity rather than the workspace, it may overlap the next wave's writing — the author is not
blocked while a round is out. That permission is the point of the invariant, not a loophole in it,
and it is why the cheapest option that holds is usually the right one.

Informal advice — a look, a second opinion — may use a live or copied view, labeled as such. The
invariant is for verdicts meant to be cited.

### The round opener names the technique

Normally the message that opens a round names the artifact and the author's mutation freedom. Any
participant can propose it; a leader or driver is the usual owner where those roles exist:

> Review `abc1234`; I may keep committing on top; verdicts name the SHA.

When no technique is named and the round wants a **citable verdict**, reviewers ask for an exact
artifact rather than reading a live workspace. Explicitly informal advice does not need the ask-back
— it can proceed against whatever view is available, labeled non-citable. Bouncing a quick look for
ceremony it was never going to need is the failure this distinction avoids.

### Signals that a round needs re-choreographing

Diagnostic, not accusations — the response is escalating along the options above, or asking for the
round to be re-choreographed:

- An agent confused because code changed underneath them mid-pass.
- Errors or flakiness tracing to shared tooling state rather than to the code.
- A verdict that cannot say which version it looked at.

Recurring signals may mean the codebase itself fights agent teams; route that to the repo owner or
lead, who can propose structural upgrades.
