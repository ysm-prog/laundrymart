"use client";

import { useState } from "react";
import Link from "next/link";
import { counted, money } from "@/lib/format";
import { formatMoney } from "@/lib/domain/pricing";
import { approveSelectionConfirmation } from "@/lib/domain/confirmations";
import { Badge, Button } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { approveSelectedJobs, placeSelectedJobs, priceSelectedJobs } from "../bulk-actions";

/**
 * Select → Price Selected / Approve Selected, and Select → Add to Draft.
 *
 * **The second mode used to be Generate Selected**, which turned the ticked jobs
 * straight into invoices — the one route by which a job became an invoice with
 * no draft in between. It puts them on their customers' drafts now, so the only
 * way a job's money reaches a customer is a draft somebody issues.
 *
 * The selection is held here and posted as one form with a `selected` checkbox
 * group, so **one press is one request**. That is the difference the brief asks
 * for: not the browser firing a server action per row, which turns forty jobs
 * into forty round trips that can fail halfway with nothing recording where.
 *
 * The count and value beside the button are the operator's confirmation of what
 * they are about to do. The server re-reads every id and re-checks every job's
 * state, so a stale checkbox is refused rather than acted on — this is a
 * summary, not a source of truth.
 *
 * **Review mode carries two verbs over one selection, and that is why an
 * unpriced row is now selectable.** It was not, deliberately: approving a job
 * with no charges half-fails, so a tick that could only do that was worse than
 * no tick. Price Selected is a verb that applies to exactly those rows, so the
 * tick now means something for every row in the list — and approving an unpriced
 * one is still refused by `checkBillingTransition`, named job by job, rather
 * than being prevented by a disabled checkbox.
 */

export type QueueRow = {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  /** The method spelled for a person. */
  billingMethod: string;
  /** The stored value, which is what the method filter matches on. */
  billingMethodValue: string;
  completedAt: string | null;
  chargeCount: number;
  subtotal: number;
  hasRateCard: boolean;
  /**
   * The automatic pricing at completion could not price all of it
   * (`billing_hold_reason = 'needs_price'`, 0055) — the Needs a price list.
   */
  needsPrice?: boolean;
};

export function BillingQueue({
  rows, mode, canAct, canPrice = false,
}: {
  rows: QueueRow[];
  mode: "approve" | "place";
  canAct: boolean;
  /** `billing.write` + `invoices.bulk` — pricing is a separate capability from approving. */
  canPrice?: boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Approving is the freeze (brief 1.6), so it is a second press: the first
  // says how many jobs and how much, and that the prices stop being editable.
  const [confirming, setConfirming] = useState(false);

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = rows.filter((row) => selected.has(row.id));
  const chosenValue = chosen.reduce((sum, row) => sum + row.subtotal, 0);

  return (
    <form action={mode === "approve" ? approveSelectedJobs : placeSelectedJobs}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">
            {mode === "approve" ? "Jobs awaiting review" : "Approved, not yet on a draft"}
          </caption>
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th scope="col" className="w-11 py-2 pr-2">
                {/* The skin is the shared `Checkbox`'s, and the padded label is
                    the hit area rather than the 18px box — the same reason that
                    component gives (§10b): a bare box is a 16px tap target, and
                    this list is worked from a phone. `Checkbox` itself cannot be
                    used here because it is uncontrolled and this selection is
                    React state. */}
                <label className="flex min-h-11 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    className="size-[1.15rem] shrink-0 rounded border-strong accent-primary"
                    aria-label={allSelected ? "Clear the selection" : "Select every job listed"}
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)))}
                  />
                </label>
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">Job</th>
              <th scope="col" className="py-2 pr-3 font-medium">Customer</th>
              <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">Billing</th>
              <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">Charges</th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => {
              const priced = row.chargeCount > 0;
              return (
                <tr key={row.id} className={selected.has(row.id) ? "bg-primary/5" : undefined}>
                  <td className="py-2 pr-2">
                    <label className="flex min-h-11 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        name="selected"
                        value={row.id}
                        className="size-[1.15rem] shrink-0 rounded border-strong accent-primary"
                        aria-label={`Select job ${row.orderNumber}`}
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                    </label>
                  </td>
                  <td className="py-2 pr-3">
                    <Link href={`/orders/${row.id}`}
                          className="inline-flex min-h-11 items-center font-medium text-primary hover:underline">
                      {row.orderNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">
                    <Link href={`/customers/${row.customerId}`}
                          className="inline-flex min-h-11 items-center hover:underline">
                      {row.customerName}
                    </Link>
                  </td>
                  <td className="hidden py-2 pr-3 text-muted-foreground md:table-cell">
                    {row.billingMethod}
                  </td>
                  <td className="hidden py-2 pr-3 sm:table-cell">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {priced ? (
                        <span className="text-muted-foreground">{counted(row.chargeCount, "line")}</span>
                      ) : !row.needsPrice ? (
                        <Badge tone="warning">
                          {row.hasRateCard ? "Not priced" : "No rate card"}
                        </Badge>
                      ) : null}
                      {row.needsPrice ? <Badge tone="warning">Needs a price</Badge> : null}
                    </span>
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {priced ? money(row.subtotal) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
        <Button type="button" variant="secondary" size="sm" onClick={() => setSelected(new Set())}
                disabled={selected.size === 0}>
          Clear selection
        </Button>
        <span className="text-sm text-muted-foreground">
          {selected.size === 0
            ? "Nothing selected"
            : `${selected.size} selected · ${formatMoney(chosenValue)}, GST included`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* Price first, then approve — the order the work is done in, and the
              order they read in on the row. Pricing is the secondary variant
              because approving is what the operator came here for; an already
              priced selection needs only the second button. */}
          {mode === "approve" && canPrice ? (
            <SubmitButton
              size="md"
              variant="secondary"
              formAction={priceSelectedJobs}
              pendingLabel="Pricing…"
            >
              Price selected{selected.size ? ` (${selected.size})` : ""}
            </SubmitButton>
          ) : null}
          {canAct && mode === "approve" && !confirming ? (
            <Button type="button" size="md" disabled={selected.size === 0}
                    onClick={() => setConfirming(true)}>
              Approve selected{selected.size ? ` (${selected.size})` : ""}
            </Button>
          ) : canAct ? (
            <SubmitButton
              size="md"
              pendingLabel={mode === "approve" ? "Approving…" : "Adding…"}
            >
              {mode === "approve"
                ? `Approve selected${selected.size ? ` (${selected.size})` : ""}`
                : `Add to draft${selected.size ? ` (${selected.size})` : ""}`}
            </SubmitButton>
          ) : (
            <span className="text-sm text-muted-foreground">
              {mode === "approve"
                ? "Approving jobs in bulk needs the approve and bulk permissions."
                : "Putting jobs on a draft in bulk needs the invoice and bulk permissions."}
            </span>
          )}
        </div>
      </div>

      {mode === "approve" && confirming ? (
        <div className="mt-4 rounded-xl border border-danger/30 bg-danger/5 p-4" role="group"
             aria-label="Confirm approval">
          <p className="text-sm font-semibold text-danger">Prices freeze when you approve</p>
          <p className="mt-1 text-sm">
            {approveSelectionConfirmation(chosen.length, chosenValue)}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <SubmitButton size="md" pendingLabel="Approving…">
              Approve {chosen.length === 1 ? "this job" : `these ${chosen.length} jobs`}
            </SubmitButton>
            <Button type="button" variant="secondary" size="md" onClick={() => setConfirming(false)}>
              Keep reviewing
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

