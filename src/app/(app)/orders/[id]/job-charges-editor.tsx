"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  CHARGE_TYPES, CHARGE_TYPE_LABELS, gstPhrase, gstWithin, inclusiveTotals, lineAmount,
  rateForGstTick, type ChargeType, type GstTickMemo,
} from "@/lib/domain/pricing";
import { formatMoney } from "@/lib/domain/pricing";
import { chargeSourceLabel, type JobChargeInput } from "../job-charges";
import { chargePatchForItem } from "@/lib/domain/coding";
import { GST_RATE_FALLBACK } from "@/lib/domain/items";
import { Button, CONTROL, IconButton, SELECT_CHEVRON } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import {
  DescriptionWithItems, ItemPicker, type CodingAccount, type CodingItem,
} from "@/components/coding-pickers";

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
    gl_account_id: null,
  };
}

export function JobChargesEditor({
  orderId, initial, action, returnTo, items = [], accounts = [],
  gstRate = GST_RATE_FALLBACK,
}: {
  orderId: string;
  initial: EditableCharge[];
  action: (formData: FormData) => void;
  returnTo?: string;
  /**
   * The item list a charge is named from. Default `[]`, so a laundry with no
   * items simply gets a plain description box rather than an error.
   */
  items?: readonly CodingItem[];
  /**
   * **The chart of accounts is read here and never shown here.**
   *
   * MYOB's model, and the client's instruction: you pick the Item and the
   * Category comes with it — nobody chooses a ledger account per charge line.
   * So an account code is *never* a question this screen asks. It travels
   * silently from `items.income_account_id`, and this list is needed only to
   * look up that account's tax code so the GST tick follows the item too.
   *
   * A charge that names no item therefore reaches the invoice uncoded, which is
   * deliberate: the invoice line composer is where a code is chosen by hand, on
   * the rare line that is in neither list.
   */
  accounts?: readonly CodingAccount[];
  /**
   * The laundry's own GST rate, for grossing an item's price up when the item
   * states it GST-exclusive, and for the "GST applies" tick adding or taking out
   * the GST. It matters more here than on an invoice line: approval **freezes**
   * these numbers, so a rate short by the GST is short on a row nobody can edit
   * afterwards.
   */
  gstRate?: number;
}) {
  const [rows, setRows] = useState<EditableCharge[]>(initial);
  // Held beside the rows rather than on them: the rows are what gets posted, and
  // a tick's memo is about this editing session, not about the charge.
  const [gstMemos, setGstMemos] = useState<Record<string, GstTickMemo | null>>({});

  const itemsById = useMemo(() => new Map(items.map((one) => [one.id, one])), [items]);
  const accountsById = useMemo(() => new Map(accounts.map((one) => [one.id, one])), [accounts]);

  const update = (key: string, patch: Partial<EditableCharge>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  // The tick moves the money, not just the flag: a line amount is GST-inclusive
  // (0043), so a tick that left the rate alone changed nothing the customer pays.
  // The rule is pure and tested; this only carries its memo for the row.
  const setRowTaxable = (row: EditableCharge, taxable: boolean) => {
    const next = rateForGstTick({
      rate: row.unit_price, taxable, gstRate, memo: gstMemos[row.key],
    });
    setGstMemos((current) => ({ ...current, [row.key]: next.memo }));
    update(row.key, { taxable, unit_price: next.rate });
  };

  // Unique per editor, not just per row: a row key is unique inside one editor
  // and two editors on one page (the gallery renders three) would otherwise
  // collide, pointing a label at another editor's input — the duplicate-id
  // defect §27 already records once on this screen.
  const fieldPrefix = (row: EditableCharge) => `${orderId}-charge-${row.key}`;

  // The one place an item fills a charge, so the description type-ahead and the
  // row's own item field cannot drift apart. The rule itself is pure and tested.
  const patchForItem = (
    row: EditableCharge, chosen: CodingItem, descriptionIsQuery = false,
  ) =>
    chargePatchForItem(row, chosen, {
      accountTaxCode: chosen.income_account_id
        ? accountsById.get(chosen.income_account_id)?.tax_code
        : null,
      // Text typed into the description box to *find* this item is a search, not
      // a description: picking replaces it. Text already sitting there when the
      // item is chosen from the field below is content, and survives.
      descriptionIsQuery,
      // A charge feeds an invoice line, and a line amount is GST-inclusive
      // (0043) — so an item stating its price GST-exclusive is grossed up
      // before it becomes a rate here.
      gstRate,
    });

  const amountOf = (row: EditableCharge) =>
    lineAmount(Number(row.quantity ?? 0), Number(row.unit_price ?? 0));

  // The same sum `recalculate_invoice` will do, so the preview says what the
  // invoice will say, and "GST included" is no longer printed over a job with none.
  const totals = inclusiveTotals(
    rows.map((row) => ({ amount: amountOf(row), taxable: row.taxable })), gstRate,
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
            <label className="sm:col-span-5" htmlFor={`${fieldPrefix(row)}-description`}>
              <span className="mb-1 block text-sm font-medium">Description</span>
              {/* Typing a code here finds the item — the fast path. Free text
                  still wins: suggestions are offered and never imposed. */}
              <DescriptionWithItems
                id={`${fieldPrefix(row)}-description`}
                items={items}
                hasItem={Boolean(row.source_item_id)}
                value={row.description}
                onChange={(description) => update(row.key, { description })}
                onChooseItem={(chosen) => update(row.key, patchForItem(row, chosen, true))}
                placeholder={items.length > 0
                  ? "What is being charged — or type an item code"
                  : "What is being charged"}
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
                {formatMoney(amountOf(row))}
              </span>
              <IconButton
                label={`Remove charge ${index + 1}`}
                onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
              >
                <Trash2 className="size-4" aria-hidden />
              </IconButton>
            </div>

            <div className="flex flex-wrap items-center gap-4 sm:col-span-12">
              {/* The shared `Checkbox`'s skin, and its padded label as the hit
                  area (§10b). That component is uncontrolled, so it cannot be
                  used for a row whose value is React state — but a bare 16px
                  box at a call site is exactly what the one-input-skin rule
                  exists to stop. */}
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-[1.15rem] shrink-0 rounded border-strong accent-primary"
                  checked={row.taxable !== false}
                  onChange={(event) => setRowTaxable(row, event.target.checked)}
                />
                GST applies
              </label>
              <span className="text-xs text-muted-foreground">
                {chargeSourceLabel(row)}
                {chargeSourceLabel(row) !== "Added by hand" && row.source_laundry_item_type
                  ? ` · ${row.source_laundry_item_type.replace(/_/g, " ")}` : ""}
              </span>
              <span className="ml-auto text-right tabular-nums">
                <span className="hidden text-sm font-medium sm:inline">{formatMoney(amountOf(row))}</span>
                <span className="block text-xs text-muted-foreground">
                  {gstPhrase(
                    row.taxable !== false ? gstWithin(amountOf(row), gstRate) : 0,
                    row.taxable !== false,
                  )}
                </span>
              </span>
            </div>

            {items.length > 0 ? (
              // Open on every row rather than hidden behind the strip: the item
              // is the question asked, and a control nobody finds is a control
              // that does not exist. The account stays a consequence below.
              <div className="sm:col-span-12">
                <ItemPicker
                  idPrefix={fieldPrefix(row)}
                  items={items}
                  chosen={row.source_item_id ? itemsById.get(row.source_item_id) ?? null : null}
                  onChoose={(chosen) => update(row.key, patchForItem(row, chosen))}
                  onClear={() => update(row.key, { source_item_id: null })}
                />
              </div>
            ) : null}

          </div>
        ))}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No charges yet. Price this job from the customer&rsquo;s rate card or your price list, or add a line yourself.
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
            Total <span className="font-semibold text-foreground tabular-nums">{formatMoney(totals.total)}</span>
            {" "}{gstPhrase(totals.gst, totals.anyTaxable)}
          </span>
          <SubmitButton size="md">Save charges</SubmitButton>
        </div>
      </div>
    </form>
  );
}
