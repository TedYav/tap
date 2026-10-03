# Herdr attribution

`runtime/bun/src/agent-state.ts` adapts detection mechanics and selected rule data from [Herdr](https://github.com/herdrdev/herdr), pinned at commit `4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c`.

Upstream material consulted:

- `src/detect/manifest.rs`
- `src/detect/manifests/claude.toml`
- `src/detect/manifests/codex.toml`
- `src/detect/manifests/cursor.toml`
- `src/detect/manifests/opencode.toml`
- `src/detect/manifests/antigravity.toml`
- `src/detect/manifests/hermes.toml`
- `src/detect/manifest/tests.rs`

Herdr is distributed under Apache License 2.0. The license is reproduced in `LICENSE`. The pinned upstream snapshot has no root `NOTICE` file.

TAP rewrote the detector in TypeScript and fixed it to bundled rules. It kept only Codex's pane-title spinner as a working signal. It removed the other OSC and remote-manifest inputs, removed the known-agent idle fallback and temporal state, and added TAP harness aliases. Absent positive evidence returns `unknown`. The fixtures under `runtime/bun/test/fixtures/agent-state/` are TAP-local test captures derived from TAP's supported harness chrome. They are not copies of Herdr fixture files.
