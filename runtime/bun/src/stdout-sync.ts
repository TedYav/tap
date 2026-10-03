import { writeSync } from "node:fs";

/** stdout's reader went away (`tap read ... | head -1`): the consumer's choice, not a failure. */
export class StdoutClosed extends Error {
  readonly stdoutClosed = true;
  constructor() { super("stdout closed by its reader"); }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write to fd 1 synchronously, looping over partial writes. On a real pipe process.stdout.write
 * queues and reports EPIPE later as an async event, after a sync caller has moved on to its next
 * effect; here the failure is thrown at the write site, tagged as StdoutClosed so only a closed
 * STDOUT (never a stderr EPIPE) is read as a quiet disposition. A non-blocking fd 1 (EAGAIN)
 * waits for the reader like a blocking write would.
 */
export function writeStdout(text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length;) {
    try { offset += writeSync(1, bytes, offset, bytes.length - offset); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EPIPE") throw new StdoutClosed();
      if (code !== "EAGAIN") throw error;
      Atomics.wait(pause, 0, 0, 2);
    }
  }
}
