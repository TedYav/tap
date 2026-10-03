import { expect, test } from "bun:test";
import { repaintPane, type RepaintIO } from "../src/pane/repaint";
import type { Run } from "../src/tmux";

const ok = (stdout = ""): Run => ({ code: 0, stdout, stderr: "" });

function fixture(absorb = false, initialOption: string | null = null) {
  let width = 113;
  let option = initialOption;
  const resizes: number[] = [];
  const restoredOptions: Array<string | null> = [];
  let captures = 0;
  const io: RepaintIO = {
    describe: () => ok(`%332\u001f@91\u001f${width}\u001f29\n`),
    windowSize: () => ok(option ?? ""),
    capture: () => ok(`frame-${++captures}`),
    resize: (_window, next) => { resizes.push(next); option = "manual"; if (!absorb || next === 113) width = next; return ok(); },
    restoreWindowSize: (_window, value) => { restoredOptions.push(value); option = value; return ok(); },
    lock: () => ({ release() {} }),
    settle: () => {},
  };
  return { io, resizes, restoredOptions, get width() { return width; }, get option() { return option; } };
}

test("one-column repaint restores original geometry and inherited window-size policy", () => {
  const f = fixture();
  const result = repaintPane("%332", f.io);
  expect(result).toMatchObject({ ok: true, attempted: true, before: "frame-1", after: "frame-2" });
  expect(f.resizes).toEqual([112, 113]);
  expect(f.restoredOptions).toEqual([null]);
  expect(f.width).toBe(113);
  expect(f.option).toBeNull();
});

test("an explicit window-size policy is restored exactly", () => {
  const f = fixture(false, "latest");
  expect(repaintPane("%332", f.io).ok).toBe(true);
  expect(f.restoredOptions).toEqual(["latest"]);
  expect(f.option).toBe("latest");
});

test("an absorbed resize is refused after restoration instead of assumed", () => {
  const f = fixture(true);
  const result = repaintPane("%332", f.io);
  expect(result).toMatchObject({ ok: false, attempted: true, reason: "window resize was not observed" });
  expect(f.resizes).toEqual([112, 113]);
  expect(f.width).toBe(113);
  expect(f.option).toBeNull();
});

test("capture or target-identity failure never attempts a resize", () => {
  const f = fixture();
  f.io.describe = () => ok(`%999\u001f@91\u001f113\u001f29\n`);
  expect(repaintPane("%332", f.io)).toMatchObject({ ok: false, attempted: false });
  expect(f.resizes).toEqual([]);
});

test("a throwing resize is restored and reported as an attempted repaint", () => {
  const f = fixture();
  let calls = 0;
  f.io.resize = (_window, next) => {
    f.resizes.push(next);
    if (++calls === 1) { throw new Error("client timed out"); }
    return ok();
  };
  const result = repaintPane("%332", f.io);
  expect(result).toMatchObject({ ok: false, attempted: true });
  expect(result.reason).toContain("unconfirmed");
  expect(f.resizes).toEqual([112, 113]);
  expect(f.restoredOptions).toEqual([null]);
});

test("window-level lock refusal prevents every repaint effect", () => {
  const f = fixture();
  f.io.lock = () => null;
  expect(repaintPane("%332", f.io)).toMatchObject({ ok: false, attempted: false, reason: "window repaint is already in progress" });
  expect(f.resizes).toEqual([]);
});
