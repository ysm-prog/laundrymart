/**
 * MYOB's **Items Register** export — the file that finally answers what an item
 * sells for and where its money lands.
 *
 * §25 records the earlier *Inventory* export as carrying seven columns and
 * neither a sell/buy flag nor an income account, which is why all 254 imported
 * items arrived uncoded and every one marked both sold and bought. This is the
 * export that has them, and its real columns are:
 *
 *     Item ID | Name | Description | Use item description | Track stock |
 *     Asset category | On hand | Current value | Sell item | Selling price |
 *     Selling price basis | Selling unit | Items per selling unit |
 *     Selling tax code | Income category | Cost of sales category | Buy item |
 *     Buying price | Buying price basis | Buying unit | Items per buying unit |
 *     Buying tax code | Expense category | Supplier item ID | Primary supplier |
 *     Min stock level | Default reorder qty
 *
 * Read from the 257 real rows rather than assumed, and four things in them shape
 * this reader:
 *
 * 1. **`Income category` is `"4-1100 Towels - Black"`** — the account code and
 *    its name in one cell, always in that shape across all 142 sellable rows
 *    (16 distinct codes). The code is what `gl_accounts` matches on.
 * 2. **`Sell item` / `Buy item` are `Y` or blank**, never `N`. 142 sell, 171 buy.
 * 3. **`Selling unit` is mostly junk**: 130 blank, 93 the bare number `1`, and
 *    34 spellings of "each" (`ea`, `ea.`, `each`). A bare number is not a unit,
 *    so it is dropped rather than shown to somebody as one.
 * 4. **`Selling price basis` is `Tax inclusive` or `Tax exclusive`** — 132
 *    exclusive, 10 inclusive. Both are kept as given: the invoice is
 *    tax-inclusive (0043), so an exclusive price is grossed up when it becomes a
 *    line, and storing the converted number instead would lose which it was.
 *
 * `Selling tax code` is normalised through `normaliseTaxCode`, because this
 * register writes a bare `N` for not-reportable on one row and the column only
 * accepts `N-T` — an unnormalised import would be refused by the check
 * constraint at the last moment.
 *
 * The two known defects are the same ones the inventory export had: **2 rows are
 * GUIDs with no name** (dropped, and named in the problem list), and **one Item
 * ID repeats when case is ignored** (`5A-LAUNDRYSE200`), which the partial unique
 * index on `(tenant_id, lower(item_code))` would refuse at insert. Caught here so
 * the message names a row rather than a constraint.
 */

import { normaliseTaxCode } from "../gst";

export const MAX_ITEM_CODE = 30;

export type RegisterItem = {
  /** `Item ID` — the code staff type. */
  code: string;
  name: string;
  description: string | null;
  isSell: boolean;
  isBuy: boolean;
  /** As MYOB gives it. Read together with `sellPriceBasis`. */
  sellPrice: number | null;
  sellPriceBasis: "inclusive" | "exclusive" | null;
  sellingUnit: string | null;
  itemsPerSellingUnit: number | null;
  /** `GST` / `FRE` / `N-T`, or null where MYOB says nothing or something odd. */
  taxCode: "GST" | "FRE" | "N-T" | null;
  /** The account code alone — `4-1100`, not `4-1100 Towels - Black`. */
  incomeAccountCode: string | null;
  costPrice: number | null;
  /** True when MYOB truncated the name at its 30-character field width. */
  nameTruncated: boolean;
};

export type RegisterProblem = { row: number; code: string; reason: string };

export type RegisterRead = {
  items: RegisterItem[];
  problems: RegisterProblem[];
  /** Counted rather than hidden: 58 of the client's names are cut at 30 chars. */
  truncatedNames: number;
};

/** One row as the sheet gives it — every value still a string or blank. */
export type RegisterRow = Record<string, string | number | null | undefined>;

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

function money(v: unknown): number | null {
  const s = text(v);
  if (!s) return null;
  const n = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** `Y` means yes; blank means no. MYOB never writes `N` in these two columns. */
function flag(v: unknown): boolean {
  return text(v).toUpperCase() === "Y";
}

export function parseIncomeAccountCode(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  // "4-1100 Towels - Black" → "4-1100". Anything not in that shape is left for a
  // person rather than guessed at, because a wrong account posts real money.
  const match = /^(\d-\d{3,4})\b/.exec(s);
  return match ? (match[1] ?? null) : null;
}

export function parseSellPriceBasis(value: unknown): "inclusive" | "exclusive" | null {
  const s = text(value).toLowerCase();
  if (s.includes("inclusive")) return "inclusive";
  if (s.includes("exclusive")) return "exclusive";
  return null;
}

/**
 * `ea`, `ea.` and `each` are one unit under three spellings; a bare number is
 * not a unit at all and is dropped. Showing "1" in a Unit column would be a
 * value nobody can read, which is worse than an empty cell.
 */
export function parseSellingUnit(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return null;
  const lower = s.toLowerCase().replace(/\.$/, "");
  if (lower === "ea" || lower === "each") return "ea";
  return s;
}

export function readItemsRegister(rows: readonly RegisterRow[]): RegisterRead {
  const items: RegisterItem[] = [];
  const problems: RegisterProblem[] = [];
  const seen = new Map<string, number>();
  let truncatedNames = 0;

  rows.forEach((row, index) => {
    const line = index + 2; // 1-based, past the header
    const code = text(row["Item ID"]);
    const name = text(row["Name"]);

    if (!code) { problems.push({ row: line, code: "", reason: "no Item ID" }); return; }
    if (!name) {
      // The two GUID rows: sync debris with no name. An item nobody can read is
      // an item nobody can pick.
      problems.push({ row: line, code, reason: "no name — dropped" });
      return;
    }
    if (code.length > MAX_ITEM_CODE) {
      problems.push({ row: line, code, reason: `code is longer than ${MAX_ITEM_CODE} characters` });
      return;
    }

    const key = code.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      // The unique index is on lower(item_code), so this would be refused at the
      // insert. Naming the row beats relaying a constraint violation.
      problems.push({ row: line, code, reason: `same code as row ${first}, ignoring case` });
      return;
    }
    seen.set(key, line);

    const nameTruncated = name.length === 30;
    if (nameTruncated) truncatedNames += 1;

    items.push({
      code,
      name,
      description: text(row["Description"]) || null,
      isSell: flag(row["Sell item"]),
      isBuy: flag(row["Buy item"]),
      sellPrice: money(row["Selling price"]),
      sellPriceBasis: parseSellPriceBasis(row["Selling price basis"]),
      sellingUnit: parseSellingUnit(row["Selling unit"]),
      itemsPerSellingUnit: money(row["Items per selling unit"]),
      taxCode: normaliseTaxCode(row["Selling tax code"] as string | null),
      incomeAccountCode: parseIncomeAccountCode(row["Income category"]),
      costPrice: money(row["Buying price"]),
      nameTruncated,
    });
  });

  return { items, problems, truncatedNames };
}
