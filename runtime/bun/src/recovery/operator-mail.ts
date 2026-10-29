import type { PayloadRef } from "./state";
import type { OperatorBinding, OperatorMail } from "./operator-admission";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { envelopeField } from "../envelope";
import { validId } from "../ids";
import { noEffectProof } from "../spool-effect-proof";
import { routingHeader } from "./evidence";

/** Only a retained spool pair with the courier's own no-effect proof establishes undelivered age. */
export function readOperatorMail(refs: PayloadRef[], binding: OperatorBinding): OperatorMail[] {
  return refs.map(ref => {
    const item: OperatorMail = { id: ref.id, home: ref.home, instance: "", firstSpooled: null,
      disposition: "unconfirmed", valid: false };
    if (!validId(ref.id) || !ref.home.startsWith("/")) return item;
    try {
      const spool = join(ref.home, "spool"), header = routingHeader(join(spool, `${ref.id}.md`));
      item.instance = envelopeField(header, "recipient_instance") ?? "";
      if (envelopeField(header, "id") !== ref.id || envelopeField(header, "to") !== binding.handle
        || (envelopeField(header, "to_team") || ref.team) !== binding.team || item.instance !== binding.instance) return item;
      const fd = openSync(join(spool, `${ref.id}.meta.json`), constants.O_RDONLY | constants.O_NONBLOCK);
      let meta;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 65536) return item;
        meta = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.id !== ref.id
        || meta.target !== binding.handle || (meta.to_team || meta.team) !== binding.team
        || meta.pane !== binding.pane || meta.pane_id !== binding.paneId
        || typeof meta.target_registry !== "string" || realpathSync(meta.target_registry) !== realpathSync(binding.registry)) return item;
      const at = meta.first_spooled_epoch;
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || !Number.isSafeInteger(at * 1000)) return item;
      item.firstSpooled = at * 1000;
      item.valid = true;
      if (noEffectProof(ref.home, spool, ref.id, meta) === "") item.disposition = "undelivered";
      return item;
    } catch { return item; }
  });
}
