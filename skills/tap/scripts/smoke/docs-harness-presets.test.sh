#!/usr/bin/env bash
# Compare every displayed preset field with the shipped reference catalog.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
bun - "$ROOT" "$WORK" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const [root, work] = process.argv.slice(2);
const catalog = Bun.TOML.parse(readFileSync(`${root}/skills/tap/config/config.v3.toml`, "utf8"));
const expected = Object.entries(catalog.presets).map(([name, preset]) => {
  const params = preset.params || {};
  const config = Array.isArray(params.config) ? params.config : [params.config].filter(Boolean);
  const effort = config.filter(value => /^model_reasoning_effort=/.test(value)).at(-1)?.split("=")[1]
    || params.effort || (["agy", "cursor"].includes(preset.harness) ? "in model name" : "—");
  return [name, preset.harness, params.model, effort, preset.metadata?.starter === true].join("\t");
});
const html = readFileSync(`${root}/docs/cheatsheet-harnesses.html`, "utf8");
const clean = text => text.replace(/<[^>]*>/g, "").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').trim();
const actual = [...html.matchAll(/<tr data-preset="([^"]+)">([\s\S]*?)<\/tr>/g)].map(([, name, row]) => {
  const heading = row.match(/<th\b[^>]*>([\s\S]*?)<\/th>/)?.[1];
  const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(match => clean(match[1]));
  if (!heading || cells.length !== 3 || clean(heading).replace(/ ★$/, "") !== name) throw new Error(`malformed preset row: ${name}`);
  return [name, ...cells, clean(heading).endsWith(" ★")].join("\t");
});
if (!expected.length || !actual.length) throw new Error("empty preset catalog/table");
writeFileSync(`${work}/catalog`, expected.sort().join("\n") + "\n");
writeFileSync(`${work}/html`, actual.sort().join("\n") + "\n");
JS
diff -u "$WORK/catalog" "$WORK/html"
echo 'docs-harness-presets: names, harnesses, models, effort and starter marks match'
