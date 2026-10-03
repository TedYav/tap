import { digestItemPreview } from "./sentinel-preview";
import { basename } from "node:path";

export type DigestItem = Record<string, unknown> & { id: string; path: string; ordinal: number };

function checkedItems(value: unknown): DigestItem[] {
  if (!Array.isArray(value)) throw new Error("expected a digest items array");
  const ids = new Set<string>(), ordinals = new Set<number>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.path !== "string")
      throw new Error("each digest item needs an id and path");
    const ordinal = Object.hasOwn(raw, "ordinal") ? raw.ordinal : index + 1;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinals.has(ordinal) || ids.has(raw.id))
      throw new Error("digest item identities and positive ordinals must be unique");
    ids.add(raw.id); ordinals.add(ordinal);
    return { ...raw, ordinal } as DigestItem;
  });
}

/** Rewrites may drop members; an existing digest never acquires new members. */
export function numberDigestItems(items: unknown, previous: unknown = null): DigestItem[] {
  const current = checkedItems(items);
  if (previous === null) return current;
  const prior = new Map(checkedItems(previous).map(item => [item.id, item.ordinal]));
  return current.map(item => {
    const ordinal = prior.get(item.id);
    if (ordinal === undefined) throw new Error("cannot add a member to an existing digest");
    return { ...item, ordinal };
  });
}

export function digestPlan(input: {
  doc: unknown; path: string; verb: "read" | "show"; all: boolean;
  selected: string; ordinal?: string; verbose: boolean; address?: string;
}): { lines: string[]; items: DigestItem[] } {
  const doc = input.doc as Record<string, unknown> | null;
  if (!doc || doc.kind !== "digest") throw new Error("expected a digest object with an items array");
  const items = checkedItems(doc.items);
  if ((input.all && (input.selected || input.ordinal !== undefined)) || (input.selected && input.ordinal !== undefined))
    throw new Error("choose one item selector or --all");
  let selected: DigestItem[] = [];
  if (input.ordinal !== undefined) {
    const n = Number(input.ordinal);
    const item = /^[1-9][0-9]*$/.test(input.ordinal) && Number.isSafeInteger(n) ? items.find(i => i.ordinal === n) : undefined;
    if (!item) throw new Error("digest has " + items.length + " item(s); no item at index " + JSON.stringify(input.ordinal));
    selected = [item];
  } else if (input.selected) {
    selected = items.filter(item => item.id === input.selected);
    if (!selected.length) throw new Error("digest has no item " + JSON.stringify(input.selected));
  } else if (input.all) selected = items;
  for (const item of input.ordinal === undefined ? [] : selected) {
    if (basename(item.path) !== item.id + ".md")
      throw new Error("item " + item.id + " path does not match its payload id");
  }

  const ident = String(doc.digest_id ?? basename(input.path, ".json"));
  const address = input.address || ident;
  const lines: string[] = [];
  const preview = (item: DigestItem): string => {
    const text = digestItemPreview(item);
    return text ? " preview=" + JSON.stringify(text) : "";
  };
  const listing = input.verb === "show" || input.verbose || (!input.all && !input.selected && input.ordinal === undefined);
  if (input.verb === "show" || input.verbose) {
    lines.push("digest: " + ident, "path: " + input.path);
    for (const item of items) lines.push("[" + item.ordinal + "] " + [
      item.id, String(item.from ?? "-"), String(item.kind ?? "discuss"),
      "reply=" + String(item.reply ?? "expected"), "settled=" + String(Boolean(item.settled)), item.path,
    ].join(" · ") + preview(item));
  } else if (listing) {
    lines.push("digest " + ident + ": " + items.length + " items");
    for (const item of items) lines.push("[" + item.ordinal + "] " + item.id + " " +
      String(item.from ?? "-") + " " + (item.reply === "expected" || item.reply === undefined ? "ask" : "note") +
      " " + (item.settled ? "settled" : "open") + preview(item));
  }
  if (listing) {
    // Only token addresses become commands; explicit paths keep --item available.
    const token = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(address);
    if (token) lines.push("Read: tap read " + address + " --all" +
      (items.length ? "  |  tap read " + address + ":" + items[0]!.ordinal : ""));
  }
  return { lines, items: selected };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const result = Bun.argv[2] === "number"
      ? { items: numberDigestItems(input.items, input.previous ?? null) }
      : digestPlan(input);
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String((error as Error).message) }));
  }
}
