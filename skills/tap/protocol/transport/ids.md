# IDs

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0041 start=265170 end=265635 sha256=b426f9b62eaa84523751ffd96464ed91408182e933de8da5fceafa61acc67b02 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## IDs

`<sender>-<utc-compact>-<hex>`, **minted by the courier** (`mintId`, `runtime/bun/src/ids.ts`) — truly: a writer MAY omit `id` from the payload, and `tap send` mints one and stamps it into the canonical payload before validation (no more "the writer must pre-supply an id" trap that made `omit --id` fail validation — the F9 bug). Charset `^[A-Za-z0-9][A-Za-z0-9._-]*$` (can't break the sentinel grammar). `--id` is an override for tests/dogfood; omit it for normal sends.

