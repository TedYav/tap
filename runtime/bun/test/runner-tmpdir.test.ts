import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

// The runner owns every fixture root its tests can reach. run.sh builds WORK
// under ${TMUX_TMPDIR:-/tmp}, exports TMUX_TMPDIR=$WORK/tmux, and exports
// TMPDIR=$WORK/tmp — so os.tmpdir() and every mkdtemp(tmpdir(), ...) land
// inside WORK, where the lsof-guarded cleanup reaps them even when a run is
// interrupted. This test pins that contract; dropping the TMPDIR export from
// run.sh fails here instead of silently scattering fixtures over /tmp and
// macOS's per-user temp dirs.

const TMUX_TMPDIR = process.env.TMUX_TMPDIR;
if (!TMUX_TMPDIR) {
  throw new Error(
    "runner-tmpdir.test.ts: TMUX_TMPDIR is unset — this contract only holds beneath the supported runner (runtime/bun/test/run.sh exports it); refusing to assert against an unknown root",
  );
}

test("os.tmpdir() lands inside the runner-owned WORK root", () => {
  const workRoot = realpathSync(dirname(TMUX_TMPDIR));
  expect(realpathSync(tmpdir()).startsWith(workRoot + "/")).toBe(true);
});
