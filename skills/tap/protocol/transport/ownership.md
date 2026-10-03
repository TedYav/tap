# Ownership

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0020 start=120436 end=122488 sha256=3f5dcbd122b676398646603f466b869a2f9577ff0b5f1888741f595553b39ed2 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Ownership

### Three-layer architecture (B3)

- **Packages:** tap-core owns transport/bus/registry/pane machinery; tap-launcher owns session and harness wrapping; tap-orchestrate owns judgment, gates, and collaboration doctrine.
- **Inviolable arrows:** tap-launcher → tap-core and tap-orchestrate → tap-core only. Core imports, invokes, and semantically knows nothing downstream; launcher and orchestrate do not depend on one another.
- **D-arch-1 declared reads:** (a) `tap doctor` and `tap admin dashboard` may use a launcher helper only for warn-only diagnostics; (b) `tap admin retire`/`refresh` may refuse destructive work on a launcher-owned existence fact, without interpreting launcher schema.
- **D-arch-2:** pending-reservation status and expiry are core registry concepts. Launcher may create pending rows through its sanctioned core path, while `tap_pending_reservation_*` and `tap_registry_pending_expired` remain in `lib.sh` for core consumers.

The following file map records the original component split; current implementations may move.

| Component | Historical file |
| --- | --- |
| shared primitives (paths, atomic write, id mint, envelope shape) | `lib.sh` |
| dispatcher | `runtime/bun/main.ts` (the root `scripts/tap.sh` is a shim into `bin/tap`) |
| `tap send` (courier: resolve → safe-inject → verify → receipt) | `runtime/bun/src/verbs/send.ts` (internal spawns use `courierArgv`) |
| `tap register` (name → pane in registry) | `tap-register.sh` |
| `tap poll` (list unprocessed payloads for me) | `runtime/bun/src/verbs/poll.ts` |
| reply settlement (atomic `.done`; public done retired) | `runtime/bun/src/verbs/reply.ts` |
| envelope-shape validator wiring | `validateEnvelope` (`runtime/bun/src/envelope.ts`), called by `canonicalPlaceLocked` |
| two smokes (named for what they test) | `smoke/courier-injects.test.sh`, `smoke/bus-roundtrip.test.sh` |
| GC/retention (manual; poll never prunes settled pairs) | [Poll contract](../delivery/poll-malformed-payload-contract.md#native-poll-ownership) |

In a shared tree, commit sequentially and hand off the writer role over TAP. Disjoint files do not isolate the index or generated files; the shared `lib.sh` write required explicit coordination.
