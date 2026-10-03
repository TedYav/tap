import { test, expect } from "bun:test";
import { launchCommand } from "../src/launcher/process";
test("owned short-lived groups tolerate exit racing cancellation", async () => {
  for (let i = 0; i < 100; i++) {
    const controller = new AbortController();
    const result = launchCommand(["/usr/bin/true"], { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("probe cancellation")), i % 3);
    expect([0, 143]).toContain((await result).code);
  }
});

test("cancellation reaps descendants even after their parent closes its pipes", async () => {
  const controller = new AbortController();
  const command = launchCommand(["/bin/sh", "-c", "(trap '' TERM; exec /bin/sleep 600) >/dev/null 2>&1 & echo $!; wait"], { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("cancel group")), 100);
  const result = await command;
  const descendant = Number(result.stdout.trim());
  expect(descendant).toBeGreaterThan(1);
  expect(() => process.kill(descendant, 0)).toThrow();
});

test("a timed-out command cannot turn into a successful mint when its TERM handler exits zero", async () => {
  const result = await launchCommand(["/bin/sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"], { timeoutMs: 100 });
  expect(result.code).toBe(124);
});
