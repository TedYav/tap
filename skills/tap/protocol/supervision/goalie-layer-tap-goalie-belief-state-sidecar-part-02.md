# Goalie layer (`tap goalie` — belief-state sidecar) — source part 2 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0068 start=429917 end=438538 sha256=65469826840386c8704c2ccd3afde30098d428e687e2c2038d1a38738c5ef71b fragment=2/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**A store the JSONL reader cannot read is UNAGED:structural, and that covers three shapes, not one.**
`db` is a SHARED store (opencode) that cannot answer a per-seat question; `dir` is an AMBIGUOUS store,
a directory rather than a session; and a `file` that is not `.jsonl` is out of the reader's scope by
construction — notably Cursor's `store.db`, which `session_store.py` records as `kind=file` while its
own comment calls it encrypted and boundary-flushed, with "ATTRIBUTION value only ... never a readable
session-state source". Scoring these `unreadable` would make every normal Cursor seat raise the alarm
whose entire value is that it means OUR instrument broke.

**The shared-store case in detail.** Every opencode seat resolves to one shared sqlite
database, so three census rows (`example-1`, `example-2`, `example-3`) aged
off a single file and no opencode seat could age while any other was alive. A shared store cannot
answer a per-seat question; `session_attribution_trust` does not discriminate here (all three carried
the highest trust, `env`), so `session_store_kind` is the field that does.

Fires when **`stale / aged >= QUORUM_PCT`**, where a seat is stale at `age >= STALE_SECONDS`. Defaults
are **80% / 40min** and are **calibration, not doctrine** (`TAP_GOALIE_QUORUM_PCT`,
`TAP_GOALIE_STALE_SECONDS`). The former `WORKING == 0` predicate is the 100% case. There is still no
eligibility model, no queue-depth term, and no machine suppressor: a suppressor a tired seat can assert
is a mute button.

**An unreadable store forces UNREADABLE-FOR-CAUSE on its own, regardless of swing.** The choice is
stated rather than left to the arithmetic, because the arithmetic quietly chose the wrong one: unreadable
seats leave the denominator like any other UNAGED, so a STALE seat becoming unreadable LOWERS the stale
percentage — 8/10 = 80% fires, the same board with that seat unreadable is 7/9 = 77% and goes quiet, and
the 10 → 9 denominator move is under tolerance so the swing tripwire cannot catch it either. One parser
failure silenced a real deadlock and reset an unanswered wake. Of the three available rules — EXCLUDE
(launders evidence), COUNT AS STALE, FORCE UNREADABLE-FOR-CAUSE — the third is taken: **an instrument fault is not a reading, and a verdict computed
over a population we could not read is not a verdict.** Scoped to `unreadable` and never to
`structural`, since cursor/agy/hermes seats are structural on every board we run and forcing on those
would make the verdict permanently unreadable and the alarm meaningless.

**COUNT AS STALE is recorded as a NEAR MISS rather than merely rejected**, because it is the option a
future reader will reach for: it fails toward firing, which is the right direction, and it is simpler
than what is here. It is wrong anyway — it asserts a fact we do not have. **It produces the right
verdict for the wrong reason, and "confidently wrong in a safe direction" is precisely the habit this
layer exists to break.** A safe-direction guess is still a guess, and the next one may not be safe.
Anyone simplifying this rule later should have to argue past that sentence rather than rediscover it.

**An unreadable acting registry is an observer failure.** A missing registry, invalid UTF-8 or
JSON, or an invalid seat map emits `verdict=unreadable-for-cause working=?`. The tick preserves
seat and wake state; it cannot prune seats or report an empty census from a failed read.
A readable empty seat map remains a legitimate quiet census.

**Quiet and unreadable ticks preserve an outstanding wake.** Neither settles the feeder's
`reply=expected` obligation. Quiet pauses the ladder without changing `wake_id`, `wake_at`,
`wake_rung` or the episode start; a subsequent deadlock resumes that same obligation and
recognizes its late reply. Unreadable ticks likewise preserve it. Quiet may reset the board
episode only when no wake is tracked. This separates a reading about the board from an answer
owed by a person; a temporary quorum change creates no second ask.

**A verdict is scored WITH its denominator, and an unstable denominator renders UNREADABLE-FOR-CAUSE.**
The percentage is taken over the seats the sensor can actually age, and that population moves: one observed
tick.log ran 4 -> 7 -> 10 -> 13 -> 15 ageable seats inside seven minutes with the threshold
fixed at 80%. Two QUIET verdicts taken at different denominators are not the same measurement. When
the ageable count swings more than `DENOM_TOLERANCE_PCT` (default **30%**,
`TAP_GOALIE_DENOM_TOLERANCE_PCT`) across the staleness window, the tick renders
`verdict=unreadable-for-cause` and names the swing, instead of `quiet` — a statement about the
INSTRUMENT, not about the board. **It replaces QUIET and never a FIRE**: letting instrument noise
silence a real deadlock would be the false-QUIET direction this layer exists to end. The sample is
recorded on every tick, fires included, or the window would describe only the quiet ticks, and
`--rearm` clears it: a new lease must not alarm against a board that no longer exists.

**A second, independent term: the AGE OF THE TOP UNCLAIMED READY TICKET** (`QUEUE_AGE_SECONDS`,
default **60min**, `TAP_GOALIE_QUEUE_AGE_SECONDS`). The quorum asks whether the seats are idle; it
cannot ask whether ready tickets are aging, and in the observed case that was the question nobody asked —
two seats in a merge loop generated enough traffic to mask seventeen idle ones beside six untouched
P1/P2s, and every aliveness instrument answered the first question correctly. This term is
independent of seat idleness, so it survives that busy-mask. **It only ever ADDS a fire and never
gates the quorum**: a board with every seat stale still fires the moment someone drains the backlog.
The backlog probe therefore runs ONCE per tick, before the decision rather than twice after it, and
**an unreadable probe FIRES, labelled** — the same rule the probe already carried ("a detector that
goes quiet when its own input breaks is the same bug one layer down"); going quiet on its own
blindness is what the first form did.

**Age means time in the ready queue, and only where that can be ESTABLISHED.** `created_at` is not it:
a ticket blocked for hours becomes ready when its dependency closes and would immediately read past
the threshold, firing on a queue that never stalled. Only tickets with `dependency_count == 0` — never
blocked, so creation IS the moment they became ready — can age the queue; the rest still count toward
its size but cannot speak to how long it has been stalled. That is an approximation whose gaps
(status-blocked tickets, closed blockers, reopened tickets) are recorded in tap-4p67 along with the
durable fix, which is to persist when each ticket was first seen ready. A fire caused by this term says so in the wake and in the tick line, and names the
aging ticket: a feeder woken by an aging queue on an otherwise-unremarkable board would otherwise go
looking for idle seats that are not there.

**UNAGED renders WHY, because it covers two different facts.** `UNAGED:structural` is a seat that
carries no store, or a shared store that cannot answer a per-seat question — coverage we knowingly do
not have (`cursor`, `agy` and `hermes` seats score this permanently). `UNAGED:unreadable` is a store
that IS configured and could not be read — our instrument failing right now, named separately on every
tick line and every wake. Rendered identically they would let a parser bug across a whole harness
family hide inside the shape of the known coverage gap, which is the one way the tail-read's
deliberate fail-toward-UNAGED could buy a blind spot. Both leave the denominator alone; only the
second is an alarm about ourselves.

**A seat with no ageable session store is UNAGED: excluded from the denominator and NAMED on every
wake.** It cannot be counted stale (inflating the numerator toward a false fire) and must not be counted
fresh (masking a real one). Naming it is required rather than logged, because a silently shrunken
denominator moves the firing point without anyone choosing to move it — a confident-wrong state about
the board's own coverage, arriving in the layer's own arithmetic.

