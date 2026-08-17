"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { CHARGE_TYPES, CHARGE_TYPE_LABELS, round2, type ChargeType } from "@/lib/domain/pricing";
import { formatMoney } from "@/lib/domain/pricing";
import type { JobChargeInput } from "../job-charges";
import { Button, CONTROL, IconButton, SELECT_CHEVRON } from "@/components/ui";
import { SubmitButton } from "@/components/form";

/**
 * The reviewer's charge lines, composed in the browser and committed once.
 *
 * Same shape as the job form's laundry list and the planner's board: rows are
 * held in React state, and one hidden field carries the whole array as JSON.
 * The contract for that payload lives in `../job-charges.ts` — outside this file
 * and outside the `"use server"` module — with tests written against exactly
 * what this component emits, because the two previous payloads in this codebase
 * that were not held that way both shipped broken behind a green `verify`.
 *
 * The running total here is a **preview**. `parseJobCharges` recomputes every
 * amount server-side from quantity × rate, so a tampered or stale number in the
 * browser cannot become what a customer is charged.
 */

export type EditableCharge = JobChargeInput & { key: string };

let nextKey = 0;
function blankCharge(): EditableCharge {
  nextKey += 1;
  return {
    key: `new-${nextKey}`,
    description: "",
    charge_type: "other",
    quantity: 1,
    unit_price: 0,
    taxable: true,
    source_agreement_id: null,
    source_agreement_line_id: null,
    source_item_id: null,
    source_laundry_item_type: null,
    pricing_model: null,
  };
}

export function JobChargesEditor({
  orderId, initial, action, returnTo,
}: {
  orderId: string;
  initial: EditableCharge[];
  action: (formData: FormData) => void;
  returnTo?: string;
}) {
  const [rows, setRows] = useState<EditableCharge[]>(initial);

  const update = (key: string, patch: Partial<EditableCharge>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const subtotal = round2(
    rows.reduce((sum, row) => sum + Number(row.quantity ?? 0) * Number(row.unit_price ?? 0), 0),
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={orderId} />
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
      {/* The one field that actually carries the answer. `key` is stripped: it
          is a React identity, not part of the contract the server parses. */}
      <input
        type="hidden"
        name="charges"
        value={JSON.stringify(rows.map(({ key: _key, ...line }) => line))}
      />

      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={row.key} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-12 sm:items-end">
            <label className="sm:col-span-5">
              <span className="mb-1 block text-sm font-medium">Description</span>
              <input
                className={CONTROL}
                value={row.description}
                onChange={(event) => update(row.key, { description: event.target.value })}
                placeholder="What is being charged"
              />
            </label>

            <label className="sm:col-span-3">
              <span className="mb-1 block text-sm font-medium">Charge</span>
              <select
                className={`${CONTROL} ${SELECT_CHEVRON}`}
                value={row.charge_type}
                onChange={(event) => update(row.key, { charge_type: event.target.value as ChargeType })}
              >
                {CHARGE_TYPES.map((value) => (
                  <option key={value} value={value}>{CHARGE_TYPE_LABELS[value]}</option>
                ))}
              </select>
            </label>

            <label className="sm:col-span-1">
              <span className="mb-1 block text-sm font-medium">Qty</span>
              <input
                className={CONTROL}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={String(row.quantity ?? 0)}
                onChange={(event) => update(row.key, { quantity: event.target.value })}
              />
            </label>

            <label className="sm:col-span-2">
              <span className="mb-1 block text-sm font-medium">Rate</span>
              <input
                className={CONTROL}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={String(row.unit_price ?? 0)}
                onChange={(event) => update(row.key, { unit_price: event.target.value })}
              />
            </label>

            <div className="flex items-center justify-between gap-2 sm:col-span-1 sm:justify-end">
              <span className="text-sm font-medium tabular-nums sm:hidden">
                {formatMoney(round2(Number(row.quantity ?? 0) * Number(row.unit_price ?? 0)))}
              </span>
              <IconButton
                label={`Remove charge ${index + 1}`}
                onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
              >
                <Trash2 className="size-4" aria-hidden />
              </IconButton>
            </div>

            <div className="flex flex-wrap items-center gap-4 sm:col-span-12">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border"
                  checked={row.taxable !== false}
                  onChange={(event) => update(row.key, { taxable: event.target.checked })}
                />
                GST applies
              </label>
              {row.source_agreement_line_id ? (
                <span className="text-xs text-muted-foreground">
                  From the rate card
                  {row.source_laundry_item_type ? ` · ${row.source_laundry_item_type.replace(/_/g, " ")}` : ""}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Added by hand</span>
              )}
              <span className="ml-auto hidden text-sm font-medium tabular-nums sm:inline">
                {formatMoney(round2(Number(row.quantity ?? 0) * Number(row.unit_price ?? 0)))}
              </span>
            </div>
          </div>
        ))}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No charges yet. Price this job from the customer&rsquo;s rate card, or add a line by hand.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <Button type="button" variant="secondary" size="sm"
                onClick={() => setRows((current) => [...current, blankCharge()])}>
          Add a charge
        </Button>
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-sm text-muted-foreground">
            Subtotal <span className="font-semibold text-foreground tabular-nums">{formatMoney(subtotal)}</span>
            {" "}before GST
          </span>
          <SubmitButton size="md">Save charges</SubmitButton>
        </div>
      </div>
    </form>
  );
}
