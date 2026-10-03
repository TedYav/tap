import { expect, test } from "bun:test";
import { chooseAttachSelection, chooseAttachTarget, seatRow, type Choose } from "../src/attach-picker";
const teams = [
  { name: "alpha", state: "ok", detail: "", seats: [{ handle: "fable", harness: "claude", session: "alpha/fable", crew: false }] },
  { name: "beta", state: "ok", detail: "", seats: [{ handle: "sol", harness: "codex", session: "beta/sol", crew: false }] },
  { name: "old", state: "historical", detail: "no live seats", seats: [] },
];
test("team and seat choices retain canonical targets, not display strings", async () => {
  let call = 0;
  const choose: Choose = async (rows, options) => {
    expect(options.verb).toBe("attach");
    return { kind: "selected", values: [rows[call++ === 0 ? 1 : 0]!.value] };
  };
  expect(await chooseAttachTarget({ teams, observable: true }, choose)).toEqual({ kind: "selected", values: ["beta/sol"] });
});
test("teams without a live seat are never offered; an unobservable team stays visible", async () => {
  const labelled = [
    ...teams,
    { name: "unob", state: "unobservable", detail: "seat classifier could not observe this team", seats: [] },
  ];
  const labels: string[] = [];
  let call = 0;
  const choose: Choose = async rows => {
    labels.push(...rows.map(row => row.label));
    return { kind: "selected", values: [rows[call++ === 0 ? 2 : 0]!.value] };
  };
  await expect(chooseAttachTarget({ teams: labelled, observable: false }, choose)).rejects.toMatchObject({ errorClass: "team_unavailable" });
  expect(labels).toEqual(["alpha  1 live seats", "beta  1 live seats", "unob  unobservable: seat classifier could not observe this team"]);
});
test("a fleet with no live attachable seat refuses instead of opening an empty picker", async () => {
  const choose: Choose = async () => { throw new Error("picker must not open"); };
  const model = { teams: [
    { name: "zeta", state: "ok", detail: "", seats: [] },
    { name: "old", state: "historical", detail: "no live seats", seats: [] },
  ], observable: true };
  await expect(chooseAttachTarget(model, choose)).rejects.toMatchObject({ errorClass: "no_candidates" });
});
test("a scoped team with no live seats refuses by name", async () => {
  const choose: Choose = async () => { throw new Error("picker must not open"); };
  const model = { teams: [
    { name: "zeta", state: "ok", detail: "", seats: [] },
    ...teams,
  ], observable: true };
  await expect(chooseAttachSelection(model, choose, { team: "zeta", seatQuery: "x" }))
    .rejects.toMatchObject({ errorClass: "no_candidates", detail: "zeta has no live attachable seats" });
});
for (const stage of [0, 1]) test(`cancelling stage ${stage} returns no attach target`, async () => {
  let call = 0;
  const choose: Choose = async rows => call++ === stage ? { kind: "cancelled" } : { kind: "selected", values: [rows[0]!.value] };
  expect(await chooseAttachTarget({ teams, observable: true }, choose)).toEqual({ kind: "cancelled" });
});
test("row labels show noncanonical sessions and crew without terminal controls", () => {
  expect(seatRow(teams[0]!.seats[0]!, "alpha")).toBe("fable  claude");
  expect(seatRow({ handle: "crew", harness: "codex", session: "alpha/fable", crew: true }, "alpha")).toBe("crew  codex  alpha/fable (crew)");
});

test("known-team seat miss skips the fleet stage and seeds only that team's seat search", async () => {
  let calls = 0;
  const choose: Choose = async (rows, options) => {
    calls++;
    expect(options.query).toBe("so");
    expect(rows.map(row => row.label)).toEqual(["sol  codex"]);
    return { kind: "selected", values: [rows[0]!.value] };
  };
  const result = await chooseAttachSelection({ teams, observable: true }, choose, { team: "beta", seatQuery: "so" });
  expect(calls).toBe(1);
  expect(result.kind === "selected" && result.values[0]!.target).toBe("beta/sol");
});

test("unknown qualified team seeds team then seat searches without widening a known team", async () => {
  const queries: Array<string | undefined> = [];
  const choose: Choose = async (rows, options) => {
    queries.push(options.query);
    return { kind: "selected", values: [rows[queries.length === 1 ? 1 : 0]!.value] };
  };
  const result = await chooseAttachSelection({ teams, observable: true }, choose, { teamQuery: "bet", seatQuery: "so" });
  expect(queries).toEqual(["bet", "so"]);
  expect(result.kind === "selected" && result.values[0]!.team).toBe("beta");
  await expect(chooseAttachSelection({ teams, observable: true }, choose, { team: "missing", seatQuery: "so" }))
    .rejects.toMatchObject({ errorClass: "selection_changed" });
});
