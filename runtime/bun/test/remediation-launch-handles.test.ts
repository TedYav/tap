// remediation-launch-handles: a remedy that names a seat must CREATE that seat.
//
// Ported from skills/tap/scripts/smoke/remediation-launch-handles.test.sh. The
// invariant: wherever remediation text says `tap session launch <A> <B>`, the
// handle that command produces must be exactly <B> — a refusal like tap-goalie's
// `next: tap session launch hermes goalie && tap in goalie` is a door, and it
// only clears because the validation then finds the EXACT handle `goalie`.
//
// WHY THE GOALIE TEMPLATE IS THE ANCHOR. Handle derivation (`<preset>-<name>`)
// briefly shipped and made `launch hermes goalie` seat `hermes-goalie`; every
// remediation string of that shape silently stopped working and nothing
// connected the prose to the handle, because "the strings are prose, the handle
// is computed elsewhere". The live producer of that prose is
// verbs/goalie.ts's no_goalie_seat action, which renders the remedy from a
// template — invisible to any repo-text grep, and the only reason the shell
// sweep ever found a hit was its own header example. So the anchor here extracts
// the LIVE template, renders it, and pushes it through the same sweep pattern
// and the same resolver the sweep uses: the pattern cannot drift without this
// test knowing, and the next hard-coded remediation string added to the repo is
// caught by the sweep below.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Notices } from "../src/launcher/catalog-notices";
import { resolveTarget } from "../src/launcher/resolve-target";

const REPO = resolve(import.meta.dir, "../../..");
const GOALIE = join(REPO, "runtime/bun/src/verbs/goalie.ts");

// Two-token `tap session launch A B` inside repo text. Three deliberate limits,
// inherited from the shell sweep: placeholder spellings name no concrete seat,
// the match must END AT A COMMAND BOUNDARY (closing quote, &&, ·, end of LINE —
// the m flag makes `$` a line boundary the way grep -o saw it; without it only
// end-of-file matches), and a sweep that fails on English is a sweep someone
// deletes, so prose is not swept.
const PATTERN = /tap session launch ([a-z][a-z0-9-]+) ([a-z][a-z0-9-]+) *(?:"|&&|·|$)/gm;

// The empty-catalog resolver call: against no config, every bare name resolves
// on the HARNESS arm. Remediation text names harnesses; if a string ever names a
// preset, resolveTarget refuses here and the caller says so rather than silently
// skipping it.
function resolveRemedy(first: string, second: string): string {
  const cfg = mkdtempSync(join(tmpdir(), "remediation-launch-handles-"));
  try {
    return resolveTarget({ XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv, new Notices(), {
      first,
      second,
      usage: "tap session launch <preset|harness> [name]",
      verb: "tap session",
    }).handle;
  } catch (error) {
    throw new Error(
      `remediation string 'tap session launch ${first} ${second}' does not resolve at all: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
}

test("the live goalie remedy names a seat that the command actually creates", () => {
  const source = readFileSync(GOALIE, "utf8");
  const template = source.match(/`tap session launch ([a-z][a-z0-9-]+) \$\{handle\} && tap in \$\{handle\}`/);
  expect(template).not.toBeNull();
  const first = template![1]!;
  const rendered = `tap session launch ${first} goalie && tap in goalie`;
  // The sweep pattern must still recognize the producer's own output shape —
  // this is the drift guard, pinned to reality instead of to a hard-coded list.
  const swept = [...rendered.matchAll(PATTERN)];
  expect(swept).toHaveLength(1);
  expect(resolveRemedy(swept[0]![1]!, swept[0]![2]!)).toBe("goalie");
});

test("the sweep pattern keeps both command boundaries the shell grep had", () => {
  // A remedy that ends its LINE (the bare `next:` shape) and one that ends at a
  // closing quote must each match exactly once — the $ alternative was silently
  // dead until the m flag, and a quote must terminate without swallowing prose.
  expect([...("x\ntap session launch hermes goalie\ny".matchAll(PATTERN))]).toHaveLength(1);
  expect([...('"tap session launch hermes goalie"'.matchAll(PATTERN))]).toHaveLength(1);
});

describe("every concrete launch remedy string in repo text creates the seat it names", () => {
  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (entry.isFile()) yield path;
    }
  }

  const hits = new Set<string>();
  for (const root of ["skills", "hooks", "scripts"].map(dir => join(REPO, dir))) {
    for (const path of walk(root)) {
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue; // grep --binary-files=without-match
      for (const match of bytes.toString("utf8").matchAll(PATTERN)) hits.add(`${match[1]} ${match[2]}`);
    }
  }

  // `launch <harness> <digits>` is the numeric-resume spelling, not a handle.
  for (const hit of hits) {
    const [first, second] = hit.split(" ");
    if (!first || !second || /^[0-9]/.test(second)) continue;
    test(`tap session launch ${first} ${second}`, () => {
      expect(resolveRemedy(first, second)).toBe(second);
    });
  }
});