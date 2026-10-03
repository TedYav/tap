import type { Bus } from "./bus";

/** One canonical census serves bounded history and both obligation directions.
 * Settlement is checked before callers stat or read outstanding message bodies. */
export function recapMessages(bus: Bus) {
  const ids = bus.canonicalIds().filter(id => id !== "" && !id.startsWith("."))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  function* outstanding() {
    for (const id of ids) {
      if (!bus.isDone(id)) yield { id, path: bus.payloadPath(id) };
    }
  }
  return { ids, outstanding: outstanding() };
}
