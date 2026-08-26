"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  CHARGE_TYPES, CHARGE_TYPE_LABELS, formatMoney, lineAmount, type ChargeType,
} from "@/lib/domain/pricing";
import type { JobChargeInput } from "../job-charges";
import { chargePatchForItem } from "@/lib/domain/coding";
import {
  normaliseTaxCode, TAX_CODES, taxInclusiveTotals, type TaxCode,
} from "@/lib/domain/gst";
import { Button, CONTROL, IconButton, SELECT_CHEVRON } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import {
  CodeCell, DescriptionWithItems, type CodingAccount, type CodingItem,
} from "@/components/coding-pickers";
import { searchAccounts } from "@/lib/domain/accounts";
import { searchItems } from "@/lib/domain/items";

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

/**
 * MYOB's nine columns, in MYOB's order. One template shared by the header row
 * and every line, so a column added to one cannot drift from the other.
 */
const COLUMNS =
  "sm:grid-cols-[8rem_minmax(11rem,1fr)_8rem_9rem_5rem_6rem_6.5rem_6rem_7rem_6rem_3rem]";

/**
 * One cell, with the label a phone needs and a desktop does not: from `sm` up the
 * header row above supplies the name, so repeating it on every line would be
 * noise a screen reader also has to hear.
 */
function Cell({ label, htmlFor, align, children }: {
  label: string; htmlFor?: string; align?: "right"; children: React.ReactNode;
}) {
  const text = (
    <span className={`mb-1 block text-sm font-medium sm:sr-only ${align === "right" ? "sm:text-right" : ""}`}>
      {label}
    </span>
  );
  return htmlFor
    ? <label htmlFor={htmlFor} className="min-w-0">{text}{children}</label>
    : <div className="min-w-0">{text}{children}</div>;
}

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
}) {
  const [rows, setRows] = useState<EditableCharge[]>(initial);

  const itemsById = useMemo(() => new Map(items.map((one) => [one.id, one])), [items]);
  const accountsById = useMemo(() => new Map(accounts.map((one) => [one.id, one])), [accounts]);

  const update = (key: string, patch: Partial<EditableCharge>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

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
    });

  // A preview only: `parseJobCharges` recomputes every amount server-side, so a
  // tampered or stale number here cannot become what a customer is charged.
  const totals = taxInclusiveTotals(rows.map((row) => ({
    amount: lineAmount(Number(row.quantity ?? 0), Number(row.unit_price ?? 0),
                       Number(row.discount_percent ?? 0)),
    taxCode: row.tax_code ?? (row.taxable === false ? "N-T" : "GST"),
  })));

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

      {/* MYOB's line, in MYOB's order: the Item ID leads, the Category follows
          from it, and the amount is the consequence of units, price and
          discount. Wide, so it scrolls sideways from `sm` up rather than
          wrapping into something that is no longer a row; below `sm` each field
          stacks with its own label, which is how every other table in this app
          behaves on a phone (§10b). */}
      <div className="space-y-3 sm:overflow-x-auto">
        <div className="sm:min-w-[62rem] sm:space-y-2">
          {/* The column headers, once, from `sm` up. Below that each field
              carries its own label instead. */}
          <div className={`hidden gap-2 px-3 text-xs font-medium text-muted-foreground sm:grid ${COLUMNS}`}>
            <span>Item ID</span>
            <span>Description</span>
            <span>Charge</span>
            <span>Category</span>
            <span>Unit</span>
            <span className="text-right">No of units</span>
            <span className="text-right">Unit price</span>
            <span className="text-right">Discount %</span>
            <span className="text-right">Amount</span>
            <span>Tax code</span>
            <span className="sr-only">Remove</span>
          </div>

          {rows.map((row, index) => {
            const item = row.source_item_id ? itemsById.get(row.source_item_id) ?? null : null;
            const account = row.gl_account_id ? accountsById.get(row.gl_account_id) ?? null : null;
            const amount = lineAmount(
              Number(row.quantity ?? 0), Number(row.unit_price ?? 0), Number(row.discount_percent ?? 0),
            );
            return (
              <div key={row.key}
                   className={`grid gap-2 rounded-lg border p-3 sm:items-center sm:rounded-none sm:border-0 sm:border-b sm:p-0 sm:pb-2 ${COLUMNS}`}>

                {/* 1 · Item ID */}
                <Cell label="Item ID" htmlFor={`${fieldPrefix(row)}-item`}>
                  <CodeCell
                    id={`${fieldPrefix(row)}-item`}
                    label="Item ID"
                    placeholder={items.length ? "Code" : "No items"}
                    chosen={item}
                    chosenLabel={(chosen) => chosen.item_code ?? chosen.name}
                    search={(query) => searchItems(items, query, 8).map((match) => ({
                      value: match, primary: match.item_code ?? "—", secondary: match.name,
                    }))}
                    onChoose={(chosen) => update(row.key, patchForItem(row, chosen))}
                    onClear={() => update(row.key, { source_item_id: null })}
                  />
                </Cell>

                {/* 2 · Description — still finds an item by code, which is the
                       fast path people reach for even with a column for it. */}
                <Cell label="Description" htmlFor={`${fieldPrefix(row)}-description`}>
                  <DescriptionWithItems
                    id={`${fieldPrefix(row)}-description`}
                    items={items}
                    hasItem={Boolean(row.source_item_id)}
                    value={row.description}
                    onChange={(description) => update(row.key, { description })}
                    onChooseItem={(chosen) => update(row.key, patchForItem(row, chosen, true))}
                    placeholder={items.length > 0 ? "What is being charged" : "What is being charged"}
                  />
                </Cell>

                {/* This app's own field, not MYOB's: it is the consolidation key
                       and what the reports group by, so it keeps a control. */}
                <Cell label="Charge" htmlFor={`${fieldPrefix(row)}-charge-type`}>
                  <select
                    id={`${fieldPrefix(row)}-charge-type`} className={`${CONTROL} ${SELECT_CHEVRON}`}
                    value={row.charge_type}
                    onChange={(event) => update(row.key, { charge_type: event.target.value as ChargeType })}
                  >
                    {CHARGE_TYPES.map((value) => (
                      <option key={value} value={value}>{CHARGE_TYPE_LABELS[value]}</option>
                    ))}
                  </select>
                </Cell>

                {/* 4 · Category — the account, arriving with the item. */}
                <Cell label="Category" htmlFor={`${fieldPrefix(row)}-account`}>
                  <CodeCell
                    id={`${fieldPrefix(row)}-account`}
                    label="Category"
                    placeholder={accounts.length ? "Account" : "No chart"}
                    chosen={account}
                    chosenLabel={(chosen) => chosen.code}
                    search={(query) => searchAccounts(accounts, query, 8).map((match) => ({
                      value: match, primary: match.code, secondary: match.name,
                    }))}
                    onChoose={(chosen) => update(row.key, {
                      gl_account_id: chosen.id,
                      // The account may answer the tax question where nothing
                      // has yet, but never overrules a code the item gave.
                      ...(row.tax_code || !normaliseTaxCode(chosen.tax_code)
                        ? {}
                        : { tax_code: normaliseTaxCode(chosen.tax_code)! }),
                    })}
                    onClear={() => update(row.key, { gl_account_id: null })}
                  />
                </Cell>

                {/* 4 · Unit */}
                <Cell label="Unit" htmlFor={`${fieldPrefix(row)}-unit`}>
                  <input
                    id={`${fieldPrefix(row)}-unit`} className={CONTROL}
                    value={row.unit_label ?? ""} placeholder="ea"
                    onChange={(event) => update(row.key, { unit_label: event.target.value })}
                  />
                </Cell>

                {/* 5 · No of units */}
                <Cell label="No of units" htmlFor={`${fieldPrefix(row)}-qty`} align="right">
                  <input
                    id={`${fieldPrefix(row)}-qty`} className={`${CONTROL} text-right tabular-nums`}
                    type="number" min={0} step="0.01" inputMode="decimal"
                    value={String(row.quantity ?? 0)}
                    onChange={(event) => update(row.key, { quantity: event.target.value })}
                  />
                </Cell>

                {/* 6 · Unit price */}
                <Cell label="Unit price" htmlFor={`${fieldPrefix(row)}-price`} align="right">
                  <input
                    id={`${fieldPrefix(row)}-price`} className={`${CONTROL} text-right tabular-nums`}
                    type="number" min={0} step="0.01" inputMode="decimal"
                    value={String(row.unit_price ?? 0)}
                    onChange={(event) => update(row.key, { unit_price: event.target.value })}
                  />
                </Cell>

                {/* 7 · Discount (%) */}
                <Cell label="Discount %" htmlFor={`${fieldPrefix(row)}-discount`} align="right">
                  <input
                    id={`${fieldPrefix(row)}-discount`} className={`${CONTROL} text-right tabular-nums`}
                    type="number" min={0} max={100} step="0.01" inputMode="decimal"
                    value={String(row.discount_percent ?? 0)}
                    onChange={(event) => update(row.key, { discount_percent: event.target.value })}
                  />
                </Cell>

                {/* 8 · Amount — a consequence, never typed. */}
                <Cell label="Amount" align="right">
                  <output className="flex min-h-11 items-center justify-end px-1 text-sm
                                     font-medium tabular-nums">
                    {formatMoney(amount)}
                  </output>
                </Cell>

                {/* 9 · Tax code */}
                <Cell label="Tax code" htmlFor={`${fieldPrefix(row)}-tax`}>
                  <select
                    id={`${fieldPrefix(row)}-tax`} className={`${CONTROL} ${SELECT_CHEVRON}`}
                    value={row.tax_code ?? (row.taxable === false ? "N-T" : "GST")}
                    onChange={(event) => update(row.key, { tax_code: event.target.value as TaxCode })}
                  >
                    {TAX_CODES.map((code) => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </select>
                </Cell>

                <div className="flex items-center justify-end">
                  <IconButton
                    label={`Remove charge ${index + 1}`}
                    onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
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
        {/* MYOB's totals block, and the wording matters: the tax is *inside*
            the subtotal, so the total equals it. "before GST" was true under the
            old exclusive model and is now a claim the numbers contradict. */}
        <div className="flex flex-wrap items-end gap-6">
          <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right font-medium">{formatMoney(totals.subtotal)}</dd>
            <dt className="text-muted-foreground">Tax</dt>
            <dd className="text-right">{formatMoney(totals.taxAmount)}</dd>
            <dt className="font-medium">Total</dt>
            <dd className="text-right font-semibold">{formatMoney(totals.total)}</dd>
          </dl>
          <SubmitButton size="md">Save charges</SubmitButton>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Prices include GST. The tax shown is the part already inside the total, not an addition.
      </p>
    </form>
  );
}
