# Scope (v1): 1:1-per-edge unicast (D1)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0019 start=119664 end=120436 sha256=c8e44c4101305f90ca10863fab27f5b9e8e8d12ff2c955d906240fde5c2fcff7 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Scope (v1): 1:1-per-edge unicast (D1)

TAP is **unicast, one edge at a time**: a payload is addressed to exactly one `to`, woken on exactly one pane, settled by exactly one `.done`. There is **no broadcast primitive**, deliberately. A fan-out to N peers is N independent `tap send` edges, each with its own minted id, sentinel, and `.done`; the _coordinator_ (e.g. `/tap:discuss`'s lead) tracks "all N settled," never a single shared `.done` — one reader's ack is never everyone's (the §3 broadcast-retention invariant lives in `/tap:discuss`'s per-participant sealing, not in transport). Broadcast (a `recipients` set + all-recipient retention) is a named **future `tap.sh` extension**, out of scope for v1; until it exists, model group work as explicit per-edge fan-out.

