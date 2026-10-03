#!/usr/bin/env bash
# Sourced by smokes that run install.sh with a fresh TAP_INDEX_HOME. install.sh stages
# the pinned fzf, which downloads its archive from GitHub. When the operator's own
# verified cache already holds that archive, point install-fzf.ts at it
# (TAP_FZF_TEST_ARCHIVE) so ordinary runs need no network. Otherwise leave the
# variable unset and the installer downloads as before. The installer re-checks the
# sha256 either way; this only chooses where the bytes come from (tap-335zf).
#
# The asset key and cache path come from fzf-tool.ts run under the same bun the
# installer uses, never from another runtime's idea of the platform: a mixed-arch
# host (x86 python under Rosetta, arm64 bun) would otherwise pick the wrong archive.
tap_pin_fzf_archive() {
  [ -n "${TAP_FZF_TEST_ARCHIVE:-}" ] && return 0
  local root cached
  root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" || return 0
  command -v bun >/dev/null 2>&1 || return 0
  # The suite sandboxes HOME, so read the account's real home (passwd) via os.userInfo.
  # Any failure (unsupported platform, missing cache, mismatched sha256) prints nothing.
  cached="$(bun -e '
    const { userInfo } = await import("node:os");
    const { fileMatches, fzfTool } = await import(process.argv[1] + "/runtime/bun/src/fzf-tool.ts");
    try {
      const tool = fzfTool({ TAP_INDEX_HOME: userInfo().homedir + "/.tap" });
      if (fileMatches(tool.cache, tool.sha256)) console.log(tool.cache);
    } catch {}
  ' "$root" 2>/dev/null)" || return 0
  [ -n "$cached" ] && export TAP_FZF_TEST_ARCHIVE="$cached"
  return 0
}
tap_pin_fzf_archive
