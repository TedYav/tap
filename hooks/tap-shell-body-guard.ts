#!/bin/sh
":" //; d="$(dirname "$0")/tap-shell-body-guard.sh"; [ -r "$d" ] || exit 0; exec /bin/bash "$d" "$@"; : <<'//SHELL-ENDS-HERE'
// The two lines above make this file safe to register as a hook command. Run
// directly, it is a shell script: line 2 hands over to the fail-open door beside
// it, which finds Bun and runs this same file as TypeScript. To TypeScript,
// line 2 is a string statement and a comment. To the shell, everything after
// line 2 is an unused here-document that the last line of this file closes, so
// the whole file parses as shell; keep that last line last. An `env bun`
// shebang instead exits 127 on every shell command of every agent whose PATH
// has no Bun.
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
// 2026-09-25; bun 1.4.0 skips the restore when stdout is a pipe). Under the
// shell door stderr is withheld from the harness when this process fails;
// run `bun <this file>` by hand to see a crash.
import { hookResponse } from "../runtime/bun/src/shell-body-guard";

const stdinBytes = new Uint8Array(await new Response(Bun.stdin).arrayBuffer());
const result = hookResponse(stdinBytes);
await Bun.write(Bun.stdout, result.stdout);
process.exit(result.exit);
//SHELL-ENDS-HERE
