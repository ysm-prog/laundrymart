import { Card } from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "@/lib/domain/laundry-orders";
import { MAX_ITEM_CODE } from "@/lib/domain/items";
import { addItemCode } from "./actions";

/**
 * Add an item code without leaving the price list.
 *
 * The owner meets this gap here: they work down their rates, find a code they
 * charge for is not in the item master, and would otherwise have to leave for
 * `/items`, add it, and come back to a form that had lost every price typed
 * before the trip.
 *
 * **A server component with a plain form**, so it works with no JavaScript and
 * so the whole card is one `<form>` with one Save — the disclosure pattern
 * §10c settled on for the People screen, minus the second verb.
 */
export function AddItemCard({ returnTo }: { returnTo?: string }) {
  return (
    <Card
      title="Add an item code"
      description="A code you charge for that is not in your item list yet. It is added as
                   something you sell, so every job, charge and invoice can name it straight away."
    >
      <form action={addItemCode} className="space-y-4">
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Item code" name="item_code" required
                 hint={`What the staff type. Up to ${MAX_ITEM_CODE} characters, no spaces.`}>
            <Input name="item_code" required placeholder="TOW001" />
          </Field>
          <Field label="Name" name="name" required>
            <Input name="name" required placeholder="Bath Towel — White" />
          </Field>
          <Field label="Kind of laundry" name="laundry_category"
                 hint="What this counts as when a customer hands it in. Leave blank if it is not
                       laundry — a chemical, a delivery fee.">
            <Select name="laundry_category" placeholder="Not laundry a customer hands in"
                    options={ITEM_TYPES.map((value) => ({
                      value, label: ITEM_TYPE_LABELS[value],
                    }))} />
          </Field>
          {/* Optional, deliberately: an owner may be adding the code now and
              agreeing the rate later. A code with no price is honest — the pricer
              reports it as unpriced — where a zero would bill silently at
              nothing. */}
          <Field label="Price per piece" name="unit_price"
                 hint="What the customer pays, GST included. Leave blank to price it later.">
            <Input name="unit_price" type="number" step="0.01" min={0} inputMode="decimal"
                   placeholder="No price yet" />
          </Field>
        </div>

        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="taxable" defaultChecked
                 className="size-[1.15rem] shrink-0 rounded border-control-border accent-primary" />
          GST applies to this item
        </label>

        <SubmitButton variant="secondary" pendingLabel="Adding…">Add item code</SubmitButton>
      </form>
    </Card>
  );
}
