# TAP agent changelog

This file is the concise, agent-facing protocol change brief. The runtime selects the
heading matching `SENTINEL_VERSION` from `runtime/bun/src/sentinel.ts`.

## TAP v0.23

**The wire got shorter.** A sentinel is now three positional slots and bare tags:
`[[TAP v0.23 <ask|note> [<team>/]<id> [tag ...] [path=<abs>][: note body]]]` — about
20 tokens where v0.22 spent about 55. `from=`, `to=`, `kind=`, `reply=` and
`urgency=` are gone from the wire; the envelope keeps every one of them at rest.

**What you have to do differently, as a reader:** the obligation is the second word
(`ask` wants a reply, `note` is settle-only), and the id is the third. Paste that id
into `tap read` / `tap show` — most sentinels no longer carry a `path=` to follow.
A short note may arrive with its body inline after `: `; the payload file is still
written either way, so nothing is inline-only.

`path=` survives in three cases, each one where the id alone does not resolve: a
digest, the bare-recipient manual relay, and a sender whose team the machine index
cannot resolve. A `<team>/` prefix on the id is a bus locator — split on the first
`/` to find the bus; the remainder is the filename.

Unknown tokens are now malformed and reported rather than skipped. If you meet a
sentinel shape you cannot read, ask the sender — they are one reply away.

See `skills/tap/scripts/CONTRACT.md` §Sentinel for the grammar, the `path=` rule and
its tap-0z9l reversal, and the recipient-corroboration change.

**Admin is native; its Bash body is gone.** Every `tap admin` form — dashboard
(with and without `--fast`), refresh, retire, rebuild-registry, migrate-registry,
prune — runs in the Bun engine, and `tap-admin.sh` is deleted in the same change:
the `tap.sh` door routes straight to `runtime/bun/main.ts`, and a stale
`~/.tap/bash-verbs: admin` rollback row is ignored with the usual one-line notice.
Behavior is the reviewed admin-r7 surface: H1's guarded missing-registry purge
(witness artifact under `<index-dir>/recovery/`, retained on any refusal), a
present indexed acting registry parses even when the bus is gone, and
`tap teams refresh` stays a pure alias.

**Old registry formats are refused, never converted.** `registry_migrate.py` is
deleted; `tap admin migrate-registry` is a one-release stub that exits 1 with
`old_store`. Every `old_store` refusal names the file and why it is old: a team
registry is upgraded by hand (rename `agents` to `seats`, add `"schema": "0.20"`)
or moved aside before `tap init`; an old `teams.json` or launcher manifest is
moved aside.

## TAP v0.22

See `skills/tap/scripts/CONTRACT.md` §v0.22 for the session-relaunch and
messaging surfaces.

## TAP v0.21

See `skills/tap/scripts/CONTRACT.md` §§483–610 for the refresh, clear, recap,
and escalation surfaces.

## TAP v0.20

One explicit `tap admin migrate-registry --yes` cutover moves only
team-registered seats into the new global and team registries. Each migrated
row receives one opaque row-incarnation id; this is not its native session id.
The launcher manifest is copied once into the migration backup, then retired;
manifest-only records do not become seats. Sentinels now require qualified
`from=<team>/<handle>` and `to=<team>/<handle>`. Post-flip `tap teardown`,
`tap restore`, `tap team reset|restore|shutdown`, `tap session undead`, and
`tap team resurrect` are temporarily unavailable until their fast-follow
replacements land; do not retry them; route the operation to the operator.

## TAP v0.19

Team reset, restore, and lifecycle operations now use fenced component fates;
the sentinel wire grammar is unchanged.
