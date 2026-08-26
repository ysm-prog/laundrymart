/**
 * MYOB's inventory export, and what has to be cleaned out of it.
 *
 * §25 said the item importer was deliberately not built because the export's real
 * column names had to be read rather than guessed — the discipline the bills
 * import learned the hard way. The file has now been read, and this is what it
 * actually contains:
 *
 *     Item ID | Item Number | Name | On hand | Current value ($) | Selling price ($) | Tax
 *
 * **`Item Number` is the code staff type**, not `Item ID` — that is MYOB's own
 * internal row number (239, 229, 265…) and means nothing to anybody. `TW`,
 * `GTW`, `HTW`, `BT`, `Del` all live in `Item Number`.
 *
 * Four things in the real file that would otherwise land in front of staff, each
 * measured on the 257-row export rather than anticipated:
 *
 * 1. **58 names are exactly 30 characters** — the export truncates
 *    ("Salon Smart Premium Towels Bla"). They import as-is because a shortened
 *    name is still the right item, but they are *counted and reported* so
 *    somebody can fix the ones that matter.
 * 2. **16 codes carry a stray backslash** (`2-B201\_PK100`) — markdown escaping
 *    that leaked into the export. Unescaped here, because `2-B201\_PK100` is a
 *    code nobody can type and nothing will ever match.
 * 3. **2 rows are GUIDs with no name at all** — junk from some earlier sync.
 *    Dropped, because an item with no name cannot be picked or read.
 * 4. **The selling price is empty on 255 of 257 rows.** Not a fault: these are
 *    mostly things the laundry *buys* — chemicals, gloves, dispensers, trolleys.
 *    What a customer is charged lives in the price list (`laundry_prices`),
 *    per customer with a tenant default, which is where this app has always kept
 *    it. The two real prices are carried across; nothing is invented for the rest.
 *
 * **`Tax` is deliberately not mapped to `items.tax_code`.** MYOB's Included /
 * Excluded says whether the selling price *includes* GST; our `tax_code` is the
 * ledger's code (GST, FRE, N-T). They are different questions and mapping one
 * onto the other would put a wrong tax code on 257 items — exactly the kind of
 * guess §25 exists to prevent.
 *
 * **`is_sell` / `is_buy` are not in this file either**, so neither is inferred:
 * every row imports as both, which is MYOB's own "we do not know" and what 0032
 * says the two booleans are for. MYOB's *Items List [Summary]* export carries the
 * real flags; when that arrives this reader gains two columns and no new rules.
 */

/** One item, as this export really gives it. */
export type InventoryItem = {
  /** `Item Number` — the code staff type. Never MYOB's internal `Item ID`. */
  code: string;
  name: string;
  /** MYOB's internal row id, kept so a re-import matches rather than duplicates. */
  myobItemId: string | null;
  onHand: number;
  /** Only where MYOB actually holds one. Null is the ordinary case here. */
  sellPrice: number | null;
  /** True when MYOB's selling price is GST-inclusive. Recorded, not acted on. */
  taxInclusive: boolean;
  /** True when the export truncated the name at its 30-character limit. */
  nameTruncated: boolean;
};

export type InventoryRead = {
  items: InventoryItem[];
  /** Rows deliberately not imported, and why — never silently dropped. */
  skipped: Array<{ row: number; code: string | null; reason: string }>;
  /** Things somebody should look at, which are not reasons to refuse the file. */
  notes: string[];
};

/** The export's headers, in the order MYOB writes them. */
export const INVENTORY_COLUMNS = [
  "Item ID", "Item Number", "Name", "On hand", "Current value ($)", "Selling price ($)", "Tax",
] as const;

/** MYOB truncates both of these fields at 30 characters. */
export const MYOB_FIELD_WIDTH = 30;

/**
 * Undo the markdown escaping that leaked into the export.
 *
 * `2-B201\_PK100` is not a code that exists anywhere; `2-B201_PK100` is. Only
 * `\_` is unescaped — a backslash before anything else is left alone, because a
 * code legitimately containing one is somebody's real code and inventing a rule
 * for it would be the guess this module exists to avoid.
 */
export function cleanCode(raw: string): string {
  return raw.trim().replace(/\\_/g, "_");
}

/** Does this look like MYOB's placeholder rather than a real item? */
export function isPlaceholderRow(code: string, name: string): boolean {
  if (!name.trim()) return true;
  // A bare GUID in the code column with nothing beside it is sync debris.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f-]*$/i.test(code) && !name.trim();
}

function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = Number(String(raw).replace(/[$,]/g, "").trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Read the export into items, the rows it refused, and what wants a human eye.
 *
 * Takes rows already parsed out of the sheet (header first) so the file format
 * stays the caller's problem and this stays pure and testable — the arrangement
 * `readAccounts` uses, and the reason those readers are the tested half.
 */
export function readInventory(rows: readonly (readonly unknown[])[]): InventoryRead {
  const items: InventoryItem[] = [];
  const skipped: InventoryRead["skipped"] = [];
  const notes: string[] = [];
  if (rows.length === 0) return { items, skipped, notes: ["That file has no rows in it."] };

  const header = (rows[0] ?? []).map((cell) => String(cell ?? "").trim());
  const missing = INVENTORY_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return {
      items: [], skipped: [],
      notes: [`Expected a MYOB inventory export; it has no ${missing.join(", ")} column.`],
    };
  }
  const at = (name: string) => header.indexOf(name);
  const [idAt, codeAt, nameAt, onHandAt, priceAt, taxAt] = [
    at("Item ID"), at("Item Number"), at("Name"), at("On hand"), at("Selling price ($)"), at("Tax"),
  ];

  const seen = new Map<string, number>();
  let truncatedNames = 0;
  let unescaped = 0;

  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    if (!row.some((cell) => String(cell ?? "").trim() !== "")) return;

    const rawCode = String(row[codeAt] ?? "");
    const code = cleanCode(rawCode);
    const name = String(row[nameAt] ?? "").trim();
    if (code !== rawCode.trim()) unescaped += 1;

    if (!code) {
      skipped.push({ row: line, code: null, reason: "no item number" });
      return;
    }
    if (isPlaceholderRow(code, name)) {
      skipped.push({ row: line, code, reason: "no name — sync debris, not an item" });
      return;
    }
    if (!name) {
      skipped.push({ row: line, code, reason: "no name" });
      return;
    }

    const lower = code.toLowerCase();
    const first = seen.get(lower);
    if (first !== undefined) {
      // Our own unique index is case-insensitive per laundry, so two codes that
      // differ only in case would fail the insert. Said here rather than at the
      // database, where the message names a constraint instead of a row.
      skipped.push({ row: line, code, reason: `the same code as row ${first}` });
      return;
    }
    seen.set(lower, line);

    const nameTruncated = name.length === MYOB_FIELD_WIDTH;
    if (nameTruncated) truncatedNames += 1;

    items.push({
      code,
      name,
      myobItemId: String(row[idAt] ?? "").trim() || null,
      onHand: toNumber(row[onHandAt]) ?? 0,
      sellPrice: toNumber(row[priceAt]),
      taxInclusive: String(row[taxAt] ?? "").trim().toLowerCase() === "included",
      nameTruncated,
    });
  });

  const priced = items.filter((item) => item.sellPrice !== null).length;
  if (priced === 0) {
    notes.push(
      "No item in this export carries a selling price, so every rate comes from your "
      + "laundry price list. Picking an item still fills in the code.",
    );
  } else if (priced < items.length) {
    notes.push(
      `${priced} of ${items.length} items carry a selling price. The rest take their rate `
      + "from your laundry price list.",
    );
  }
  if (truncatedNames > 0) {
    notes.push(
      `${truncatedNames} names arrive cut off at ${MYOB_FIELD_WIDTH} characters — that is MYOB's `
      + "export limit, not a fault here. They import as they are; edit the ones that matter.",
    );
  }
  if (unescaped > 0) {
    notes.push(`${unescaped} item numbers had a stray backslash removed (2-B201\\_PK100 → 2-B201_PK100).`);
  }
  notes.push(
    "This export says nothing about which items you sell and which you buy, so each is "
    + "imported as both. MYOB's Items List export carries those flags if you want them set.",
  );

  return { items, skipped, notes };
}
