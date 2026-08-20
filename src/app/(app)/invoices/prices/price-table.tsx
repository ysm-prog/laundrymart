import { Card } from "@/components/ui";
import { Input, SubmitButton } from "@/components/form";
import { money } from "@/lib/format";
import { ITEM_TYPES, ITEM_TYPE_LABELS, type ItemType } from "@/lib/domain/laundry-orders";
import { bagField, taxableField, unitField } from "./price-form";
import { saveLaundryPrices } from "./actions";

/**
 * The price list, as one form of nine rows — the default list and a customer's
 * own list are the same shape, so they are the same component.
 *
 * All nine kinds of laundry are always shown, priced or not, because the
 * question the screen has to answer is "what will the monthly run be able to
 * bill?" — and a kind of laundry that is missing from the list is precisely the
 * one that will be left off an invoice. A blank row is that answer, said out
 * loud, rather than a row that quietly does not exist.
 */

export type PriceRowValue = {
  unitPrice: number;
  bagPrice: number | null;
  taxable: boolean;
};

export function PriceTable({
  title,
  description,
  values,
  defaults,
  customerId,
  returnTo,
  writable,
  submitLabel = "Save prices",
}: {
  title: string;
  description: string;
  /** The prices stored for *this* list. A kind of laundry with no row is absent. */
  values: ReadonlyMap<ItemType, PriceRowValue>;
  /**
   * The tenant default, shown beside a customer's own row so the person setting
   * an override can see what they are overriding — and so leaving it blank
   * reads as "use the usual price" rather than as an omission.
   */
  defaults?: ReadonlyMap<ItemType, PriceRowValue>;
  customerId?: string;
  returnTo?: string;
  writable: boolean;
  submitLabel?: string;
}) {
  return (
    <Card title={title} description={description}>
      <form action={saveLaundryPrices} className="space-y-4">
        {customerId ? <input type="hidden" name="customer_id" value={customerId} /> : null}
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}

        <div className="space-y-3">
          {/* Column headings on a wide screen only: below `sm` each row is a
              stacked block with its own labels, the same idea DataTable uses. */}
          <div className="hidden gap-3 px-1 text-xs font-medium text-muted-foreground sm:grid
                          sm:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))_auto]">
            <span>Kind of laundry</span>
            <span>Price per piece</span>
            <span>Price per bag</span>
            <span className="text-right">GST</span>
          </div>

          {ITEM_TYPES.map((itemType) => {
            const value = values.get(itemType);
            const fallback = defaults?.get(itemType);
            return (
              <div key={itemType}
                   className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))_auto]
                              sm:items-center sm:border-0 sm:p-1">
                <div>
                  <label htmlFor={unitField(itemType)} className="text-sm font-medium text-foreground">
                    {ITEM_TYPE_LABELS[itemType]}
                  </label>
                  {fallback ? (
                    <p className="text-xs text-muted-foreground">
                      Usual price {money(fallback.unitPrice)}
                      {fallback.bagPrice ? ` · ${money(fallback.bagPrice)} a bag` : ""}
                    </p>
                  ) : null}
                </div>

                <div>
                  <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Price per piece</span>
                  {/* The placeholder says what a blank field *means*, never the
                      figure it would fall back to — a greyed number in a price
                      box reads as a value that is already set. */}
                  <Input name={unitField(itemType)} type="number" step="0.01" min={0}
                         inputMode="decimal" readOnly={!writable}
                         placeholder={fallback ? "Usual price" : "No price"}
                         defaultValue={value ? value.unitPrice : ""} />
                </div>

                <div>
                  <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Price per bag</span>
                  <Input name={bagField(itemType)} type="number" step="0.01" min={0}
                         inputMode="decimal" readOnly={!writable}
                         placeholder="optional"
                         defaultValue={value?.bagPrice ?? ""} />
                </div>

                {/* `relative`, because the label below becomes `sr-only` at `sm`
                    and an absolutely-positioned child needs a containing block
                    inside the layout — the planner's 227px overflow was exactly
                    this, one screen wider. */}
                <label className="relative flex min-h-11 items-center gap-2 text-sm sm:justify-end">
                  <input type="checkbox" name={taxableField(itemType)}
                         defaultChecked={value ? value.taxable : true}
                         disabled={!writable}
                         className="size-[1.15rem] shrink-0 rounded border-strong accent-primary" />
                  <span className="sm:sr-only">GST applies</span>
                </label>
              </div>
            );
          })}
        </div>

        {writable ? <SubmitButton>{submitLabel}</SubmitButton> : null}
      </form>
    </Card>
  );
}
