import type { PricedItem } from "@/lib/domain/laundry-prices";

/**
 * The item columns the price screens read, stated once.
 *
 * Both screens select the same set and both hand it to the same component, so a
 * column named on one and not the other is a field the table renders as blank on
 * one screen only. `ITEM_COLUMNS` in `items/columns.ts` exists for the same
 * reason and records the drift that made it necessary: two hand-maintained
 * `select(...)` strings had silently diverged, and a typecheck cannot see it.
 */
export const PRICE_LIST_ITEM_COLUMNS =
  "id, item_code, name, description, laundry_category, sell_price, selling_unit, sell_price_basis";

export type PriceListItem = PricedItem & {
  id: string;
  description: string | null;
};
