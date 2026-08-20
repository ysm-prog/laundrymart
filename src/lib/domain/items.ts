/**
 * The item master, said the way the counter says it. No database in sight.
 *
 * **Staff know the codes.** They type TOW001, not "bath towels" — that is the
 * whole reason the item master exists — so an item reads
 *
 *     TOW001 — Bath Towel
 *
 * wherever it appears, and the search matches the code before the name. A person
 * who has typed `TOW` a thousand times should get their answer on the third
 * keystroke, not after scrolling a list ordered by something else.
 */

/** What these rules need to know about an item. Deliberately less than a row. */
export type PickableItem = {
  id: string;
  item_code: string | null;
  name: string;
  description?: string | null;
  laundry_category?: string | null;
  status?: string;
};

/**
 * `TOW001 — Bath Towel`, or just the name where no code has been set.
 *
 * The code leads because it is the shorter, more certain half: two items can be
 * called "Bath Towel" and only one can be TOW001.
 */
export function itemLabel(item: Pick<PickableItem, "item_code" | "name">): string {
  const code = item.item_code?.trim();
  return code ? `${code} — ${item.name}` : item.name;
}

/**
 * Does this item match what somebody typed?
 *
 * Case- and space-insensitive, and matched against the code, the name and the
 * description — the three things a person might half-remember. A blank query
 * matches everything, so the picker opens on the full list rather than empty.
 */
export function itemMatches(item: PickableItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.item_code, item.name, item.description]
    .some((field) => field?.toLowerCase().includes(needle));
}

/**
 * The items matching a query, code matches first.
 *
 * Ranked rather than merely filtered, and the ranking is the point: typing `TOW`
 * should put TOW001 above "Pillowcase (towelling trim)", which merely contains
 * the letters. Within a rank the order is the caller's, which is by code.
 */
export function searchItems<T extends PickableItem>(
  items: readonly T[], query: string, limit = 20,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items.slice(0, limit);

  const rank = (item: PickableItem): number => {
    const code = item.item_code?.toLowerCase() ?? "";
    const name = item.name.toLowerCase();
    if (code === needle) return 0;
    if (code.startsWith(needle)) return 1;
    if (name.startsWith(needle)) return 2;
    if (code.includes(needle)) return 3;
    if (name.includes(needle)) return 4;
    return 5;
  };

  return items
    .filter((item) => itemMatches(item, query))
    .map((item, index) => ({ item, index, rank: rank(item) }))
    // `index` keeps the caller's order inside a rank, so the list does not
    // reshuffle as somebody types a longer prefix of the same code.
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * Is this code usable, and is it free?
 *
 * The uniqueness rule the client asked for, stated here so the form can say so
 * before the insert does. The database holds the real constraint — a unique
 * index, case-insensitive per laundry — because two people can type the same
 * code at the same moment and only one of them can be told by a screen.
 */
export function checkItemCode(
  code: string, taken: readonly string[], existingId?: string, byId?: ReadonlyMap<string, string>,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "An item code is required." };
  if (trimmed.length > 20) return { ok: false, reason: "Keep the item code to 20 characters." };
  if (/\s/.test(trimmed)) {
    return { ok: false, reason: "An item code cannot contain spaces." };
  }

  const lower = trimmed.toLowerCase();
  const own = existingId ? byId?.get(existingId)?.toLowerCase() : undefined;
  if (own === lower) return { ok: true };

  if (taken.some((other) => other.trim().toLowerCase() === lower)) {
    return { ok: false, reason: `The item code ${trimmed} is already in use.` };
  }
  return { ok: true };
}
