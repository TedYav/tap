/**
 * What a `spawnSync` call actually did, and how much of a child's output we are
 * willing to hold.
 *
 * This module exists because the same question was answered three times in three
 * files, twice wrongly. It is deliberately dependency-free so that verbs, the
 * roster reader, and `reset.ts` can all reach it without a module-direction
 * problem — `reset.ts` must not import from a verb, and `verbs/team.ts` must not
 * import from `verbs/refresh.ts`, which is a cycle.
 */

/**
 * `status !== 0` conflates three different worlds, and the conflation has now
 * produced three measured defects in this port:
 *
 *   - an unrunnable `kill` read as proof a process was dead (`reset.ts`);
 *   - a VALID registry read as corrupt because it serialized past bun's ~1MB
 *     default `maxBuffer` — ENOBUFS sets `status` to null, `null !== 0` is true,
 *     and the roster was never examined (`verbs/refresh.ts`);
 *   - a classifier's raw records written onto a `--json` receipt's stdout, which
 *     made the receipt unparseable while the command still exited 0
 *     (`verbs/team.ts`).
 *
 * The three states:
 *
 *   ran      — the child ran and exited 0. Its output is real.
 *   failed   — the child ran and exited non-zero. The FAILURE is real, and its
 *              stderr is the child's own diagnostic.
 *   unusable — the child could not be run, or was killed, or its output was
 *              truncated. We learned NOTHING about the subject, and saying
 *              otherwise invents evidence.
 *
 * The distinction is asked for rather than re-derived at each call site: a sweep
 * across `runtime/bun/src` found one site naming it and several relying on it
 * implicitly, three of those correct only by luck. A site that is right by luck
 * breaks when someone edits beside it.
 */
export type SpawnOutcome = "ran" | "failed" | "unusable";

/**
 * WHICH CONJUNCT CARRIES WHICH FAILURE, measured across both runtimes rather
 * than assumed (cleanup review, at `be9c0ee3`):
 *
 *   failure                        bun status    node status   error
 *   ENOENT (binary not runnable)   undefined     null          ENOENT
 *   ENOBUFS (over maxBuffer)       null          null          ENOBUFS
 *   killed (SIGKILL)               null          null          NONE
 *   exit 3                         3             3             none
 *
 * The third row is why the type is widened past what either runtime documents
 * and why `typeof r.status !== "number"` is not redundant with `r.error`: **a
 * killed child sets no error at all**, so the status test is the only thing
 * standing between "the child was killed" and "the child succeeded". And the
 * first row is why `undefined` is in the signature — bun produces a value there
 * that `number | null` says cannot occur, which an earlier signature asserted
 * while the implementation handled it anyway.
 */
export function spawnOutcome(
  r: { status: number | null | undefined; error?: Error },
): SpawnOutcome {
  if (r.error || typeof r.status !== "number") return "unusable";
  return r.status === 0 ? "ran" : "failed";
}

/**
 * A registry can legitimately be large on a big team, and bun's default
 * `spawnSync` maxBuffer is about 1MB. Refusing to read a roster because it is
 * big is not a behaviour anyone chose — it is a default leaking into policy.
 *
 * It is also a failure mode the INCUMBENT STRUCTURALLY CANNOT HAVE: bash reads
 * its classifier through command substitution and its registry reader through a
 * redirect, neither of which has a fixed buffer. So bounding these children
 * restores a property bash gets for free rather than introducing a divergence.
 *
 * WHAT THIS CONSTANT DOES AND DOES NOT PROMISE. It is a value callers pass; it
 * enforces nothing on its own, and an earlier version of this comment said
 * "every child whose output scales with the registry takes this bound" — a
 * sentence that was false three lines from where the constant is imported, and
 * that is exactly the kind of claim that stops the next reader looking. Twice.
 * The current bounded set, as of this commit:
 *
 *   refresh.ts  register rebind
 *   observe.ts  process-table snapshot
 *   team.ts     presetFacts
 *
 * AND THE SET IS THE WHOLE FILE FOR refresh.ts: it carries one spawnSync call
 * site — the register rebind — and it takes the bound. Four former members are
 * gone with the M3 port. The registry WRITER
 * was an embedded python child that had no bound — it passed no override, sat
 * under Bun's IMPLICIT ~1MB default (measured at 2,000,000 child stdout bytes
 * returning `status=null` with ENOBUFS, 1,800,755 captured before the
 * cutoff), and stayed safe only BY SCALE, printing `len(removed)` — one
 * integer — rather than a registry-scale payload. The roster READER took this
 * bound. The session-namespace snapshot — one of the original bounded
 * children — took it too; its classification moved into a tmux.ts leaf whose
 * tmux child carries the same bound (REGISTRY_MAX_BUFFER on `list-sessions`,
 * restored when truncation was shown to turn a real answer unobservable). The
 * strand report — also an original bounded
 * child — took it as well; its warning is assembled in-process now. All four
 * went as their work moved in-process (trim, then the read, then the
 * namespace, then the strand report), and with each spawn its refusal died:
 * there is no refresh child left that can fail to run. The sentence
 * that used to live here about the writer's buffer situation is retired with
 * it, kept as history because an earlier version of this comment once claimed
 * the writer had "no bound to exceed" — wrong, disproven twenty-five lines
 * up, and the reason this file names its bounded set instead of gesturing at
 * it.
 *
 * Nor is the behaviour past the bound uniform:
 *
 *   REFUSE   observe's process-table snapshot: an unusable child enters the
 *            shared snapshot as psOk=false with no parsed rows. Classification
 *            still completes, but each seat whose verdict needs process
 *            evidence is refused as unobservable instead of being attested
 *            from a partial table. The engine-throw/code-1 arm is separate.
 *   DEGRADE  `presetFacts`: a failed child cannot supply catalog roles or
 *            metadata, but recorded preset names remain durable truth. Every
 *            row is marked `preset_catalog_unavailable` and human output emits
 *            one warning, so the partial answer cannot masquerade as complete.
 *
 * Raising the bound moves each cliff; it makes no site fail closed that did not
 * already.
 */
export const REGISTRY_MAX_BUFFER = 64 * 1024 * 1024;
