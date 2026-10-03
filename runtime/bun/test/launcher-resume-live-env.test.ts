// The one-process suite runs test files that swap `process.env` wholesale (the
// launcher-repair hermeticity pattern). Any module that captured `process.env`
// at load time is detached by such a swap: its later reads keep the pre-swap
// PATH, so a resume fixture's fake tmux — prepended to the CURRENT global —
// is never consulted, every live check reads the real tmux's "no server", and
// resume falls through to a native launch. This file pins the contract the
// launcher seams must hold: the environment is read AT CALL TIME, so a fixture
// built after a swap still reaches its own tmux and a live row reattaches.
import { afterEach, expect, test } from "bun:test";
import { fixture, options, recorder, restoreEnvironment, resume } from "./support/resume-harness";

afterEach(restoreEnvironment);

test("a resume fixture built after a process.env swap still reaches its own fake tmux", async () => {
  const prior = process.env;
  try {
    // The bad ordering, miniaturized: another file's hermetic swap has already
    // happened by the time this fixture is built.
    process.env = { ...process.env, TAP_ENV_SWAP_CANARY: "1" };
    const world = fixture({
      registry: { schema: "0.20", team: { name: "repo" }, seats: {
        scout: { status: "active", delivery: "pane", harness: "claude", session: "repo/scout", tag: "scout", index: 1 },
      } },
      tmux: [{ match: "*has-session -t =*" }],
    });
    const { events, deps } = recorder({ hasTty: true });
    const result = await resume(world.root, options({ key: "repo/scout" }), deps);
    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(events).toEqual([["register", "repo/scout", "claude"], ["attach", "resume", "repo/scout"]]);
  } finally {
    process.env = prior;
  }
});
