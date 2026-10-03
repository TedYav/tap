# Watchers

Details for [/tap:choreography](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Watchers and wakes

### The shape

Push does the delivery: a successfully injected send wakes a recipient whose pane is active. Queued,
poll-delivery, unavailable-pane, and failed-courier states do not wake anyone — which is what
supervision is for.

Who holds supervision — and how many of each sidecar a team runs — is owned by `/tap:lead` and
`/tap`; the question there is which seat carries the coverage, not which mode the run is in.
Two distinct pane-less sidecars exist and they **compose**, so they are worth naming precisely
rather than collapsing:

- **`tap watch`** — the per-team *liveness* sidecar. It detects silent deadlock from observable bus
  state and probes a wedged team up an escalation chain. `tap watch status` says whether your team
  has one armed.
- **`tap goalie`** — the opt-in *belief-state* sidecar, which asks an idle-looking teammate a closed
  judgment question. It is a rung in `tap watch`'s own escalation chain, which is the clearest
  evidence they are not alternatives.

Both poll so that no seat burns turns doing it, and neither is claimed to eliminate every logical
deadlock. Running one does not forbid the other; a second instance of the *same* sidecar for the same
team is the redundancy worth questioning, not the pairing.

What stays true regardless of mode: per-seat watchers of self-delivering traffic add cost without
coverage, and a watcher is better placed on a cheap seat than on the lead.

### The caution

A harness background watcher/monitor or polling sidecar pointed at a channel that *already
self-delivers, and is delivering* costs turns and context without adding coverage — turns on traffic
already settled or never yours, cold-cache requests, and, compounding, context degradation: each
wasted wake leaves busy-waiting residue, so the agent reaches its real work already many pages down.

**The admission test is coverage plus termination — both legs, not either:**

1. **It adds coverage the existing wake path does not guarantee.** Not "an event nothing else
   delivers" — that phrasing excludes the very gaps supervision exists for. A push that *lands*
   needs no watcher; the same message *queued*, sent to an unavailable pane, or dropped by a failed
   courier wakes nobody, and an independent observer does add coverage there. The question is about
   the failure modes, not the event's name.
2. **It has a bounded termination condition** — a named stop condition *and* an owner who disarms
   on it. This is worth stating carefully, because the sanctioned primitive does not enforce a
   lifetime for you: `tap watch` holds an armer-owned lease that lives until someone deletes it,
   an evaluator of `none` never judges completion at all, and chain exhaustion raises a sticky
   notice rather than disarming. A seat can therefore follow the approved route and still produce
   the unbounded watcher this section is warning about. The bound is a commitment someone keeps,
   not a property the tool supplies.

**The decision fork agents skip.** The reasoning that gets here is sound at every step, which is why
naming the rule is not enough: *golden rule says never poll-sleep → convert waiting into something
event-driven → arm a watcher.* The missing step is between the last two — **event-driven does not
imply a new watcher.** First ask whether an existing mechanism already wakes the responsible seat
and already covers the failure modes you are worried about; arm something new only for what it does
not. Agents arrive here through compliance, not ignorance, which is why the fork has to be spelled
out rather than assumed.

The tell that it has already gone wrong: **notifications you acknowledge without acting on** —
redundant wake machinery does not stay neutral, it degrades into noise.

Signals that genuinely reward watching are the ones outside the bus: tests, CI status, deploys, logs,
external queues, and intermediate events a completion signal will not carry. Healthy TAP delivery is
not among them — it pushes to your pane. Its *failure* states are, which is what the supervision
model above is for.

When a watcher passes the admission test, prefer it not run on the team lead: a lead's turns are the
team's most expensive context, and watch-wakes hollow them out. Route watching to a cheap seat or
pane-less infrastructure, which reports with `--ask` (tracked) or `--wake` (settle-only, but the seat settles it itself) when
something real fires — a plain send parks for the digest and is pre-settled for the recipient. Neither
`--ask` nor `--wake` promises prompt arrival: both ride the seat's delivery window, and `--delivery
interrupt` is the only class that bypasses it. If the courier or the target pane itself looks wedged, `tap escalate` reaches the operator
directly and is not a bus send.

The risks are symmetric, which is why the answer is not "never wait" either. Watchers and waiting
loops eat turns by accident, to no purpose. And push alone cannot recover a run whose next obligation
became unrepresented — nobody is waiting to be woken, so nothing arrives. That is a supervision gap
rather than a delivery failure, and supervision is what closes it.
