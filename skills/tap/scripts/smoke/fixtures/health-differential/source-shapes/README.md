# source-shapes — registry files copied from a live bus, handles anonymized

Copied on 2026-09-01T21:47:37Z from the `tap` team (primary checkout /Users/runner/wrk/Example-Org/tap), a migrated team that carries BOTH files:

| file here | source path | source mtime (local) | sha256 of the copy here (seat handles anonymized) |
|---|---|---|---|
| `team-registry.json` | `/Users/runner/wrk/Example-Org/tap/.tap/team-registry.json` | 2026-09-01T14:24:57 | `795081ff3f1b2109d1c41c8856f536efed35126ee03d80e8e5825eb5aa69e685` |
| `bus-registry.json` | `/Users/runner/wrk/Example-Org/tap/.tap/bus/registry.json` | 2026-08-31T06:07:31 | `a314aca7f0a153f2051ae58f1487fa33e0d31cf4a8faa8f1327d09e03d005b6f` |

- `team-registry.json` is the POST-FLIP acting file (`schema: 0.20`, `seats` axis, 11 rows).
- `bus-registry.json` is the PRE-FLIP bus registry (`team.schema_version: 1`, `agents` axis, 3 rows) that a
  migrated team keeps at `.tap/bus/registry.json` beside the acting file. It is the ambient decoy that
  tap-health.sh's line 90 hands to the renderer when the acting-registry rebind fails (tap-n85k).

How the test uses them (`health-differential.test.sh`, team C): both files are installed into the
sandbox team — `.tap/team-registry.json` and `.tap/bus/registry.json` respectively — with exactly ONE field
rewritten in each, `team.worktree_root`, pointed at the sandbox team root so a real path on this machine is
never read. Every seat row, pane id, boot id, and session field is the live shape unchanged, except that each seat handle (and
the session, pane, tag and instance values derived from it) is replaced by the synthetic name below; the pane
ids do not exist on the sandbox tmux server, so every pane seat classifies `unknown`. The seat NAMES differ
between the two files, which is what lets a recorded roster say which file it was read from.

## Synthetic handle mapping

The live seat handles were replaced by one fixed mapping applied to both files and to the roster in
`../marker-good-both-files.{json,text}`, which the test compares against the rendering. Each handle
is replaced wherever it appears: the row key, `tag`, `instance`, `session` and `pane` values. Sorted order,
pane-window relations, harness, status and every other field are unchanged. The two registries use disjoint
names, so a rendering still says which file it came from.

| team-registry.json (acting file) | synthetic |
|---|---|
| first architect seat | `alder-architect` |
| its leader twin | `alder-leader` |
| first two review seats | `birch-review`, `cedar-review` |
| two panel seats sharing one conductor session | `dogwood-panel-1`, `dogwood-panel-2` |
| third review seat | `elm-review` |
| conductor | `fir-conductor` |
| gate seat | `ginkgo-gate` |
| planner | `hazel-planner` |
| coach | `juniper-coach` |

`bus-registry.json` (pre-flip) maps its three seats to `maple-lane-1`, `oak-regress` and `pine-driver`; its
decoy seat `decoy-probe-2` keeps its name. The mapping was chosen to keep the original alphabetical order of each
file's rows, since the renderer sorts by handle.
