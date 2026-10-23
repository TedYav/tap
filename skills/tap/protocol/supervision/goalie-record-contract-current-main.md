# Goalie record contract (current-main addition)

> Normative TAP v0.23 content landed on current main after the frozen source.

<!-- tap-current-delta id=current-0001 start=424480 end=433869 sha256=1cc05da13b528c20ca057f4bd1d4e6c0d723b8b59e45689e681f13e308bb5680 transform=current_insert -->
<!-- TAP_CURRENT_DELTA_BYTES_BEGIN -->
**The lease record's writers, and which of them share a byte policy.** `$TAP_HOME/goalie/arm.json`
has **three** writer families, and only the first two share a policy:

1. `goalie-lease.ts` — the verb's reads, merges, seat transactions and delete — publishing through
   `watch-lease.ts publish`;
2. `tap_watch_prune_handle`/`tap_watch_restore_handle` (`tap teardown`/`tap restore`'s per-handle
   `seats` slices), through the same `publish`;
3. `tap goalie verdict`'s claim/unclaim pair, **still Python**, writing the record with
   `json.dump(…, separators=(",", ":"))` and `os.replace` — compact, with **no trailing newline**.
   Those two port with the verdict surface; until then a record whose last writer was a verdict ends
   `}` rather than a newline.

For writers 1 and 2 the following are part of the contract and not incidental: a merge publishes even
when no value changed, the published bytes end with a newline, and a path that exists but is not a
regular file is refused before any temp is created. **None of those three holds for writer 3.** A
reader of this record must therefore tolerate both byte forms — every current reader does, because
`json.load` and `parseRecord` both accept trailing whitespace.

Presence tests over this record are likewise **not** uniform, and the distinction is which question
is being asked. The verb-level "is the goalie armed" decisions are **regular-file** tests:
`_goalie_is_armed` (consulted at ten sites — `tap goalie status`, `on`'s idempotence and takeover
checks, `off`, the loop's two continuation tests, the verdict endpoint's armed check) and
`runtime/bun/src/watchers/goalie-heartbeat.ts`'s independent guard. The *writers'* own guards are existence tests:
claim/unclaim use `os.path.exists`, and `pruneHandle`/`restoreHandle` use `existsSync`. So a
directory at the record's path reads as "not armed" to every verb-level decision while still
existing to those writers' guards.

What is settled is the pair that used to disagree with each other inside one operation: the armed
test and the **create guard** are now both regular-file, so a directory at the path is "not armed"
*and* an arming write through it is a refusal rather than an uncaught filesystem fault. The broader
convergence — one writer, one byte policy, one presence operator across all three families — is not
claimed here and is tracked as its own change.

Prior to that unification the record had two writers with divergent byte policies: the Bash verb's
Python wrote compact JSON with no trailing newline, published only on a real change, and died with an
uncaught `IsADirectoryError` on a directory at the path, while the teardown path already appended a
newline, always published, and refused. Both byte forms are accepted by every reader of this record
(`json.load` and `parseRecord` both tolerate trailing whitespace) and nothing reads the record's
mtime — the heartbeat ages the separate `goalie/heartbeat` file by its content — so the unification is
invisible to consumers. Terminality of the record's *shape* is part of the write decision, not
separate from it.

**The record's writers carry a typed exit contract that adapters must forward.** A merge answers `0`,
`3` (no record present and the caller did not pass `TAP_GOALIE_ALLOW_CREATE=1`), or `4` (the caller
demanded a generation via `TAP_GOALIE_EXPECT_ARMED_AT` and the record disagrees). The seat
transactions differ deliberately and each keeps its own mapping: `observe-seat` answers `3` for an
absent *or* malformed record and `4` for a generation mismatch, while `request-status` and
`prune-seats` answer `0` for absent, malformed and mismatched alike — they are advisory and never
block their caller. A `seats` value that is not a plain object (a list, number, string, `null`)
holds no seat data, and every seat transaction (`observe-seat`, `request-status`, `prune-seats`,
claim and unclaim) reads it as empty, the same way: none faults, claim answers `4` (no open
episode), and `observe-seat` publishes a fresh mapping in its place. The goalie tick's delivery
health reads `seats` through the same guard, so a malformed value heals on the next tick instead
of holding the goalie degraded; `tap goalie status` still reports the malformed value. A Bash boundary onto these surfaces forwards the module's status verbatim and
reports a missing runtime distinctly; collapsing every nonzero into one value would deliver an
infrastructure failure as a predicate answer. Since the R6 U3 cutover the verb layer is native
(`runtime/bun/src/verbs/goalie.ts`) and calls the module in process, so the boundary is a function
return: the typed codes arrive as values, not exit statuses, and the verb maps them to the same
refusal classes the Bash dispatcher did.

**A record is readable only if its BYTES decode, and every scalar decision reads the value Python
read.** Four properties of this record's reader and its scalar semantics are contract, because each
one of them was a place a port could silently answer a different question:

- **Decoding is strict.** The record is read as UTF-8 with no replacement, so a single invalid byte
  anywhere in the file — including in free text the deciding code never consults — makes the whole
  record unreadable and takes that surface's unreadable disposition (`observe-seat` answers `3`;
  `field`, `snapshot`, `request-status` and `prune-seats` answer nothing and `0`). A leading BOM is
  likewise unreadable, because the reader is plain UTF-8 rather than UTF-8-with-signature. A reader
  that repaired the bad byte would hand the state machine a record its predecessor rejected outright,
  and the machine would then mint and publish against it.
- **A generation comparison is a string comparison of the value as Python renders it**, not of some
  projection of it. `TAP_GOALIE_EXPECT_ARMED_AT` and the seat transactions' generation arguments
  compare against `str(<parsed value>)`, so a container renders as Python's repr — `[100]` is
  `[100]` and `['x']` keeps its quotes — and never collapses into the element it contains. A
  renderer that joined a one-element list into its element would let `armed_at: [100]` satisfy a
  demand for generation `100`, which is a generation check that passes without comparing generations.
- **A preserved float is a NUMBER to every decision and prints as its source text.** The codec keeps
  a float's source so `1.0` round-trips as `1.0`; that representation is invisible to the contract,
  but the semantics are not. An integer conversion is `int(x or <default>)`, so a falsy value takes
  the default and a truthy unconvertible one is a fault rather than a healed zero; a float zero is
  falsy; `1.0` equals `1`, so a merge that assigns `1` over a stored `1.0` is not a change. A
  non-canonical float source (`1E5`) prints as written where Python prints `100000.0` — a declared
  deviation, observable only on a hand-edited record, since every float the writers emit is canonical.
- **Archiving the record's home removes only a real directory at the destination.** The legacy goalie
  `reap` helper replaces `<archive>/goalie` when a directory is there; a plain file, a symlink or anything
  else at that path is PRESERVED and the reap refuses, leaving the source home in place. Deleting a
  non-directory destination would destroy unrelated archive content the predecessor declined to touch.

These four hold for the shared reader and the shared string conversion, so the watch record carries
them too.

**Three more, about WHICH disposition an input takes and WHEN a check runs.** These are contract
because each names a distinction the record's surfaces are easy to collapse:

- **A parse failure and a successfully parsed non-mapping are different inputs.** An unreadable
  record takes its surface's typed disposition (`observe-seat` answers `3`; `field`, `snapshot`,
  `request-status` and `prune-seats` answer nothing and `0`). A record that PARSES into a list,
  `null`, a number, a string or a bool is a FAULT where a mapping access is actually reached:
  `snapshot`, the three seat transactions (`observe-seat`, `request-status`, `prune-seats`), and
  `set` once a complete pair or `TAP_GOALIE_EXPECT_ARMED_AT` sends it to `.get`. There the reader
  succeeded and the mapping access is what failed, so the surface exits `1` and writes nothing.
  For the same input `field` deliberately answers nothing, and `set` with nothing to merge never
  reaches the mapping and answers `0`. Collapsing the second input into the first turns an
  operator-visible fault into a silent advisory answer.
- **In `request-status` the generation check runs BEFORE the seat state is validated.** A
  generation mismatch answers `0` with a corrupt seat state left untouched; only a MATCHED
  generation reaches the seat state, where a truthy non-mapping faults. A surface that validates
  the seat state eagerly refuses input this contract answers `0` for.
- **Container rendering follows Python's printability rule, which is a category test rather than an
  ASCII range.** Anything in Cc, Cf, Cs, Co, Cn, Zl, Zp or Zs is escaped — ASCII space excepted —
  so NEL (U+0085), NBSP (U+00A0) and ZWSP (U+200B) escape even though they sit above `0x20`, while
  accented letters and emoji stay literal. Which characters count as unassigned is decided by the
  executing runtime's Unicode tables, so the rendering is not a promise of byte-identical repr
  across Python versions: measured on this candidate, Python 3.11.14 (Unicode 14) escapes U+1FAE8
  and U+1CC00 as unassigned where Python 3.14.6 (Unicode 16) and Bun 1.4.0 print them literally —
  a probe that records differences, not a cross-version parity PASS. Three boundaries are declared
  rather than held: that Unicode-table version, a non-canonical float source printing as written
  (above), and key ORDER for a mapping that mixes integer-like keys with others following the
  renderer rather than insertion order. The last two are reachable only from a hand-edited record.

