"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  accountLabel, isRevenueAccount, searchAccounts, type PickableAccount,
} from "@/lib/domain/accounts";
import { itemLabel, searchItems, type PickableItem } from "@/lib/domain/items";
import { CONTROL, cx, Eyebrow, Notice } from "@/components/ui";
import { Field } from "@/components/form";

/**
 * Picking an item or an account code, in the two places money is decided.
 *
 * **Shared because the two screens are the same question asked twice.** MYOB puts
 * the item and the account on the invoice line at the moment the line is written;
 * this app splits that decision across a job's Charges screen (where the price is
 * agreed and frozen) and the invoice line composer (where a line can still be
 * added by hand). Both need a code-first type-ahead over the item list and one
 * over the chart of accounts, and a second copy of either would drift — which is
 * exactly what happened to the item form, built twice in one afternoon on two
 * branches that then disagreed about tenancy.
 *
 * Everything here is presentation and search. What a picked item *means* — which
 * account it codes to, whether GST applies — is `lib/domain/items.ts` and
 * `lib/domain/accounts.ts`, so it stays testable without a browser.
 */

/** An item as either picker needs it: the code, the name, and what it implies. */
export type CodingItem = PickableItem & {
  sell_price: number | string | null;
  tax_code: string | null;
  income_account_id: string | null;
};

export type CodingAccount = PickableAccount;

/* -------------------------------------------------------------- the pickers */

/**
 * The least an item must carry to be pickable here. `CodingItem` satisfies it
 * and adds what a *coded* line needs on top.
 *
 * The picker is generic over this rather than fixed to `CodingItem` so the job
 * form can hand it the job catalogue — `{id, item_code, name, description,
 * laundry_category}` — and get its own type back from `onChoose`, instead of
 * either widening `CodingItem` (which would make `income_account_id` optional at
 * the two call sites that depend on it) or making the job form fetch three
 * columns it has no use for.
 */
export type PickerItem = PickableItem & { sell_price?: number | string | null };

export function ItemPicker<T extends PickerItem>({
  items, chosen, onChoose, onClear, idPrefix = "line", purpose = "coding",
}: {
  items: readonly T[];
  chosen: T | null;
  onChoose: (item: T) => void;
  onClear: () => void;
  /**
   * What this picker is choosing an item *for*, which changes two things.
   *
   * On an invoice line or a job charge (`coding`) the item genuinely brings its
   * price, its GST answer and its account with it, so the results show
   * `items.sell_price` and the hint says so.
   *
   * On a job's laundry row (`laundry`) none of that is true: what the customer
   * pays comes from `laundry_prices`, per customer with a tenant default, and
   * `items.sell_price` is a list price for a *sale* line. Showing it beside a
   * bag of towels would be a second answer to "what is this worth" — the
   * duplication this codebase argues against everywhere — and with 252 of
   * Adelaide's 254 items carrying no sell price, "no price set" on a laundry row
   * would read as "this job will not be billed", which is false.
   */
  purpose?: "coding" | "laundry";
  /**
   * Makes this picker's ids unique on the page.
   *
   * The invoice composer draws one of these; the job's Charges screen draws one
   * **per row**, and without a prefix every row would render `id="line-item"` —
   * so each row's `<label>` would point at the first row's box and a screen
   * reader would announce the wrong field. Found by driving the screen, which is
   * the only way a duplicate id shows up.
   */
  idPrefix?: string;
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
      id={`${idPrefix}-item`} label="Item" placeholder="Search by code or name — TOW001"
      hint={purpose === "coding"
        ? "Type the code you know. The price, the GST and the account all come with it."
        : "Type the code you know. The kind of laundry comes with it."}
      query={query} onQuery={setQuery}
      empty={purpose === "coding"
        ? "No item matches that. Try another code, or switch to “Something else”."
        : "No item matches that. Try another code, or leave it blank and pick the kind of laundry."}
      results={matches.map((match) => ({
        key: match.id,
        primary: itemLabel(match),
        /*
         * **"No price set" is said out loud, not left blank.** The client's own
         * MYOB inventory export carries a selling price on **2 of 257** items,
         * so an item with none is the ordinary case here, not the exception —
         * and a blank where a price should be reads as "free" or as a screen
         * still loading. Naming it tells the operator the rate is theirs to type.
         */
        secondary: [
          match.description,
          purpose === "coding"
            ? (Number(match.sell_price ?? 0) > 0
                ? `$${Number(match.sell_price).toFixed(2)}`
                : "no price set")
            : null,
        ].filter(Boolean).join(" · "),
        onPick: () => { onChoose(match); setQuery(""); },
      }))}
    />
  );
}

export function AccountPicker({
  accounts, chosen, noChart, compact, onChoose, onClear, idPrefix = "line",
}: {
  idPrefix?: string;
  accounts: readonly CodingAccount[];
  chosen: CodingAccount | null;
  noChart: boolean;
  compact?: boolean;
  onChoose: (account: CodingAccount) => void;
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
        id={compact ? `${idPrefix}-account-extra` : `${idPrefix}-account`} label="Account code"
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

export function Chosen({
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
export function TypeAhead({
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

/**
 * A description box that also finds an item by its code.
 *
 * **Typing `tw` here offers `TW · Towels - Wash & Dry Only`.** That is how MYOB
 * behaves and it is what people actually reach for — the item search used to sit
 * behind a small "Add item or code" link at the end of the row, so somebody
 * typing a code into the description saw nothing happen and concluded the codes
 * were missing. This is the fast path; the item field under the row is the same
 * choice made deliberately, and both go through `chargePatchForItem`.
 *
 * **Free text still wins, and that is the constraint the whole component is
 * shaped by.** A charge line is often "Bath towels — 40 collected 14 Aug", which
 * is in no item list. So suggestions are *offered*, never imposed: they appear
 * only while the box has focus, Escape dismisses them, and typing past a match
 * simply stops matching. Nothing is chosen without a deliberate Enter or click.
 *
 * Once the row names an item there is nothing left to suggest, so the list stops
 * appearing — the row's item field is then the place to change or clear it.
 */
export function DescriptionWithItems<T extends PickerItem>({
  id, value, onChange, onChooseItem, items, placeholder, hasItem,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onChooseItem: (item: T) => void;
  items: readonly T[];
  placeholder: string;
  /** True once the row names an item: there is nothing left to suggest. */
  hasItem: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(
    () => (hasItem || !value.trim() || items.length === 0 ? [] : searchItems(items, value, 6)),
    [items, value, hasItem],
  );
  const open = focused && !dismissed && matches.length > 0;

  function pick(item: T) {
    onChooseItem(item);
    setDismissed(true);
    setActive(0);
  }

  return (
    // `relative` is load-bearing, not decorative: the list is absolutely
    // positioned, and without a containing block it escapes an ancestor's
    // overflow clip — the defect §10b records from the planner.
    <div className="relative">
      <input
        id={id}
        className={CONTROL}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-items`}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${id}-item-${active}` : undefined}
        onChange={(event) => { onChange(event.target.value); setDismissed(false); setActive(0); }}
        onFocus={() => setFocused(true)}
        // A click on a suggestion blurs the box before it lands, so closing is
        // deferred a tick. Without it every pick would be swallowed.
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown") {
            event.preventDefault(); setActive((i) => (i + 1) % matches.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length);
          } else if (event.key === "Enter") {
            // Only ever inside an open list — otherwise Enter belongs to the form.
            // Guarded rather than asserted: the list can reshuffle under a
            // keystroke, and picking `undefined` would clear the row's item.
            const chosen = matches[active];
            if (chosen) { event.preventDefault(); pick(chosen); }
          } else if (event.key === "Escape") {
            event.preventDefault(); setDismissed(true);
          }
        }}
      />

      {open ? (
        <ul id={`${id}-items`} role="listbox"
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto
                       rounded-xl border bg-surface py-1 shadow-lg">
          {matches.map((item, index) => (
            <li key={item.id} id={`${id}-item-${index}`} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(item)}
                className={cx(
                  "flex min-h-12 w-full flex-col items-start justify-center px-4 py-2 text-left transition",
                  index === active ? "bg-surface-muted" : "hover:bg-surface-muted",
                )}
              >
                <span className="font-mono text-sm font-medium">{item.item_code ?? "—"}</span>
                <span className="text-xs text-muted-foreground">{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
