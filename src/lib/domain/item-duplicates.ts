/**
 * Items that look like the same thing under two codes (Darshan's review,
 * brief 3.5, G15).
 *
 * The live list holds T22, T23, T24 and T25, all named "Towels - Black" and
 * differing only in the rate the code was created for, beside 42469 and 88658.
 * A counter hand searching "towel" is offered all of them and has no way to
 * tell which one this customer is priced on. This finds the groups so the
 * owner can retire the extras — as **inactive**, never deleted: inactive items
 * stay on every old job, charge and invoice, and drop out of the pickers.
 *
 * Grouped on the name with case, spacing and punctuation folded away, so
 * "Towels - Black", "towels black" and "TOWELS – BLACK" are one group and
 * "Towel" and "Towels" stay apart (that is a judgement for a person).
 */
export function normaliseItemName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export type DuplicateItem = {
  id: string; item_code: string | null; name: string; status: string;
};

export function findDuplicateItems<T extends DuplicateItem>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = normaliseItemName(item.name);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()]
    // A group is worth a person's time only while two of it are still offered.
    .filter((group) => group.filter((item) => item.status === "active").length > 1)
    .map((group) => [...group].sort((a, b) => (a.item_code ?? "").localeCompare(b.item_code ?? "", undefined, { numeric: true })))
    .sort((a, b) => b.length - a.length || normaliseItemName(a[0]!.name).localeCompare(normaliseItemName(b[0]!.name)));
}
