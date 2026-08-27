"use client";

import { useId, useMemo, useState } from "react";
import { ButtonLink, Card, cx, CONTROL, EmptyState } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { counted } from "@/lib/format";
import { itemLabel, itemMatches } from "@/lib/domain/items";
import { priceRowHint, type ItemPriceRow, type PricedItem } from "@/lib/domain/laundry-prices";
import { bagField, PRESENT_FIELD, taxableField, unitField } from "./price-form";
import { saveLaundryPrices } from "./actions";

/**
 * The laundry price list, as one form of item codes.
 *
 * The usual list and a customer's own list are the same shape, so they are the
 * same component — the only difference is that a customer's row shows the usual
 * price beneath it, which is what makes leaving a field blank read as "charge
 * them the usual price" rather than as an omission.
 *
 * **Every row is rendered and every row posts; the filter only hides.** That is
 * the one place this departs from §29, which says a filter is a link and lives
 * in the URL, and the reason is that §29 is a rule about *list pages* and this is
 * a form: navigating to narrow 254 items would throw away every price typed
 * before the search. So the search and the two chips are client state that set
 * `hidden` on a row, the inputs keep posting either way, and `present` therefore
 * covers the whole list however it is filtered. CLAUDE.md beats the standards
 * file, and this is the departure said out loud rather than made quietly.
 *
 * `hidden` and not unmounting, for the same reason: an unmounted input posts
 * nothing, and a row that stops posting silently loses whatever was typed into
 * it before the search narrowed it away.
 */

type Filter = "all" | "priced" | "unpriced";

export function ItemPriceTable<T extends PricedItem>({
  title,
  description,
  rows,
  customerId,
  returnTo,
  writable,
  submitLabel = "Save prices",
}: {
  title: string;
  description: string;
  rows: readonly ItemPriceRow<T>[];
  customerId?: string;
  returnTo?: string;
  writable: boolean;
  submitLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  /*
   * DOM ids are per table instance, not per item.
   *
   * The **names** stay `unit_<itemId>`, because that is the contract
   * `parsePriceForm` reads. The ids cannot: a customer's screen and the gallery
   * both draw more than one of these, and two `unit_i-t22`s in one document
   * means every `<label for>` resolves to whichever came first — invalid HTML
   * that a typecheck, a unit test and a screenshot all miss equally. §27 records
   * this exact defect on the charges editor and §18 records it again on the
   * People screen; measuring is what catches it both times.
   */
  const uid = useId();
  const domId = (field: string) => `${uid}${field}`;

  const priced = useMemo(() => rows.filter((row) => row.price !== null).length, [rows]);

  // Which rows the filter is showing. Computed as a set of ids rather than a
  // filtered array, because the render below walks *every* row — the hidden ones
  // still have to be in the DOM to post.
  const shown = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      if (filter === "priced" && row.price === null) continue;
      if (filter === "unpriced" && row.price !== null) continue;
      if (!itemMatches(row.item, query)) continue;
      set.add(row.item.id);
    }
    return set;
  }, [rows, query, filter]);

  const chips: Array<{ value: Filter; label: string; count: number }> = [
    { value: "all", label: "All", count: rows.length },
    { value: "priced", label: "Priced", count: priced },
    { value: "unpriced", label: "No price yet", count: rows.length - priced },
  ];

  if (rows.length === 0) {
    return (
      <Card title={title} description={description}>
        <EmptyState
          title="No item codes to price"
          description="Your price list is built from the items you sell. Add an item code below, or
                       tick “I sell this” on an item you already have."
          action={<ButtonLink href="/items" variant="secondary">Open your items</ButtonLink>}
        />
      </Card>
    );
  }

  return (
    <Card title={title} description={description}>
      <form action={saveLaundryPrices} className="space-y-4">
        {customerId ? <input type="hidden" name="customer_id" value={customerId} /> : null}
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <label className="sr-only" htmlFor={domId("search")}>Search item codes</label>
          <input id={domId("search")} type="search" value={query} placeholder="Search a code or name…"
                 onChange={(event) => setQuery(event.target.value)}
                 className={cx(CONTROL, "sm:max-w-72")} />
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button key={chip.value} type="button" onClick={() => setFilter(chip.value)}
                      aria-pressed={filter === chip.value}
                      className={cx(
                        "min-h-11 rounded-lg border px-3 text-sm transition",
                        filter === chip.value
                          ? "border-foreground bg-foreground text-background"
                          : "border-strong hover:bg-surface-muted",
                      )}>
                {chip.label} <span className="tabular-nums opacity-70">{chip.count}</span>
              </button>
            ))}
          </div>
        </div>

        <p className="text-sm text-muted-foreground" role="status">
          {shown.size === rows.length
            ? `Showing all ${counted(rows.length, "item code")}.`
            : `Showing ${shown.size} of ${counted(rows.length, "item code")}. `
              + "Prices you have typed are still saved, whether or not they are on screen."}
        </p>

        <div className="space-y-3">
          {/* Column headings on a wide screen only: below `sm` each row is a
              stacked block with its own labels, the same idea DataTable uses. */}
          <div className="hidden gap-3 px-1 text-xs font-medium text-muted-foreground sm:grid
                          sm:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,1fr))_auto]">
            <span>Item code</span>
            <span>Price per piece</span>
            <span>Price per bag</span>
            <span className="text-right">GST</span>
          </div>

          {rows.map((row) => {
            const { item, price, fallback } = row;
            const unitName = unitField(item.id);
            const unitId = domId(unitName);
            const hint = priceRowHint(row);
            return (
              <div key={item.id} hidden={!shown.has(item.id)}
                   className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,1fr))_auto]
                              sm:items-center sm:border-0 sm:p-1">
                {/* Every rendered row is posted, filtered or not — see the note
                    above. This is what tells the action which codes were on the
                    form, so a blank field can mean "clear this price" without
                    a code that was never shown being read as blank. */}
                <input type="hidden" name={PRESENT_FIELD} value={item.id} />

                <div className="min-w-0">
                  <label htmlFor={unitId} className="text-sm font-medium text-foreground">
                    {itemLabel(item)}
                  </label>
                  {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
                </div>

                <div>
                  <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Price per piece</span>
                  {/* The placeholder says what a blank field *means*, never the
                      figure it would fall back to — a greyed number in a price
                      box reads as a value that is already set. */}
                  <input id={unitId} name={unitName} type="number" step="0.01" min={0}
                         inputMode="decimal" readOnly={!writable}
                         placeholder={fallback ? "Usual price" : "No price"}
                         defaultValue={price ? price.unitPrice : ""}
                         className={CONTROL} />
                </div>

                <div>
                  <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Price per bag</span>
                  <input name={bagField(item.id)} type="number" step="0.01" min={0}
                         inputMode="decimal" readOnly={!writable}
                         placeholder="optional"
                         defaultValue={price?.bagPrice ?? ""}
                         className={CONTROL} />
                </div>

                {/* `relative`, because the label below becomes `sr-only` at `sm`
                    and an absolutely-positioned child needs a containing block
                    inside the layout — the planner's 227px overflow was exactly
                    this, one screen wider. */}
                <label className="relative flex min-h-11 min-w-11 items-center gap-2 px-1 text-sm
                                  sm:justify-end">
                  <input type="checkbox" name={taxableField(item.id)}
                         defaultChecked={price ? price.taxable : true}
                         disabled={!writable}
                         className="size-[1.15rem] shrink-0 rounded border-control-border accent-primary" />
                  <span className="sm:sr-only">GST applies</span>
                </label>
              </div>
            );
          })}

          {shown.size === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No item code matches “{query}”. Clear the search, or add the code below.
            </p>
          ) : null}
        </div>

        {writable ? <SubmitButton>{submitLabel}</SubmitButton> : null}
      </form>
    </Card>
  );
}
