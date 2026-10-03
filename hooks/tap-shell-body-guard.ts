#!/usr/bin/env bun
// The shell-body guard as a Bun process (ported from the retired
// tap-shell-body-guard.py at E4; the classifier, adapter and byte-exact
// Python-json emitter live in runtime/bun/src/shell-body-guard.ts —
// hookResponse is the pure process contract; this main is thin I/O only).
//
// Launch shape: `bun <repo>/hooks/tap-shell-body-guard.ts` with the harness's
// hook payload JSON on stdin and the decision JSON on stdout. stdout must
// remain a pipe: every wired harness reads the decision from it, and a
// stdout-tty shape would (a) be unreadable as a decision channel and (b)
// reset the tty to the startup termios snapshot at exit (S1 termios gate,
// 2026-09-25; bun 1.4.0 skips the restore when stdout is a pipe). stderr
// stays live for crash diagnostics.
import { hookResponse } from "../runtime/bun/src/shell-body-guard";

const stdinBytes = new Uint8Array(await new Response(Bun.stdin).arrayBuffer());
const result = hookResponse(stdinBytes);
await Bun.write(Bun.stdout, result.stdout);
process.exit(result.exit);
