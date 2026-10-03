/**
 * Notice lifetime for the catalog engine: suppression, per-command dedup, and
 * the reset that scopes both to ONE command.
 *
 * Three pieces of state, and they answer three different questions:
 *
 *   suppressed  -- does this command print prose at all? (`--json`, TAP_JSON)
 *   said        -- has this exact text already been printed in THIS command?
 *   reset()     -- a new command begins; forget what was said.
 *
 * Getting the scope wrong fails in both directions and a per-call API cannot
 * tell them apart. Fresh state per call means the same text prints twice in one
 * command; process-lifetime state means the same text prints ONCE across two
 * commands in a long-lived host and the second command looks silent. Both are
 * wrong, so the generation is explicit rather than implied by a process
 * boundary.
 *
 * Dedup is on the EXACT rendered string, not on a message id: two different
 * paths producing two different sentences are two different facts and both
 * print, while the same sentence reached twice is one fact.
 */

export class Notices {
  private suppressed = false;
  private said = new Set<string>();
  constructor(private readonly write: (message: string) => void = m => process.stderr.write(`${m}\n`)) {}

  /** A new command begins. */
  reset(): void { this.said.clear(); }

  /** Carried EXPLICITLY from the argv the command was invoked with, never inherited ambiently. */
  suppress(suppressed: boolean): void { this.suppressed = suppressed; }
  get isSuppressed(): boolean { return this.suppressed; }

  emit(message: string): void {
    if (this.suppressed || this.said.has(message)) return;
    this.said.add(message);
    this.write(message);
  }

  /**
   * Run `body` with prose suppressed, then restore -- on failure as well.
   *
   * A roster or discovery read is silent BY DESIGN: it consults the catalog to
   * decorate rows, and an operator asking "who is on this team" has not asked
   * about their config file. Restoring in a `finally` is what keeps a later
   * ordinary notice working after a read that threw, and what keeps an
   * already-suppressed command suppressed rather than silently unmuted.
   */
  quietly<T>(body: () => T): T {
    const previous = this.suppressed;
    this.suppressed = true;
    try { return body(); } finally { this.suppressed = previous; }
  }

  /** The callback shape the catalog engine takes. Bound so it can be passed directly. */
  get sink(): (message: string) => void { return message => this.emit(message); }

  /**
   * The lifetime as a VALUE, so it can cross a process boundary.
   *
   * A Python caller suppresses once and emits at several later sites; if each of
   * those is a separate child, the lifetime has to travel as data or the fourth
   * emit forgets what the first said and an already-suppressed command starts
   * talking. Exporting it here -- rather than letting the caller keep its own
   * bool and its own set -- is what keeps the dedup and suppression POLICY on
   * this side: the caller holds the value opaquely and never inspects it.
   */
  capture(): { suppressed: boolean; said: string[] } {
    return { suppressed: this.suppressed, said: [...this.said] };
  }

  restore(state: { suppressed: boolean; said: string[] }): void {
    this.suppressed = state.suppressed;
    this.said = new Set(state.said);
  }
}

/** The process-wide notice generation. `reset()` at each command boundary. */
export const notices = new Notices();
