# Poll malformed-payload contract

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0125 start=823339 end=831115 sha256=e76ef62622fe7fb28b72cf4766c5a859c2b17823aa051d885daa5fe1eac9355e fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Poll malformed-payload contract

`tap poll <me>` is resilient to malformed canonical payloads (CONTRACT v0.2):

- A payload that fails envelope validation (missing/empty required fields) is **quarantined**: moved ONCE to `payloads/.quarantine/<name>`, bytes preserved, and thereafter invisible to the scan. It does not make poll non-zero by itself. (v0.23, tap-7r3fn.7 — it was previously warned about on stderr on every invocation, forever.) All poll and outstanding entry points use `src/quarantine.ts`. It serializes by obligation id, revalidates after locking, claims a destination without overwrite, and marks a pristine reset generation reused after moving bytes. Only confirmed source disappearance before publication is benign; failed preservation or generation marking emits a degraded diagnostic. One aggregate pointer names successful moves (stderr in quiet/JSON mode).
- Validation runs before recipient filtering, so a malformed `to` value is quarantined and pointed at instead of silently skipped.
- A valid payload is inbound when the selected recipient team's addressee grant permits `<me>` to act and its optional `to_team` matches that team. A different `to_team` is outbound relay state and is skipped without warning. The grant includes ordinary, adopted and explicitly forwarded custody; the payload's bus supplies settlement receipts, never recipient identity.
- A payload whose envelope `id` field does not match its filename is **quarantined** the same way, with reason `id_mismatch`.
- **Warnings always go to stderr; valid pending items always go to stdout.**
- poll exits `0` whether or not a valid pending item was listed (pending mail is state, not an error; CLI-EXIT-0); with none it prints the empty state. A malformed payload never changes the exit. `--quiet` retains pending human rows and suppresses the empty line: stdout remains the daemon's work signal. `--quiet --json` retains the JSON object. Continue independent work; yield only if nothing useful remains, and let the sentinel wake you.
- For each valid pending item, poll prints `next step: tap read <id> --by <me>` for notes (retaining `--epoch` when present), or `tap reply <id> -f <file>` for asks, on a separate stdout line.
- `_*.md` names are still ignored as a defensive draft guard, but envelope validation is the primary protection against corrupt files reaching the output.

`tap outstanding <me>` applies the same envelope validation to outbound payloads whose `from` field names `<me>`, and **quarantines** them on the same terms as inbound — the brief says "a malformed payload", not "a malformed inbound payload", and outbound corruption warned forever too. A quarantined entry is no longer an outstanding send, so the exit code follows the genuine sends that remain.

### Native poll ownership

`cmdPoll` owns every execution door. Like every local native verb, poll first passes the router's onboarding preflight and may be preceded by the overdue advisory; the router runs no server-restart reconciliation before it. The Bash poll body is retired. Missing or empty `--team` operands return a native usage error instead of falling back. Static help stays on its existing path.

Canonical eligibility uses `addresseeGrant`; parked eligibility also uses `spoolAuthorized` to check the envelope, filename and metadata target. Both receive the selected recipient team's registry, marker and history. Before the live marker, the shared grant ignores instance stamps; after it, ordinary and adopted instance checks apply. This intentionally replaces native poll's former unconditional instance filter and restores visibility of granted adopted-predecessor mail, including rewritten local envelopes. Restoring human quiet rows likewise corrects native poll's former suppression; these are contract convergence changes, not claims of historical byte parity.

A forwarding record whose destination is `<me>` (in any state: superseded, revoked or bound to an older instance) permits that seat's discovery on enrolled sender buses; a teammate's record does not, so that seat reads only its own bus, as on a team without forwarding. The per-payload addressee grant still decides, so poll lists exactly the forwarded mail `tap read path=` accepts. Every foreign row must explicitly name the selected destination team before any addressee grant; unqualified matching handles grant no foreign custody. Foreign bytes remain untouched, and foreign hints use an explicit `path=` address. Malformed local canonical files are quarantined; malformed parked files are skipped with stderr diagnostics. Poll never promotes parked mail or settles an obligation.

Unanchored reads use native pane observations and typed recovery before directory creation. Exit `4`, observed session/generation evidence, successful native pane anchoring, and caller-pin precedence remain. An original nonempty `TAP_HOME` grounds the read after selector validation, including a canonical-layout bus without a registry before the live marker. Layout must not turn an explicit pin into a cwd-derived bus; an unpinned cwd still refuses before creating one. Invalid markers, non-acting pins and unreachable enrollments retain their selector refusals. A generic missing-authority diagnosis is `unanchored_bus`, replacing the old Bash `unregistered` spelling; an unobservable pane never authorizes a bus or a lookup from a bare pane id.

Retention remains manual: settled payload/receipt pairs are not pruned by poll or by liveness inference.

### The quarantine (v0.23, tap-7r3fn.7)

A malformed canonical is **moved once** to `payloads/.quarantine/`, and that move is the mechanism
that makes "warn once" true: the file leaves the scan, so the pointer is printed by the run that
acted and never again. The behaviour it replaces warned once per malformed file per invocation,
forever — five stale files on a live bus cost five warnings on every poll by every seat, about state
nobody was going to act on. A quarantine that keeps shouting is a warning with extra steps.

- **Bytes are preserved and never overwritten.** A name already taken in the quarantine gets a
  numbered sibling: the file being moved is evidence about a defect, and the one already there is
  evidence about an earlier instance of it.
- **`.quarantine` lives INSIDE `payloads/`** so it travels with the bus and survives a relocation,
  and its dot-prefixed name is already skipped by the `*.md` glob every scanner uses.
- **ONE pointer per invocation that moved something**, naming the count and the directory. On the
  human path it is stdout; under `--json` it goes to **stderr**, which keeps the JSON shape
  byte-identical while still disclosing a real mutation of the bus to a machine caller. A verb that
  relocates files and reports nothing anywhere is the failure this rule exists to prevent.
- **Quarantined artifacts stay inspectable.** `tap show <id>` resolves them by exact id and by 12-hex
  suffix, labels the residency, prints the raw preserved bytes, and says the envelope did not parse
  rather than rendering an empty one. "Listable, bytes preserved" is only true if something can read
  them back; a quarantine nothing can open is a delete with a longer path.
- **A quarantined entry carries no obligation.** It is not pending inbound, not an outstanding send,
  and `tap read` never reaches it.

### Row shape (v0.23, tap-7r3fn.7)

`tap outstanding` rows are `<id>  <to>  ask|note  <age>s`, plus a state suffix for a spooled or held
entry. They print no path — `tap read <id>` is how a payload is opened, so a path per row is a token
cost with no reader — and no `kind` column, because this inspection row does not need the envelope’s kind.

**`tap poll` rows show `id  from  ask|note  age`.** Every entry reaches the native formatter, which omits payload paths and kind from the row. It retains cross-team sender qualification, reply_to, unattributed provenance, and invalid-reply disclosure. Invalid reply values render `invalid`, stay on the bus, and teach `tap show`; they never authorize settlement or quarantine.

`outstanding`'s peer column is the RECIPIENT on purpose. It lists sends where `from == me`, so a
`from` column would repeat the caller's own handle on every row. Poll uses `from` because it lists mail where `to == me`.

`outstanding` additionally renders the `.read` receipt: `read <age>, unanswered` for an ask, and
`read by <other> (forced)` when someone read it on the recipient's behalf. `read` without
`unanswered` beside it would let a sender read an observation as a discharge, which is the one
misreading that receipt exists to prevent. When a canonical fallback note on this bus names the ask in `in_reply_to`, reverses its participants and teams, matches any stamped sender/recipient instances, and has a matching non-forced `.done` with `via=read` by its addressee, the ask instead names `answered by <note id> (unsettled)`. JSON adds `answered_by`, an ordered array of note IDs. This reports an acknowledged linked note, not a judgment that its contents fully answer the ask. Transport/courier receipts, forced reads, cancelled notes, and mismatched identities do not count. A fallback routed to the asker’s current successor also matches when explicit instance-pinned forwarding grants that successor custody and the note preserves the original recipient identity. Historical answer-note scanning starts only when the selected sender has a visible open ask. It reads only settled notes whose minted stamp (`<handle>-<UTC stamp>-<suffix>`) is no earlier than the oldest such open ask's (an answer is minted after its ask); a note without a minted stamp is always read, and an open ask without one removes the bound. No ask receipt is written, the ask stays listed as outstanding, and ordinary reply or sender cancellation still closes it. Notes outside the queried bus are not searched. Ages are recorded as data for every row, spooled entries
included, because the `tap cancel` discoverability legend gates on the oldest of them — a gate that
re-derives its input from a rendered row is one reformat away from silently switching off.

**Adoption authority on settlement (tap-7r3fn.27).** Read, reply, and both local/foreign private reply settlement paths use the same addressee-grant check. An ordinary recipient matches its current instance or an unbound payload. A successor may also act under its recorded adoption grant: locally rewritten mail keeps the fork's recipient_instance and names the fork in to_adopted_from; unrevised remainder and foreign mail still name the fork in to. The grant must match that retired instance, never the successor's current instance. Read observations and settlements record adopted_from without implying force. The private reply settlement primitive repeats the same authority check. No payload instance is rewritten to obtain authority. Refusals name the sender's cancel first; restoration is offered only from the actor's own recorded history, using the existing instance-clearing remedy. Poll and the parked-recipient predicate keep only the grant verdict, so they skip that remedy and never list team-history for a mismatched binding.
