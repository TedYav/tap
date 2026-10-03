// E1 registry-native: the registry serializer is byte-identical to python's
// `json.dump(doc, indent=2, sort_keys=True)` + trailing newline, proven against
// a fixture whose expected bytes were captured ONCE from python3 and committed
// (fixtures/registry-serialize-oracle.json). The test never spawns python3.
// Shapes in the fixture, each a gap a UTF-16 or JSON.stringify emitter gets
// wrong: a non-ASCII string, an integer above 2^53, an astral-versus-BMP key
// pair (code-point order differs from UTF-16 order there), the noncanonical
// float 1e0, DEL (0x7F) raw and escaped, an empty key, empty containers.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pyDumpIndent } from "../src/lossless-json";
import { serializeRegistryDocument } from "../src/verbs/admin";
import { loads } from "../src/watch-detect";

const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/registry-serialize-oracle.json"), "utf8")) as { input: string; expected: string };

test("registry serialization matches python's json.dump(indent=2, sort_keys=True) bytes", () => {
  const doc = loads(oracle.input);
  // The DEL, café, λ, 1e0 and both wide-adjacent keys ride in the input text:
  // a raw DEL byte, a \u007F escape, the astral 😀 key sorting AFTER the BMP
  // \uE000 key (UTF-16 order flips them), the 2^53+1 digits intact.
  expect(pyDumpIndent(doc, 0) + "\n").toBe(oracle.expected);
  expect(serializeRegistryDocument(doc)).toBe(oracle.expected);
});
