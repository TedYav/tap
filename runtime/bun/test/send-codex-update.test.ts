import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN, teamFixture, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

test.each([false, true])("public first send skips the real Codex update menu before its payload, urgent=%s", urgent => {
  const f = teamFixture({ command: "codex", codexChevron: true,
    seats: { ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "codex" } } });
  const bin = join(f.root, "update-bin"), original = join(f.env.PATH!.split(":")[0]!, "tmux");
  mkdirSync(bin);
  const frame = join(f.root, "update-menu"), skipped = join(f.root, "update-skipped");
  writeFileSync(frame, readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/update-available-real.txt")));
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
case "$*" in
  *capture-pane*)
    if [ ! -e '${skipped}' ]; then cat '${frame}'; exit 0; fi
    if [ ! -e "$FAKE_BAND" ]; then printf '› \\033[2mAsk Codex to do anything\\033[0m\\n'; exit 0; fi ;;
  *'#{pane_title}'*) printf 'Codex\\n'; exit 0 ;;
  *send-keys*Escape*)
    printf '%s\\n' "$*" >> "$FAKE_ALL_KEYS"
    : > '${skipped}'
    exit 0 ;;
esac
exec '${original}' "$@"
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const id = "ua-20261028T000000Z-aabbccddeeff";
  const body = join(f.root, "body.md"); writeFileSync(body, "A fixture note.");
  const result = Bun.spawnSync([process.execPath, MAIN, "send", "ub", "-f", body, "--from", "ua", "--ask", "--id", id,
    ...(urgent ? ["--urgent"] : [])], { cwd: f.wt, env: f.env });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const keys = readFileSync(f.env.FAKE_ALL_KEYS!, "utf8").trim().split("\n");
  expect(keys[0]).toContain("Escape");
  expect(keys.filter(line => line.includes("Escape"))).toHaveLength(1);
  expect(keys.some(line => line.includes(id))).toBe(true);
  expect(existsSync(join(f.bus, "receipts", `${id}.attempted`))).toBe(true);
  expect(existsSync(join(f.bus, "receipts", `${id}.sent`))).toBe(true);
  expect(readFileSync(join(f.bus, "registry-events.log"), "utf8")).toContain("0.164.0_->_0.165.0");
}, 30_000);
