"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/domain/pricing";
import { countWithoutEmail, type StatementListRow } from "@/lib/domain/statement";
import { Button } from "@/components/ui";
import { SubmitButton } from "@/components/form";

/**
 * The Statements list, after ysm-hub's: one row per customer with something on
 * their statement, their contact, phone and email, what they owe, and View,
 * Download and Send on the row, with a selection for sending many.
 *
 * Every send asks first, naming the statement date and — the half ysm-hub's own
 * confirm carries — how many of those chosen have no billing email and will be
 * skipped. One form holds both kinds of send: a row's Send posts the one-customer
 * action through `formAction`, so the selection is never in the way of it.
 *
 * The statement date and the "up to that date" choice ride along as hidden
 * fields, so a statement sent from here says what the one viewed said.
 */

type Confirm = null | { kind: "one"; id: string } | { kind: "selection" };

export function StatementSelection({
  rows, asAt, asAtLabel, upToAsAt, returnTo, sendOne, sendSelected, canSend,
}: {
  rows: readonly StatementListRow[];
  asAt: string;
  asAtLabel: string;
  upToAsAt: boolean;
  returnTo: string;
  sendOne: (formData: FormData) => void | Promise<void>;
  sendSelected: (formData: FormData) => void | Promise<void>;
  /** False when the role cannot send or no mail provider is set up: View and Download only. */
  canSend: boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm>(null);

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.customerId));
  const chosen = rows.filter((row) => selected.has(row.customerId));
  const chosenValue = chosen.reduce((sum, row) => sum + row.total, 0);
  const pdf = (row: StatementListRow, download: boolean) =>
    `/api/customers/${row.customerId}/statement?as_at=${asAt}${upToAsAt ? "" : "&upto=0"}${download ? "&download=1" : ""}`;

  const target = confirm?.kind === "one" ? rows.find((row) => row.customerId === confirm.id) : null;
  const targets = confirm?.kind === "one" ? (target ? [target] : []) : chosen;
  const noEmail = countWithoutEmail(targets);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <form action={sendSelected} className="space-y-4">
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="as_at" value={asAt} />
      <input type="hidden" name="upto" value={upToAsAt ? "1" : "0"} />
      {confirm?.kind === "one" ? <input type="hidden" name="id" value={confirm.id} /> : null}

      {canSend ? (
        // The padded label is the hit area, not the 18px box (§10b).
        <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b text-sm font-medium">
          <input
            type="checkbox"
            className="size-[1.15rem] shrink-0 rounded border-strong accent-primary"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.customerId)))}
          />
          Select all {rows.length}
        </label>
      ) : null}

      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row.customerId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
            <label className={`flex min-w-0 flex-1 items-start gap-3 ${canSend ? "cursor-pointer" : ""}`}>
              {canSend ? (
                <input
                  type="checkbox"
                  name="selected"
                  value={row.customerId}
                  className="mt-0.5 size-[1.15rem] shrink-0 rounded border-strong accent-primary"
                  checked={selected.has(row.customerId)}
                  onChange={() => toggle(row.customerId)}
                  aria-label={`Select ${row.name}`}
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{row.name}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMoney(row.total)}</span>
                </span>
                <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{row.customerNumber} · {row.invoices} {row.invoices === 1 ? "invoice" : "invoices"}</span>
                  {row.overdue > 0 ? (
                    <span className="font-medium text-danger">{formatMoney(row.overdue)} overdue</span>
                  ) : null}
                  {row.contactName ? <span>{row.contactName}</span> : null}
                  {row.phone ? <span>{row.phone}</span> : null}
                  <span className={row.billingEmail ? undefined : "font-medium text-warning"}>
                    {row.billingEmail ?? "no billing email"}
                  </span>
                </span>
              </span>
            </label>
            <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
              {/* Route handlers, not pages, so plain anchors. */}
              <a href={pdf(row, false)} target="_blank" rel="noreferrer"
                 className="inline-flex min-h-10 items-center rounded-lg border px-3 text-sm font-medium transition hover:bg-surface-muted">
                View
              </a>
              <a href={pdf(row, true)}
                 className="inline-flex min-h-10 items-center rounded-lg border px-3 text-sm font-medium transition hover:bg-surface-muted">
                Download
              </a>
              {canSend ? (
                <Button type="button" variant="secondary" size="sm"
                        disabled={!row.billingEmail}
                        onClick={() => setConfirm({ kind: "one", id: row.customerId })}>
                  Send
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {canSend ? (
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button type="button" variant="secondary" size="sm"
                  onClick={() => { setSelected(new Set()); setConfirm(null); }}
                  disabled={selected.size === 0}>
            Clear
          </Button>
          <span className="text-sm text-muted-foreground">
            {selected.size === 0 ? "Nothing selected" : `${selected.size} selected · ${formatMoney(chosenValue)}`}
          </span>
          <div className="ml-auto">
            <Button type="button" size="md" disabled={selected.size === 0}
                    onClick={() => setConfirm({ kind: "selection" })}>
              Email statements{selected.size ? ` (${selected.size})` : ""}
            </Button>
          </div>
        </div>
      ) : null}

      {/* The confirm, inline beside the list like `ConfirmSubmit`. */}
      {confirm && targets.length > 0 ? (
        <div role="group" aria-label="Confirm sending statements"
             className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm font-semibold">It leaves straight away</p>
          <p className="mt-1 text-sm">
            {targets.length === 1
              ? `Email ${targets[0]!.name} a statement as at ${asAtLabel} for ${formatMoney(targets[0]!.total)}?`
              : `Email a statement as at ${asAtLabel} to ${targets.length} customers, totalling ${formatMoney(targets.reduce((sum, row) => sum + row.total, 0))}?`}
            {noEmail > 0
              ? ` ${noEmail} ${noEmail === 1 ? "has" : "have"} no billing email and will be skipped.`
              : ""}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {confirm.kind === "one" ? (
              <SubmitButton size="md" pendingLabel="Sending…" formAction={sendOne}>Send statement</SubmitButton>
            ) : (
              <SubmitButton size="md" pendingLabel="Sending…">
                Send {targets.length === 1 ? "1 statement" : `${targets.length} statements`}
              </SubmitButton>
            )}
            <Button type="button" variant="secondary" size="md" onClick={() => setConfirm(null)}>
              Not yet
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
