"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/domain/pricing";
import { Badge, Button } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { sendSelectedInvoices } from "./bulk-actions";

/**
 * Select → Send Selected, on the invoice register.
 *
 * The other half of "generation and sending are completely separate". Generating
 * puts drafts in the register and tells nobody; this is the deliberate act that
 * puts them in front of customers, and it carries its own capability
 * (`invoices.send` plus `invoices.bulk`).
 *
 * One press is one request. Each invoice still gets its own email with its own
 * PDF — that part is irreducible — but they go out from a single action that
 * collects every outcome, so a bounce on the third does not stop the fortieth,
 * and the operator is told both numbers.
 *
 * Drafts are absent from this list on purpose: a draft's lines can still change,
 * so sending one means a customer holding a document the system may contradict
 * tomorrow. Issue it first.
 */

export type SendableInvoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  total: number;
  status: string;
  alreadyEmailed: boolean;
};

export function SendSelected({
  invoices, returnTo,
}: { invoices: SendableInvoice[]; returnTo: string }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const allSelected = invoices.length > 0 && invoices.every((row) => selected.has(row.id));
  const chosen = invoices.filter((row) => selected.has(row.id));
  const chosenValue = chosen.reduce((sum, row) => sum + row.total, 0);

  return (
    <form action={sendSelectedInvoices} className="space-y-4">
      <input type="hidden" name="return_to" value={returnTo} />

      <label className="flex items-center gap-2 border-b pb-3 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4 rounded border"
          checked={allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(invoices.map((r) => r.id)))}
        />
        Select every invoice listed
      </label>

      <ul className="divide-y">
        {invoices.map((row) => (
          <li key={row.id}>
            <label className="flex cursor-pointer items-start gap-3 py-2.5">
              <input
                type="checkbox"
                name="selected"
                value={row.id}
                className="mt-1 size-4 rounded border"
                checked={selected.has(row.id)}
                onChange={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  })}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{row.customerName}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatMoney(row.total)}
                  </span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{row.invoiceNumber}</span>
                  {/* Re-sending is legitimate — a customer loses an email, an
                      address was wrong — so it is allowed and simply labelled. */}
                  {row.alreadyEmailed ? <Badge tone="neutral">Already sent</Badge> : null}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button type="button" variant="secondary" size="sm"
                onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
          Clear
        </Button>
        <span className="text-sm text-muted-foreground">
          {selected.size === 0
            ? "Nothing selected"
            : `${selected.size} selected · ${formatMoney(chosenValue)}`}
        </span>
        <div className="ml-auto">
          <SubmitButton size="md" pendingLabel="Sending…">
            Send selected{selected.size ? ` (${selected.size})` : ""}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
