"use client";

import { useState } from "react";
import Link from "next/link";
import { counted, money } from "@/lib/format";
import { formatMoney } from "@/lib/domain/pricing";
import { Badge, Button } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { approveSelectedJobs, generateSelectedInvoices, priceSelectedJobs } from "../bulk-actions";

/**
 * Select → Price Selected / Approve Selected, and Select → Generate Selected.
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
};

export function BillingQueue({
  rows, mode, canAct, canPrice = false,
}: {
  rows: QueueRow[];
  mode: "approve" | "generate";
  canAct: boolean;
  /** `billing.write` + `invoices.bulk` — pricing is a separate capability from approving. */
  canPrice?: boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

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
    <form action={mode === "approve" ? approveSelectedJobs : generateSelectedInvoices}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">
            {mode === "approve" ? "Jobs awaiting review" : "Jobs ready to invoice"}
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
                    {priced ? (
                      <span className="text-muted-foreground">{counted(row.chargeCount, "line")}</span>
                    ) : (
                      <Badge tone="warning">
                        {row.hasRateCard ? "Not priced" : "No rate card"}
                      </Badge>
                    )}
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
            : `${selected.size} selected · ${formatMoney(chosenValue)} before GST`}
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
          {canAct ? (
            <SubmitButton
              size="md"
              pendingLabel={mode === "approve" ? "Approving…" : "Generating…"}
            >
              {mode === "approve"
                ? `Approve selected${selected.size ? ` (${selected.size})` : ""}`
                : `Generate selected${selected.size ? ` (${selected.size})` : ""}`}
            </SubmitButton>
          ) : (
            <span className="text-sm text-muted-foreground">
              {mode === "approve"
                ? "Approving jobs in bulk needs the approve and bulk permissions."
                : "Generating invoices in bulk needs the invoice and bulk permissions."}
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
