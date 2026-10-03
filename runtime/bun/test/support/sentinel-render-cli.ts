// Test adapter for the native wire constructor used by send and spool delivery.
import { renderSentinel } from "../../src/sentinel";
import { senderIndexEvidence } from "../../src/remote-target";

const [from = "", to = "", id = "", kind = "", reply = "", urgency, path = "", body] = process.argv.slice(2);
const fromTeam = from.includes("/") ? from.split("/", 1)[0]! : "";
const toTeam = to.includes("/") ? to.split("/", 1)[0]! : "";
process.stdout.write(renderSentinel({ from, to, id, kind, reply, urgency, path, body,
  senderIndex: fromTeam && toTeam && fromTeam !== toTeam ? senderIndexEvidence(fromTeam, process.env.TAP_INDEX_HOME) : undefined }));
