// Test-only shell transport; use the native bounded client without rate/cache writes.
import { ServerUnresponsive, tmuxAttachClient, tmuxClientEffect } from "../../src/tmux";
const args = process.argv.slice(2);
try {
  let i = 0;
  while (args[i]?.startsWith("-")) i += ["-L", "-S", "-f", "-T", "-c"].includes(args[i]!) ? 2 : 1;
  if (["attach", "attach-session"].includes(args[i] ?? "") || args.slice(0, i).some(a => a === "-C" || a === "-CC")) {
    process.exitCode = tmuxAttachClient(args);
  } else {
    const r = tmuxClientEffect(args);
    process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.code;
  }
} catch (error) {
  if (error instanceof ServerUnresponsive && error.tmuxResult) process.stderr.write(error.tmuxResult.stderr);
  process.stderr.write(`tap: ${error instanceof Error ? error.message : error}; do not retry a possible effect\n`);
  process.exitCode = error instanceof ServerUnresponsive ? 124 : 127;
}
