"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { CHARGE_TYPES, CHARGE_TYPE_LABELS, round2, type ChargeType } from "@/lib/domain/pricing";
import { formatMoney } from "@/lib/domain/pricing";
import type { JobChargeInput } from "../job-charges";
import { accountLabel, taxableFromTaxCode } from "@/lib/domain/accounts";
import { itemLabel } from "@/lib/domain/items";
import { Button, CONTROL, IconButton, SELECT_CHEVRON } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import {
  AccountPicker, ItemPicker, type CodingAccount, type CodingItem,
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
}: {
  orderId: string;
  initial: EditableCharge[];
  action: (formData: FormData) => void;
  returnTo?: string;
  /**
   * The item list and the chart of accounts, so a charge can be coded **here**
   * rather than again on the invoice it becomes.
   *
   * This is the half MYOB has and this app did not: MYOB puts the Item ID and
   * the Category (its name for the account code) on the line at the moment the
   * line is written, and here the charge screen had neither — so a hand-added
   * charge reached the invoice uncoded and somebody re-keyed the code. Default
   * `[]` so a laundry with no chart, or a role that cannot read one, simply gets
   * the screen it had before rather than an error.
   */
  items?: readonly CodingItem[];
  accounts?: readonly CodingAccount[];
}) {
  const [rows, setRows] = useState<EditableCharge[]>(initial);
  /** Which rows have their pickers open. Screen state; nothing is posted for it. */
  const [coding, setCoding] = useState<ReadonlySet<string>>(new Set());

  const itemsById = useMemo(() => new Map(items.map((one) => [one.id, one])), [items]);
  const accountsById = useMemo(() => new Map(accounts.map((one) => [one.id, one])), [accounts]);
  const canCode = items.length > 0 || accounts.length > 0;

  const toggleCoding = (key: string) =>
    setCoding((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

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

            {/*
              The coding strip: what this charge is, and where the money lands.

              Collapsed to one line by default and expanded per row, because a
              job's charges are a *list* — two full pickers open on every row
              would be a wall, and the accessibility pass settled on asking one
              question at a time. The summary is always readable, so "is this
              coded?" never needs a click to answer.
            */}
            {canCode ? (
              <ChargeCoding
                row={row}
                items={items}
                accounts={accounts}
                item={row.source_item_id ? itemsById.get(row.source_item_id) ?? null : null}
                account={row.gl_account_id ? accountsById.get(row.gl_account_id) ?? null : null}
                open={coding.has(row.key)}
                onToggle={() => toggleCoding(row.key)}
                onChange={(patch) => update(row.key, patch)}
                accountsById={accountsById}
              />
            ) : null}
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

/**
 * One charge's item and account code.
 *
 * **Picking an item fills the rest of the line**, which is the whole point: the
 * description, the rate, whether GST applies and the account all follow from the
 * item, the same way they do on the invoice composer and the same way MYOB's
 * Item ID column behaves. What a person typed is never overwritten — a blank
 * description is filled, an edited one is left alone.
 */
function ChargeCoding({
  row, items, accounts, item, account, open, onToggle, onChange, accountsById,
}: {
  row: EditableCharge;
  items: readonly CodingItem[];
  accounts: readonly CodingAccount[];
  item: CodingItem | null;
  account: CodingAccount | null;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<EditableCharge>) => void;
  accountsById: ReadonlyMap<string, CodingAccount>;
}) {
  function chooseItem(chosen: CodingItem) {
    const price = Number(chosen.sell_price ?? 0);
    const fromItem = taxableFromTaxCode(chosen.tax_code);
    const fromAccount = chosen.income_account_id
      ? taxableFromTaxCode(accountsById.get(chosen.income_account_id)?.tax_code)
      : null;
    const taxable = fromItem ?? fromAccount;

    onChange({
      source_item_id: chosen.id,
      // The item's own account, unless this charge already names one: choosing a
      // code by hand is a deliberate override and picking an item must not undo it.
      gl_account_id: row.gl_account_id ?? chosen.income_account_id,
      // Only where the operator has not written their own. A charge often reads
      // "Bath towels — 40 collected 14 Aug", which the item name would flatten.
      ...(row.description.trim() ? {} : { description: chosen.name }),
      ...(Number(row.unit_price ?? 0) === 0 && price > 0 ? { unit_price: price } : {}),
      ...(taxable === null ? {} : { taxable }),
    });
  }

  function chooseAccount(chosen: CodingAccount) {
    const taxable = taxableFromTaxCode(chosen.tax_code);
    onChange({ gl_account_id: chosen.id, ...(taxable === null ? {} : { taxable }) });
  }

  const summary = [
    item ? itemLabel(item) : null,
    account ? accountLabel(account) : null,
  ].filter(Boolean).join("  ·  ");

  return (
    <div className="sm:col-span-12">
      <div className="flex flex-wrap items-center gap-2 border-t pt-2">
        <span className={summary ? "font-mono text-xs" : "text-xs text-muted-foreground"}>
          {summary || "Not coded — this charge reaches the invoice with no account on it"}
        </span>
        <button
          type="button" onClick={onToggle}
          aria-expanded={open}
          className="ml-auto min-h-11 rounded-lg px-3 text-sm underline underline-offset-4"
        >
          {open ? "Done" : summary ? "Change" : "Add item or code"}
        </button>
      </div>

      {open ? (
        <div className="mt-2 space-y-3 rounded-xl border bg-surface-muted/40 p-3">
          {/*
            **The item leads and the account follows.** MYOB works this way and so
            does the client's instruction: you pick the Item ID and the Category
            comes with it — nobody sits and chooses a ledger account per line. So
            the item is the question asked, and the account is shown underneath as
            its *consequence*, editable for the cases the item cannot answer (a
            recharge, a levy, an item nobody has coded yet).
          */}
          {items.length > 0 ? (
            <ItemPicker
              idPrefix={`charge-${row.key}`}
              items={items} chosen={item}
              onChoose={chooseItem}
              onClear={() => onChange({ source_item_id: null })}
            />
          ) : null}

          {accounts.length > 0 ? (
            <div className={items.length > 0 ? "border-t pt-3" : undefined}>
              {account && item && item.income_account_id === account.id ? (
                // The ordinary case: the item answered it, so this is a
                // statement rather than a question. One line, no picker.
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Codes to <span className="font-mono text-foreground">{accountLabel(account)}</span>
                    {" "}— from the item
                  </span>
                  <button
                    type="button"
                    onClick={() => onChange({ gl_account_id: null })}
                    className="min-h-11 rounded-lg px-3 text-sm underline underline-offset-4"
                  >
                    Use a different account
                  </button>
                </div>
              ) : (
                <AccountPicker
                  idPrefix={`charge-${row.key}`}
                  accounts={accounts} chosen={account} noChart={false}
                  onChoose={chooseAccount}
                  onClear={() => onChange({ gl_account_id: null })}
                />
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No chart of accounts on file, so nothing can be coded yet. The item and
              the price still apply.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
