// Shell fixture bridge to the product writer: seed the EXPIRED input-protection
// record a production park would have left behind. A park that never went
// through the courier (fixture park_busy) mints nothing, so a forced drain
// would mint a fresh real-clock grace on its first look — seeding the expired
// record first is what puts the drain on the delivery path it is built for.
// Exits nonzero when the writer declined to write a record, so a vacuous seed
// is loud rather than a silent fresh-mint hold.
import { seedExpiredProtection } from "./input-protection-seed";

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const requireArg = (flag: string): string => {
  const v = get(flag);
  if (!v) {
    process.stderr.write(`input-protection-seed-cli: missing ${flag}\n`);
    process.exit(2);
  }
  return v;
};

const paneId = requireArg("--pane");
const written = seedExpiredProtection({
  env: process.env,
  paneId,
  serverEpoch: get("--epoch") ?? process.env.TAP_SERVER_EPOCH ?? "",
  harness: get("--harness"),
  home: requireArg("--home"),
  id: requireArg("--id"),
  sender: get("--sender"),
  ageSeconds: get("--age") ? Number(get("--age")) : undefined,
  draft: get("--draft"),
});
if (!written) {
  process.stderr.write(`input-protection-seed-cli: the writer declined to seed a record for pane ${paneId}\n`);
  process.exit(1);
}
const until = written.snoozeUntil || written.graceUntil;
process.stdout.write(`input-protection-seed-cli: pane ${paneId} graceUntil=${new Date(until).toISOString()}\n`);
