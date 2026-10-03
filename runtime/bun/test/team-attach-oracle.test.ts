/**
 * `tap team attach`, natively, against the Bash verb it replaces — RUN, not
 * read (batch-2 rule 13). The harness (fixture, doors, effects, capture) is
 * test/helpers/incumbent-oracle.ts; this file is the corpus and the declared
 * deviations.
 *
 * Every case builds a fresh team fixture (registry rows written through the
 * launcher's own writer, real tmux sessions on the runner's private server,
 * PATH shims for osascript and the catalog), drives `team attach` through both
 * head doors from the restored initial state, and compares stdout, stderr,
 * exit code and the `.tap/` effects with the incumbent's — live from
 * `TAP_T1_ORACLE_BASE`, else from fixtures/team-attach-oracle.json.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  BASE, Oracle, applyDeviations, assertBaseCheckout, assertCaptureProvenance, canonicalStreams, type Deviation, type FixtureSpec, type Streams,
  ORACLE_BUS_AUTHORITY_MARKER,
} from "./helpers/incumbent-oracle";

interface CaseSpec extends FixtureSpec {
  name: string;
  argv: string[];
  /** Exported env for the run (e.g. TAP_JSON=1 to take the JSON refusal path). */
  env?: NodeJS.ProcessEnv;
  /** Named transforms applied to the incumbent's bytes before comparison. */
  deviations?: DeviationName[];
}

type DeviationName = "no-tap_bun_call-boilerplate" | "prologue-reconciliation-not-run-natively" | "login-shell-startup-budget" | "positional-team-selection" | "stripped-root-unenrolled-refuses" | "optional-selector-needs-terminal" | "duplicate-selector-refusal";

/**
 * `iterm-viewer.ts` resolves the tmux binary via `Bun.which("tmux")` — a PATH
 * lookup, not a fixed path. The smoke sandbox shadows PATH with a `tmux-guard`
 * wrapper for destructive-call protection, so the generated AppleScript's
 * embedded binary differs from whatever real tmux the frozen capture happened
 * to resolve against (tap-xdxk7). That is environment, not behavior: normalize
 * both sides' streams before every comparison in this file rather than pin one
 * environment's path into the frozen fixture.
 *
 * Scoped to exactly the executable argument `iterm-viewer.ts` shell-quotes via
 * `shellQuote` (`shell-quote.ts`): `'<path>'`, itself re-quoted by the
 * outer `/bin/sh -c` wrap into the literal `exec '"'"'<path>'"'"'`. Matching
 * only between that literal marker pair — rather than any `/…/tmux` substring
 * — tolerates whitespace inside the path (a real risk: `TMPDIR` can contain
 * spaces) and leaves the unrelated `-S '"'"'…/tmux-502/default'"'"'` socket
 * argument untouched, so a real socket-path regression still fails the
 * comparison instead of being masked by the same placeholder.
 *
 * The AppleScript-plan streams this file compares carry that marker through a
 * further `JSON.stringify` (the AppleScript command literal), which backslash-
 * escapes every `"` in `'"'"'` into `\"`. Streams that skip the AppleScript
 * plan (e.g. non-osascript stdout) keep the unescaped marker. `\\?` before each
 * `"` matches both forms so the fixture's actual bytes — not just the
 * conceptual shell-quoted shape — are what gets normalized.
 *
 * The `-S` socket argument's `tmux-<uid>/default` directory name is the same
 * class of environment noise: tmux derives it from `getuid()` at runtime
 * (`/tmp/tmux-<uid>/` by default), not from anything this repo's code
 * decides, so a runner whose effective UID differs from the one the frozen
 * capture ran under reproduces a byte-identical socket structure under a
 * different digit string (observed: fixture froze `tmux-502`, a later runner
 * produced `tmux-501`). Masking only the digits immediately before the
 * literal `/default` — never the surrounding shape — still fails a real
 * socket-path regression (wrong directory name, wrong session target).
 *
 * The frozen fixture's digit carries no meaning beyond whichever machine
 * froze it, so it is always masked. A LIVE side's digit is masked only when
 * it equals THIS process's own `getuid()`: a live run computing some other,
 * wrong digit (a real regression — e.g. `tmux-0`, matching neither the
 * runner's UID nor the frozen capture's) is left unmasked and correctly
 * fails the comparison instead of being accepted as "just an environment
 * difference".
 */
function normalizeTmuxBinary(s: Streams, opts: { verifyUid?: boolean; frozenSocket?: string } = {}): Streams {
  const uid = process.getuid?.();
  // Deliberate behavior change: attach is typed into a login shell, not stored
  // as iTerm's reusable startup command. Compare the same layout and exact
  // per-pane attach commands; iterm-viewer.test.ts checks shell startup itself.
  const normalizePlan = (text: string): string => {
    const commands: string[] = [];
    const lines = text.split("\n").flatMap(line => {
      const typed = line.match(/^  tell p\d+ to write text (.*)$/);
      if (typed) { commands.push(typed[1]!); return []; }
      const launch = line.match(/^(.*with default profile command )(.*)(\))$/);
      if (!launch) return [line];
      const command = JSON.parse(launch[2]!);
      if (command.includes("attach-session")) commands.push(launch[2]!);
      else expect(command).toMatch(/ && exec .* -l/);
      return [`${launch[1]}<LOGIN_SHELL>${launch[3]}`];
    });
    if (commands.length) lines.push(...commands.sort().map(c => `ATTACH ${c}`));
    return lines.join("\n");
  };
  const strip = (text: string) =>
    normalizePlan(text)
      .replace(/(exec '\\?"'\\?"')[^']*('\\?"'\\?"')/g, "$1<TMUX_BIN>$2")
      .replace(/tmux-(\d+)(?=\/default)/g, (match, digits) =>
        !opts.verifyUid || (uid !== undefined && Number(digits) === uid) ? "tmux-<UID>" : match)
      // tap-26r3: the unavailable disclosure's resume command is anchored to
      // the team root (`cd '<root>' && tap session resume <h>`). The root is a
      // per-run temp dir on the native side, so fold the anchor back to the
      // incumbent's bare spelling on BOTH sides; team-attach-disclosures.test.ts
      // pins the anchored bytes themselves. The canonical form replaces the
      // real root with `{CASE}` and drops the quotes, so match both spellings.
      .replace(/cd (?:'[^']*'|[^ ]*) && tap session resume/g, "tap session resume");
  // Replay restores the captured socket spelling after the child runs.
  // Map that exact input back to the capture's normalized expectation; no
  // arbitrary path or socket identity is hidden by this substitution.
  const effects = Object.fromEntries(Object.entries(s.effects).map(([path, value]) => {
    const suffix = opts.frozenSocket?.match(/\/(tmux-\d+\/default)$/)?.[1];
    if (typeof value === "string" && opts.frozenSocket && suffix)
      value = value.replaceAll(JSON.stringify(opts.frozenSocket), JSON.stringify(`{TMUX_TMPDIR}/${suffix}`));
    return [path, value];
  }));
  return { ...s, effects, stdout: strip(s.stdout), stderr: strip(s.stderr) };
}

const DEVIATIONS: Record<DeviationName, Deviation> = {
  "stripped-root-unenrolled-refuses": {
    why: "The Python-stripped worktree_root names a different, unenrolled directory. The incumbent ran pre-flip, "
      + "where that directory's absent bus listed no seats; every machine is born live since F1, so the session "
      + "list refuses the unenrolled directory instead of certifying an empty roster.",
    apply: s => ({ ...s, rc: 1, stdout: "",
      stderr: "tap team attach: tap session: worktree is not enrolled; next: tap session launch or tap in; next: tap session list --json\n" }),
  },
  "positional-team-selection": {
    why: "The positional operand is now a team name; a valid unknown name preserves its exact refusal without a terminal. Malformed names still refuse exactly.",
    apply: s => ({ ...s, stderr: s.stderr
      .replace("unexpected argument 'fable'; next: tap help team", "--team 'fable' is not enrolled in the machine index; next: tap register")
      .replace("unexpected argument 'bad argument'; next: tap help team", "--team 'bad argument' fails charset ^[A-Za-z0-9][A-Za-z0-9._-]*$; next: tap help") }),
  },
  "optional-selector-needs-terminal": {
    why: "An omitted selector value requests the interactive picker; the oracle runs without a TTY and now receives an explicit-list remedy.",
    apply: s => ({ ...s, stderr: "tap team attach: tap team attach needs a target here; pass tap team attach <team> [--only <h,...> | --except <h,...>] explicitly (interactive picker requires a terminal and non-JSON output); next: tap team attach <team> [--only <h,...> | --except <h,...>]\n" }),
  },
  "duplicate-selector-refusal": {
    why: "A duplicate handle in a supplied selector list now refuses instead of silently deduplicating.",
    apply: s => ({ ...s, rc: 1, stdout: "", stderr: "tap team attach: --except repeats handle 'c'; next: tap team attach --except <handle>[,<handle>...]\n" }),
  },
  "login-shell-startup-budget": {
    why: "Login-shell initialization now precedes attachment; allow 25 probes rather than the incumbent's 10.",
    apply: s => ({ ...s, stderr: s.stderr.replace("after 10 bounded probe(s)", "after 25 bounded probe(s)") }),
  },
  "no-tap_bun_call-boilerplate": {
    why: "the incumbent reached the planner through lib.sh's tap_bun_call adapter, which printed its own "
      + "`tap: slice_failed id=… slice=attach-partition: classification failed` line on any nonzero; the "
      + "native verb calls the planner in-process, so the adapter's line has no adapter to come from. The "
      + "planner's own diagnostic and the verb's refusal line are unchanged.",
    apply: s => ({ ...s, stderr: s.stderr.replace(/^tap: slice_failed id=[^\n]* slice=attach-partition: classification failed\n/m, "") }),
  },
  "prologue-reconciliation-not-run-natively": {
    why: "tap.sh ran `tap_registry_invalidate_server_restart` before dispatching any non-dry-run verb: rows "
      + "bound to the current server socket with a stale generation got their pane coordinates cleared and were "
      + "parked as suspended/server_restarted under the registry lock, and a registry event was appended. The "
      + "native door runs no prologue, so the incumbent's registry rewrite, event lines and lock sidecars are "
      + "absent from the native run's effects. The verb's OUTPUT is identical: the catalog's `live` flag comes "
      + "from tmux session names, not from the rows the prologue parks. Disposition: permanent. Verb-prelude "
      + "row C retired tap.sh's dispatcher; tap-fp16 also retired its remaining native and Bash-fallback "
      + "restart preludes. Read-time classification keeps stale bindings non-routable without rewriting them.",
    apply: s => {
      const effects = { ...s.effects };
      for (const path of [".tap/bus/registry.json", ".tap/bus/registry.json.lock",
        ".tap/bus/registry-events.log", ".tap/bus/registry-events.log.lock"]) delete effects[path];
      return { ...s, effects };
    },
  },
};

const CASES: CaseSpec[] = [
  { name: "dotted_plain_dry_run", team: "demo.alpha.107-Renewal",
    rows: [{ handle: "fable", live: true }, { handle: "sol", live: true }, { handle: "ghost", live: false }],
    argv: ["--dry-run"] },
  { name: "dotted_only_one", team: "demo.alpha.107-Renewal",
    rows: [{ handle: "fable", live: true }, { handle: "sol", live: true }, { handle: "ghost", live: false }],
    argv: ["--dry-run", "--only", "fable"] },
  { name: "dotted_only_whole_roster", team: "demo.alpha.107-Renewal",
    rows: [{ handle: "fable", live: true }, { handle: "sol", live: true }, { handle: "ghost", live: false }],
    argv: ["--dry-run", "--only", "fable,sol,ghost"] },
  { name: "dotted_except_all_spared", team: "demo.alpha.107-Renewal",
    rows: [{ handle: "fable", live: true }, { handle: "sol", live: true }, { handle: "ghost", live: false }],
    argv: ["--dry-run", "--except", "fable,sol,ghost"] },
  { name: "undotted_plain_dry_run", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    argv: ["--dry-run"] },
  { name: "except_one_dry_run", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    argv: ["--dry-run", "--except", "b"] },
  { name: "foreign_prefix_row_not_planned", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "visitor", live: true, session: "other-team/visitor" }],
    argv: ["--dry-run"] },
  { name: "empty_roster_no_live_seats", team: "demo", rows: [], argv: ["--dry-run"] },
  { name: "all_unavailable_no_live_seats", team: "demo",
    rows: [{ handle: "a", live: false }, { handle: "b", live: false }],
    argv: ["--dry-run"] },
  { name: "except_unknown_handle", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    argv: ["--dry-run", "--except", "nobody"] },
  { name: "except_two_unknown_typed_order", team: "demo",
    rows: [{ handle: "b", live: true }, { handle: "a", live: true }],
    argv: ["--dry-run", "--except", "z,a,y"] },
  { name: "except_all_unavailable_still_fails", team: "demo",
    rows: [{ handle: "a", live: false }, { handle: "b", live: false }],
    argv: ["--dry-run", "--except", "a,b"] },
  { name: "only_unknown_handle", team: "demo",
    rows: [{ handle: "a", live: true }],
    argv: ["--dry-run", "--only", "a,nobody"] },
  { name: "only_and_except_conflict", team: "demo",
    rows: [{ handle: "a", live: true }],
    argv: ["--only", "a", "--except", "a", "--dry-run"] },
  { name: "except_no_value", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--dry-run", "--except"], deviations: ["optional-selector-needs-terminal"] },
  { name: "only_no_value", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--only"], deviations: ["optional-selector-needs-terminal"] },
  { name: "except_empty_value", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "", "--dry-run"] },
  { name: "except_empty_between_commas", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "a,,b"] },
  { name: "except_trailing_comma", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "a,"] },
  { name: "only_qualified_handle", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--only", "demo/a"] },
  { name: "except_colon_qualified_handle", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "demo:a"] },
  { name: "except_bad_charset", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "bad!x"] },
  // Exported TAP_JSON=1: the refusal is one JSON object, and a DEL byte in the
  // echoed handle must escape as \\u007f the way Python json.dumps does.
  // ensureAscii escapes DEL since tap-u2nfe; the explicit escape in tapErrorJson
  // is redundant belt now.
  { name: "except_del_handle_json_escaped", team: "demo", rows: [{ handle: "a", live: true }],
    env: { TAP_JSON: "1" }, argv: ["--except", "a\x7f", "--dry-run"] },
  { name: "except_leading_space_handle", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", " a"] },
  { name: "except_nbsp_handle", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "a\u00a0"] },
  { name: "except_bom_handle", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "\ufeffa"] },
  { name: "except_dedupes_and_orders", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }, { handle: "c", live: true }],
    argv: ["--dry-run", "--except", "c,a,c"], deviations: ["duplicate-selector-refusal"] },
  // Handles spelled like sibling subcommands: the router's option scan must
  // not read a selection VALUE as a Bash-owned route (partner review).
  { name: "only_handle_named_up", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "up", live: true }],
    argv: ["--dry-run", "--only", "up"] },
  { name: "except_handle_named_down", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "down", live: true }],
    argv: ["--except", "down", "--dry-run"] },
  { name: "unexpected_argument", team: "demo", rows: [{ handle: "a", live: true }], argv: ["fable"], deviations: ["positional-team-selection"] },
  { name: "unknown_option", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--bogus"] },
  { name: "later_usage_error_wins_over_roster", team: "demo", rows: [{ handle: "a", live: true }],
    argv: ["--except", "nobody", "--wat"] },
  { name: "crew_in_except", team: "demo",
    rows: [{ handle: "driver", live: true }, { handle: "helper", live: true, crew: true, session: "demo/driver" }],
    argv: ["--dry-run", "--except", "helper"] },
  { name: "crew_in_only", team: "demo",
    rows: [{ handle: "driver", live: true }, { handle: "helper", live: true, crew: true, session: "demo/driver" }],
    argv: ["--dry-run", "--only", "helper"] },
  { name: "eight_seats_tabs_layout", team: "demo",
    rows: ["a", "b", "c", "d", "e", "f", "g", "h"].map(handle => ({ handle, live: true })),
    argv: ["--dry-run"] },
  { name: "seven_seats_panes_layout", team: "demo",
    rows: ["a", "b", "c", "d", "e", "f", "g"].map(handle => ({ handle, live: true })),
    argv: ["--dry-run"] },
  { name: "tabs_flag_two_seats", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    argv: ["--tabs", "--dry-run"] },
  { name: "worktree_root_absent_bus_derived", team: "demo", worktreeRoot: "absent",
    rows: [{ handle: "a", live: true }],
    argv: ["--dry-run"] },
  { name: "root_with_quote_and_space", team: "demo", rootName: "it's a dir",
    rows: [{ handle: "a", live: true }],
    argv: ["--dry-run"] },
  { name: "root_non_ascii", team: "demo", rootName: "équipe é",
    rows: [{ handle: "a", live: true }],
    argv: ["--dry-run"] },
  // A quote with NOTHING else unsafe: the space in the case above already
  // forces quoting, so only this shape tells a safe class that admits `'`
  // from one that does not.
  { name: "root_with_quote_only", team: "demo", rootName: "it'sadir",
    rows: [{ handle: "a", live: true }],
    argv: ["--dry-run"] },
  // DEL is above 0x7e and below 0x80: Python escapes it, JSON.stringify does not.
  { name: "root_with_del_byte", team: "demo", rootName: "d\u007fir",
    rows: [{ handle: "a", live: true }],
    argv: ["--dry-run"] },
  // The registry's worktree_root goes through Python's `.strip()`, and a root
  // that ENDS in a character the two strip sets disagree on names a different
  // directory: JS trim() drops U+FEFF (Python keeps it) and keeps U+0085 and
  // U+001C (Python drops both). Selecting the wrong directory is a different
  // PLAN, not a different message (partner review F1).
  { name: "root_trailing_bom", team: "demo", rootName: "root\ufeff", rows: [{ handle: "a", live: true }], argv: ["--dry-run"] },
  { name: "root_trailing_nel", team: "demo", rootName: "root\u0085", rows: [{ handle: "a", live: true }], argv: ["--dry-run"], deviations: ["stripped-root-unenrolled-refuses"] },
  { name: "root_trailing_file_separator", team: "demo", rootName: "root\u001c", rows: [{ handle: "a", live: true }], argv: ["--dry-run"], deviations: ["stripped-root-unenrolled-refuses"] },
  // A refusal quoting a user-supplied argument that carries CR/LF must still
  // be ONE line on every door, as tap_error_line's flattening made it
  // (partner review F2).
  { name: "except_value_with_lf", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--except", "a\nb"] },
  { name: "unexpected_argument_with_cr", team: "demo", rows: [{ handle: "a", live: true }], argv: ["bad\rargument"], deviations: ["positional-team-selection"] },
  { name: "already_attached_seat", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    attached: ["a"], argv: ["--dry-run"] },
  { name: "all_already_attached", team: "demo",
    rows: [{ handle: "a", live: true }],
    attached: ["a"], argv: ["--dry-run"] },
  { name: "automation_unavailable_prints_commands", team: "demo",
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    osascript: "refuse-probe", argv: [] },
  // The prologue's reconciliation, measured: same rows, socket-bound with a
  // stale generation, non-dry-run. Output must still agree; the registry
  // rewrite is the declared deviation (see DEVIATIONS).
  { name: "stale_generation_non_dry_run", team: "demo", staleGeneration: true,
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    osascript: "refuse-probe", argv: [], deviations: ["prologue-reconciliation-not-run-natively"] },
  // Its control: the same rows under --dry-run, where the incumbent skips the
  // reconciliation too, so the two doors' effects agree with no deviation.
  { name: "stale_generation_dry_run_control", team: "demo", staleGeneration: true,
    rows: [{ handle: "a", live: true }, { handle: "b", live: true }],
    argv: ["--dry-run"] },
  { name: "automation_accepted_but_unverified", team: "demo",
    rows: [{ handle: "a", live: true }],
    osascript: "accept", argv: [], deviations: ["login-shell-startup-budget"] },
  { name: "automation_rejected", team: "demo",
    rows: [{ handle: "a", live: true }],
    osascript: "reject-script", argv: [] },
  { name: "catalog_unavailable", team: "demo",
    rows: [{ handle: "a", live: true }],
    python: "list-fails", argv: ["--dry-run"] },
  { name: "catalog_not_an_object", team: "demo",
    rows: [{ handle: "a", live: true }],
    python: "list-array", argv: ["--dry-run"], deviations: ["no-tap_bun_call-boilerplate"] },
];

// Born live (F1): attach resolves the team through an enrolled machine index.
const live = <T extends FixtureSpec>(spec: T): T => ({ globalEnroll: true, ...spec });

const oracle = new Oracle("team-attach", join(import.meta.dir, "fixtures", "team-attach-oracle.json"));
const capture = oracle.capture();
const written: NonNullable<typeof capture>["cases"] = [];
// Provenance is a REPLAY-mode gate: at freeze the on-disk capture is the
// one being replaced, so its staleness is irrelevant.
if (!BASE && capture) assertCaptureProvenance(capture, oracle.fixturePath);

beforeAll(() => {
  if (!BASE && !capture) throw new Error(`no frozen capture at ${oracle.fixturePath} and TAP_T1_ORACLE_BASE is unset`);
  assertBaseCheckout("skills/tap/scripts/tap-team-attach.sh");
});

describe("tap team attach: native vs incumbent", () => {
  for (const spec of CASES) {
    test(spec.name, () => {
      const fixture = oracle.newFixture(spec);
      try {
        const frozen = capture?.cases.find(c => c.name === spec.name);
        const inputs = oracle.buildFixture(live(spec), fixture, !BASE ? frozen?.inputs : undefined);
        // Common rule 13: a constructed case asserts its defining byte at the
        // position the program reads, so LIVE mode cannot regenerate both sides
        // from a silently changed input (F6, the partner reviewer Unit A r3).
        if (spec.name === "except_del_handle_json_escaped") expect(spec.argv[1]?.charCodeAt(1)).toBe(0x7f);
        const argv = ["team", "attach", ...spec.argv];
        let expected: Streams;
        if (BASE) {
          const { trace: _baseTrace, ...incumbent } = oracle.run("base", fixture, argv, { env: spec.env });
          if (process.env.TAP_T1_ORACLE_DEBUG) process.stderr.write(`[${spec.name}] incumbent effects: ${JSON.stringify(Object.keys(incumbent.effects))}\n${incumbent.stderr}\n`);
          expected = incumbent;
          written.push({ name: spec.name, expected, inputs });
        } else {
          if (!frozen) throw new Error(`case ${spec.name} has no frozen expectation; regenerate with TAP_T1_ORACLE_BASE + TAP_T1_ORACLE_WRITE=1`);
          expected = canonicalStreams(frozen.expected);
        }
        const ratified = applyDeviations(DEVIATIONS, expected, spec.deviations, spec.name);
        const { trace, ...native } = oracle.run("head-native", fixture, argv, { env: spec.env });
        expect(normalizeTmuxBinary(native, { verifyUid: true, frozenSocket: frozen?.inputs?.serverSocket })).toEqual(normalizeTmuxBinary(ratified));
        // The public door reached the native handler — the router did not hand
        // this form to Bash on the strength of a token that looks like a route.
        expect(trace).toBe("native team\n");
        if (spec.osascript === "accept" || spec.osascript === "reject-script") {
          // The script the fake iTerm received is the plan; the dry-run arms
          // print it, this arm proves the live path hands over the same bytes.
          expect(existsSync(fixture.scriptCapture)).toBe(true);
        }
      } finally {
        oracle.teardown(fixture);
      }
    }, 120_000);
  }
});

describe("a worktree path carrying a backslash (tap-e05cw)", () => {
  // Bun 1.4.0's realpathSync throws ENOENT for an existing directory whose
  // path contains a backslash; the selector's canonicalDir now recovers the
  // physical path through the native platform (tap-e05cw), so the native door
  // plans the attach the incumbent plans instead of refusing cwd_unreachable.
  // Replay reuses `except_no_value`'s captured inputs (same shape: team demo,
  // one live `a`) — the substitution table stamps this fixture's backslash
  // root into the registry (rule 34).
  test("root_shell_metacharacters — native plans the attach on a backslash root", () => {
    const spec: CaseSpec = { name: "root_shell_metacharacters", team: "demo", rootName: "root`$()\\name", rows: [{ handle: "a", live: true }], argv: ["--dry-run"] };
    const fixture = oracle.newFixture(spec);
    try {
      oracle.buildFixture(live(spec), fixture, BASE ? undefined : capture!.cases.find(c => c.name === "except_no_value")!.inputs);
      const { trace: _t, ...native } = oracle.run("head-native", fixture, ["team", "attach", ...spec.argv]);
      expect(native.rc).toBe(0);
    } finally {
      oracle.teardown(fixture);
    }
  });
});

describe("context flag precedence: `team attach --context` at HEAD", () => {
  // At HEAD, `main.ts`'s cmdTeam strips --context (the roster context-details
  // flag, verbs/team.ts) BEFORE its attach arm, so `team attach --context`
  // plans the team's default attach and exits 0. Standalone control, not a
  // corpus case: the router's exact route trace is asserted directly.
  // Replay reuses `except_no_value`'s captured inputs (same shape: team demo,
  // one live `a`) instead of rebuilding through HEAD siblings (rule 34);
  // freeze builds through the pinned base's builders and discards the capture.
  test("context_flag_precedence — --context is stripped before the attach plan", () => {
    const spec: CaseSpec = { name: "context_flag_precedence", team: "demo", rows: [{ handle: "a", live: true }], argv: ["--context"] };
    const fixture = oracle.newFixture(spec);
    try {
      oracle.buildFixture(live(spec), fixture, BASE ? undefined : capture!.cases.find(c => c.name === "except_no_value")!.inputs);
      const argv = ["team", "attach", ...spec.argv];
      const native = oracle.run("head-native", fixture, argv);
      // The router carried the argv to the native handler itself — the exact
      // route, not merely a non-Bash one.
      expect(native.trace).toBe("native team\n");
      expect(native.rc).toBe(0);
      expect(native.stdout).toContain("tap team attach: iTerm automation unavailable; run these attach commands");
      expect(native.stdout).toContain("tmux attach -t '=demo/a'");
      expect(native.stdout).toContain("printed 1 attach command(s) for team 'demo'");
      expect(native.stderr).toBe("");
    } finally {
      oracle.teardown(fixture);
    }
  }, 120_000);
});

describe("router: sibling forms keep their owner", () => {
  test("team detach and team up/down use the unified native dispatcher", () => {
    const spec: CaseSpec = { name: "router-controls", team: "demo", rows: [{ handle: "a", live: true }], argv: [] };
    const fixture = oracle.newFixture(spec);
    try {
      // Same build shape as `except_no_value` (team demo, one live `a`) — at
      // replay this control reuses that case's captured inputs instead of
      // rebuilding through HEAD siblings (rule 34).
      oracle.buildFixture(live(spec), fixture, BASE ? undefined : capture!.cases.find(c => c.name === "except_no_value")!.inputs);
      expect(oracle.run("head-native", fixture, ["team", "detach", "--dry-run"]).trace).toBe("native team\n");
      expect(oracle.run("head-native", fixture, ["team", "down", "--dry-run"]).trace).toBe("native team\n");
      expect(oracle.run("head-native", fixture, ["team", "up", "--dry-run"]).trace).toBe("native team\n");
    } finally {
      oracle.teardown(fixture);
    }
  }, 60_000);
});

describe("native door: tagged bus refusals", () => {
  // bus.ts throws ordinary Errors tagged with `tapErrorClass`/`tapAction` — it
  // has no TapError to express the refusal with. `renderRefusals` is the only
  // error boundary: the tagged error must render as the refusal it declares,
  // not escape as a Bun crash stack. `--dry-run` keeps the door itself from
  // writing the bus before the module runs, so the unwritable root is first
  // felt exactly where ensureDirs stamps the authority marker.
  // Standalone control: this asserts the live contract; Unit 4 owns any
  // frozen-base freeze/replay, so no frozen oracle case is added here.
  test("native door renders tagged bus authority refusal as JSON", () => {
    const spec: CaseSpec = { name: "bus_authority_unwritable_direct_module", team: "demo", rows: [], argv: ["--dry-run"] };
    const fixture = oracle.newFixture(spec);
    try {
      // Same build shape as `empty_roster_no_live_seats` (team demo, empty
      // roster) — at replay this control reuses that case's captured inputs
      // instead of rebuilding through HEAD siblings (rule 34).
      oracle.buildFixture(live(spec), fixture, BASE ? undefined : capture!.cases.find(c => c.name === "empty_roster_no_live_seats")!.inputs);
      const run = oracle.run("head-native", fixture, ["team", "attach", "--dry-run"],
        { env: { TAP_JSON: "1" }, busAuthorityUnwritable: true });
      expect(run.rc).toBe(1);
      // No Bun stack: the refusal is rendered, not crashed.
      expect(run.stderr).toBe("");
      const lines = run.stdout.split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      const refusal = JSON.parse(lines[0]!) as { ok: boolean; error_class: string; action: string; detail?: string };
      expect(refusal.ok).toBe(false);
      expect(refusal.error_class).toBe("bus_authority_unwritable");
      expect(refusal.action).toBe("fix TAP_HOME's own permissions, not just its children");
      expect(refusal.detail).toContain("could not write");
      expect(refusal.detail).toContain(ORACLE_BUS_AUTHORITY_MARKER);
    } finally {
      oracle.teardown(fixture);
    }
  }, 60_000);
});

afterAll(() => {
  oracle.writeCapture(written, [
    "skills/tap/scripts/tap-team-attach.sh", "skills/tap/scripts/tap-team.sh", "skills/tap/scripts/tap.sh",
    "skills/tap/scripts/lib.sh", "skills/tap/scripts/style.sh", "runtime/bun/src/launcher/attach-partition.ts",
    "skills/tap/scripts/session/launcher.py",
  ]);
});
