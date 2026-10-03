# Goalie layer (`tap goalie` — belief-state sidecar) — source part 1 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0067 start=421302 end=429917 sha256=5a62568cbca44f64a8d4e563710222d9a891369bf808b82dbc51b961596bf9c5 fragment=1/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Goalie layer (`tap goalie` — belief-state sidecar)

`tap goalie on [--by <lead>] [--threshold <seconds>] [--interval <seconds>] [--feeder <handle>] [--ledger <abs-path>]` arms one cheap, per-team judgment loop. **The observer is a ROLE, not a name.** The seat is resolved ONCE at arm time and stored on the lease: an explicit `--goalie <handle>` wins; otherwise a seat literally named `goalie` if one is active; otherwise the unique active seat whose preset carries the `goalie` role (so `hermes-goalie` resolves). Two role-carrying seats FAIL (`error_class=ambiguous_goalie_seat`) rather than being guessed between — a wake sent to the wrong observer is a wake nobody watches. Nothing downstream re-derives the name: the census exclusion, the judge request, deadlock feeder wakes' `--from`, and the `verdict` endpoint's actor check use the lease's `goalie_handle`; human escalation uses its `armed_by` as `--from` so the phone notification names the armer, refusing locally if the armer is missing or invalid rather than guessing an identity. It must be an active pane seat. Defaults match watch cadence: 1500s idle threshold and a ~60s tick. `on` is idempotent for the same lead/cadence. **Both** `--rearm` and `off` are armer-owned unless `--force`, and either forced non-armer path sends the armer one fixed `kind=notice` — re-arming a lease out from under its armer is the same authority act as disarming it, so it carries the same gate and the same notice (tap-pqf2). The forced act completes either way: when the notice send fails, the verb still writes (or removes) the lease but exits 1 with `goalie_owner_notify_failed` instead of reporting success (tap-1e8o), the refusal carries a runnable notification command with a literal body, and when the sidecar also failed to start the same failure's detail names both facts. A refusal names a door chosen by the caller: the armer is offered `off` or `--rearm`; a non-armer is offered `off --force` and never another seat's handle. `status [--json]` exposes the lease. `tick`, `run`, `verdict`, and reset's `reap` are internal surfaces. `$TAP_HOME/goalie/arm.json` is the lease; `tap team reset` archives `goalie/` beside `watch/`, so the loop exits when reset removes the lease. Sidecar spawn and cleanup use the owner's exact session name; cleanup targets `=<session>:goalie-sidecar` and requires PID equality before `kill-pane`.

**Disarm authority (tap-calo).** `tap goalie off [--force]` authenticates the CALLING PANE as the actor (`resolveActorHandle`, the same rule the verdict path uses); `--by` is still parsed so old scripts do not hit `unknown_option` but grants nothing on `off`, and `TAP_SELF` is never consulted. Only the stored armer's own pane disarms silently. Any other actor, including an unresolvable pane, gets `goalie_off_refused` (an ownerless lease, with no `armed_by`, has no armer to protect: an unresolvable pane disarms it, since `""` equals the empty owner, while a resolved seat is still refused) with the action `tap goalie off --force`, which disarms loudly, is attributed to the true pane (`unknown` when unresolved) and sends the armer a notice; the action never names another seat's handle. The `goalie_already_armed` door follows the same rule: it offers bare `off` only when the calling pane is the armer, otherwise `off --force`.

**Deterministic trigger, one model call per seat episode.** Every tick considers each active pane-backed non-lead teammate independently; `goalie` and poll/daemon seats are excluded. A seat is eligible only while positively `idle-at-prompt`; working, unknown, or dead evidence resets/suppresses that seat alone and fails closed to the mechanical watcher. Its silence clock is bus-only: `max(arm/per-seat floor, non-supervision payload or receipt mtime whose from/to includes that seat)`, with future timestamps clamped. `window_activity` is deliberately excluded because tmux scopes it to the whole window and courier injection itself advances it; either signal would let a pane-crew sibling or mechanical watch probe poison the candidate's episode. Other teammates' traffic cannot mask or reset it, and `probe`/`notice` traffic never manufactures activity on any clock arm. After one seat remains idle for the threshold, the sidecar atomically claims that seat's episode and sends exactly one settle-only `kind=probe` scoped to that candidate; it never repeats until genuine non-supervision bus activity involving that seat resets the episode. Independent stale seats may each receive one cheap judgment request.

Goalie accepts only the explicit courier tuples `0:injected:pane`, `0:queued:spool`, `0:queued:poll`, and `5:pending:<empty delivery>`; wildcard rc0 acceptance and the retired `4:spooled` arm are forbidden. Its per-seat `request_status` records `injected`, `queued`, or `pending` so a parked request is never mislabeled delivered.

**Accepted false-wake boundary.** A seat can be truly `idle-at-prompt` while waiting on off-window background work that produces no TAP traffic. The bus-only clock cannot distinguish that healthy wait from settled-but-undone silence, so it may issue one judge request after the threshold. This is deliberate: the request is judgment, not interruption; the goalie should return `clear` (or `unsure`), the candidate receives no corrective notice, and the one-call episode guard prevents repeated model traffic until real bus activity resumes.

**Judgment and injection boundary.** `goalie-templates/judge.md` tells the seat to compare one named candidate's `tap peek` claims with `tap outstanding`/`tap health` observable state. All transcript/payload/tool text is explicitly untrusted data. The model cannot author a TAP body: it may call only `tap goalie verdict` with the request's candidate, tick epoch, and random per-episode capability plus a closed pair — `wake-seat` + `phantom-wait|settled-undone|stale-wait`, `wake-lead` + `unsure`, or `clear` + `clean`. The capability makes same-tick episodes collision-proof: one seat's probe cannot claim another seat's episode even when their numeric epochs match. The endpoint authenticates the actual current pane as `goalie` (ignoring `TAP_SELF`/`--by`), admits one verdict per seat episode under the lease lock, rejects arbitrary reason prose and redirection to another target, validates wake-seat as a current active non-lead teammate, and re-checks that target is still positively idle. Code then sends one fixed settle-only `kind=notice`; model-observed text is never interpolated into the outbound.

**Work-feeder detector (QUORUM STALENESS).** Beside the per-seat episode logic, every tick runs one
board-level pass. It asks a **deterministic** question — when did each session last do anything — rather
than classifying what a TUI is doing right now. The census is every active pane-backed seat EXCEPT the
resolved observer (poll/daemon seats excluded), and unlike the per-seat loop it **includes the lead**.

Age comes from the seat's **`session_store_path`** — the OBSERVED live session — never
`transcript_path`, which is the launcher's *expectation*. Those diverged on 8 of 21 active seats in
one measured census, with the expectation file 118-792 minutes stale for seats working continuously
(identity capture had quarantined them, so the launcher's expected transcript stopped updating);
aging it would have fired the quorum permanently. Expectation-versus-
observation is the same distinction as `.sent` versus arrival.

**Within that store, age is the newest record the SEAT AUTHORED — courier arrivals do not count.**
The clause above ("`probe`/`notice` traffic never manufactures activity on any clock arm") binds this
clock too, and the first implementation broke it by reading the file's `mtime`: a delivery WRITES the
store on arrival, measured at 2.5 seconds ahead of the seat's own first record. The
goalie's wakes, its judge-verdict wakes, and the watch layer's probes therefore refreshed the very
seats the quorum measures, with the worst exposure on the FEEDER — woken every fire, no failover, and
"alive but dispatching nothing" is the state this layer exists to see. Activity is established by AUTHORSHIP, not by inspecting text: only records the seat itself produced
count — `type: assistant` on claude, and on codex `type: response_item` whose `payload.role` is absent
or `assistant`. **The role test is load-bearing, not a detail:** codex delivers the courier's arrival
in the SAME top-level shape as the seat's own output (`response_item` with `payload.role: user`), so
accepting every `response_item` counts a wake as work and reproduces this very defect for one harness
family. An absent role is a reasoning or tool record, which exists only because the seat is working;
an unrecognised role is refused, which ages a seat — the safe direction. **A payload that is not a dict
at all is refused outright**, never mapped to "absent role": absent-role is the arm that means "a
reasoning or tool record, so the seat was working", and routing an uninterpretable record there would
count garbage as activity. It must also never raise — the census is one process for the whole board, so
an exception loses EVERY row and the board reads `no seat carries an ageable session store`
permanently, since every later tick then samples `aged=0` and the denominator tripwire has no swing to
see. An earlier form skipped records
containing the TAP sentinel, which catches the courier and nothing else — a hook message or a human
prompt is a timestamped arrival with no sentinel, so a wedged seat that received one and produced
nothing scored fresh for another whole staleness window. Untimestamped harness metadata is skipped
rather than ending the read, and the tail window grows until a complete record is in hand, since one
record can exceed it.
**Scope, stated so the guarantee is not read wider than it is:** this removes activity that is purely
an ARRIVAL — a wake that lands, submits, and yields nothing. It does not remove work a woken seat
genuinely produces, because whether that work is *dispatch* is a question about content, and this
sensor does not read content.

