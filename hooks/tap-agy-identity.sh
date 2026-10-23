#!/bin/bash
# Runtime adapter only: the Bun entry owns native identity capture and failure handling.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -x "$REPO/libexec/tap/bun" ]; then exec "$REPO/libexec/tap/bun" "$REPO/runtime/bun/src/agy-identity-hook.ts"; fi
if command -v bun >/dev/null 2>&1; then exec bun "$REPO/runtime/bun/src/agy-identity-hook.ts"; fi
printf '{}\n'
