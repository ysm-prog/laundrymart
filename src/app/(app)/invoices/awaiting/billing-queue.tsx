"use client";

import { useState } from "react";
import Link from "next/link";
import { money } from "@/lib/format";
import { formatMoney } from "@/lib/domain/pricing";
import { Badge, Button } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { approveSelectedJobs, generateSelectedInvoices } from "../bulk-actions";

/**
 * Select → Approve Selected, and Select → Generate Selected.
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
 */

export type QueueRow = {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  billingMethod: string;
  completedAt: string | null;
  chargeCount: number;
  subtotal: number;
  hasRateCard: boolean;
};

export function BillingQueue({
  rows, mode, canAct,
}: {
  rows: QueueRow[];
  mode: "approve" | "generate";
  canAct: boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Approving needs charges on the job; a job nobody has priced cannot be
  // approved and the server would refuse it, so it is not selectable here
  // either — an unselectable row with a reason beside it beats a selection
  // that half fails.
  const selectable = rows.filter((row) => mode === "generate" || row.chargeCount > 0);
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.id));

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
                      setSelected(allSelected ? new Set() : new Set(selectable.map((row) => row.id)))}
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
              const canSelect = mode === "generate" || priced;
              return (
                <tr key={row.id} className={selected.has(row.id) ? "bg-primary/5" : undefined}>
                  <td className="py-2 pr-2">
                    <label className={`flex min-h-11 items-center justify-center ${
                      canSelect ? "cursor-pointer" : "cursor-not-allowed"}`}>
                      <input
                        type="checkbox"
                        name="selected"
                        value={row.id}
                        className="size-[1.15rem] shrink-0 rounded border-strong accent-primary
                                   disabled:opacity-40"
                        aria-label={`Select job ${row.orderNumber}`}
                        disabled={!canSelect}
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                    </label>
                  </td>
                  <td className="py-2 pr-3">
                    <Link href={`/orders/${row.id}`} className="font-medium text-primary hover:underline">
                      {row.orderNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">
                    <Link href={`/customers/${row.customerId}`} className="hover:underline">
                      {row.customerName}
                    </Link>
                  </td>
                  <td className="hidden py-2 pr-3 text-muted-foreground md:table-cell">
                    {row.billingMethod}
                  </td>
                  <td className="hidden py-2 pr-3 sm:table-cell">
                    {priced ? (
                      <span className="text-muted-foreground">{row.chargeCount} line(s)</span>
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
        <div className="ml-auto">
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
