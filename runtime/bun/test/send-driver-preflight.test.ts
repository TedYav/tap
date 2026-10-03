// tap_serial_triggers "bin/" "runtime/bun/main.ts" "runtime/bun/src/verbs/send.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh" "runtime/bun/test/support/send-delivery-fixture.ts"
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, releaseScratch, run, routeOf } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);
type Fx = ReturnType<typeof fixture>;
const config = "<root>/xdg-config/tap/config.toml";
const unusable = "tap: " + config + " is unusable (insecure source, malformed TOML, or a non-string driver value); refusing rather than silently selecting tmux\n";
const configHome = (value: string) => 'tap: XDG_CONFIG_HOME is relative or unusable ("' + value + '"); the launcher\'s contract is an absolute config home, and a cwd-relative one would let the working directory choose the delivery door. Refusing.\n';
const unwired = (value: string) => 'tap: [harness.claude] driver = "' + value + '" in ' + config + ' names no WIRED driver; remove the driver key or set it to tmux\n';
const refusal = "tap send: the configured delivery driver for this recipient cannot be used; refusing before parking rather than queueing a message that would drain through tmux; next: tap doctor\n";

const rows: Array<{ name: string; source?: string; setup?: (fx: Fx, path: string) => void; diagnostic?: string; modal?: boolean }> = [
  { name: "relative XDG home", setup: fx => { fx.env.XDG_CONFIG_HOME = "relative"; }, diagnostic: configHome("relative") },
  { name: "relative HOME", setup: fx => { delete fx.env.XDG_CONFIG_HOME; fx.env.HOME = "relative"; }, diagnostic: configHome("") },
  { name: "unset HOME and XDG", setup: fx => { delete fx.env.XDG_CONFIG_HOME; delete fx.env.HOME; }, diagnostic: configHome("") },
  { name: "dangling config symlink", setup: (fx, path) => symlinkSync(join(fx.root, "absent"), path),
    diagnostic: "tap: " + config + " is a dangling symlink; refusing rather than silently selecting tmux for a config that is present but unreadable\n" },
  { name: "no config file" },
  { name: "absent family", source: '[harness.codex]\ndriver = "agy"\n' },
  { name: "absent driver key", source: '[harness.claude]\npermissions = "bypass"\n' },
  { name: "empty driver", source: '[harness.claude]\ndriver = ""\n',
    diagnostic: 'tap: [harness.claude] driver = "" in ' + config + ' names no driver; remove the key to use tmux\n' },
  { name: "insecure file", source: '[harness.claude]\ndriver = "tmux"\n', setup: (_, path) => chmodSync(path, 0o666), diagnostic: unusable },
  { name: "config directory", setup: (_, path) => mkdirSync(path), diagnostic: unusable },
  { name: "malformed TOML", source: '[harness.claude\n', diagnostic: unusable },
  { name: "non-string driver", source: '[harness.claude]\ndriver = 42\n', diagnostic: unusable },
  { name: "NUL in driver", source: '[harness.claude]\ndriver = "tmux\\u0000"\n', diagnostic: unusable },
  { name: "newline in driver", source: '[harness.claude]\ndriver = "tmux\\n"\n', diagnostic: unusable },
  { name: "illegal name", source: '[harness.claude]\ndriver = "not-legal"\n',
    diagnostic: 'tap: [harness.claude] driver = "not-legal" in ' + config + ' is not a legal driver name\n' },
  { name: "retired agy", source: '[harness.claude]\ndriver = "agy"\n', diagnostic: unwired("agy") },
  { name: "retired ccnative", source: '[harness.claude]\ndriver = "ccnative"\n', diagnostic: unwired("ccnative") },
  { name: "legal unwired name", source: '[harness.claude]\ndriver = "unwired"\n', diagnostic: unwired("unwired") },
  { name: "explicit tmux", source: '[harness.claude]\ndriver = "tmux"\n' },
  // Successful preflight still obeys the ordinary modal hold.
  { name: "force tmux bypasses bad config and reaches a modal hold", source: '[harness.claude\n', modal: true, setup: fx => { fx.env.TAP_DRIVER_FORCE_TMUX = "1"; } },
];

describe("U5 configured-driver preflight owns both refusal and tmux selection", () => {
  for (const row of rows) test(row.name, () => {
    const fx = fixture({ modal: row.modal });
    const directory = join(fx.env.XDG_CONFIG_HOME!, "tap");
    mkdirSync(directory);
    const path = join(directory, "config.toml");
    if (row.source !== undefined) writeFileSync(path, row.source, { mode: 0o600 });
    row.setup?.(fx, path);
    const v = run(fx, ["send", "rb", "-m", "driver control"], false);
    expect(v.route).toBe(routeOf("send"));
    if (row.diagnostic) {
      expect({ code: v.code, stdout: v.stdout, payloads: v.payloads, placed: v.placed, spool: v.spool, keys: v.keys })
        .toEqual({ code: 1, stdout: "", payloads: 0, placed: 0, spool: [], keys: [] });
      expect(readdirSync(join(fx.bus, "receipts"))).toEqual([]);
      expect(v.stderr).toBe(row.diagnostic + refusal);
    } else if (row.modal) {
      expect({ code: v.code, stderr: v.stderr, payloads: v.payloads, placed: v.placed, spool: v.spool, keys: v.keys })
        .toEqual({ code: 0, stderr: "", payloads: 0, placed: 1,
          spool: [{ reason: "no-input-prompt", policy: "standard", timeout_seconds: null, to: "rb" }], keys: [] });
      expect(v.stdout).toStartWith("tap send: queued <id>\nQueue: busy/no-input-prompt");
    } else {
      expect({ code: v.code, stderr: v.stderr, payloads: v.payloads, placed: v.placed, spool: v.spool })
        .toEqual({ code: 0, stderr: "", payloads: 1, placed: 1, spool: [] });
      expect(v.stdout).toBe("tap send: ok <id>\n");
      expect(v.keys.some(line => line.endsWith("Enter"))).toBe(true);
    }
  }, 120_000);
});
