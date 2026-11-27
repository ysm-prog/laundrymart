import { Card } from "@/components/ui";
import { Field, Input, SubmitButton } from "@/components/form";
import { money } from "@/lib/format";
import { lotPricing } from "@/lib/domain/lot-booking";
import { saveLotPrice } from "./actions";

/**
 * The standard lot price (0067): what one lot costs when a job is booked with
 * Laundry by Lot switched on.
 *
 * **The one thing it must say plainly is what a change does not do.** A booking
 * keeps the price it was taken at (0066's trigger fixes it on the job), so
 * changing this re-prices nothing already booked, drafted or invoiced.
 *
 * A server component with a plain form, so it works with no JavaScript; the
 * equivalent including GST is worked out from the saved price, not live.
 */
export function LotPriceCard({
  unitPriceExGst, gstRate, saved, writable,
}: { unitPriceExGst: number; gstRate: number; saved: boolean; writable: boolean }) {
  const one = lotPricing(1, unitPriceExGst, gstRate);
  return (
    <Card
      title="Laundry by lot"
      description="The price of one lot, for jobs booked with Laundry by Lot switched on."
    >
      <p className="mb-4 text-sm text-muted-foreground">
        Now <strong className="text-foreground">{money(one.unitPriceExGst)}</strong> a lot excluding
        GST — {money(one.totalIncGst)} including {money(one.gstAmount)} GST
        {saved ? "." : " (the standard price; you have not set your own yet)."}
      </p>
      {writable ? (
        <form action={saveLotPrice} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Price per lot (excl. GST)" name="lot_price_ex_gst" required
                   hint="Lots booked from now on use this price. A job already booked by the lot keeps the price it was booked at.">
              <Input name="lot_price_ex_gst" type="number" step="0.01" min="0.01" max={100000}
                     inputMode="decimal" required defaultValue={one.unitPriceExGst.toFixed(2)} />
            </Field>
          </div>
          <SubmitButton variant="secondary" size="md" pendingLabel="Saving…">
            Save lot price
          </SubmitButton>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">Only the Owner or an Office manager can change it.</p>
      )}
    </Card>
  );
}
