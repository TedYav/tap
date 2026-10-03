import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", "courier-contract", name), "utf8");
const jsonl = (values: readonly unknown[]): string =>
  `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
const attemptFixture = (): Record<string, unknown>[] =>
  fixture("attempt-pair.jsonl").trimEnd().split("\n").map((line) => JSON.parse(line));
const modulePath = join(import.meta.dir, "..", "src", "courier-contract.ts");
const contract = async () => {
  expect(existsSync(modulePath), "courier-contract.ts exists").toBe(true);
  return import("../src/courier-contract");
};

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;
type _ReparkImpliesNoEffect = Assert<
  Equal<
    Extract<import("../src/courier-contract").DeliveryResult, { action: "repark" }>["effect"],
    "none"
  >
>;
type _InvalidIntentQuarantines = Assert<
  Equal<
    import("../src/courier-contract").InvalidIntentDisposition,
    { action: "quarantine"; notice: "failed"; terminal: true }
  >
>;

describe("courier cross-lane contract", () => {
  test("intent golden round-trips every KTD2 field", async () => {
    const { decodeCourierIntent, encodeCourierIntent } = await contract();
    const raw = fixture("intent.json");
    expect(encodeCourierIntent(decodeCourierIntent(raw))).toBe(raw);
  });

  test("attempt rows round-trip as an explicit begin/outcome pair", async () => {
    const { decodeAttemptRows, encodeAttemptRows, joinAttemptRows } = await contract();
    const raw = fixture("attempt-pair.jsonl");
    const rows = decodeAttemptRows(raw);
    expect(typeof joinAttemptRows, "explicit pairing API").toBe("function");
    const readout = joinAttemptRows(rows);
    const pair = readout.paired[0];

    expect(rows.map(({ phase }) => phase)).toEqual(["begin", "outcome"]);
    expect(pair?.begin.attempt_id).toBe(pair?.outcome.attempt_id);
    expect(pair?.begin.driver).toBe("tmux");
    expect(pair?.outcome).toMatchObject({
      driver: "tmux",
      disposition: "delivered",
      effect: "possible",
      tier: "left-input-band",
    });
    expect(readout.paired).toHaveLength(1);
    expect(pair?.attempt_id).toBe(pair?.begin.attempt_id);
    expect(readout.pre_begin).toEqual([]);
    expect(readout.unverified).toBeNull();
    expect(encodeAttemptRows(rows)).toBe(raw);
  });

  test("an outcome with a different attempt id is not a pair", async () => {
    const { decodeAttemptRows, joinAttemptRows } = await contract();
    const [begin, outcome] = attemptFixture();
    expect(typeof joinAttemptRows, "explicit pairing API").toBe("function");
    const readout = joinAttemptRows(decodeAttemptRows(jsonl([
      begin,
      { ...outcome, attempt_id: "alice-20260830T150000Z-aabbccddeeff:2" },
    ])));
    expect(readout.paired).toEqual([]);
    expect(readout.unverified).toMatchObject({ effect: "possible" });
    expect(readout.unverified?.rows).toHaveLength(2);
  });

  test("empty attempt correlation identifiers remain unverified", async () => {
    const { decodeAttemptRows, joinAttemptRows } = await contract();
    const [begin, outcome] = attemptFixture();
    const rows = decodeAttemptRows(jsonl([
      { ...begin, payload_id: "payload-a", attempt_id: "" },
      { ...outcome, payload_id: "payload-b", attempt_id: "" },
    ]));
    const readout = joinAttemptRows(rows);

    expect(rows.map(({ phase }) => phase)).toEqual(["opaque", "opaque"]);
    expect(readout.paired).toEqual([]);
    expect(readout.unverified).toMatchObject({ effect: "possible" });
    expect(readout.unverified?.rows).toHaveLength(2);
  });

  test("the same attempt id across different payloads is not a pair", async () => {
    const { decodeAttemptRows, joinAttemptRows } = await contract();
    const [begin, outcome] = attemptFixture();
    const rows = decodeAttemptRows(jsonl([
      { ...begin, payload_id: "payload-a" },
      { ...outcome, payload_id: "payload-b" },
    ]));
    const readout = joinAttemptRows(rows);

    expect(readout.paired).toEqual([]);
    expect(readout.unverified).toMatchObject({ effect: "possible" });
    expect(readout.unverified?.rows).toHaveLength(2);
  });

  test("a possible-effect begin cannot resolve as a pre-begin outcome", async () => {
    const { decodeAttemptRows, joinAttemptRows } = await contract();
    const [begin, outcome] = attemptFixture();
    expect(typeof joinAttemptRows, "explicit pairing API").toBe("function");
    for (const action of ["repark", "cancel"] as const) {
      expect(() => joinAttemptRows(decodeAttemptRows(jsonl([
        begin,
        { ...outcome, disposition: action, effect: "none", tier: "none" },
      ]))), action).toThrow("effect-none");
    }
  });

  test("an unmatched begin remains a legal unverified attempt", async () => {
    const { decodeAttemptRows, joinAttemptRows } = await contract();
    const [begin] = attemptFixture();
    expect(typeof joinAttemptRows, "explicit pairing API").toBe("function");
    const readout = joinAttemptRows(decodeAttemptRows(jsonl([begin])));
    expect(readout.paired).toEqual([]);
    expect(readout.unverified).toMatchObject({ effect: "possible", rows: [begin] });
  });

  test("queued spool receipt golden stays honest about placement", async () => {
    const { decodeQueuedSpoolReceipt, encodeQueuedSpoolReceipt } = await contract();
    const raw = fixture("queued-spool-receipt.json");
    const receipt = decodeQueuedSpoolReceipt(raw);

    expect(receipt).toMatchObject({
      status: "queued",
      delivery: "spool",
      turn: "unconfirmed",
    });
    expect(receipt.path).toContain("/payloads/");
    expect(receipt.meta).toContain("/spool/");
    expect(encodeQueuedSpoolReceipt(receipt)).toBe(raw);
  });

  test("only the ruled action/effect pairs are legal", async () => {
    const { isActionEffectPair } = await contract();
    const expected = new Map([
      ["repark:none", true],
      ["repark:possible", false],
      ["cancel:none", true],
      ["cancel:possible", true],
      ["unconfirmed:none", false],
      ["unconfirmed:possible", true],
      ["delivered:none", false],
      ["delivered:possible", true],
    ]);

    for (const [pair, allowed] of expected) {
      const [action, effect] = pair.split(":") as [
        "repark" | "cancel" | "unconfirmed" | "delivered",
        "none" | "possible",
      ];
      expect(isActionEffectPair(action, effect), pair).toBe(allowed);
    }
  });

  test("an intent missing a frozen field is refused", async () => {
    const { decodeCourierIntent } = await contract();
    const value = JSON.parse(fixture("intent.json"));
    delete value.pane_id;
    expect(() => decodeCourierIntent(`${JSON.stringify(value)}\n`)).toThrow("pane_id");
  });

  test("excluded intents require an escalated notify-and-cancel disposition", async () => {
    const { decodeCourierIntent } = await contract();
    const intent = JSON.parse(fixture("intent.json"));
    const invalid = [
      { disposition_at_deadline: "notify-and-hold", escalated_at: 1 },
      { disposition_at_deadline: "deliver-anyway", escalated_at: 1 },
      { disposition_at_deadline: "notify-and-cancel", escalated_at: null },
    ];

    for (const fields of invalid) {
      expect(() => decodeCourierIntent(jsonl([{ ...intent, ...fields, excluded: true }]))).toThrow("excluded");
    }
    expect(decodeCourierIntent(jsonl([{
      ...intent,
      disposition_at_deadline: "notify-and-cancel",
      escalated_at: 1,
      excluded: true,
    }]))).toMatchObject({ excluded: true });
  });

  test("behavior-record codecs reject unknown fields", async () => {
    const { decodeCourierIntent, decodeQueuedSpoolReceipt } = await contract();
    const intent = { ...JSON.parse(fixture("intent.json")), bonus: true };
    const receipt = { ...JSON.parse(fixture("queued-spool-receipt.json")), bonus: true };

    expect(() => decodeCourierIntent(`${JSON.stringify(intent)}\n`), "intent").toThrow("bonus");
    expect(() => decodeQueuedSpoolReceipt(`${JSON.stringify(receipt)}\n`), "receipt").toThrow("bonus");
  });

  test("attempt extensions survive decode and encode", async () => {
    const { decodeAttemptRows, encodeAttemptRows } = await contract();
    const [begin] = attemptFixture();
    const raw = jsonl([{ ...begin, bonus: { future: 1 } }]);
    expect(encodeAttemptRows(decodeAttemptRows(raw))).toBe(raw);
  });

  test("an undecodable attempt line remains opaque possible-effect evidence", async () => {
    const { decodeAttemptRows, encodeAttemptRows, joinAttemptRows } = await contract();
    const raw = '{"v":1,"attempt_id":"cut-off"\n';
    const rows = decodeAttemptRows(raw);
    expect(typeof joinAttemptRows, "explicit pairing API").toBe("function");
    expect(rows).toEqual([{ phase: "opaque", raw: raw.trimEnd(), effect: "possible" }]);
    expect(encodeAttemptRows(rows)).toBe(raw);
    expect(joinAttemptRows(rows)).toEqual({
      paired: [],
      pre_begin: [],
      unverified: { effect: "possible", rows },
    });
  });

  test("an unterminated final attempt fragment remains exact opaque evidence", async () => {
    const { decodeAttemptRows, encodeAttemptRows, joinAttemptRows } = await contract();
    const begin = attemptFixture()[0]!;
    const tail = '{"v":1,"attempt_id":"cut-off"';
    const raw = `${JSON.stringify(begin)}\n${tail}`;
    const rows = decodeAttemptRows(raw);
    const readout = joinAttemptRows(rows);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.phase).toBe("begin");
    if (rows[0]?.phase !== "begin") throw new Error("first attempt row must decode as begin");
    expect(rows[0].attempt_id).toBe("alice-20260830T150000Z-aabbccddeeff:1");
    expect(rows[1]).toEqual({ phase: "opaque", raw: tail, effect: "possible", terminated: false });
    expect(encodeAttemptRows(rows)).toBe(raw);
    expect(readout).toMatchObject({
      paired: [],
      pre_begin: [],
      unverified: { effect: "possible" },
    });
    expect(readout.unverified?.rows).toHaveLength(2);
  });
});
