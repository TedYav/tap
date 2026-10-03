# Antigravity (`agy`) pane captures — 2026-09-03

Verbatim `tmux capture-pane -p` output from live Antigravity seats on the operator's server,
taken 2026-09-03 while investigating tap-92v3r. **The corpus spans two capture sessions**, and the
per-row times below are the authority: the first four were taken around 07:48Z; `generating-243.txt`
came later, around 08:55Z, once a pane appeared in that state. A single corpus-wide timestamp was
wrong here and the reviewer caught it against the transcript times inside the file itself. These are the bytes the courier's
readiness rule actually reads. They are committed as files, rather than reconstructed with
`printf`, because the defect they pin was a geometry misread: a fixture that rebuilds the
geometry from a description can only ever contain the geometry its author already believed in.

| file | pane | seat | state |
|---|---|---|---|
| `idle-243.txt` (07:48Z) | `%243` | `tap/willow-low-conductor` | idle at the band; footer `? for shortcuts` |
| `tool-running-254.txt` (07:48Z) | `%254` | `tap/willow-roster-driver` | mid-tool-loop: spinner above the band's top rule, a THIRD rule below the band, a task card between it and the footer, footer `esc to cancel … 1 task(s)` |
| `task-idle-footer-228.txt` (07:48Z) | `%228` | `opencode/gemini` | background task running while the agent is IDLE: same three-rule geometry as `%254`, footer `? for shortcuts … 1 task(s)` |
| `draft-262.txt` (07:48Z) | `%262` | `tap/willow-review` | a real unsubmitted TAP sentinel sitting in the band — a captured draft, not a written one |
| `generating-243.txt` (08:55Z) | `%243` | `tap/willow-low-conductor` | a generating turn with NO background task: spinner above the band's top rule, `esc to cancel` footer, two rules rather than three |
| `generating-taskcard-243.txt` (16:35Z) | `%243` | `tap/willow-low-conductor` | the incident shape: generating WITH a task card rendered below the band, so three rules — captured off her live pane at the moment the courier told this lane's driver that a message to her would never arrive |

`tool-running-254.txt` is the shape from the incident: the courier read it as `busy:noprompt`,
held the payload for its 300-second deadline, and told the sender it would never arrive, for a
seat that was one `send-keys` away the whole time.

`generating-243.txt` and `tool-running-254.txt` are separate shapes on purpose. The first
was a `printf` reconstruction of the leader's quoted capture until the partner held it
blocking, correctly: a rebuilt fixture can only contain the geometry its author already
believed, which is the exact failure mode this whole change is about. It was captured off
the live pane once one appeared in that state.

`task-idle-footer-228.txt` is the pair that shows the retired rule never tracked turn state at
all. It and `%254` have the same geometry and opposite footers, and the difference between them
is not whether the agent is working — in `%228` a background task is running and the agent is
idle. The old rule read `%228` as ready and `%254` as dead on the strength of that one string.

What the footer IS good for is the focus question — "would delivering now interrupt a
train of thought?" — which `--polite` asks and ordinary delivery does not.
the readiness walk's agy focus branch (`agyInTurnFromFrame`, runtime/bun/src/spool-readiness.ts) reads it for exactly that, and `%228` is why it reads the
footer rather than the task card.

**No captured specimen of a bandless `agy` pane exists here, and none is claimed.** All nine agy
panes running on this machine at capture time (`%87 %228 %231 %237 %239 %240 %243 %254 %262`)
rendered the rule-pair band, including one still showing its startup splash. That is a measured
snapshot of one fleet at one moment, not a property of the harness: nothing here rules out a
bandless `agy` pane, and a startup or teardown frame is the obvious candidate.
The no-band arm in `agy-harness.test.sh` therefore uses a CONSTRUCTED fixture and says so at its
definition; it asserts only the band reader's pre-existing structural contract (no rule-pair
band defers with rc 3 through `tap_pending_input_text`).

The permission-overlay arm is constructed for a sharper reason: this fleet runs
`--dangerously-skip-permissions`, so no live agy pane renders that modal at all. Its
vocabulary is borrowed from the seat observer's existing agy rule and its geometry from
`%228`/`%254`. It pins the refusal's polarity, not the modal's appearance.

**One redaction, in `draft-262.txt` only:** the account e-mail in Antigravity's startup splash is
replaced by `operator@example.invalid`, padded to preserve the line's column geometry. Nothing
else in any file is altered, apart from the anonymization described below.

**`generating-taskcard-243.txt` is the defect reproducing on its own fix.** It was taken at 16:35Z
while `tap/willow-low-conductor` was mid-`tap send` — visibly working — at the same minute the courier
delivered a `delivery-failed` notice to this lane's driver saying a payload to her "will not arrive on
its own". It is the third rule that makes it worth keeping separately from `generating-243.txt`: a
task card renders BELOW the band, so a reader anchored on "the last rule" finds the card's rule rather
than the band's, and a live band goes unseen. Arm 16 of `courier-busy-hold.test.sh` asserts both
generating shapes are injectable for exactly that reason.

**Trailing whitespace and the final newline are part of the capture and are deliberately kept.**
`git diff --check` reports blank-line and trailing-space diagnostics on `draft-262.txt` and
`task-idle-footer-228.txt`; those bytes are what `capture-pane` emitted, and the band readers under
test consume exactly them. Normalizing would make the "verbatim" claim above false and could change
what a whitespace-sensitive reader sees, so the diagnostics are accepted for this directory rather
than fixed.

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step.
