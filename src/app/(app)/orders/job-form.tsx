"use client";

import { useMemo, useState } from "react";
import { Field, FormActions, Input, Select, SubmitButton, Textarea } from "@/components/form";
import {
  Badge, ButtonLink, CONTROL, Eyebrow, FormSection, Notice, cx, humanise,
} from "@/components/ui";
import {
  Building2, CalendarClock, Check, ClipboardList, MessageSquareText, Plus, Search, Shirt, Truck,
} from "lucide-react";
import { CustomerEssentials } from "@/app/(app)/customers/customer-form";
import {
  DELIVERY_WINDOWS, DELIVERY_WINDOW_LABELS, ITEM_TYPES, ITEM_TYPE_LABELS,
  ORDER_PRIORITIES, PRIORITY_LABELS, QUANTITY_TYPES, QUANTITY_TYPE_LABELS,
  RECEIVED_VIA_LABELS, describeItem, initialDeliveryRequired, initialReceivedVia,
  receivedViaOptions, type ReceivedVia,
} from "@/lib/domain/laundry-orders";
import { businessToday, toZonedDate } from "@/lib/domain/timezone";
import type { LaundryOrder, LaundryOrderItem } from "@/lib/db/types";
import { itemLabel } from "@/lib/domain/items";

/**
 * Taking laundry in, on one screen.
 *
 * A dedicated page rather than a modal, matching the Customers module and the
 * flat design system, which has no overlays. The target is thirty to sixty
 * seconds for the common job, so the order of the page is the order of the
 * conversation at the counter: who is this, what did they bring, when do they
 * want it, anything unusual.
 *
 * Everything that can be a default is one: today's date, a driver pickup,
 * delivery back to the customer, normal priority, one empty laundry row ready to
 * fill. Neither the time of receipt nor a pickup time is asked for at all — the
 * first is the moment the job is being taken in, so the server stamps it, and
 * the second was a field nobody ever read. The two branching questions — how it
 * arrived, and whether we deliver it back — *render* their extra fields rather
 * than hiding them, so nothing that is out of play is still in the post.
 *
 * The laundry rows post as JSON in one hidden field: the compose-locally,
 * commit-once shape the dispatch planner and the contract wizard already use,
 * which keeps a repeating group out of FormData index games and lets the server
 * validate one well-formed list.
 */

export type JobCustomer = {
  id: string;
  customer_number: string;
  business_name: string;
  trading_name: string | null;
  phone: string | null;
  billing_email: string | null;
  billing_address: string | null;
  delivery_address: string | null;
};

export type JobDriver = { id: string; full_name: string };
export type JobStaff = { id: string; label: string; role: string };

type ItemRow = {
  key: number;
  /** The item master row, or "" for a row entered as a bare kind of laundry. */
  itemId: string;
  itemType: string;
  customDescription: string;
  quantityType: "exact" | "bulk_lot";
  exactQuantity: string;
  bagCount: string;
  estimatedQuantity: string;
  notes: string;
};

const QUICK_CREATE_FORM = "job-customer-quick-create";

function blankItem(key: number): ItemRow {
  return {
    key,
    itemId: "",
    itemType: "towels",
    customDescription: "",
    quantityType: "exact",
    exactQuantity: "",
    bagCount: "",
    estimatedQuantity: "",
    notes: "",
  };
}

/** "" → absent, so an untouched number field is not posted as zero. */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function JobForm({
  action, customerAction, customers, drivers, staff,
  order, items, catalogue = [], defaultCustomerId, canBackdate, returnPath,
}: {
  action: (formData: FormData) => Promise<void>;
  /** The existing `createCustomer` action — this module adds no customer flow. */
  customerAction: (formData: FormData) => Promise<void>;
  customers: JobCustomer[];
  drivers: JobDriver[];
  staff: JobStaff[];
  order?: LaundryOrder;
  items?: LaundryOrderItem[];
  /**
   * The laundry's item master, code-first. Empty for a laundry that has not set
   * one up, which is why the kind-of-laundry select stays.
   */
  catalogue?: Array<{
    id: string; item_code: string | null; name: string;
    description?: string | null; laundry_category: string | null;
  }>;
  defaultCustomerId?: string;
  /** `orders.manage` — only they may record a job as arriving on an earlier day. */
  canBackdate: boolean;
  /** Where the quick-create returns to, so the job form is not restarted. */
  returnPath: string;
}) {
  const editing = order !== undefined;

  // `defaultCustomerId` wins over the saved one: it is set when the customer
  // quick-create has just come back with a brand new customer, and when a
  // rejected save is coming back with the customer already chosen. Either way
  // it is the one the user meant.
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? order?.customer_id ?? "");

  // Both of those arrive as a *navigation*, not a fresh page load, so React may
  // keep this component mounted and `useState`'s initial value would never be
  // read again. Adjusting during render on a changed prop is what keeps the
  // selection in step — and it is the one pattern that does not need an effect,
  // which the react-hooks rules here rightly refuse.
  const [lastDefault, setLastDefault] = useState(defaultCustomerId);
  if (defaultCustomerId !== lastDefault) {
    setLastDefault(defaultCustomerId);
    if (defaultCustomerId) setCustomerId(defaultCustomerId);
  }
  const [query, setQuery] = useState("");
  const [quickCreate, setQuickCreate] = useState(false);
  const [receivedVia, setReceivedVia] = useState<string>(() => initialReceivedVia(order));
  const [deliveryRequired, setDeliveryRequired] = useState(() => initialDeliveryRequired(order));
  const [deliveryWindow, setDeliveryWindow] = useState<string>(
    order?.delivery_window ?? "no_specific_time",
  );
  const [customAddress, setCustomAddress] = useState(order?.delivery_address_source === "custom");
  const [nextKey, setNextKey] = useState(1);
  const [rows, setRows] = useState<ItemRow[]>(() => {
    if (!items?.length) return [blankItem(0)];
    return items.map((item, index) => ({
      key: index,
      itemId: item.item_id ?? "",
      itemType: item.item_type,
      customDescription: item.custom_description ?? "",
      quantityType: item.quantity_type === "bulk_lot" ? "bulk_lot" : "exact",
      exactQuantity: item.exact_quantity == null ? "" : String(item.exact_quantity),
      bagCount: item.bag_count == null ? "" : String(item.bag_count),
      estimatedQuantity: item.estimated_quantity == null ? "" : String(item.estimated_quantity),
      notes: item.notes ?? "",
    }));
  });

  const selected = customers.find((customer) => customer.id === customerId);

  /**
   * Search across the four things a counter hand would have to hand: the name
   * over the door, the trading name, the phone number they are reading off a
   * docket, and the email. Filtered in the browser over a list already loaded —
   * no round trip, so it narrows as fast as they type.
   */
  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return customers.slice(0, 12);
    return customers.filter((customer) => [
      customer.business_name, customer.trading_name, customer.customer_number,
      customer.phone, customer.billing_email,
    ].some((field) => field?.toLowerCase().includes(term))).slice(0, 12);
  }, [customers, query]);

  /**
   * The item list as the picker needs it, labelled code-first and ordered by
   * code — the order it is scanned in, since staff look for TOW001 and read down.
   */
  const itemOptions = useMemo(
    () => catalogue.map((entry) => ({ id: entry.id, label: itemLabel(entry) })),
    [catalogue],
  );
  const itemById = useMemo(() => new Map(catalogue.map((entry) => [entry.id, entry])), [catalogue]);

  const itemsPayload = useMemo(() => JSON.stringify(
    rows.map((row) => ({
      item_id: row.itemId || null,
      item_type: row.itemType,
      custom_description: row.customDescription.trim() || null,
      quantity_type: row.quantityType,
      exact_quantity: row.quantityType === "exact" ? numberOrNull(row.exactQuantity) : null,
      bag_count: row.quantityType === "bulk_lot" ? numberOrNull(row.bagCount) : null,
      estimated_quantity: row.quantityType === "bulk_lot" ? numberOrNull(row.estimatedQuantity) : null,
      notes: row.notes.trim() || null,
    })),
  ), [rows]);

  function patch(key: number, next: Partial<ItemRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)));
  }

  function addRow() {
    setRows((current) => [...current, blankItem(nextKey)]);
    setNextKey((key) => key + 1);
  }

  // Read back through the business timezone, not the device's: the counter in
  // Sydney and a laptop set to UTC must see the same received date on the same
  // job. Only the date is asked for — the time of day is the moment the job is
  // taken in, which the server stamps (see `receivedInstant`).
  const receivedDate = order ? toZonedDate(order.received_at) : businessToday();

  // The two real answers, plus whatever an older job already holds, so editing
  // one taken in under a retired option cannot rewrite how it arrived.
  const receivedViaChoices = receivedViaOptions(order?.received_via);

  return (
    <>
      {/*
        The existing customer quick-create, reused rather than reimplemented: its
        own <form> element sits here as a stub and its visible fields live inside
        the customer card below, associated back by the `form` attribute. It
        posts `return_to`, so `createCustomer` comes back to this page with
        `?customer=<id>` and the new customer already chosen — the job form is
        never restarted.
      */}
      <form id={QUICK_CREATE_FORM} action={customerAction}>
        <input type="hidden" name="status" value="active" />
        <input type="hidden" name="payment_terms_days" value="14" />
        <input type="hidden" name="return_to" value={returnPath} />
      </form>

      <form action={action} className="space-y-4">
        {editing ? <input type="hidden" name="id" value={order.id} /> : null}
        <input type="hidden" name="items" value={itemsPayload} />
        <input type="hidden" name="return_to" value={returnPath} />
        <input type="hidden" name="customer_id" value={customerId} />
        {deliveryRequired ? <input type="hidden" name="delivery_required" value="on" /> : null}
        {customAddress ? <input type="hidden" name="use_custom_address" value="on" /> : null}

        {/* ------------------------------------------------------ customer --- */}
        <FormSection
          title="Customer"
          description="Every job belongs to a customer already on file."
          icon={<Building2 className="size-[1.15rem]" />}
        >
          <div className="space-y-4">
            {selected ? (
              /*
                Chosen: the search box is gone and what remains is a card that
                answers "is this the right business?" at a glance. Nothing else
                on this screen needs the customer list any more.
              */
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span aria-hidden
                          className="flex size-10 shrink-0 items-center justify-center rounded-lg
                                     bg-primary/12 text-primary">
                      <Building2 className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold">{selected.business_name}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {[selected.customer_number, selected.trading_name]
                          .filter(Boolean).join(" · ")}
                      </p>
                    </div>
                  </div>
                  <button type="button" onClick={() => { setCustomerId(""); setQuery(""); }}
                          className="inline-flex min-h-10 items-center rounded-lg border
                                     border-strong bg-surface px-3 text-sm font-medium shadow-xs
                                     transition hover:bg-surface-muted">
                    Change customer
                  </button>
                </div>
                <dl className="mt-4 grid gap-x-8 gap-y-2 border-t border-primary/20 pt-3 text-sm
                               sm:grid-cols-2">
                  <Detail label="Phone" value={selected.phone} />
                  <Detail label="Email" value={selected.billing_email} />
                  <Detail label="Billing address" value={selected.billing_address} />
                  <Detail label="Delivery address" value={selected.delivery_address} />
                </dl>
              </div>
            ) : (
              /*
                Not yet chosen: one search box, and *nothing else* until they
                type. This screen used to open with a scrolling list of the first
                twelve customers, which made the first thing on the page the
                largest and least useful thing on it. Results now float over the
                form as a short list, the way a picker should behave.

                Reached with a `customerId` still set, this is a customer the
                server could not resolve — a record since deleted. Said out loud
                above the box, because the alternative is a picker that looks
                untouched while the form still carries that id, and a save that
                then fails on it for no visible reason. The warning sits outside
                the `relative` wrapper: that wrapper is the floating results
                list's containing block, and anything added inside it pushes the
                list down the page.
              */
              <>
                {customerId ? (
                  <Notice tone="warning" title="That customer is no longer on file">
                    The customer this job was pointed at cannot be opened any more.
                    Please search for the right one and save again.
                  </Notice>
                ) : null}

                <div className="relative">
                  <Field label="Customer" name="customer_search">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4
                                         -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <input
                        id="customer_search" type="search" autoComplete="off"
                        className={cx(CONTROL, "pl-9")}
                        placeholder="Search customer by name, phone or email"
                        role="combobox" aria-expanded={query.trim().length > 0}
                        aria-controls="customer-results"
                        value={query} onChange={(event) => setQuery(event.target.value)}
                      />
                    </div>
                  </Field>

                  {query.trim() ? (
                    <ul id="customer-results"
                        className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto
                                   rounded-xl border bg-surface py-1 shadow-lg">
                      {matches.map((customer) => (
                        <li key={customer.id}>
                          <button type="button" onClick={() => setCustomerId(customer.id)}
                                  className="flex min-h-12 w-full flex-col items-start justify-center
                                             px-4 py-2 text-left transition hover:bg-surface-muted">
                            <span className="text-sm font-medium">{customer.business_name}</span>
                            <span className="text-xs text-muted-foreground">
                              {[customer.customer_number, customer.phone, customer.billing_email]
                                .filter(Boolean).join(" · ")}
                            </span>
                          </button>
                        </li>
                      ))}
                      {matches.length === 0 ? (
                        <li className="px-4 py-3 text-sm text-muted-foreground">
                          No customer found. Try another search, or add a new customer below.
                        </li>
                      ) : null}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Start typing to find them — business name, customer number, phone or email.
                    </p>
                  )}
                </div>
              </>
            )}

            <button type="button" onClick={() => setQuickCreate((open) => !open)}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm
                               font-medium text-primary transition hover:bg-primary/8">
              {quickCreate
                ? "Never mind — pick an existing customer"
                : <><Plus className="size-4" aria-hidden /> Add new customer</>}
            </button>

            {quickCreate ? (
              <div className="space-y-4 rounded-xl border bg-surface-muted/50 p-4">
                <p className="text-sm font-semibold">New customer — four fields is all it takes.</p>
                <CustomerEssentials formId={QUICK_CREATE_FORM} />
                <button type="submit" form={QUICK_CREATE_FORM}
                        className="inline-flex min-h-11 items-center rounded-lg bg-action px-5
                                   text-sm font-medium text-action-foreground shadow-xs transition
                                   hover:brightness-110">
                  Create customer and come back
                </button>
                <p className="text-xs text-muted-foreground">
                  You will land back on this form with them already selected. Anything
                  else you have typed here is not kept, so add the customer first.
                </p>
              </div>
            ) : null}
          </div>
        </FormSection>

        {/* ------------------------------------------------------ received --- */}
        <FormSection title="Order received" description="When the laundry actually arrived."
                     icon={<CalendarClock className="size-[1.15rem]" />}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Received date" name="received_date" required
                   hint={canBackdate ? undefined : "Today. A manager can record an earlier day."}>
              <Input name="received_date" type="date" required defaultValue={receivedDate}
                     max={canBackdate ? undefined : businessToday()} />
            </Field>
            <Field label="Received via" name="received_via">
              <select id="received_via" name="received_via" className={CONTROL}
                      value={receivedVia} onChange={(event) => setReceivedVia(event.target.value)}>
                {receivedViaChoices.map((value) => (
                  <option key={value} value={value}>
                    {RECEIVED_VIA_LABELS[value as ReceivedVia] ?? humanise(value)}
                  </option>
                ))}
              </select>
            </Field>

            {/* Only a driver pickup has pickup details, and the fields are
                *rendered* conditionally rather than hidden — nothing out of play
                is still in the post. Pickup date is optional and carries no
                asterisk: the counter often does not know it yet, and a job that
                cannot be saved for want of it is a job that does not get taken
                in. There is no Pickup time field: it was asked for on every
                collection, used by nothing, and is gone from the workflow. */}
            {receivedVia === "driver_pickup" ? (
              <>
                <Field label="Pickup date" name="pickup_date" hint="Optional.">
                  <Input name="pickup_date" type="date" defaultValue={order?.pickup_date ?? undefined} />
                </Field>
                <Field label="Collected by" name="pickup_driver_id" className="sm:col-span-2"
                       hint="Your existing drivers.">
                  <Select name="pickup_driver_id" placeholder="Not recorded"
                          defaultValue={order?.pickup_driver_id}
                          options={drivers.map((driver) => ({ value: driver.id, label: driver.full_name }))} />
                </Field>
              </>
            ) : null}
          </div>
        </FormSection>

        {/* -------------------------------------------------------- laundry --- */}
        <FormSection
          title="Laundry details"
          description="What is in the bag. Count it, or take it as a bulk lot."
          icon={<Shirt className="size-[1.15rem]" />}
          actions={
            <button type="button" onClick={addRow}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border
                               border-strong bg-surface px-3.5 text-sm font-medium shadow-xs
                               transition hover:bg-surface-muted">
              <Plus className="size-4" aria-hidden /> Add item
            </button>
          }
        >
          <ul className="space-y-3">
            {rows.map((row, index) => (
              <li key={row.key} className="rounded-lg border p-3">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <Eyebrow>Item {index + 1}</Eyebrow>
                  {rows.length > 1 ? (
                    <button type="button"
                            onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                            className="min-h-9 text-xs font-medium text-danger hover:underline">
                      Remove
                    </button>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {/* **The item, by code.** Staff know TOW001 and type it; the
                      nine kinds of laundry are the fallback beneath, for a
                      laundry that has not set an item list up yet and for
                      anything the list does not cover. Picking an item fills the
                      kind in from the item master, which is also what the
                      database trigger does — so the two cannot disagree however
                      the row is written. */}
                  <label className="space-y-1 sm:col-span-2">
                    <span className="block text-sm font-medium text-foreground">
                      Item
                    </span>
                    {itemOptions.length > 0 ? (
                      <select
                        className={CONTROL}
                        value={row.itemId}
                        onChange={(event) => {
                          const picked = itemById.get(event.target.value);
                          patch(row.key, {
                            itemId: event.target.value,
                            // An item that says which kind of laundry it is sets
                            // it; one that does not leaves the row's own answer.
                            ...(picked?.laundry_category
                              ? { itemType: picked.laundry_category }
                              : {}),
                          });
                        }}
                      >
                        <option value="">Not on the item list</option>
                        {itemOptions.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No items set up yet — choose a kind of laundry beside this.
                      </p>
                    )}
                  </label>

                  <label className="space-y-1">
                    <span className="block text-sm font-medium text-foreground">
                      Kind of laundry
                    </span>
                    <select className={CONTROL} value={row.itemType}
                            disabled={Boolean(itemById.get(row.itemId)?.laundry_category)}
                            onChange={(event) => patch(row.key, { itemType: event.target.value })}>
                      {ITEM_TYPES.map((value) => (
                        <option key={value} value={value}>{ITEM_TYPE_LABELS[value]}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="block text-sm font-medium text-foreground">
                      Quantity type
                    </span>
                    <select className={CONTROL} value={row.quantityType}
                            onChange={(event) => patch(row.key, {
                              quantityType: event.target.value as ItemRow["quantityType"],
                            })}>
                      {QUANTITY_TYPES.map((value) => (
                        <option key={value} value={value}>{QUANTITY_TYPE_LABELS[value]}</option>
                      ))}
                    </select>
                  </label>

                  {row.itemType === "other" ? (
                    <label className="space-y-1 sm:col-span-2">
                      <span className="block text-sm font-medium text-foreground">
                        What is it
                      </span>
                      <input className={CONTROL} value={row.customDescription}
                             placeholder="Chef whites, curtains…"
                             onChange={(event) => patch(row.key, { customDescription: event.target.value })} />
                    </label>
                  ) : null}

                  {row.quantityType === "exact" ? (
                    <label className="space-y-1">
                      <span className="block text-sm font-medium text-foreground">
                        How many
                      </span>
                      <input className={CONTROL} type="number" min={1} step={1} inputMode="numeric"
                             value={row.exactQuantity}
                             onChange={(event) => patch(row.key, { exactQuantity: event.target.value })} />
                    </label>
                  ) : (
                    <>
                      <label className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Bags / lots
                        </span>
                        <input className={CONTROL} type="number" min={1} step={1} inputMode="numeric"
                               value={row.bagCount}
                               onChange={(event) => patch(row.key, { bagCount: event.target.value })} />
                      </label>
                      <label className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Rough count
                        </span>
                        <input className={CONTROL} type="number" min={1} step={1} inputMode="numeric"
                               placeholder="Optional" value={row.estimatedQuantity}
                               onChange={(event) => patch(row.key, { estimatedQuantity: event.target.value })} />
                      </label>
                    </>
                  )}

                  <label className="space-y-1 sm:col-span-2 lg:col-span-4">
                    <span className="block text-sm font-medium text-foreground">
                      Item notes
                    </span>
                    <input className={CONTROL} value={row.notes}
                           placeholder="Red wine on two of the cloths"
                           onChange={(event) => patch(row.key, { notes: event.target.value })} />
                  </label>
                </div>
              </li>
            ))}
          </ul>

        </FormSection>

        {/* --------------------------------------------------- instructions --- */}
        {/* The plant's field, kept distinct from each item's own notes: one is
            how to wash it, the other is what came in the bag. Same
            `special_instructions` column it has always written to, and its own
            section now because it is the one free-text answer on the form. */}
        <FormSection title="Instructions"
                     description="Anything the plant needs to know before it goes in."
                     icon={<MessageSquareText className="size-[1.15rem]" />}>
          <Field label="Machine instructions" name="special_instructions"
                 hint="Directions to the door go under Delivery instructions instead.">
            <Textarea name="special_instructions" rows={3}
                      defaultValue={order?.special_instructions}
                      placeholder="Separate the whites; no fabric softener." />
          </Field>
        </FormSection>

        {/* ------------------------------------------------------- delivery --- */}
        <FormSection title="Delivery"
                     description="Are we taking it back to them, or are they coming for it?"
                     icon={<Truck className="size-[1.15rem]" />}>
          <div className="space-y-3">
            {/* Deliver leads and is the default: it is the normal job, and
                selecting it every time was a step that was almost always the
                same. Customer pickup is one tap away and unchanged. The word is
                "Deliver", not "Re-deliver" — re-delivery is a courier's second
                attempt, which is a different event this system does not model. */}
            <div className="flex flex-wrap gap-2">
              <ChoiceButton selected={deliveryRequired} onClick={() => setDeliveryRequired(true)}
                            label="Deliver to customer" detail="We take it back out to them." />
              <ChoiceButton selected={!deliveryRequired} onClick={() => setDeliveryRequired(false)}
                            label="Customer pickup" detail="They collect it from the counter." />
            </div>

            {deliveryRequired ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Expected delivery date" name="expected_delivery_date" required>
                  <Input name="expected_delivery_date" type="date" required
                         min={businessToday()}
                         defaultValue={order?.expected_delivery_date ?? undefined} />
                </Field>
                <Field label="Delivery window" name="delivery_window">
                  <select id="delivery_window" name="delivery_window" className={CONTROL}
                          value={deliveryWindow}
                          onChange={(event) => setDeliveryWindow(event.target.value)}>
                    {DELIVERY_WINDOWS.map((value) => (
                      <option key={value} value={value}>{DELIVERY_WINDOW_LABELS[value]}</option>
                    ))}
                  </select>
                </Field>
                {deliveryWindow === "specific_time" ? (
                  <Field label="Delivery time" name="expected_delivery_time" required>
                    <Input name="expected_delivery_time" type="time" required
                           defaultValue={order?.expected_delivery_time?.slice(0, 5) ?? undefined} />
                  </Field>
                ) : null}

                <div className="sm:col-span-2">
                  <Eyebrow>Delivery address</Eyebrow>
                  <p className="mt-1 text-sm">
                    {customAddress
                      ? "A one-off address for this job only."
                      : selected?.delivery_address
                        ?? selected?.billing_address
                        ?? "Select a customer to see their address."}
                  </p>
                  <label className="mt-1 flex min-h-9 items-center gap-2 text-sm">
                    <input type="checkbox" checked={customAddress}
                           onChange={(event) => setCustomAddress(event.target.checked)}
                           className="h-4 w-4 border border-strong accent-primary" />
                    Use a different delivery address for this job
                  </label>
                  <p className="text-xs text-muted-foreground">
                    The address is copied onto the job as it stands today. Changing the
                    customer&apos;s address later will not rewrite this one.
                  </p>
                </div>

                {customAddress ? (
                  <Field label="One-off delivery address" name="delivery_address" required
                         className="sm:col-span-2">
                    <Input name="delivery_address" required
                           defaultValue={order?.delivery_address_source === "custom"
                             ? order.delivery_address ?? undefined
                             : undefined}
                           placeholder="12 Bay St, Ultimo NSW 2007" />
                  </Field>
                ) : null}

                <Field label="Delivery instructions" name="delivery_instructions"
                       className="sm:col-span-2">
                  <Input name="delivery_instructions"
                         defaultValue={order?.delivery_instructions ?? undefined}
                         placeholder="Rear door, ask for the duty manager" />
                </Field>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Notice tone="info" title="Customer pickup">
                  The customer collects this job. It is completed when they walk out with it.
                </Notice>
                <Field label="Expected collection date" name="expected_collection_date"
                       hint="Optional — leave blank if they did not say.">
                  <Input name="expected_collection_date" type="date" min={businessToday()}
                         defaultValue={order?.expected_collection_date ?? undefined} />
                </Field>
              </div>
            )}
          </div>
        </FormSection>

        {/* ------------------------------------------ priority + assignment --- */}
        <FormSection title="Job management" description="Priority, and who is looking after it."
                     icon={<ClipboardList className="size-[1.15rem]" />}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" name="priority">
              <Select name="priority" defaultValue={order?.priority ?? "normal"}
                      options={ORDER_PRIORITIES.map((value) => ({
                        value, label: PRIORITY_LABELS[value],
                      }))} />
            </Field>
            <Field label="Assign to" name="assigned_to" hint="Optional. Anyone who can sign in.">
              <Select name="assigned_to" placeholder="Nobody yet" defaultValue={order?.assigned_to}
                      options={staff.map((member) => ({
                        value: member.id, label: `${member.label} · ${member.role}`,
                      }))} />
            </Field>
          </div>
          {editing ? null : (
            <p className="mt-3 text-xs text-muted-foreground">
              New jobs always start as <Badge>New</Badge> and are given their job number
              automatically. There is nothing else to set.
            </p>
          )}
        </FormSection>

        <FormActions>
          <SubmitButton pendingLabel={editing ? "Saving…" : "Creating…"}>
            {editing ? "Save changes" : "Create job"}
          </SubmitButton>
          {editing
            ? <ButtonLink href={`/orders/${order.id}`}>Cancel</ButtonLink>
            : <ButtonLink href="/orders">Cancel</ButtonLink>}
          <span className="ml-auto hidden text-sm text-muted-foreground sm:inline">
            {rows.length === 1 ? "1 laundry item" : `${rows.length} laundry items`}
            {rows[0] ? ` · ${describeItem({
              item_type: rows[0].itemType,
              custom_description: rows[0].customDescription,
              quantity_type: rows[0].quantityType,
              exact_quantity: numberOrNull(rows[0].exactQuantity),
              bag_count: numberOrNull(rows[0].bagCount),
              estimated_quantity: numberOrNull(rows[0].estimatedQuantity),
            })}` : ""}
          </span>
        </FormActions>
      </form>

    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value || "—"}</dd>
    </div>
  );
}

/** A two-option choice big enough to hit on a tablet, in place of a radio pair. */
function ChoiceButton({
  selected, onClick, label, detail,
}: { selected: boolean; onClick: () => void; label: string; detail: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
            className={cx(
              "flex min-h-16 flex-1 items-start gap-2.5 rounded-xl border px-4 py-3 text-left",
              "shadow-xs transition",
              selected
                ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                : "border-strong bg-surface hover:bg-surface-muted",
            )}>
      {/* A tick, not just a fill: the chosen option must survive being read in
          greyscale or by someone who cannot separate the two tints. */}
      <span aria-hidden
            className={cx(
              "mt-0.5 flex size-[1.15rem] shrink-0 items-center justify-center rounded-full border",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-strong",
            )}>
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0">
        <span className={cx("block text-sm font-semibold", selected && "text-primary")}>{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}
