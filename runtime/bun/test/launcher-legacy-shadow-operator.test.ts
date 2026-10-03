import { afterAll, expect, test } from "bun:test";
import { resolveCatalog } from "../src/launcher/catalog";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Rule 38, the legacy-shadow predicate: `-f`, not "any entry".
 *
 * `loadPresetCatalog` takes the predicate that decides whether a surviving
 * `presets.toml` SHADOWS the authority catalog. The incumbent asks
 * `legacy.is_file()` inside `except (OSError, PresetError)` (presets.py:1657-1661)
 * -- `-f`, symlinks followed, a throwing stat counting as FALSE. The port passed
 * `existsSync`, which is WIDER: any directory entry at all.
 *
 * The divergence is not hypothetical and not symmetric. A DIRECTORY named
 * `presets.toml` is an entry but not a file, so the port emitted a
 * legacy-shadowed notice about something that is not a legacy catalog while the
 * incumbent said nothing. A BROKEN SYMLINK agrees by accident -- `existsSync`
 * follows links and returns false -- which is exactly why reading the two
 * predicates side by side did not surface it: the obvious counterexample is the
 * one where they already agreed.
 */

const work = mkdtempSync(join(tmpdir(), "legacy-shadow-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let index = 0;

const AUTHORITY = 'version=3\n[presets.alpha]\nharness="claude"\n';
const SHADOW = "is no longer read and can be deleted";

/** A config dir with a populated config.toml, plus whatever `legacy` builds at presets.toml. */
function noticesWith(legacy: (path: string) => void): string[] {
  const dir = join(work, String(index++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  const config = join(dir, "tap", "config.toml");
  writeFileSync(config, AUTHORITY);
  chmodSync(config, 0o600);
  legacy(join(dir, "tap", "presets.toml"));
  const said: string[] = [];
  // A preset must actually be REQUESTED, or the catalog is never read and the
  // shadow branch is never reached -- `resolveCatalog` consults policy alone when
  // nothing was asked for. The first draft of this file passed `undefined` and
  // every "no shadow notice" arm passed vacuously; the positive control below is
  // what caught it.
  resolveCatalog("alpha", undefined, { XDG_CONFIG_HOME: dir, HOME: join(dir, "home") },
                 message => said.push(message));
  return said;
}

test("a real legacy file DOES shadow, and says so", () => {
  // The positive control. Without it, every arm below would pass against a
  // predicate that is simply always false, and "no shadow notice" would prove
  // nothing about the operator.
  const said = noticesWith(path => writeFileSync(path, 'version=3\n[presets.old]\nharness="codex"\n'));
  expect(said.filter(line => line.includes(SHADOW))).toHaveLength(1);
});

test("a DIRECTORY named presets.toml is not a legacy catalog", () => {
  // The row rule 38 asks for. `existsSync` is true here and `-f` is false, so
  // this is where the two operators actually disagree.
  expect(noticesWith(path => mkdirSync(path))).toEqual([]);
});

test("a broken symlink agrees under BOTH operators, which is why it proves nothing alone", () => {
  expect(noticesWith(path => symlinkSync(join(work, "nothing-here"), path))).toEqual([]);
});

test("a symlink TO a real file shadows: `-f` follows links", () => {
  // `lstat` would be the wrong port -- that is `-L`. The incumbent's
  // `Path.is_file()` follows, so a legacy catalog reached through a symlink is
  // still a legacy catalog.
  const target = join(work, `linked-${index}.toml`);
  writeFileSync(target, 'version=3\n[presets.old]\nharness="codex"\n');
  expect(noticesWith(path => symlinkSync(target, path)).filter(l => l.includes(SHADOW))).toHaveLength(1);
});

test("an absent presets.toml does not shadow", () => {
  expect(noticesWith(() => {})).toEqual([]);
});
