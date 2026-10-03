import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// The TOCTOU re-check is the reason this read opens the path ONCE and then
// interrogates the descriptor: a name that stops pointing at the opened object
// between the open and the read must refuse rather than return the substitute.
//
// Deterministic rather than raced. The swap happens inside an instrumented
// `openSync`, after the real call has returned a descriptor on the original
// file and before the reader gets to `realpathSync` -- exactly the window the
// check exists to close, entered on purpose instead of hoped for. Its own file
// because the dynamic import below must be what binds the instrumented export.
test("a path retargeted after open refuses instead of reading the substitute", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "tap-secure-swap-"));
  roots.push(root);
  const original = join(root, "original.toml");
  const substitute = join(root, "substitute.toml");
  const link = join(root, "config.toml");
  fs.writeFileSync(original, 'version = 3\n');
  fs.writeFileSync(substitute, 'version = 3\nstolen = true\n');
  fs.chmodSync(original, 0o600);
  fs.chmodSync(substitute, 0o600);
  fs.symlinkSync(original, link);

  const realOpen = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((path: never, ...rest: never[]) => {
    const fd = (realOpen as never as (...a: never[]) => number)(path, ...rest);
    if (String(path) === link) { fs.unlinkSync(link); fs.symlinkSync(substitute, link); }
    return fd;
  }) as never);
  const { readSecureBytes } = await import("../src/launcher/catalog");
  try {
    // ONE swapped read, two assertions on the refusal it produced. Calling
    // twice would re-point the link at the file it already named -- not a swap.
    let refusal: Error | undefined;
    try { readSecureBytes(link); } catch (error) { refusal = error as Error; }
    expect(refusal?.message).toContain("changed while opening");
    expect(refusal?.message).toContain("preset_config_insecure");
  } finally {
    spy.mockRestore();
  }

  // Negative control, and it is the half that makes the arm above mean
  // something. With the instrumentation gone the link is an ordinary symlink to
  // an ordinary secure file and the same call succeeds -- so the refusal is
  // caused by the RETARGETING, not by the symlink, the spy, or the fixture.
  // (The first draft asserted the refusal twice instead. The second call
  // re-pointed the link at the file it already named, which is not a swap, so
  // the assertion was testing nothing and said so by failing.)
  expect(readSecureBytes(link).resolvedPath).toBe(fs.realpathSync(substitute));
});

// The NATIVE contract above is `preset_config_insecure` / "changed while
// opening". The retired Python `read_secure_preset_bytes` classed the same
// race `preset_config_invalid` with "source changed while it was being opened;
// retry" (its `_invalid`), and those texts are the facade's observable
// contract -- so the facade door supplies its own reader with a fault mapping
// and the shared native reader is not bent to match. Same swap, same window,
// asserting the mapping lands where it is scoped: on the facade's door only.
test("the Python facade reader maps the same race to the incumbent's class", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "tap-secure-swap-facade-"));
  roots.push(root);
  const original = join(root, "original.toml");
  const substitute = join(root, "substitute.toml");
  const link = join(root, "config.toml");
  fs.writeFileSync(original, 'version = 3\n');
  fs.writeFileSync(substitute, 'version = 3\nstolen = true\n');
  fs.chmodSync(original, 0o600);
  fs.chmodSync(substitute, 0o600);
  fs.symlinkSync(original, link);

  const realOpen = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((path: never, ...rest: never[]) => {
    const fd = (realOpen as never as (...a: never[]) => number)(path, ...rest);
    if (String(path) === link) { fs.unlinkSync(link); fs.symlinkSync(substitute, link); }
    return fd;
  }) as never);
  const { facadeSecureRead } = await import("../src/slices/preset-api");
  try {
    let refusal: Error | undefined;
    try { facadeSecureRead(link); } catch (error) { refusal = error as Error; }
    expect(refusal?.message).toContain("source changed while it was being opened; retry");
    expect(refusal?.message).toContain("preset_config_invalid");
  } finally {
    spy.mockRestore();
  }
});

// The rest of the post-open window, on both channels. The name is REMOVED
// after the open and nothing replaces it, so the reader fails at its
// resolve-phase re-check (realpath). The incumbent's secure reader wraps that
// OSError in `_invalid` ("could not resolve opened file"), while the native
// default must stay the raw Node error -- same window, two contracts.
test("a name removed after open refuses raw natively and through the facade's resolve mapping", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "tap-secure-vanish-"));
  roots.push(root);
  const original = join(root, "original.toml");
  const link = join(root, "config.toml");
  fs.writeFileSync(original, 'version = 3\n');
  fs.chmodSync(original, 0o600);
  fs.symlinkSync(original, link);

  const realOpen = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((path: never, ...rest: never[]) => {
    const fd = (realOpen as never as (...a: never[]) => number)(path, ...rest);
    // Remove the NAME only; the opened descriptor stays valid, so the read
    // proceeds to the resolve phase and finds nothing to resolve.
    if (String(path) === link) fs.unlinkSync(link);
    return fd;
  }) as never);
  const catalog = await import("../src/launcher/catalog");
  const { facadeSecureRead } = await import("../src/slices/preset-api");
  try {
    let nativeError: Error | undefined;
    try { catalog.readSecureBytes(link); } catch (error) { nativeError = error as Error; }
    expect(nativeError?.message).toContain("ENOENT");
    expect(nativeError?.message).not.toContain("could not resolve opened file");

    // The link must exist again for the facade arm's open to succeed; the spy
    // removes it once more, inside the same window.
    fs.symlinkSync(original, link);
    let refusal: Error | undefined;
    try { facadeSecureRead(link); } catch (error) { refusal = error as Error; }
    expect(refusal?.message).toContain("could not resolve opened file");
    expect(refusal?.message).toContain("preset_config_invalid");
  } finally {
    spy.mockRestore();
  }
});
