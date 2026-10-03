import { expect, test } from "bun:test";
import { claudeWindows, parseWindowEnvironment } from "../src/context-window";
test("environment reader separates set, unset, unreadable and disagreement", () => {
  const table = "10 1 zsh\n11 10 node\n12 11 node\n20 1 claude\n";
  const read = (values: Record<string,string|null>) => claudeWindows(["10"], () => table, pid => values[pid] ?? null).get("10");
  expect(read({11:"claude CLAUDE_CODE_AUTO_COMPACT_WINDOW=420000 PATH=/bin",12:"node CLAUDE_CODE_AUTO_COMPACT_WINDOW=420000"})).toEqual({state:"set",value:"420000"});
  expect(read({11:"CLAUDE_CODE_AUTO_COMPACT_WINDOW=420000",12:"CLAUDE_CODE_AUTO_COMPACT_WINDOW=350000"})).toEqual({state:"unknown"});
  expect(read({11:"PATH=/bin",12:"PATH=/bin"})).toEqual({state:"unset"});
  expect(read({11:"PATH=/bin",12:null})).toEqual({state:"unknown"});
  expect(read({11:"",12:""})).toEqual({state:"unknown"});
  expect(claudeWindows(["99"],()=>table).get("99")).toEqual({state:"unknown"});
  expect(parseWindowEnvironment("PATH=/bin\0CLAUDE_CODE_AUTO_COMPACT_WINDOW=350000\0")).toEqual({state:"set",value:"350000"});
  expect(parseWindowEnvironment("CLAUDE_CODE_AUTO_COMPACT_WINDOW=")).toEqual({state:"set",value:""});
});
