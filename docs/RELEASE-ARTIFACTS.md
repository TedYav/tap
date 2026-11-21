# Build and install a release archive

The release builder produces a platform archive, its SHA-256 file, and a standalone
bootstrap script from one Git commit. The installed TAP includes its Bun runtime;
users still need Git, Bash 5+, tmux, jq, tar, gzip, lsof, and a SHA-256 tool. URL installs
also need curl.

**Publication is pending.** The commands below prepare and test local artifacts.
No downloadable release is promised by this guide.

## Build

Use Bun 1.4.0 or newer on the platform being released. From the checkout, run:

```bash
bun runtime/bun/src/release/build.ts --commit HEAD --out tmp/release
```

The command reads committed files only. Commit the intended changes first; dirty
files do not enter the archive. It writes:

- `tap-<version>-<os>-<arch>.tar.gz`
- `tap-<version>-<os>-<arch>.tar.gz.sha256`
- `tap-bootstrap.sh`

The version is the release version (for example `0.23.0`) at a tagged release
commit. Other builds add a development suffix, such as `0.23.0+3.g0123456789ab`:
commits since the tag and the source commit prefix. Without an export tag, the
count starts at the release heading's introduction; even that first build
carries `+0.g<sha>`.
The archive contains `tap-release.json` with the full commit, platform, and Bun
version, plus an `INVENTORY` of file hashes and executable bits. The build prints
the archive path, SHA-256, file count, source commit, and bootstrap path.

Build on each target host into a separate output directory. The filename records
the host platform: `darwin-arm64`, `darwin-x64`, `linux-arm64`, or `linux-x64`.
There is no cross-compilation flag. A filename alone does not establish that an
archive installs on that platform; run the acceptance there before releasing it.

## Check the archive

For local contributor verification, run the supported acceptance in isolation:

```bash
env TAP_SUITE_DIR=regress bash scripts/smoke-all.sh --only skills/tap/scripts/regress/release-artifact-stranger.test.sh
```

It builds two archives and exercises installation, hooks, a message round trip,
checksum refusal, and upgrade in a fresh HOME without Bun on PATH. Its watch
sidecar must adopt the new release under the same PID. The focused
`sidecar-source-refresh.test.ts` also exercises goalie and spool waiter upgrades,
including lease and retry-cadence preservation.

Check the exact archive intended for attachment on its target OS too. Given its
path and a trusted checksum, a user installs with:

```bash
/bin/bash tap-bootstrap.sh --archive "$TAP_ARCHIVE" --sha256 "$TAP_SHA256"
```

`--prefix` defaults to `~/.local/share/tap`. Both the prefix and HOME must use only
letters, digits, `/`, `.`, `_`, `+`, and `-`. Paths requiring shell quoting refuse
with `install_path` before any download or install write. The installer cannot
yet register working hooks for those paths.

## Prepare a GitHub release

1. Select a source commit whose full gate passed. Build distribution archives from
   the public copy derived from that commit. A private checkout's archive can
   contain private tooling and must remain local.
2. Record the public source commit and the successful gate's source commit
   together. Build and test each intended platform from that public commit with
   the same Bun version. Keep the receipts and platform acceptance results.
3. Complete the signing decision before a public macOS release. The current
   builder produces an ad-hoc-signed binary; it does not provide Developer ID
   signing or notarization. Signing changes bytes: finalize signing before
   generating the inventory, archive, and checksum. The current builder has no
   signing step, so a signed release needs that implementation first.
4. After publication is authorized, attach each platform's archive and matching
   `.sha256`, plus the bootstrap from the same commit. Choose a trusted channel
   for checksums and for the bootstrap itself. An archive checksum does not
   authenticate a bootstrap downloaded alongside it.
5. Fill the release tag, platform archive URL, bootstrap URL, and expected digest
   into the install instructions. Test those exact URLs before advertising them.

This procedure does not create tags, releases, uploads, or a public-copy sync.

### Bootstrap one-liner for a future README

Once assets exist, set `TAP_BOOTSTRAP_URL` to the tagged release's bootstrap URL,
`TAP_ARCHIVE_URL` to its platform archive URL, and `TAP_SHA256` to the trusted
64-character digest. In an empty download directory:

```bash
curl -fsSL "$TAP_BOOTSTRAP_URL" -o tap-bootstrap.sh && /bin/bash tap-bootstrap.sh --url "$TAP_ARCHIVE_URL" --sha256 "$TAP_SHA256"
```

On a terminal, first installation offers machine setup. Without a terminal, follow
the printed setup command, then run `tap doctor`. A missing prerequisite is named
with its recovery step before installation writes begin.

## Upgrade and rollback

Run the new release's bootstrap with its archive and checksum. It verifies the
tree, installs `versions/<version>`, then switches `current` atomically. Existing
hooks and links keep the stable `current` path. Artifact installs refuse
`install.sh --sync`; use the bootstrap to upgrade.

Watch, goalie, and spool waiter loops check `current` at their next refresh
boundary. They re-exec the new release's interpreter and entry, preserving the
PID, lease, and remaining waiter retries. An in-flight tick finishes first;
switching `current` does not interrupt a running delivery. Each loop prints
`release-changed; re-exec` in its existing output. A missing or invalid current
release leaves the old loop running.

The new source tree is complete before `current` switches. Loops can adopt it
while the installer updates hooks, or after that installer reports a failure;
they do not depend on those installer outputs. A bootstrap success means the
installation completed, not that every running loop has reached its next refresh.

Rollback uses the old archive and its checksum through the bootstrap. Old version
directories stay available. Do not remove a version while processes still use it.
The initial prototype archives stayed in test sandboxes; there is no distributed
pre-refresh release requiring a separate restart command.

## Remaining release work

| Item | Disposition |
| --- | --- |
| Shell-sensitive prefix or HOME | Refused before writes; full path quoting needs coordinated changes to hook and shim generation. |
| Loops running old code | Refresh follows the current release for watch, goalie, and spool waiter; clone source refresh is preserved. |
| Public-copy distribution | Procedure is ready; an authorized public-copy build from a source commit with a successful full gate is still required. Private build artifacts stay local. |
| Linux | Native build naming and bootstrap platform matching exist. Linux build/install acceptance remains unverified; only publish a Linux asset after that run. |
| macOS signing | Developer ID signing and notarization await a signing identity, release policy, and build integration. |
| Git removal | Deferred by product scope. Git remains a prerequisite because initialization and runtime commands still use it. |
