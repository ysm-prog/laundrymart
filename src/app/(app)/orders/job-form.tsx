"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Field, FormActions, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { Badge, ButtonLink, Card, CONTROL, Eyebrow, Notice, cx, humanise } from "@/components/ui";
import { CustomerEssentials } from "@/app/(app)/customers/customer-form";
import {
  DELIVERY_WINDOWS, DELIVERY_WINDOW_LABELS, ITEM_TYPES, ITEM_TYPE_LABELS,
  ORDER_PRIORITIES, PRIORITY_LABELS, QUANTITY_TYPES, QUANTITY_TYPE_LABELS,
  RECEIVED_VIA_LABELS, describeItem, initialDeliveryRequired, receivedViaOptions,
  type ReceivedVia,
} from "@/lib/domain/laundry-orders";
import { businessToday, toZonedDate } from "@/lib/domain/timezone";
import type { LaundryOrder, LaundryOrderItem } from "@/lib/db/types";

/**
 * Taking laundry in, on one screen.
 *
 * A dedicated page rather than a modal, matching the Customers module and the
 * flat design system, which has no overlays. The target is thirty to sixty
 * seconds for the common job, so the order of the page is the order of the
 * conversation at the counter: who is this, what did they bring, when do they
 * want it, anything unusual.
 *
 * Everything that can be a default is one: today's date, a customer drop-off,
 * re-delivery, normal priority, one empty laundry row ready to fill. The time of
 * receipt is not asked for at all — it is the moment the job is being taken in,
 * so the server stamps it. The two branching questions — how it arrived, and
 * whether we deliver it back —
 * *render* their extra fields rather than hiding them, so nothing that is out of
 * play is still in the post.
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
  order, items, defaultCustomerId, canBackdate, returnPath,
}: {
  action: (formData: FormData) => Promise<void>;
  /** The existing `createCustomer` action — this module adds no customer flow. */
  customerAction: (formData: FormData) => Promise<void>;
  customers: JobCustomer[];
  drivers: JobDriver[];
  staff: JobStaff[];
  order?: LaundryOrder;
  items?: LaundryOrderItem[];
  defaultCustomerId?: string;
  /** `orders.manage` — only they may record a job as arriving on an earlier day. */
  canBackdate: boolean;
  /** Where the quick-create returns to, so the job form is not restarted. */
  returnPath: string;
}) {
  const editing = order !== undefined;

  // `defaultCustomerId` wins over the saved one: it is only ever set when the
  // customer quick-create has just come back with a brand new customer, and
  // that is the one the user meant.
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? order?.customer_id ?? "");
  const [query, setQuery] = useState("");
  const [quickCreate, setQuickCreate] = useState(false);
  const [receivedVia, setReceivedVia] = useState<string>(order?.received_via ?? "customer_dropoff");
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

  const itemsPayload = useMemo(() => JSON.stringify(
    rows.map((row) => ({
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
        <Card title="Customer" description="Every job belongs to a customer already on file.">
          <div className="space-y-3">
            <Field label="Find a customer" name="customer_search"
                   hint="Search by business name, customer number, phone or email.">
              <input
                id="customer_search" type="search" className={CONTROL} autoComplete="off"
                placeholder="Harbourview, 0400…, accounts@…"
                value={query} onChange={(event) => setQuery(event.target.value)}
              />
            </Field>

            {selected ? (
              <div className="border border-l-[5px] border-l-primary p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] font-semibold">{selected.business_name}</p>
                  <button type="button" onClick={() => { setCustomerId(""); setQuery(""); }}
                          className="text-xs font-medium text-primary hover:underline">
                    Choose someone else
                  </button>
                </div>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <Detail label="Customer no." value={selected.customer_number} />
                  <Detail label="Trading as" value={selected.trading_name} />
                  <Detail label="Phone" value={selected.phone} />
                  <Detail label="Email" value={selected.billing_email} />
                  <Detail label="Billing address" value={selected.billing_address} />
                  <Detail label="Delivery address" value={selected.delivery_address} />
                </dl>
              </div>
            ) : (
              <div className="border">
                <ul className="max-h-64 divide-y overflow-y-auto">
                  {matches.map((customer) => (
                    <li key={customer.id}>
                      <button type="button" onClick={() => setCustomerId(customer.id)}
                              className="flex min-h-9 w-full flex-col items-start px-3 py-2 text-left hover:bg-surface-muted">
                        <span className="text-[12.5px] font-medium">{customer.business_name}</span>
                        <span className="font-mono text-3xs text-muted-foreground">
                          {[customer.customer_number, customer.phone, customer.billing_email]
                            .filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    </li>
                  ))}
                  {matches.length === 0 ? (
                    <li className="px-3 py-3 text-xs text-muted-foreground">
                      No customer matches that. Check the spelling, or add them below.
                    </li>
                  ) : null}
                </ul>
              </div>
            )}

            <button type="button" onClick={() => setQuickCreate((open) => !open)}
                    className="min-h-9 text-xs font-medium text-primary hover:underline">
              {quickCreate ? "Never mind — pick an existing customer" : "+ Add new customer"}
            </button>

            {quickCreate ? (
              <div className="space-y-3 border border-l-[5px] border-l-primary p-3">
                <p className="text-[12.5px] font-medium">New customer — four fields is all it takes.</p>
                <CustomerEssentials formId={QUICK_CREATE_FORM} />
                <button type="submit" form={QUICK_CREATE_FORM}
                        className="min-h-9 bg-action px-3 py-1.5 text-[12.5px] font-medium text-action-foreground hover:opacity-90">
                  Create customer and come back
                </button>
                <p className="text-xs text-muted-foreground">
                  You will land back on this form with them already selected. Anything
                  else you have typed here is not kept, so add the customer first.
                </p>
              </div>
            ) : null}
          </div>
        </Card>

        {/* ------------------------------------------------------ received --- */}
        <Card title="Order received" description="When the laundry actually arrived.">
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

            {receivedVia === "driver_pickup" ? (
              <>
                <Field label="Pickup date" name="pickup_date">
                  <Input name="pickup_date" type="date" defaultValue={order?.pickup_date ?? undefined} />
                </Field>
                <Field label="Pickup time" name="pickup_time">
                  <Input name="pickup_time" type="time"
                         defaultValue={order?.pickup_time?.slice(0, 5) ?? undefined} />
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
        </Card>

        {/* -------------------------------------------------------- laundry --- */}
        <Card
          title="Laundry"
          description="What is in the bag. Count it, or take it as a bulk lot."
          actions={
            <button type="button" onClick={addRow}
                    className="min-h-9 border border-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium hover:bg-surface-muted">
              + Add item
            </button>
          }
        >
          <ul className="space-y-3">
            {rows.map((row, index) => (
              <li key={row.key} className="border p-3">
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
                  <label className="space-y-1">
                    <span className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                      Item type
                    </span>
                    <select className={CONTROL} value={row.itemType}
                            onChange={(event) => patch(row.key, { itemType: event.target.value })}>
                      {ITEM_TYPES.map((value) => (
                        <option key={value} value={value}>{ITEM_TYPE_LABELS[value]}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
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
                      <span className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                        What is it
                      </span>
                      <input className={CONTROL} value={row.customDescription}
                             placeholder="Chef whites, curtains…"
                             onChange={(event) => patch(row.key, { customDescription: event.target.value })} />
                    </label>
                  ) : null}

                  {row.quantityType === "exact" ? (
                    <label className="space-y-1">
                      <span className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                        How many
                      </span>
                      <input className={CONTROL} type="number" min={1} step={1} inputMode="numeric"
                             value={row.exactQuantity}
                             onChange={(event) => patch(row.key, { exactQuantity: event.target.value })} />
                    </label>
                  ) : (
                    <>
                      <label className="space-y-1">
                        <span className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                          Bags / lots
                        </span>
                        <input className={CONTROL} type="number" min={1} step={1} inputMode="numeric"
                               value={row.bagCount}
                               onChange={(event) => patch(row.key, { bagCount: event.target.value })} />
                      </label>
                      <label className="space-y-1">
                        <span className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                          Rough count
                        </span>
                        <input className={CONTROL} type="number" min={1} step={1} inputMode="numeric"
                               placeholder="Optional" value={row.estimatedQuantity}
                               onChange={(event) => patch(row.key, { estimatedQuantity: event.target.value })} />
                      </label>
                    </>
                  )}

                  <label className="space-y-1 sm:col-span-2 lg:col-span-4">
                    <span className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
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

          <div className="mt-3">
            {/* The plant's field, kept distinct from each item's own notes:
                one is how to wash it, the other is what came in the bag. Same
                `special_instructions` column it has always written to. */}
            <Field label="Machine instructions" name="special_instructions"
                   hint="Anything the plant needs to know. Directions to the door go under Delivery.">
              <Textarea name="special_instructions" rows={2}
                        defaultValue={order?.special_instructions}
                        placeholder="Separate the whites; no fabric softener." />
            </Field>
          </div>
        </Card>

        {/* ------------------------------------------------------- delivery --- */}
        <Card title="Delivery or pickup"
              description="Are we taking it back to them, or are they coming for it?">
          <div className="space-y-3">
            {/* Re-deliver leads and is the default: it is the normal job, and
                selecting it every time was a step that was almost always the
                same. Customer pickup is one tap away and unchanged. */}
            <div className="flex flex-wrap gap-2">
              <ChoiceButton selected={deliveryRequired} onClick={() => setDeliveryRequired(true)}
                            label="Re-deliver" detail="It goes back out to them on a run." />
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
                  <p className="mt-1 text-[12.5px]">
                    {customAddress
                      ? "A one-off address for this job only."
                      : selected?.delivery_address
                        ?? selected?.billing_address
                        ?? "Select a customer to see their address."}
                  </p>
                  <label className="mt-1 flex min-h-9 items-center gap-2 text-[12.5px]">
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
        </Card>

        {/* ------------------------------------------ priority + assignment --- */}
        <Card title="Priority and who is on it">
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
        </Card>

        <FormActions>
          <SubmitButton pendingLabel={editing ? "Saving…" : "Creating…"}>
            {editing ? "Save changes" : "Create job"}
          </SubmitButton>
          {editing
            ? <ButtonLink href={`/orders/${order.id}`}>Cancel</ButtonLink>
            : <ButtonLink href="/orders">Cancel</ButtonLink>}
          <span className="text-xs text-muted-foreground">
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

      {editing ? null : (
        <p className="mt-4 text-xs text-muted-foreground">
          Looking for an existing one? <Link href="/orders" className="text-primary hover:underline">All jobs</Link>
        </p>
      )}
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
              "min-h-9 flex-1 border px-3 py-2 text-left transition",
              selected ? "border-primary bg-primary/10" : "border-strong hover:bg-surface-muted",
            )}>
      <span className={cx("block text-[12.5px] font-medium", selected && "text-primary")}>{label}</span>
      <span className="block text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}
