// The differential suite's own safety property, tested rather than asserted.
//
// The property: if the reference implementation cannot be found, the differential
// suite must FAIL LOUDLY and never report green. That is exactly the
// success-shaped-signal class the differential suite exists to catch, so leaving
// it as a claim in a comment would be this file's own sin.
import { describe, expect, test } from "bun:test";

import { assertRealExit, findRefBin, refBinCandidates } from "./support/ref-lib";

describe("the reference BINARY lookup fails closed too", () => {
  // The differential CLI arms had neither of these properties until
  // The partner reviewer ran them from a detached clone: the path was built by walking
  // parent directories (author-topology only), and the guard accepted 127.
  test("no candidate on disk is a LOUD throw, never a skip", () => {
    expect(() => findRefBin(["/nope/a", "/nope/b"], () => false)).toThrow(/HARD FAILURE/);
  });

  test("the error names what it searched, so the remedy is derivable", () => {
    expect(() => findRefBin(["/nope/a"], () => false)).toThrow(/TAP_POC_REF_BIN/);
  });

  test("an explicit TAP_POC_REF_BIN wins over the derived paths", () => {
    const cands = refBinCandidates({ TAP_POC_REF_BIN: "/explicit/tap.sh" } as NodeJS.ProcessEnv);
    expect(cands[0]).toBe("/explicit/tap.sh");
  });

  test("candidates include one DERIVED from the installed tap", () => {
    // An assertion over the real list cannot tell derivation from a value that
    // merely happens to match (two earlier versions of this test were placebos
    // for exactly that reason). So the resolver takes an injected lookup, and
    // the test supplies a path that could ONLY have come from derivation.
    const derived = "/fake/tree/scripts/tap.sh";
    const cands = refBinCandidates({} as NodeJS.ProcessEnv, () => derived);
    expect(cands).toContain(derived);

    // And with NO installed tap and no explicit path, the list is empty, so
    // findRefBin throws rather than guessing one machine's checkout.
    const noInstall = refBinCandidates({} as NodeJS.ProcessEnv, () => undefined);
    expect(noInstall).toEqual([]);
  });

  test("a shell could-not-run code is rejected BY NAME, not by sign", () => {
    // `ref >= 0` was the original guard, and 127 is >= 0.
    expect(() => assertRealExit(127, "ref")).toThrow(/could not run/);
    expect(() => assertRealExit(126, "ref")).toThrow(/could not run/);
    expect(() => assertRealExit(-1, "ref")).toThrow(/did not run/);
    // A real refusal is not a spawn failure and must pass.
    expect(() => assertRealExit(2, "ref")).not.toThrow();
  });
});
