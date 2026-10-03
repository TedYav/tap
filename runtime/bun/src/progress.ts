// progress.ts — the animated phase line shared by `tap session launch` and
// `tap team refresh`.
//
// A command that spends seconds in waits the operator cannot see names each
// phase on one stderr line:
//
//   animate  stderr is a TTY (not TERM=dumb): a spinner frame, settling to ✓/✗
//   off      redirected stderr, TERM=dumb, --json / TAP_JSON=1, or a dry run:
//            the output bytes are unchanged
//
// Like `tap team doctor`'s scan progress (docs/CLI-STANDARDS.md CLI-TTY), this
// is a terminal-only exception: redirected and machine output stay free of it.
//
// The reporter patches the process-wide stderr/stdout writers so any other
// output erases the frame first, and it animates on the event loop: the caller
// must await its slow work (a blocking spawnSync or sync flock freezes frames).
// No color is used, so NO_COLOR needs no branch.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const CLEAR = "\r\x1b[2K";

export type ProgressMode = "off" | "animate";

export function progressMode(stderrTty: boolean, json: boolean, env: NodeJS.ProcessEnv = process.env): ProgressMode {
  if (json || env.TAP_JSON === "1" || !stderrTty || env.TERM === "dumb") return "off";
  return "animate";
}

type Write = typeof process.stderr.write;

export class PhaseProgress {
  private label = "";
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A prompt owns the row: the animation stays off until `resume`. */
  private paused = false;
  /** The spinner line is on screen now. */
  private drawn = false;
  /** The current phase has been drawn at least once. */
  private shown = false;
  /** The current phase leaves its ✓ even when it finishes before a first frame. */
  private keep = false;
  private readonly signals: [NodeJS.Signals, () => void][] = [];
  private readonly origErr = process.stderr.write;
  private readonly origOut = process.stdout.write;
  private readonly rawErr: Write;
  private readonly rawOut: Write;

  constructor() {
    this.rawErr = this.origErr.bind(process.stderr) as Write;
    this.rawOut = this.origOut.bind(process.stdout) as Write;
    // Any other output during a phase (a notice, the collision prompt) first
    // erases the spinner line, so it never lands glued to a frame; the next
    // tick redraws. Every launcher writer goes through these two streams.
    const erase = (raw: Write): Write => ((...args: Parameters<Write>) => {
      this.erase();
      return raw(...args);
    }) as Write;
    process.stderr.write = erase(this.rawErr);
    process.stdout.write = erase(this.rawOut);
    // Before the transaction installs its own interrupt handling (config
    // discovery), a signal would end the process with a frame on screen:
    // erase it, then re-raise with default handling. Inside the transaction
    // its handler owns the interrupt and this one only steps aside.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        if (process.listenerCount(signal) > 1) return;
        this.stop(null);
        process.kill(process.pid, signal);
      };
      this.signals.push([signal, handler]);
      process.on(signal, handler);
    }
  }

  /** Begin a phase; `keep` makes its ✓ survive a phase too quick to draw (an effect-bearing step). */
  phase(label: string, keep = false): void {
    if (label === this.label) return;
    this.settle("✓");
    this.label = label;
    this.keep = keep;
    // Each phase's first frame waits a full tick: a phase that finishes inside
    // one, or synchronous work such as the collision prompt, never flashes.
    this.frame = 0;
    this.startTimer();
  }

  /** A prompt takes the row: erase the frame and stop animating until `resume`. */
  pause(): void {
    this.paused = true;
    this.erase();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The prompt is answered: animate the current phase again, its first frame a tick away. */
  resume(): void {
    this.paused = false;
    if (this.label) this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.paused) return;
    this.timer = setInterval(() => this.draw(), FRAME_MS);
    this.timer.unref?.();
  }

  /** Settle the current phase: ✗ names the phase a failure stopped in; null just erases it. */
  settle(mark: "✓" | "✗" | null): void {
    if (!this.label) return;
    const label = this.label;
    this.label = "";
    // A phase too quick to draw leaves no ✓ unless it is kept; a failure is always named.
    if (mark === "✗" || (mark === "✓" && (this.shown || this.keep))) this.rawErr(`${CLEAR}${mark} ${label}\n`);
    else this.erase();
    this.drawn = false;
    this.shown = false;
    this.keep = false;
  }

  stop(mark: "✓" | "✗" | null): void {
    this.settle(mark);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    process.stderr.write = this.origErr;
    process.stdout.write = this.origOut;
    for (const [signal, handler] of this.signals.splice(0)) process.off(signal, handler);
  }

  private draw(): void {
    if (!this.label) return;
    // Fit one physical row: CLEAR erases only the current row, so a wrapped
    // frame would leave fragments behind (the tap team doctor rule).
    const width = Math.max(1, (process.stderr.columns || 80) - 3);
    const label = this.label.replace(/[\x00-\x1f\x7f-\x9f]/g, "?").slice(0, width);
    this.rawErr(`${CLEAR}${FRAMES[this.frame++ % FRAMES.length]} ${label}`);
    this.drawn = true;
    this.shown = true;
  }

  private erase(): void {
    if (!this.drawn) return;
    this.drawn = false;
    this.rawErr(CLEAR);
  }
}
