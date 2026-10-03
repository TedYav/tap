// Captured Claude 2.1.287 / Codex 0.160.0 local marketplace JSON contracts.
// Installer tests invoke this fixture instead of depending on installed harnesses.
import { existsSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const [host, command, verb, ...args] = process.argv.slice(2);
if (command !== "plugin") process.exit(0);
const home = host === "claude" ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") : process.env.CODEX_HOME || join(homedir(), ".codex");
const file = join(home, ".native-plugin-fixture.json");
const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { markets: {}, plugins: {} };
let result: unknown = {};
if (verb === "marketplace") {
  const [operation, value] = args;
  if (operation === "list") {
    const rows = Object.entries(data.markets).map(([name, source]) => host === "claude"
      ? { name, source: "directory", path: source, installLocation: source }
      : { name, root: source, marketplaceSource: { sourceType: "local", source } });
    result = host === "claude" ? rows : { marketplaces: rows };
  } else if (operation === "add") {
    const market = JSON.parse(readFileSync(join(value!, ".claude-plugin/marketplace.json"), "utf8"));
    const source = host === "codex" ? realpathSync(value!) : value;
    if (data.markets[market.name] && data.markets[market.name] !== source) throw new Error("marketplace already added from a different source");
    data.markets[market.name] = source;
  } else if (operation === "remove") delete data.markets[value!];
  else throw new Error(`unsupported fixture marketplace command ${operation}`);
} else if (verb === "list") {
  const rows = Object.keys(data.plugins).filter(id => host === "claude" || data.markets[id.split("@")[1]!]).map(id => host === "claude"
    ? { id, scope: "user", enabled: data.plugins[id] }
    : { pluginId: id, installed: true, enabled: data.plugins[id] });
  result = host === "claude" ? rows : { installed: rows, available: [] };
} else if (verb === "add" || verb === "install") data.plugins[args[0]!] = true;
else if (verb === "remove" || verb === "uninstall") delete data.plugins[args[0]!];
else if (verb !== "update") throw new Error(`unsupported fixture plugin command ${verb}`);
const listing = verb === "list" || (verb === "marketplace" && args[0] === "list");
if (!listing) {
  if (Object.keys(data.markets).length || Object.keys(data.plugins).length) writeFileSync(file, JSON.stringify(data));
  else if (existsSync(file)) unlinkSync(file);
}
if (host === "claude" && !listing) console.log("fixture progress");
console.log(JSON.stringify(result, null, listing ? 2 : undefined));
