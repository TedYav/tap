import { readFileSync } from "node:fs";
import { installFzf } from "../../src/install-fzf";

// The pinned binary is a required test dependency, never a skipped test. Local
// runs may supply the already-downloaded release archive; CI provisions the
// identical checksum-verified artifact into the runner's scratch index. run.sh sets the
// variable from the account's verified cache (fzf-archive-pin.sh) when one exists.
export async function fixtureFzf(env: NodeJS.ProcessEnv): Promise<string> {
  const archive = process.env.TAP_FZF_TEST_ARCHIVE;
  return installFzf({ env, ...(archive ? { download: async () => readFileSync(archive) } : {}) });
}
