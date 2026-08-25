"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { CHARGE_TYPE_LABELS } from "@/lib/domain/pricing";
import {
  accountLabel, isRevenueAccount, searchAccounts, taxableFromTaxCode,
  type PickableAccount,
} from "@/lib/domain/accounts";
import { itemLabel, searchItems, type PickableItem } from "@/lib/domain/items";
import { CONTROL, cx, Eyebrow, Notice } from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";

/**
 * Adding a line to an invoice, three ways.
 *
 * The client keeps their books against a chart of accounts and every sale has to
 * be coded to one of them. Their ask, in their words: a line can be added **by
 * selecting an item or by the code**, and something in neither list **is a line
 * of free text**.
 *
 * **Those are three ways to fill one line, not three kinds of line.** Whichever
 * route is taken the row that lands is the same — a description, a quantity, a
 * price, a GST flag — and may additionally name an item, an account, or both. So
 * nothing here posts a `kind`, the database grew no `line_kind` column, and a
 * line written by the month-end roll-up is the same shape as one typed at a desk.
 *
 * Why a mode switch rather than three pickers always on screen: with all three
 * visible the form asks four questions at once and none of them says which to
 * answer. One question first — *how do you want to add this?* — is the shape the
 * accessibility pass settled on for the job form, and it happens to be exactly
 * the client's own mental model.
 */

export type LineFormItem = PickableItem & {
  sell_price: number | string | null;
  tax_code: string | null;
  income_account_id: string | null;
};

export type LineFormAccount = PickableAccount;

type Mode = "item" | "account" | "free";

const MODES: ReadonlyArray<{ value: Mode; label: string; hint: string }> = [
  { value: "item", label: "An item", hint: "Pick from your item list — the code fills itself in." },
  { value: "account", label: "An account code", hint: "Pick the account this sale belongs to." },
  { value: "free", label: "Something else", hint: "Type it out. Add a code if you know one." },
];

export function InvoiceLineForm({
  invoiceId, items, accounts, action,
}: {
  invoiceId: string;
  items: readonly LineFormItem[];
  accounts: readonly LineFormAccount[];
  /**
   * `addInvoiceLine`, passed in rather than imported. The same arrangement
   * `InvoiceSelection` and `JobChargesEditor` use, and for the same reason: it is
   * what lets `/design-preview` render this with a stub, which is the only place
   * a compose-in-the-browser component like this one can be looked at at all —
   * the page that hosts it is an async server component reading Supabase.
   */
  action: (formData: FormData) => void | Promise<void>;
}) {
  /*
   * The mode that produces a coded line with the least work, given what this
   * laundry actually has on file. Not merely "item, or free text if there are
   * none": **`Adelaide Towel Service` holds 268 accounts and zero items today**,
   * so falling straight to free text would make the default route the one that
   * produces uncoded lines, for the one laundry with a chart to code to.
   */
  const [mode, setMode] = useState<Mode>(
    items.length > 0 ? "item" : accounts.length > 0 ? "account" : "free",
  );

  const [itemId, setItemId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  /*
   * Whether the description is the operator's words or the app's guess.
   *
   * Without this the two rules below contradict each other: "never overwrite
   * what somebody typed" and "a new pick should describe the new thing". Found
   * by driving the form rather than by reading it — pick TT001, switch to
   * Account code, pick 4-2000, and the line still said "Tea Towel" while
   * carrying the delivery-fees account. A description that names one thing and a
   * code that names another is worse than either being blank.
   */
  const [typed, setTyped] = useState(false);
  const [unitPrice, setUnitPrice] = useState("0");
  const [taxable, setTaxable] = useState(true);

  const byAccountId = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])), [accounts],
  );
  const item = itemId ? items.find((one) => one.id === itemId) ?? null : null;
  const account = accountId ? byAccountId.get(accountId) ?? null : null;

  /*
   * Switching mode clears the pickers but **keeps what was typed**. Somebody who
   * has written "Replacement tablecloth — damaged in transit" and then realises
   * they want a code on it should not lose the sentence to get one.
   */
  function chooseMode(next: Mode) {
    setMode(next);
    setItemId(null);
    if (next !== "free") setAccountId(null);
    // A description the app filled in belongs to the pick that has just been
    // cleared. One somebody wrote is theirs and survives — which is the whole
    // point: writing a sentence and then realising it wants a code should not
    // cost the sentence.
    if (!typed) setDescription("");
  }

  function chooseItem(chosen: LineFormItem) {
    setItemId(chosen.id);
    if (!typed) setDescription(chosen.name);
    const price = Number(chosen.sell_price ?? 0);
    setUnitPrice(Number.isFinite(price) && price > 0 ? price.toFixed(2) : "0");
    // The item's own account is the whole reason picking an item produces a code.
    setAccountId(chosen.income_account_id);
    // The item's tax code first, then the account's. An item saying FRE where its
    // account says GST is the item being specific about itself, so it wins.
    const fromItem = taxableFromTaxCode(chosen.tax_code);
    const fromAccount = chosen.income_account_id
      ? taxableFromTaxCode(byAccountId.get(chosen.income_account_id)?.tax_code)
      : null;
    const answer = fromItem ?? fromAccount;
    if (answer !== null) setTaxable(answer);
  }

  function chooseAccount(chosen: LineFormAccount, fillDescription: boolean) {
    setAccountId(chosen.id);
    // The account name is a serviceable description and a terrible one — "Towels
    // - Black" is what the books call it, not what the customer bought. It is
    // filled in as a starting point and stays editable, and it is never
    // overwritten on top of something somebody typed.
    if (fillDescription && !typed) setDescription(chosen.name);
    const answer = taxableFromTaxCode(chosen.tax_code);
    if (answer !== null) setTaxable(answer);
  }

  const noChart = accounts.length === 0;

  return (
    <form action={action} className="mt-4 space-y-4 border-t pt-4 print:hidden">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="item_id" value={item?.id ?? ""} />
      <input type="hidden" name="gl_account_id" value={account?.id ?? ""} />

      <fieldset>
        <legend className="mb-2 text-sm font-medium">What are you adding?</legend>
        <div className="flex flex-wrap gap-2">
          {MODES.map((option) => {
            const active = mode === option.value;
            // A route with nothing behind it is not offered. Clicking through to
            // "you have no chart of accounts" is a dead end dressed as a choice;
            // the sentence under the buttons says it once instead.
            const disabled = (option.value === "item" && items.length === 0)
                          || (option.value === "account" && accounts.length === 0);
            return (
              <button
                key={option.value} type="button" disabled={disabled}
                aria-pressed={active}
                onClick={() => chooseMode(option.value)}
                className={cx(
                  "min-h-11 rounded-lg border px-4 text-sm transition",
                  active ? "border-primary bg-primary text-on-status font-medium"
                         : "bg-surface hover:bg-surface-muted",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{modeHint(mode, items.length, accounts.length)}</p>
      </fieldset>

      {mode === "item" ? (
        <ItemPicker items={items} chosen={item} onChoose={chooseItem} onClear={() => setItemId(null)} />
      ) : null}

      {mode === "account" ? (
        <AccountPicker
          accounts={accounts} chosen={account} noChart={noChart}
          onChoose={(chosen) => chooseAccount(chosen, true)}
          onClear={() => setAccountId(null)}
        />
      ) : null}

      {/*
        The code, on the two routes that did not start from one.
        - Item mode: shown as the *consequence* of the item, and only once one is
          picked — an account picker sitting under an empty search box is asking
          a question nobody has reached yet. It appears because an item with no
          account on it would otherwise produce an uncoded line in silence, which
          is the failure this whole feature exists to end.
        - Free-text mode: offered, never demanded. A line that is in neither list
          is precisely the line the client asked to be able to write.
      */}
      {(mode === "free" || (mode === "item" && item)) && !noChart ? (
        <div className="rounded-xl border bg-surface-muted/40 p-3">
          {account ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Eyebrow>Codes to</Eyebrow>
                <p className="font-mono text-sm">{accountLabel(account)}</p>
              </div>
              <button type="button" onClick={() => setAccountId(null)}
                      className="min-h-11 rounded-lg px-3 text-sm underline underline-offset-4">
                Change
              </button>
            </div>
          ) : (
            <>
              <Eyebrow>
                {mode === "item" && item
                  ? "This item has no account set — it will not be coded"
                  : "Account code (optional)"}
              </Eyebrow>
              <AccountPicker
                accounts={accounts} chosen={null} noChart={noChart} compact
                onChoose={(chosen) => chooseAccount(chosen, false)}
                onClear={() => setAccountId(null)}
              />
            </>
          )}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Description" name="description" required className="lg:col-span-2"
               hint="What the customer sees on the invoice.">
          <input
            id="description" name="description" required
            className={CONTROL} value={description}
            onChange={(event) => { setDescription(event.target.value); setTyped(true); }}
          />
        </Field>
        <Field label="Charge type" name="charge_type">
          <Select name="charge_type" defaultValue="other"
                  options={Object.entries(CHARGE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Quantity" name="quantity">
          <Input name="quantity" type="number" step="0.01" min={0} defaultValue="1" inputMode="decimal" />
        </Field>
        <Field label="Unit price" name="unit_price">
          <input
            id="unit_price" name="unit_price" type="number" step="0.01" min={0}
            inputMode="decimal" className={CONTROL} value={unitPrice}
            onChange={(event) => setUnitPrice(event.target.value)}
          />
        </Field>
        <div className="flex items-end">
          {/*
            The shared `Checkbox` is uncontrolled and this one is driven by the
            account's tax code, so it borrows the skin and the 44px padded label
            rather than the component — the arrangement the billing queue and the
            charges editor already use for the same reason.
          */}
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg py-1.5 text-sm
                            transition hover:bg-surface-muted/60">
            <input
              id="taxable" name="taxable" type="checkbox" checked={taxable}
              onChange={(event) => setTaxable(event.target.checked)}
              className="size-[1.15rem] shrink-0 rounded border-control-border accent-primary"
            />
            GST applies
          </label>
        </div>
        <div className="flex items-end">
          <SubmitButton variant="secondary" size="md" pendingLabel="Adding…">Add line</SubmitButton>
        </div>
      </div>
    </form>
  );
}

/**
 * The sentence under the mode buttons.
 *
 * It has to answer the *disabled* cases as well as the chosen one, because a
 * greyed-out button with no explanation reads as a fault in the app rather than
 * as a list this laundry has not filled in yet.
 */
function modeHint(mode: Mode, itemCount: number, accountCount: number): string {
  if (itemCount === 0 && accountCount === 0) {
    return "No item list and no chart of accounts yet, so type the line out. "
         + "Adding either will let a line code itself.";
  }
  if (itemCount === 0) return "No items on file yet — pick an account code, or type it out.";
  if (accountCount === 0) {
    return "No chart of accounts on file yet, so nothing can be coded. "
         + "Pick an item or type the line out.";
  }
  return MODES.find((option) => option.value === mode)!.hint;
}

/* -------------------------------------------------------------- the pickers */

function ItemPicker({
  items, chosen, onChoose, onClear,
}: {
  items: readonly LineFormItem[];
  chosen: LineFormItem | null;
  onChoose: (item: LineFormItem) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchItems(items, query, 8), [items, query]);

  if (chosen) {
    return (
      <Chosen label="Item" value={itemLabel(chosen)} onClear={() => { onClear(); setQuery(""); }} />
    );
  }

  return (
    <TypeAhead
      id="line-item" label="Item" placeholder="Search by code or name — TOW001"
      hint="Type the code you know. The price, the GST and the account all come with it."
      query={query} onQuery={setQuery}
      empty="No item matches that. Try another code, or switch to “Something else”."
      results={matches.map((match) => ({
        key: match.id,
        primary: itemLabel(match),
        secondary: [
          match.description,
          Number(match.sell_price ?? 0) > 0 ? `$${Number(match.sell_price).toFixed(2)}` : null,
        ].filter(Boolean).join(" · "),
        onPick: () => { onChoose(match); setQuery(""); },
      }))}
    />
  );
}

function AccountPicker({
  accounts, chosen, noChart, compact, onChoose, onClear,
}: {
  accounts: readonly LineFormAccount[];
  chosen: LineFormAccount | null;
  noChart: boolean;
  compact?: boolean;
  onChoose: (account: LineFormAccount) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  /*
   * Revenue accounts by default. A sale belongs on one, and offering all 268 —
   * every loan, every expense — makes the right answer harder to find rather than
   * easier. The escape stays one checkbox away because a bookkeeper offsetting a
   * recharge against an expense account is doing their job, not making a mistake.
   */
  const pool = useMemo(
    () => (showAll ? accounts : accounts.filter(isRevenueAccount)),
    [accounts, showAll],
  );
  const matches = useMemo(() => searchAccounts(pool, query, 8), [pool, query]);

  if (noChart) {
    return (
      <Notice tone="info" title="No chart of accounts on file">
        Import your chart of accounts and every line can be coded to one. Until then,
        pick an item or type the line out.
      </Notice>
    );
  }

  if (chosen) {
    return (
      <Chosen label="Account" value={accountLabel(chosen)} mono
              onClear={() => { onClear(); setQuery(""); }} />
    );
  }

  return (
    <div className={compact ? "mt-2" : undefined}>
      <TypeAhead
        id={compact ? "line-account-extra" : "line-account"} label="Account code"
        placeholder="Search by code or name — 4-1100, towels"
        hint={compact ? undefined : "The account this sale is tracked against in your books."}
        query={query} onQuery={setQuery} mono
        empty={showAll
          ? "No account matches that."
          : "No income account matches that. Tick “every account” to search the rest of the chart."}
        results={matches.map((match) => ({
          key: match.id,
          primary: accountLabel(match),
          secondary: [match.account_type, match.tax_code].filter(Boolean).join(" · "),
          onPick: () => { onChoose(match); setQuery(""); },
        }))}
      />
      <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-3 rounded-lg py-1.5
                        text-sm transition hover:bg-surface-muted/60">
        <input type="checkbox" checked={showAll}
               onChange={(event) => setShowAll(event.target.checked)}
               className="size-[1.15rem] shrink-0 rounded border-control-border accent-primary" />
        Search every account, not just income
      </label>
    </div>
  );
}

/* --------------------------------------------------------------- the pieces */

function Chosen({
  label, value, mono, onClear,
}: { label: string; value: string; mono?: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border
                    bg-surface-muted/40 p-3">
      <div>
        <Eyebrow>{label}</Eyebrow>
        <p className={cx("text-sm font-medium", mono && "font-mono")}>{value}</p>
      </div>
      <button type="button" onClick={onClear}
              className="min-h-11 rounded-lg px-3 text-sm underline underline-offset-4">
        Change
      </button>
    </div>
  );
}

type Result = { key: string; primary: string; secondary?: string; onPick: () => void };

/**
 * One search box and a floating result list.
 *
 * `relative` on the wrapper is load-bearing rather than decorative: the list is
 * absolutely positioned, and without a containing block inside the scroller it
 * escapes an ancestor's `overflow` clip — the defect §10b records from the
 * planner, where an absolutely-positioned child stretched the document 227px on
 * a phone.
 */
function TypeAhead({
  id, label, placeholder, hint, query, onQuery, results, empty, mono,
}: {
  id: string; label: string; placeholder: string; hint?: string;
  query: string; onQuery: (value: string) => void;
  results: readonly Result[]; empty: string; mono?: boolean;
}) {
  return (
    <div className="relative">
      <Field label={label} name={id} hint={hint}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4
                             -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            id={id} type="search" autoComplete="off"
            className={cx(CONTROL, "pl-9", mono && "font-mono")}
            placeholder={placeholder}
            role="combobox" aria-expanded={query.trim().length > 0}
            aria-controls={`${id}-results`}
            value={query} onChange={(event) => onQuery(event.target.value)}
          />
        </div>
      </Field>

      {query.trim() ? (
        <ul id={`${id}-results`}
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto
                       rounded-xl border bg-surface py-1 shadow-lg">
          {results.map((result) => (
            <li key={result.key}>
              <button type="button" onClick={result.onPick}
                      className="flex min-h-12 w-full flex-col items-start justify-center
                                 px-4 py-2 text-left transition hover:bg-surface-muted">
                <span className={cx("text-sm font-medium", mono && "font-mono")}>{result.primary}</span>
                {result.secondary ? (
                  <span className="text-xs text-muted-foreground">{result.secondary}</span>
                ) : null}
              </button>
            </li>
          ))}
          {results.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">{empty}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
