import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Native behavior has separate real-CLI probes; ordinary tests use captured JSON. */
export function fakePluginClis(directory: string, hosts = ["claude", "codex"]): void {
  mkdirSync(directory, { recursive: true });
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const fixture = resolve(import.meta.dir, "../fixtures/native-plugin-cli.ts");
  for (const host of hosts) writeFileSync(join(directory, host), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(host)} "$@"\n`, { mode: 0o755 });
}
