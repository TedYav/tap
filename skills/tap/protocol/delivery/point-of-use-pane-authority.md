# Point-of-use pane authority

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0113 start=741354 end=741900 sha256=d9bc59cdae064dbfe314df5ac6f6b707d1e914ed15420b8588061dc5c2a22d32 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Point-of-use pane authority

After the shared observer admits a seat, watch retains that cycle's resolved pane address/id and rechecks their equality immediately before each pane read. A later rename waits for the next cycle; an address rebound never exposes a foreign pane.

Effectful rowless callers must supply the exact session name their preflight observed. `tap command` derives it from the observer-resolved pane address for compatible register-born rows that omit an explicit `session`, so the effect-time identity guard stays armed.

