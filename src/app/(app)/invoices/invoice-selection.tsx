"use client";

import { useState } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/domain/pricing";
import { Badge, Button } from "@/components/ui";
import { SubmitButton } from "@/components/form";

/**
 * Select → Issue Selected, and Select → Send Selected.
 *
 * One component with the verb passed in, because the two lists differ only in
 * which invoices they carry and what the button says. They were one component
 * and a copy for about an hour, which is long enough: the selection mechanics,
 * the total beside the button and the tap targets are the part that has to stay
 * identical, and a copy is where they stop being.
 *
 * The other half of "generation and sending are completely separate". Generating
 * puts drafts in the register and tells nobody; issuing turns a draft into a
 * document, and sending is the deliberate act that puts it in front of a
 * customer. Each carries its own capability.
 *
 * One press is one request. A send still emails one invoice at a time with its
 * own PDF — that part is irreducible — but they go out from a single action that
 * collects every outcome, so a bounce on the third does not stop the fortieth,
 * and the operator is told both numbers.
 */

export type SelectableInvoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  total: number;
  status: string;
  /** Sending only: re-sending is legitimate, so it is allowed and simply labelled. */
  alreadyEmailed?: boolean;
};

export function InvoiceSelection({
  invoices, returnTo, action, verb, pendingLabel, selectAllLabel,
  confirmIssue = false, blocked = null, settingsHref = null,
}: {
  invoices: SelectableInvoice[];
  returnTo: string;
  action: (formData: FormData) => void | Promise<void>;
  verb: string;
  pendingLabel: string;
  selectAllLabel: string;
  /**
   * Issuing cannot be undone (brief 1.6), so the first press asks — naming how
   * many and for how much — and only the second submits. Sending is left to post
   * on one press: re-sending an invoice is legitimate and harmless.
   */
  confirmIssue?: boolean;
  /**
   * Why nothing on this list can be acted on yet — for issuing, the laundry's
   * missing ABN, address or bank details (brief 1.1). The list still shows, so
   * the operator can see what is waiting; the button does not post.
   */
  blocked?: string | null;
  /** Where to fix `blocked`, for the one role that can open it. */
  settingsHref?: string | null;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const allSelected = invoices.length > 0 && invoices.every((row) => selected.has(row.id));
  const chosen = invoices.filter((row) => selected.has(row.id));
  const chosenValue = chosen.reduce((sum, row) => sum + row.total, 0);
  const chosenSummary = `${chosen.length} ${chosen.length === 1 ? "invoice" : "invoices"} totalling ${formatMoney(chosenValue)}`;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="return_to" value={returnTo} />

      {/* The skin is the shared `Checkbox`'s and the padded label is the hit
          area rather than the box itself (§10b) — a bare box is a 16px tap
          target and this list is worked from a phone. `Checkbox` cannot be used
          directly because it is uncontrolled and this selection is React state. */}
      <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b text-sm font-medium">
        <input
          type="checkbox"
          className="size-[1.15rem] shrink-0 rounded border-strong accent-primary"
          checked={allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(invoices.map((r) => r.id)))}
        />
        {selectAllLabel}
      </label>

      <ul className="divide-y">
        {invoices.map((row) => (
          <li key={row.id}>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5">
              <input
                type="checkbox"
                name="selected"
                value={row.id}
                className="mt-0.5 size-[1.15rem] shrink-0 rounded border-strong accent-primary"
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
                  {row.alreadyEmailed ? <Badge tone="neutral">Already sent</Badge> : null}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button type="button" variant="secondary" size="sm"
                onClick={() => { setSelected(new Set()); setConfirming(false); }}
                disabled={selected.size === 0}>
          Clear
        </Button>
        <span className="text-sm text-muted-foreground">
          {selected.size === 0
            ? "Nothing selected"
            : `${selected.size} selected · ${formatMoney(chosenValue)}`}
        </span>
        <div className="ml-auto">
          {blocked ? (
            <Button type="button" size="md" disabled>{verb}</Button>
          ) : confirmIssue && !confirming ? (
            // First press asks; nothing posts until the confirm below.
            <Button type="button" size="md" disabled={selected.size === 0}
                    onClick={() => setConfirming(true)}>
              {verb}{selected.size ? ` (${selected.size})` : ""}
            </Button>
          ) : confirmIssue ? null : (
            <SubmitButton size="md" pendingLabel={pendingLabel}>
              {verb}{selected.size ? ` (${selected.size})` : ""}
            </SubmitButton>
          )}
        </div>
      </div>

      {blocked ? (
        <p className="text-sm text-muted-foreground">
          {blocked}
          {settingsHref ? (
            <>
              {" "}
              <Link href={settingsHref} className="font-medium text-primary underline">
                Open Settings › Invoicing
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {/* The confirm step for issuing (brief 1.6): the count and the total, the
          consequence, and the real submit beside a way out. Inline, like
          `ConfirmSubmit`, so it sits next to the list it is about. */}
      {confirmIssue && confirming && !blocked ? (
        <div role="group" aria-label="Confirm issuing"
             className="rounded-xl border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm font-semibold text-danger">This can&apos;t be undone</p>
          <p className="mt-1 text-sm">
            {chosen.length === 0
              ? "Select at least one draft to issue."
              : `Issue ${chosenSummary}? Each is dated today, its lines are frozen, and it becomes the tax invoice the customer is sent.`}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {chosen.length > 0 ? (
              <SubmitButton size="md" pendingLabel={pendingLabel}>
                Issue {chosen.length === 1 ? "1 invoice" : `${chosen.length} invoices`}
              </SubmitButton>
            ) : null}
            <Button type="button" variant="secondary" size="md" onClick={() => setConfirming(false)}>
              Keep them as drafts
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
