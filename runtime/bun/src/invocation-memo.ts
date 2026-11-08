/**
 * Scoped, opt-in memoization for registration and synchronous reporting discovery.
 *
 * The ps-table and git-root memos exist to collapse ONE CLI invocation's
 * redundant subprocess fan-out. They must not outlive that invocation:
 * long-lived processes (compact, crew lifecycle, resume-all, session-start)
 * sleep between effects and re-ask the same questions across a restart or a
 * `git init`; a process-global cache would answer those from a world that no
 * longer exists. So the memos are armed only inside `withInvocationMemo`,
 * which the register verb wraps its body in. Reporting adds a narrower scope
 * for caller/context observations. Outside a scope the probes behave as
 * fresh reads, exactly as they did before the collapse.
 *
 * Nesting reuses the outermost scope: the arm/disarm pair is a depth count,
 * and the caches are cleared on entry to depth 1 and after exit from it, so
 * a nested scope cannot observe a stale outer cache nor leak its own inward.
 */

let depth = 0;
let reportingDepth = 0;
const resets: Array<() => void> = [];
const reportingResets: Array<() => void> = [];

export function invocationMemoActive(): boolean {
  return depth > 0;
}

/** Reporting discovery only. Registration and effect-bearing readers stay live. */
export function reportingMemoActive(): boolean {
  return reportingDepth > 0;
}

export function withReportingMemo<T>(fn: () => T): T {
  return withInvocationMemo(() => {
    reportingDepth++;
    try {
      if (reportingDepth === 1) for (const reset of reportingResets) reset();
      return fn();
    } finally {
      reportingDepth--;
      if (reportingDepth === 0) for (const reset of reportingResets) reset();
    }
  });
}

/** Retain a read only during the synchronous reporting phase. */
export function reportingMemo<T>(): (key: string, read: () => T) => T {
  const values = new Map<string, T>();
  reportingResets.push(() => values.clear());
  return (key, read) => {
    if (!reportingMemoActive()) return read();
    if (values.has(key)) return values.get(key)!;
    const value = read();
    values.set(key, value);
    return value;
  };
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
