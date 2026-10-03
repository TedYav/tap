import { afterAll, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "pending-clock-"));
afterAll(() => removeScratchTree(scratch));
const bin = join(scratch, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "tmux"), '#!/bin/sh\n[ "$PENDING_TMUX" = unknown ] && exit 1\n[ "$PENDING_TMUX" = live ] && printf "demo/live\\n"\nexit 0\n');
chmodSync(join(bin, "tmux"), 0o755);
for (const name of ["bash", "python3"]) {
  writeFileSync(join(bin, name), "#!/bin/sh\nexit 99\n"); chmodSync(join(bin, name), 0o755);
}
const cases: [string, string, string, string, boolean, string][] = [
  ["missing", "demo/gone", "1970-01-01T00:00:00Z", "59", false, "grace:1"],
  ["missing", "demo/gone", "1970-01-01T00:00:00Z", "60", true, "grace:0"],
  ["live", "demo/live", "1970-01-01T00:00:00Z", "600", false, "alive"],
  ["unknown", "demo/gone", "1970-01-01T00:00:00Z", "600", false, "grace:0"],
  ["missing", "", "1970-01-01T00:00:00Z", "600", false, "grace:0"],
  ["missing", "demo/gone", "", "600", false, "grace:60"],
  ["missing", "demo/gone", "2026-02-30T00:00:00Z", "600", false, "grace:60"],
  ["missing", "demo/gone", "1970-01-01", "600", false, "grace:60"],
  ["missing", "demo/gone", "1970-01-01T00:00:00Z", "garbage", false, "grace:60"],
  ["missing", "demo/gone", "1970-01-01T00:00:00Z", "60.5", false, "grace:60"],
  ["missing", "demo/gone", "1970-01-01T00:00:00Z", "0x60", false, "grace:60"],
  ["missing", "demo/gone", "1970-1-1t0:0:0z", " +6_0 ", true, "grace:0"],
  ["missing", "demo/gone", "1970-01- 1T00:00:00Z", "60", true, "grace:0"],
  ["missing", "demo/gone", "1970-01-01T00:00:00Z", "\uFEFF60", false, "grace:60"],
  ["missing", "demo/gone", "1970-01-01T00:00:00Z", "٦٠", true, "grace:0"],
  ["missing", "demo/gone", "1970-01-01T00:01:00Z", "0", false, "grace:120"],
];
for (const [tmux, session, stamp, now, expired, grace] of cases) {
  test(`${tmux} ${JSON.stringify(session)} ${JSON.stringify(stamp)} now=${now}`, () => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PENDING_TMUX: tmux, TAP_WATCH_NOW: now };
    for (const [mode, expected] of [["expired", String(expired)], ["grace", grace]] as const) {
      // Poisoned Bash/Python make an accidental native -> legacy hop observable.
      const native = spawnSync(process.execPath, [join(root, "runtime/bun/src/pending-reservation.ts"), mode!, session, stamp], { env, encoding: "utf8" });
      expect(native.status).toBe(0); expect(native.stdout.trim()).toBe(expected);
    }
  });
}


test("a wedged tmux retains custody within its deadline and honors the socket pin", () => {
  const slow = join(scratch, "slow"); mkdirSync(slow);
  const args = join(scratch, "tmux-args");
  writeFileSync(join(slow, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PENDING_ARGS"\nexec /bin/sleep 10\n', { mode: 0o755 });
  // Allow process startup on a loaded native Mac; the fake still wedges for 10s.
  const env = { ...process.env, PATH: `${slow}:${process.env.PATH}`, TAP_TMUX_SOCKET: "pending-private", TAP_TMUX_SOCKET_PATH: "", PENDING_ARGS: args, TAP_TMUX_TIMEOUT_SECONDS: "1", TAP_WATCH_NOW: "60" };
  for (const [mode, expected] of [["expired", "false"], ["grace", "grace:0"]] as const) {
    rmSync(args, { force: true }); // Each mode must actually invoke the pinned tmux.
    const start = Date.now();
    const result = spawnSync(process.execPath, [join(root, "runtime/bun/src/pending-reservation.ts"), mode, "demo/gone", "1970-01-01T00:00:00Z"], { env, encoding: "utf8", timeout: 4000 });
    expect(result.status).toBe(0); expect(result.stdout.trim()).toBe(expected);
    expect(Date.now() - start).toBeLessThan(4000);
    expect(readFileSync(args, "utf8")).toBe("-L\npending-private\nlist-sessions\n-F\n#S\n");
  }
}, 10_000);
