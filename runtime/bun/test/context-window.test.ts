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

test("Darwin environment reads are deduplicated and chunked at 64 pids", () => {
  const pids = Array.from({length: 130}, (_, i) => String(i + 11));
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "-axo") return "10 1 zsh\n" + pids.map(pid => `${pid} 10 node`).join("\n");
    expect(args.slice(0, 5)).toEqual(["-E", "-ww", "-o", "pid=,command=", "-p"]);
    return args[5]!.split(",").map(pid => ` ${pid} node PATH=/bin CLAUDE_CODE_AUTO_COMPACT_WINDOW=420000`).join("\n") + "\n";
  };
  expect(claudeWindows(["10", "10", "11"], run, undefined, "darwin").get("10")).toEqual({state:"set", value:"420000"});
  expect(calls).toHaveLength(4);
  expect(calls.slice(1).map(args => args[5]!.split(",").length)).toEqual([64, 64, 2]);
});

test("missing pids and unreadable tables fail to unknown without a second inventory", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => { calls.push(args); return args[0] === "-axo" ? "10 1 zsh\n11 10 node\n12 10 node\n" : "11 node PATH=/bin\n"; };
  expect(claudeWindows(["10"], run, undefined, "darwin").get("10")).toEqual({state:"unknown"});
  expect(calls.filter(args => args[0] === "-axo")).toHaveLength(1);
  expect(claudeWindows(["10"], () => null, undefined, "darwin").get("10")).toEqual({state:"unknown"});
});

test("ambiguous environment row boundaries never attribute another process's window", () => {
  for (const batch of [
    "11 node PATH=/bin EXTRA=one\ncontinuation\n12 node PATH=/bin\n",
    "11 node PATH=/bin EXTRA=one\n12 node CLAUDE_CODE_AUTO_COMPACT_WINDOW=999\n12 node PATH=/bin\n",
    "11 node PATH=/bin\n999 node CLAUDE_CODE_AUTO_COMPACT_WINDOW=999\n",
  ]) {
    const run = (args: string[]) => args[0] === "-axo" ? "10 1 zsh\n11 10 node\n12 10 node\n" : args[3] === "pid=,command=" ? batch : null;
    expect(claudeWindows(["10"], run, undefined, "darwin").get("10")).toEqual({state:"unknown"});
  }
});
