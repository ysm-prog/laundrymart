"use client";

import { useMemo, useState } from "react";
import { Field, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { ButtonLink, Card, Notice, Stage, cx } from "@/components/ui";
import { CustomerEssentials, FormDisclosure } from "@/app/(app)/customers/customer-form";
import { HOLIDAY_RULE_LABELS, HOLIDAY_RULES } from "@/lib/domain/service-calendar";
import { money, today } from "@/lib/format";

/**
 * Contract creation as a conversation (design spec P-3, AD-2): three steps, one
 * post. Step state lives in memory and the whole thing submits once to the
 * existing `createAgreement` action — no draft rows, no step-per-URL. A wizard
 * abandoned halfway is simply abandoned.
 *
 * Every step's fields stay mounted (hidden, not unmounted) so the single form
 * carries all of them at the end. Nothing here uses the `required` attribute:
 * a required field inside a hidden step would fail native validation with
 * nothing visible to focus, so each step's Next button validates instead.
 */

const REGIONS = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((value) => ({ value, label: value }));

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type WizardCustomer = { id: string; business_name: string; customer_number: string };
export type WizardLocation = { id: string; name: string; customer_id: string };
export type WizardDepot = { id: string; name: string };
export type WizardItem = { id: string; name: string; sku: string; rental_price: number };

type LineRow = {
  key: number;
  itemId: string;
  quantity: string;
  unitPrice: string;
  pricingModel: "per_item" | "per_kg" | "per_collection" | "monthly";
  includedQuantity: string;
};

const QUICK_CREATE_FORM = "customer-quick-create";

export function AgreementWizard({
  action, customerAction, customers, locations, depots, items, defaultCustomerId,
}: {
  action: (formData: FormData) => Promise<void>;
  customerAction: (formData: FormData) => Promise<void>;
  customers: WizardCustomer[];
  locations: WizardLocation[];
  depots: WizardDepot[];
  items: WizardItem[];
  defaultCustomerId?: string;
}) {
  const [step, setStep] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");
  const [quickCreate, setQuickCreate] = useState(false);
  const [pickupDays, setPickupDays] = useState<number[]>([]);
  const [follows, setFollows] = useState(true);
  const [deliveryDays, setDeliveryDays] = useState<number[]>([]);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [nextKey, setNextKey] = useState(1);

  const customerLocations = useMemo(
    () => locations.filter((location) => location.customer_id === customerId),
    [locations, customerId],
  );
  // One site means no choice to make — select it for them.
  const [locationId, setLocationId] = useState("");
  const effectiveLocationId =
    customerLocations.length === 1 ? customerLocations[0]!.id : locationId;

  const customerName = customers.find((c) => c.id === customerId)?.business_name;

  function toStep(target: number) {
    if (target > 1 && !customerId) {
      setProblem("Choose a customer first — a contract always belongs to one.");
      return;
    }
    if (target > 2 && pickupDays.length === 0) {
      setProblem("Pick at least one collection day.");
      return;
    }
    if (target > 2 && !follows && deliveryDays.length === 0) {
      setProblem("Pick at least one delivery day, or tick “deliveries follow collections”.");
      return;
    }
    setProblem(null);
    setStep(target);
  }

  function addLine() {
    const first = items[0];
    setLines((current) => [...current, {
      key: nextKey,
      itemId: first?.id ?? "",
      quantity: "",
      unitPrice: first ? String(first.rental_price ?? 0) : "0",
      pricingModel: "per_item",
      includedQuantity: "0",
    }]);
    setNextKey((k) => k + 1);
  }

  function patchLine(key: number, patch: Partial<LineRow>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  // What actually posts: the JSON shape `createAgreement` validates.
  const linesPayload = useMemo(() => JSON.stringify(
    lines
      .filter((line) => line.itemId)
      .map((line) => ({
        item_id: line.itemId,
        charge_type: line.pricingModel === "per_kg" ? "weight_charge" : "rental",
        pricing_model: line.pricingModel,
        unit_price: Number(line.unitPrice) || 0,
        standard_quantity: Number(line.quantity) || 0,
        included_quantity: Number(line.includedQuantity) || 0,
        taxable: true,
      })),
  ), [lines]);

  return (
    <>
      {/*
        The quick-create is its own form, rendered as a stub before the wizard's
        form. Its visible fields sit inside step 1's markup and associate back
        here via the `form` attribute — HTML's answer to nesting one form's
        fields inside another form's layout.
      */}
      <form id={QUICK_CREATE_FORM} action={customerAction}>
        <input type="hidden" name="status" value="active" />
        <input type="hidden" name="payment_terms_days" value="14" />
        <input type="hidden" name="return_to" value="/agreements/new" />
      </form>

      <form action={action} className="space-y-4">
        <input type="hidden" name="lines" value={linesPayload} />
        <input type="hidden" name="pickup_type" value="weekly" />
        {follows
          ? <input type="hidden" name="delivery_follows" value="on" />
          : <input type="hidden" name="delivery_type" value="weekly" />}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Card>
            <ol className="space-y-3">
              {/* ------------------------------------------------ step 1 --- */}
              <Stage index={1} label="Who and when" done={step > 1}
                     detail={step > 1 && customerName ? customerName : "The customer, their site, and when service starts."}>
                <div hidden={step !== 1} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Customer" name="customer_id" required>
                      <div className="space-y-1.5">
                        <select
                          id="customer_id" name="customer_id" value={customerId}
                          onChange={(event) => { setCustomerId(event.target.value); setLocationId(""); }}
                          className="rounded-lg w-full border border-strong bg-surface-muted px-2.5 py-1.5 text-sm"
                        >
                          <option value="">Choose a customer</option>
                          {customers.map((customer) => (
                            <option key={customer.id} value={customer.id}>
                              {customer.business_name} ({customer.customer_number})
                            </option>
                          ))}
                        </select>
                        <button type="button" onClick={() => setQuickCreate((open) => !open)}
                                className="text-xs font-medium text-primary hover:underline">
                          {quickCreate ? "Never mind — pick an existing customer" : "+ New customer"}
                        </button>
                      </div>
                    </Field>
                    <Field label="Start date" name="start_date" required hint="Defaults to today">
                      <Input name="start_date" type="date" defaultValue={today()} />
                    </Field>
                    <Field label="Site" name="location_id"
                           hint={customerLocations.length === 1
                             ? "Their only site — selected for you"
                             : "Leave blank to cover every site"}>
                      <select
                        id="location_id" name="location_id" value={effectiveLocationId}
                        onChange={(event) => setLocationId(event.target.value)}
                        className="rounded-lg w-full border border-strong bg-surface-muted px-2.5 py-1.5 text-sm"
                      >
                        <option value="">All sites</option>
                        {customerLocations.map((location) => (
                          <option key={location.id} value={location.id}>{location.name}</option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  {quickCreate ? (
                    <div className="rounded-lg space-y-3 border border-l-[5px] border-l-primary p-3">
                      <p className="text-sm font-medium">New customer — four fields is all it takes.</p>
                      <CustomerEssentials formId={QUICK_CREATE_FORM} />
                      <button type="submit" form={QUICK_CREATE_FORM}
                              className="rounded-lg bg-action px-3 py-1.5 text-sm font-medium text-action-foreground hover:brightness-110">
                        Create customer
                      </button>
                      <p className="text-xs text-muted-foreground">
                        You&rsquo;ll come straight back here with them selected.
                      </p>
                    </div>
                  ) : null}

                  <FormDisclosure summary="Billing details"
                                  hint="Pre-filled with the usual defaults — change only what you actually charge">
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      <Field label="Billing frequency" name="billing_frequency">
                        <Select name="billing_frequency" defaultValue="monthly" options={[
                          { value: "per_service", label: "Per service" },
                          { value: "weekly", label: "Weekly" },
                          { value: "fortnightly", label: "Fortnightly" },
                          { value: "monthly", label: "Monthly" },
                        ]} />
                      </Field>
                      <Field label="Payment terms (days)" name="payment_terms_days">
                        <Input name="payment_terms_days" type="number" min={0} defaultValue={14} />
                      </Field>
                      <Field label="Purchase order number" name="purchase_order_number"
                             hint="Only if their accounts team needs one">
                        <Input name="purchase_order_number" />
                      </Field>
                      <Field label="Public holiday rule" name="holiday_rule"
                             hint="What happens when a service day lands on a public holiday">
                        <Select name="holiday_rule" defaultValue="next_business_day"
                                options={HOLIDAY_RULES.map((value) => ({ value, label: HOLIDAY_RULE_LABELS[value] }))} />
                      </Field>
                      <Field label="Holiday region" name="holiday_region">
                        <Select name="holiday_region" options={REGIONS} defaultValue="NSW" />
                      </Field>
                      <Field label="Linen ownership" name="linen_ownership"
                             hint="Rental: you own the linen and hire it out">
                        <Select name="linen_ownership" defaultValue="rental" options={[
                          { value: "rental", label: "Rental (laundry owned)" },
                          { value: "customer_owned", label: "Customer owned" },
                          { value: "mixed", label: "Mixed" },
                        ]} />
                      </Field>
                      <Field label="End date" name="end_date" hint="Leave blank for an open-ended contract">
                        <Input name="end_date" type="date" />
                      </Field>
                      <Field label="Servicing site" name="depot_id" hint="Which of your sites runs their collections">
                        <Select name="depot_id" placeholder="Unassigned"
                                options={depots.map((depot) => ({ value: depot.id, label: depot.name }))} />
                      </Field>
                      <Field label="Collections per visit" name="collections_per_visit" hint="Usually 1">
                        <Input name="collections_per_visit" type="number" min={1} defaultValue={1} />
                      </Field>
                    </div>
                    <div className="mt-4">
                      <Field label="Notes" name="notes">
                        <Textarea name="notes" rows={2} />
                      </Field>
                    </div>
                  </FormDisclosure>
                </div>
              </Stage>

              {/* ------------------------------------------------ step 2 --- */}
              <Stage index={2} label="Service days" done={step > 2}
                     detail={step > 2
                       ? describeDays(pickupDays, follows, deliveryDays)
                       : "Which days you collect, and when the clean linen comes back."}>
                <div hidden={step !== 2} className="space-y-4">
                  <Field label="We collect on…" name="pickup_weekdays" required>
                    <DayPicker name="pickup_weekdays" value={pickupDays} onChange={setPickupDays} />
                  </Field>

                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={follows}
                           onChange={(event) => setFollows(event.target.checked)}
                           className="mt-0.5 h-3.5 w-3.5 border border-strong accent-primary" />
                    <span>
                      …and deliver the clean linen on the next service day
                      <span className="block text-xs text-muted-foreground">
                        The usual arrangement: what&rsquo;s collected Monday comes back Thursday, and so on.
                        Untick only if deliveries run on different days.
                      </span>
                    </span>
                  </label>

                  {!follows ? (
                    <Field label="We deliver on…" name="delivery_weekdays" required>
                      <DayPicker name="delivery_weekdays" value={deliveryDays} onChange={setDeliveryDays} />
                    </Field>
                  ) : null}

                  <p className="text-xs text-muted-foreground">
                    Fortnightly, monthly or irregular patterns can be set on the contract after it&rsquo;s created.
                  </p>
                </div>
              </Stage>

              {/* ------------------------------------------------ step 3 --- */}
              <Stage index={3} label="What and price" done={false}
                     detail="The items on the run and what each costs.">
                <div hidden={step !== 3} className="space-y-4">
                  {items.length === 0 ? (
                    <Notice tone="warning">
                      No items are set up yet. The contract can still be created — add items later and
                      price them on the contract page.
                    </Notice>
                  ) : (
                    <>
                      <div className="overflow-x-auto border">
                        <table className="w-full text-sm">
                          <thead className="bg-surface-muted text-left">
                            <tr>
                              {["Item", "Qty per visit", "Unit price",
                                ...(advanced ? ["Priced", "Included free"] : []), ""].map((header) => (
                                <th key={header || "x"}
                                    className="px-2.5 py-1.5 text-3xs font-normal text-muted-foreground">
                                  {header}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((line) => (
                              <tr key={line.key} className="border-t">
                                <td className="px-2.5 py-1.5">
                                  <select
                                    value={line.itemId} aria-label="Item"
                                    onChange={(event) => {
                                      const item = items.find((i) => i.id === event.target.value);
                                      patchLine(line.key, {
                                        itemId: event.target.value,
                                        unitPrice: item ? String(item.rental_price ?? 0) : line.unitPrice,
                                      });
                                    }}
                                    className="rounded-lg w-full min-w-[10rem] border border-strong bg-surface-muted px-2 py-1"
                                  >
                                    {items.map((item) => (
                                      <option key={item.id} value={item.id}>{item.name} ({item.sku})</option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-2.5 py-1.5">
                                  <input type="number" min={0} step="0.01" inputMode="decimal" placeholder="0"
                                         value={line.quantity} aria-label="Quantity per visit"
                                         onChange={(event) => patchLine(line.key, { quantity: event.target.value })}
                                         className="rounded-lg w-20 border border-strong bg-surface-muted px-2 py-1 text-right" />
                                </td>
                                <td className="px-2.5 py-1.5">
                                  <input type="number" min={0} step="0.01" inputMode="decimal"
                                         value={line.unitPrice} aria-label="Unit price"
                                         onChange={(event) => patchLine(line.key, { unitPrice: event.target.value })}
                                         className="rounded-lg w-20 border border-strong bg-surface-muted px-2 py-1 text-right" />
                                </td>
                                {advanced ? (
                                  <>
                                    <td className="px-2.5 py-1.5">
                                      <select
                                        value={line.pricingModel} aria-label="Pricing model"
                                        onChange={(event) => patchLine(line.key, {
                                          pricingModel: event.target.value as LineRow["pricingModel"],
                                        })}
                                        className="rounded-lg border border-strong bg-surface-muted px-2 py-1"
                                      >
                                        <option value="per_item">Per item</option>
                                        <option value="per_kg">Per kg</option>
                                        <option value="per_collection">Per collection</option>
                                        <option value="monthly">Monthly</option>
                                      </select>
                                    </td>
                                    <td className="px-2.5 py-1.5">
                                      <input type="number" min={0} step="0.01" inputMode="decimal"
                                             value={line.includedQuantity} aria-label="Included free"
                                             onChange={(event) => patchLine(line.key, { includedQuantity: event.target.value })}
                                             className="rounded-lg w-20 border border-strong bg-surface-muted px-2 py-1 text-right" />
                                    </td>
                                  </>
                                ) : null}
                                <td className="px-2.5 py-1.5 text-right">
                                  <button type="button"
                                          onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                                          className="text-xs text-danger hover:underline">
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            ))}
                            {lines.length === 0 ? (
                              <tr className="border-t">
                                <td colSpan={advanced ? 6 : 4}
                                    className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                                  No items yet. Without any, billing falls back to each item&rsquo;s default price.
                                </td>
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        <button type="button" onClick={addLine}
                                className="rounded-lg border border-strong bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-muted">
                          + Add an item
                        </button>
                        <button type="button" onClick={() => setAdvanced((open) => !open)}
                                className="text-xs font-medium text-primary hover:underline">
                          {advanced ? "Hide advanced pricing" : "Advanced pricing (per-kg, included allowances)"}
                        </button>
                      </div>
                    </>
                  )}

                  {/* Hidden, not unmounted: the defaults still post when advanced pricing is never opened. */}
                  <div hidden={!advanced} className="grid gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Minimum charge" name="minimum_charge"
                           hint="Tops the period up when service falls short">
                      <Input name="minimum_charge" type="number" step="0.01" min={0} defaultValue={0} />
                    </Field>
                    <Field label="Fuel levy %" name="fuel_levy_pct" hint="Leave at 0 if you don't charge one">
                      <Input name="fuel_levy_pct" type="number" step="0.01" min={0} max={100} defaultValue={0} />
                    </Field>
                    <Field label="Weekend surcharge %" name="weekend_surcharge_pct">
                      <Input name="weekend_surcharge_pct" type="number" step="0.01" min={0} max={100} defaultValue={0} />
                    </Field>
                    <Field label="Holiday surcharge %" name="holiday_surcharge_pct">
                      <Input name="holiday_surcharge_pct" type="number" step="0.01" min={0} max={100} defaultValue={0} />
                    </Field>
                  </div>
                </div>
              </Stage>
            </ol>

            {problem ? <div className="mt-3"><Notice tone="danger">{problem}</Notice></div> : null}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
              {step > 1 ? (
                <button type="button" onClick={() => toStep(step - 1)}
                        className="rounded-lg border border-strong bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-muted">
                  Back
                </button>
              ) : null}
              {step < 3 ? (
                <button type="button" onClick={() => toStep(step + 1)}
                        className="rounded-lg bg-action px-3 py-1.5 text-sm font-medium text-action-foreground hover:brightness-110">
                  Next
                </button>
              ) : (
                <SubmitButton pendingLabel="Creating…">Create contract</SubmitButton>
              )}
              <ButtonLink href="/agreements">Cancel</ButtonLink>
            </div>
          </Card>

          <PlainEnglishSummary
            customerName={customerName}
            pickupDays={pickupDays}
            follows={follows}
            deliveryDays={deliveryDays}
            lines={lines}
            items={items}
          />
        </div>
      </form>
    </>
  );
}

/** Controlled weekday checkboxes that double as the posted form fields. */
function DayPicker({
  name, value, onChange,
}: { name: string; value: number[]; onChange: (next: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAY_LABELS.map((label, index) => {
        const day = index + 1;
        const active = value.includes(day);
        return (
          <label key={day} className={cx(
            "rounded-lg cursor-pointer border px-3 py-1.5 text-sm",
            active ? "border-primary bg-primary/10 font-medium text-primary" : "border-border",
          )}>
            <input
              type="checkbox" name={name} value={day} checked={active}
              onChange={() => onChange(
                active ? value.filter((d) => d !== day) : [...value, day].sort((a, b) => a - b),
              )}
              className="sr-only"
            />
            {label}
          </label>
        );
      })}
    </div>
  );
}

function describeDays(pickupDays: number[], follows: boolean, deliveryDays: number[]): string {
  if (pickupDays.length === 0) return "Which days you collect and deliver.";
  const collect = `Collect ${joinDays(pickupDays)}`;
  return follows
    ? `${collect} — clean linen back the next service day`
    : `${collect} · deliver ${joinDays(deliveryDays)}`;
}

function joinDays(days: number[]): string {
  const labels = days.map((day) => WEEKDAY_LABELS[day - 1]).filter(Boolean);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} & ${labels[labels.length - 1]}`;
}

/**
 * The live summary (P-3): says back, in plain English, only what the entered
 * numbers can stand behind — per-kg lines are billed by what is actually
 * weighed, so they get a sentence, not an invented figure.
 */
function PlainEnglishSummary({
  customerName, pickupDays, follows, deliveryDays, lines, items,
}: {
  customerName?: string;
  pickupDays: number[];
  follows: boolean;
  deliveryDays: number[];
  lines: LineRow[];
  items: WizardItem[];
}) {
  const itemName = (id: string) => items.find((item) => item.id === id)?.name ?? "item";

  const perItem = lines.filter((line) => line.itemId && line.pricingModel === "per_item");
  const perKg = lines.filter((line) => line.itemId && line.pricingModel === "per_kg");
  const monthly = lines.filter((line) => line.itemId && line.pricingModel === "monthly");

  const perVisit = perItem.reduce(
    (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0), 0);
  const totalQty = perItem.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const weekly = perVisit * pickupDays.length;
  const monthlyTotal = monthly.reduce((sum, line) => sum + (Number(line.unitPrice) || 0), 0);

  const sentences: string[] = [];
  if (pickupDays.length > 0) {
    sentences.push(totalQty > 0
      ? `Every ${joinDays(pickupDays)} we collect ~${formatQty(totalQty)} item(s)${headline(perItem, itemName)}.`
      : `We collect every ${joinDays(pickupDays)}.`);
    sentences.push(follows
      ? "Clean linen goes back on the next service day."
      : deliveryDays.length > 0
        ? `Deliveries run ${joinDays(deliveryDays)}.`
        : "Delivery days still to pick.");
  } else {
    sentences.push("Pick the collection days to see the week take shape.");
  }
  if (weekly > 0) sentences.push(`You bill about ${money(weekly)}/week + GST.`);
  if (monthlyTotal > 0) sentences.push(`Plus ${money(monthlyTotal)}/month in fixed charges.`);
  for (const line of perKg) {
    const rate = Number(line.unitPrice) || 0;
    if (rate > 0) sentences.push(`${itemName(line.itemId)} is billed at ${money(rate)}/kg on the weight actually collected.`);
  }

  return (
    <Card title="The contract so far"
          description={customerName ?? "In plain English, as you build it."}>
      <ul className="space-y-2 text-sm">
        {sentences.map((sentence) => (
          <li key={sentence} className="border-l-[3px] border-l-primary/40 pl-2.5">{sentence}</li>
        ))}
      </ul>
    </Card>
  );
}

function headline(
  perItem: LineRow[], itemName: (id: string) => string,
): string {
  const biggest = [...perItem]
    .filter((line) => (Number(line.quantity) || 0) > 0)
    .sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0))[0];
  if (!biggest) return "";
  return `, mostly ${itemName(biggest.itemId).toLowerCase()}`;
}

function formatQty(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
