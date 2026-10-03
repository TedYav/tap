/**
 * Scoped, opt-in memoization for `tap register`'s pre-lock probes.
 *
 * The ps-table and git-root memos exist to collapse ONE CLI invocation's
 * redundant subprocess fan-out. They must not outlive that invocation:
 * long-lived processes (compact, crew lifecycle, resume-all, session-start)
 * sleep between effects and re-ask the same questions across a restart or a
 * `git init`; a process-global cache would answer those from a world that no
 * longer exists. So the memos are armed only inside `withInvocationMemo`,
 * which the register verb wraps its body in. Outside a scope both behave as
 * fresh reads, exactly as they did before the collapse.
 *
 * Nesting reuses the outermost scope: the arm/disarm pair is a depth count,
 * and the caches are cleared on entry to depth 1 and after exit from it, so
 * a nested scope cannot observe a stale outer cache nor leak its own inward.
 */

let depth = 0;
const resets: Array<() => void> = [];

export function invocationMemoActive(): boolean {
  return depth > 0;
}

/** Register a cache clear to run whenever a memo scope opens or closes. */
export function onInvocationMemoScope(fn: () => void): void {
  resets.push(fn);
}

export function withInvocationMemo<T>(fn: () => T): T {
  depth++;
  try {
    if (depth === 1) for (const reset of resets) reset();
    return fn();
  } finally {
    depth--;
    if (depth === 0) for (const reset of resets) reset();
  }
}
