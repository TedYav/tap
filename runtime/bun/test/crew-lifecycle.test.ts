// killablePane's row-shape refusals return before any tmux read, so they are pure
// (tap-jmdo). The live-pane arms are exercised through the crew shutdown tests.
import { expect, test } from "bun:test";
import { killablePane } from "../src/crew-lifecycle";

test("a row with a pane_id but no session is refused, naming the missing session", () => {
  expect(killablePane({ pane_id: "%1" })).toEqual({ paneId: "", skip: "no session on row", hint: "" });
});

test("a row with no pane_id is refused, naming the missing pane_id", () => {
  expect(killablePane({ session: "crew/one" })).toEqual({ paneId: "", skip: "no pane_id on row", hint: "" });
  expect(killablePane({})).toEqual({ paneId: "", skip: "no pane_id on row", hint: "" });
});
