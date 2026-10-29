import { expect, test } from "bun:test";
import { crewOf } from "../src/crew-lifecycle";

test("crew selection separates recycled session names by generation and recorded socket", () => {
  const current = { session: "t/owner", server_epoch: "srv:2:2", server_socket: "/current" };
  const old = { ...current, server_epoch: "srv:1:1" };
  const other = { ...current, server_socket: "/other" };
  expect(crewOf({
    owner: current, oldOwner: old, otherOwner: other,
    child: { ...current, crew: true }, oldChild: { ...old, crew: true }, otherChild: { ...other, crew: true },
  }, "owner")).toEqual(["child"]);
  expect(() => crewOf({ owner: current, duplicate: current, child: { ...current, crew: true } }, "owner")).toThrow();
});
