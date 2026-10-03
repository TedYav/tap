import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCatalog, readSecureBytes } from "../src/launcher/catalog";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(contents: Buffer | string, mode = 0o600) {
  const root = mkdtempSync("/tmp/tap-secure-read-");
  roots.push(root);
  mkdirSync(join(root, "tap"));
  const path = join(root, "tap/config.toml");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return { root, path };
}

// A's requirement: the digest-window writer reads the same file and must see a
// leading BOM, so the secure read hands back undecoded bytes. The two doors still
// answer differently about the same file — but the parsed door now REFUSES that
// file rather than quietly consuming its BOM.
//
// This test used to end `expect(readCatalog(path).data.version).toBe(3)`, and its
// title said "while the parsed door consumes it". That was the port's behavior
// and it was wrong against the incumbent: `tomllib` refuses a leading U+FEFF, so
// a BOM-prefixed config degrades to NO harness policy in Python while the port
// read it and applied the fenced env tier. Rule 40 / tap-uddlm family T3.
//
// The half worth keeping is the first half, and it is unchanged: raw bytes, BOM
// intact, for A's writer.
test("secure read returns bytes verbatim, BOM intact; the parsed door refuses that file", () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('version = 3\n')]);
  const { path } = fixture(bytes);
  const raw = readSecureBytes(path);
  expect([...raw.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(raw.bytes.length).toBe(bytes.length);
  expect(() => readCatalog(path)).toThrow("preset_config_invalid");
  // The same bytes without the mark go through, so the refusal is about the BOM
  // and not about the reader having become unable to read anything.
  expect(readCatalog(fixture('version = 3\n').path).data.version).toBe(3);
});

test("the digest covers the raw bytes, not the decoded projection", () => {
  const body = 'version = 3\n';
  const plain = fixture(body);
  const withBom = fixture(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));
  // The premise this used to state through `readCatalog` — "same parsed document,
  // different files" — can no longer be stated that way, because the parsed door
  // refuses the BOM file. It is still true of the DECODED TEXT, which is what the
  // claim was always about: `TextDecoder` drops the mark, so a digest taken after
  // decoding would call these two files identical and a config change would go
  // unwitnessed.
  const decode = (b: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(b);
  expect(decode(readSecureBytes(withBom.path).bytes)).toBe(decode(readSecureBytes(plain.path).bytes));
  expect(readSecureBytes(plain.path).digest).not.toBe(readSecureBytes(withBom.path).digest);
});

test("group or world writable config refuses through both doors", () => {
  for (const mode of [0o620, 0o602, 0o666]) {
    const { path } = fixture('version = 3\n', mode);
    expect(() => readSecureBytes(path)).toThrow("preset_config_insecure");
    expect(() => readCatalog(path)).toThrow("preset_config_insecure");
  }
});

// The permission check interrogates the OPENED DESCRIPTOR, so it sees the
// target's mode. A symlink is always 0777 on this platform, so a check that
// lstat'd the name instead would refuse every symlinked config — and a check
// that stat'd the name would still pass this. Both arms are needed: the secure
// link must be accepted and the insecure target must be refused.
test("permission is judged on the opened target, not on the symlink naming it", () => {
  const secure = fixture('version = 3\n', 0o600);
  const link = join(secure.root, "tap/linked.toml");
  symlinkSync(secure.path, link);
  // realpath on both sides deliberately: /tmp is a symlink to /private/tmp on
  // macOS, so a literal comparison here would put two spellings of one
  // directory on either side of the assertion and fail on the platform the
  // gate runs on.
  expect(readSecureBytes(link).resolvedPath).toBe(realpathSync(secure.path));

  const insecure = fixture('version = 3\n', 0o666);
  const badLink = join(insecure.root, "tap/linked.toml");
  symlinkSync(insecure.path, badLink);
  expect(() => readSecureBytes(badLink)).toThrow("preset_config_insecure");
});

test("a directory at the config path refuses rather than reading", () => {
  const root = mkdtempSync("/tmp/tap-secure-read-");
  roots.push(root);
  mkdirSync(join(root, "tap/config.toml"), { recursive: true });
  expect(() => readSecureBytes(join(root, "tap/config.toml"))).toThrow("preset_config_insecure");
});

test("an absent config is classed as missing and still carries its ENOENT code", () => {
  const root = mkdtempSync("/tmp/tap-secure-read-");
  roots.push(root);
  // Infrastructure absence is its own answer: it must not arrive wearing the
  // insecure/invalid refusal that means "this file is present and wrong". It
  // gets its OWN class -- the incumbent's `preset_config_missing`, remedied by
  // creating the file -- while keeping `code` so callers that already branch on
  // ENOENT are unaffected. Both halves are asserted because dropping either one
  // is a silent behavior change for a different caller.
  let caught: { code?: string; errorClass?: string; action?: string } = {};
  try { readSecureBytes(join(root, "missing.toml")); } catch (error) { caught = error as never; }
  expect(caught.code).toBe("ENOENT");
  expect(caught.errorClass).toBe("preset_config_missing");
  expect(caught.action).toContain("create ");
});
