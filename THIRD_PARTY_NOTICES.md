# Third-party notices

This file covers text in this repository that was copied from, or substantially based on, other
projects. Code merely inspired by another project carries no notice here. Vendored code ships with
its own license files, listed below.

## tap-pair skill contracts

The `/tap:pair` skill's builder and review contracts (`skills/pair/SKILL.md`,
`skills/pair/references/builder-brief.md`, `skills/pair/references/review-contract.md`)
are adapted from the following sources. Their licenses require that the copyright notice and
permission notice accompany the adapted material; both are reproduced here. The contracts were
reworked for TAP's two-seat model; the upstream projects are not affiliated with TAP and do not
endorse it.

From [obra/superpowers](https://github.com/obra/superpowers) `subagent-driven-development`
(`SKILL.md`, `builder-brief.md`, `review-contract.md`):

```text
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

From [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin)
`ce-work` (`builder-brief.md` only):

```text
MIT License

Copyright (c) 2025 Every

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## vendor/fzf

TAP installs the official [fzf](https://github.com/junegunn/fzf) platform executable (fzf is MIT
licensed, Copyright (c) 2013-2026 Junegunn Choi). `vendor/fzf/` carries fzf's own `LICENSE`, the
per-module `*.LICENSE` notices for the Go modules listed by fzf's `go.mod`, the Go runtime's BSD
license (`go.LICENSE`), and a `NOTICE.md` describing the pinned release and archive digests. See
those files for the full license texts; they govern the executable and the modules it embeds.

## runtime/bun/src/agent-state.ts (adapted from Herdr)

`runtime/bun/src/agent-state.ts` adapts agent-screen detection mechanics and selected rule data
from [Herdr](https://github.com/herdrdev/herdr) at upstream commit
`4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c`, under the Apache License 2.0. The full license text
ships at `runtime/bun/third_party/herdr/LICENSE`, and
`runtime/bun/third_party/herdr/README.md` records the upstream files consulted and the changes
TAP made to the adapted material.
