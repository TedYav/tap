import { afterAll, expect, test } from "bun:test";
import { resolveCatalog } from "../src/launcher/catalog";
import { loadHarnessPolicy } from "../src/launcher/catalog-listing";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The tier-2 degradation notice (tap-03b71 §3 / tap-dv0b6).
 *
 * When harness policy cannot be read the launch PROCEEDS -- resume is the
 * recovery verb and has to run in the failure state, so refusing is the wrong
 * answer and silence is the wrong answer. What is left is the notice, and the
 * port's generic "catalog unavailable; harness policy is not applied" told the
 * operator that something was wrong without telling them WHAT or what to do.
 * The incumbent's `_degraded_notice` (presets.py:1849-1854) interpolates the
 * refusal's own `detail` and `action`, so the operator reads the one fault that
 * is actually true and the command that repairs it.
 *
 * These arms assert the CONTENT, not merely that a notice happened. A test that
 * only checked "some notice was emitted" passed throughout the period the
 * generic line was shipping, which is the whole reason three oracle rows were
 * red against an implementation that was already speaking.
 */

const work = mkdtempSync(join(tmpdir(), "degrade-notice-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let index = 0;

/** A config directory whose `tap/config.toml` is built by `shape`. */
function fixture(shape: (path: string) => void): string {
  const dir = join(work, String(index++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  shape(join(dir, "tap", "config.toml"));
  return dir;
}

function noticesFor(dir: string): string[] {
  const said: string[] = [];
  resolveCatalog(undefined, "claude", { XDG_CONFIG_HOME: dir, HOME: join(dir, "home") },
                 message => said.push(message));
  return said;
}

const POLICY = 'version=3\n[harness.claude]\nenv.POLICY_TIER_TWO="from-config"\n';

test("a group/world-writable config names THAT fault and hands over chmod", () => {
  const said = noticesFor(fixture(path => {
    writeFileSync(path, POLICY);
    chmodSync(path, 0o666);
  }));
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("could not read harness environment policy from");
  expect(said[0]).toContain("preset config is group/world writable:");
  expect(said[0]).toContain("launching WITHOUT it; harness policy is not being applied.");
  expect(said[0]).toContain("Fix: chmod 600 ");
  // The fault it is NOT. Before the split, one merged refusal said "must be a
  // regular file without group/world write permission" for both shapes, which
  // sends a mode-666 operator looking at file kinds.
  expect(said[0]).not.toContain("not a regular file");
});

test("a config that is a DIRECTORY names that fault instead, with its own repair", () => {
  const said = noticesFor(fixture(path => mkdirSync(path)));
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("preset config is not a regular file:");
  expect(said[0]).toContain("Fix: replace ");
  expect(said[0]).toContain("with an operator-owned regular file");
  expect(said[0]).not.toContain("group/world writable");
  expect(said[0]).not.toContain("chmod 600");
});

test("the prefix is `tap session:`, which is not the prefix this reader's other notices use", () => {
  // The incumbent uses BOTH and they are not interchangeable: a parse-level
  // finding about the file is `tap config:`, while this one reports a
  // CONSEQUENCE FOR THE LAUNCH and is `tap session:`. The port had canonicalized
  // everything to `tap config:` on the reasoning that one reader owns one prefix.
  const said = noticesFor(fixture(path => {
    writeFileSync(path, POLICY);
    chmodSync(path, 0o666);
  }));
  // Asserted through `said`, not `said[0]!`: a non-null assertion here would
  // turn "no notice was emitted at all" into a crash rather than a readable
  // failure, and that is precisely the regression this file must report clearly.
  expect(said).toHaveLength(1);
  expect(said.filter(line => line.startsWith("tap session: "))).toHaveLength(1);
  expect(said[0]).not.toContain("tap config:");
  expect(said[0]).not.toContain("catalog unavailable");
});

test("a malformed config degrades with the same shape, carrying the parse detail", () => {
  const said = noticesFor(fixture(path => writeFileSync(path, "invalid [[[\n")));
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("tap session: could not read harness environment policy from");
  expect(said[0]).toContain("invalid preset config ");
  expect(said[0]).toContain("TOML parse failed");
  expect(said[0]).toContain("Fix: fix ");
});

test("an ABSENT config is silence, not a fault", () => {
  // The one shape that must NOT speak: no config is the default posture, and a
  // notice here would fire on every launch of a machine that never wrote one.
  expect(noticesFor(fixture(() => {}))).toEqual([]);
});

test("a plain filesystem error still names a fault and a repair, never 'undefined'", () => {
  // The window is real: `readSecureBytes` wraps its own refusals, but
  // `realpathSync`, `statSync` and `readFileSync` run UNWRAPPED after `openSync`
  // has already succeeded — so a config unlinked or made unreadable inside that
  // window arrives here as a plain Node error carrying neither `detail` nor
  // `action`. The notice rendered "(undefined) … Fix: undefined": this notice,
  // the one this file exists for, failing at exactly the moment an operator
  // needs the filesystem fault in order to recover.
  //
  // Driven through the PRODUCTION reader by injecting the `read` it already
  // takes as a parameter, rather than by restating the fallback in the test. An
  // earlier draft of this arm computed `detail ?? message` itself and passed
  // whether or not the production code did the same thing — a green that proved
  // only that the test could do arithmetic.
  const said: string[] = [];
  const throwPlain = () => { throw new Error("EIO: i/o error, read"); };
  const got = loadHarnessPolicy(m => said.push(m), throwPlain as never, "/nowhere");

  expect(got.policy).toEqual({});               // the launch still proceeds
  expect(said).toHaveLength(1);
  expect(said[0]).not.toContain("undefined");   // the defect, named directly
  expect(said[0]).toContain("EIO: i/o error, read");
  expect(said[0]).toContain("Fix: fix /nowhere/config.toml");
  expect(said[0]).toContain("harness policy is not being applied");
});
