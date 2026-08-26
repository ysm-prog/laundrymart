/**
 * The columns both item screens read, stated once.
 *
 * The list and the detail page had their own hand-maintained `select(...)`
 * strings, and they had already drifted: the detail page named
 * `income_account_id` **twice** and the list page did not name `xero_item_code`
 * at all. Neither is visible to a typecheck — PostgREST takes a string, so a
 * column that is missing from it comes back `undefined` and renders as a blank
 * field that silently saves as empty.
 *
 * With 0044 that risk stops being theoretical: the detail form now writes
 * fifteen more columns, and a form that *posts* a field it never *read* is a
 * form that clears it on every save.
 *
 * The list reads a few columns it does not display, which is the deliberate
 * trade — 254 rows of short text against two lists that cannot disagree.
 */
export const ITEM_COLUMNS = [
  "id", "sku", "item_code", "name", "description", "use_item_description",
  "category", "laundry_category", "ownership_type", "status",

  // Selling. `sell_price_basis`, `selling_unit` and `items_per_selling_unit` are
  // 0043's; everything else on this line is older.
  "is_sell", "sell_price", "sell_price_basis", "selling_unit",
  "items_per_selling_unit", "tax_code", "income_account_id",
  "cost_of_sales_account_id", "xero_item_code",

  // Buying — all 0044, all null on every row until somebody edits an item.
  "is_buy", "cost_price", "buy_price_basis", "buy_unit", "buy_units_per",
  "buy_tax_code", "expense_account_id", "supplier_item_code",

  // Restocking. `reorder_level` is MYOB's *minimum stock level* and
  // `default_reorder_qty` is how much to order — two numbers, both kept.
  "track_stock", "asset_account_id", "primary_supplier_id", "reorder_level",
  "default_reorder_qty",

  // Linen this laundry owns and rents out, which predates the item master.
  "replacement_cost", "rental_price", "wash_only_price", "weight_kg",

  // Provenance.
  "myob_item_id", "myob_item_code", "external_synced_at",
].join(", ");
