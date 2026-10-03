import { readSync } from "node:fs";

/**
 * One byte from stdin for the interactive consent loops: 0 at end of input.
 * On a closed pty (the pane or terminal vanished) readSync raises EIO; that is
 * an end of input for a prompt, never a reason to spin or crash (tap-ryhno).
 */
export function readStdinByte(buffer: Buffer): number {
  try { return readSync(0, buffer, 0, 1, null); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EIO") return 0; throw error; }
}
