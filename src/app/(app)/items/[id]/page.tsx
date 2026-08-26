import { ConfirmSubmit } from "@/components/confirm-submit";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { number } from "@/lib/format";
import { listIncomeAccounts } from "@/lib/accounts";
import type { InventoryPool, Item } from "@/lib/db/types";
import {
  ButtonLink, Card, DataTable, EmptyState, PageHeader, humanise,
} from "@/components/ui";
import { Field, FormActions, Input, Select, SubmitButton } from "@/components/form";
import { ITEM_CATEGORIES } from "../categories";
import { ITEM_COLUMNS } from "../columns";
import { archiveItem, updateItem } from "../actions";
import { IncomeAccountField } from "../income-account-field";
import { AccountField } from "../account-fields";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "@/lib/domain/laundry-orders";
import { PRICE_BASIS_OPTIONS } from "@/lib/domain/items";

export const dynamic = "force-dynamic";

/** The suppliers an item can be ordered from. Name and number, nothing more. */
type PickableSupplier = { id: string; supplier_number: string; name: string };

const YES_NO = [{ value: "true", label: "Yes" }, { value: "false", label: "No" }];

export default async function ItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("items.read");
  const writable = can(session.role, "items.write");

  const supabase = await createClient();
  // The account and supplier lists are only ever used by the edit form below, so
  // they are read alongside the item rather than in further round trips. Both are
  // empty for a role that cannot see them, which cannot happen here — every
  // `items.write` holder also holds `purchases.read` (pinned in `roles.test.ts`).
  //
  // Both name the tenant explicitly (§23): a platform admin's session reads every
  // laundry, and an id chosen from either list is posted into a write scoped to
  // one — so an unfiltered read here would offer another business's supplier and
  // the save would fail on the foreign key with nothing on screen explaining why.
  const [{ data: item }, { data: pools }, accounts, { data: suppliers }] = await Promise.all([
    supabase.from("items").select(ITEM_COLUMNS).eq("id", id).maybeSingle<Item>(),
    supabase.from("inventory_pools")
      .select("id, item_id, owner_type, state, customer_id, depot_id, vehicle_id, quantity, reorder_level")
      .eq("item_id", id).neq("quantity", 0).order("state")
      .returns<InventoryPool[]>(),
    listIncomeAccounts(supabase, session.tenantId),
    supabase.from("suppliers")
      .select("id, supplier_number, name")
      .eq("tenant_id", session.tenantId)
      .is("deleted_at", null).eq("status", "active")
      .order("name").limit(500)
      .returns<PickableSupplier[]>(),
  ]);

  if (!item) notFound();

  const onHand = (pools ?? []).reduce((total, pool) => total + pool.quantity, 0);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={item.name}
        description={`${item.item_code ?? item.sku} · ${humanise(item.category)} · ${number(onHand)} in circulation`}
        actions={<ButtonLink href="/items">Back to items</ButtonLink>}
      />

      <Card title="Stock position by state">
        <DataTable
          rows={pools ?? []}
          empty={<EmptyState title="No stock recorded for this item yet" />}
          columns={[
            { header: "State", cell: (row) => humanise(row.state) },
            { header: "Owner", cell: (row) => humanise(row.owner_type), hideBelow: "sm" },
            { header: "Quantity", cell: (row) => number(row.quantity), align: "right" },
          ]}
        />
      </Card>

      {writable ? (
        <>
          {/*
            **Four cards, one form, one Save.**

            This was a single Details card dropping twenty fields into one flat
            grid, and 0044 would have made it thirty-five — a wall of inputs with
            the buying tax code sitting three rows under the rental price for no
            reason anybody could state. The four groups are MYOB's own, in MYOB's
            order, so somebody holding the two screens side by side reads down
            both at once.

            Splitting the *cards* and not the *form* is the part that matters:
            four forms would be four saves, four chances to lose the other three
            cards' edits, and four toasts. One `<form>` wraps all four and posts
            once to `updateItem`, exactly as before.
          */}
          <form action={updateItem} className="space-y-6">
            <input type="hidden" name="id" value={item.id} />

            <Card title="Details"
                  description="What this item is, and what it is called.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Item code" name="item_code" required
                       hint="What staff type. No spaces, and unique in this laundry.">
                  <Input name="item_code" required defaultValue={item.item_code ?? ""} />
                </Field>
                <Field label="Name" name="name" required>
                  <Input name="name" required defaultValue={item.name} />
                </Field>
                <Field label="SKU" name="sku" required>
                  <Input name="sku" required defaultValue={item.sku} />
                </Field>
                <Field label="Description" name="description" className="sm:col-span-2">
                  <Input name="description" defaultValue={item.description ?? ""} />
                </Field>
                <Field label="Use this description on sales and purchases"
                       name="use_item_description"
                       hint="Print the description above on documents instead of the name."
                       className="sm:col-span-2">
                  <Select name="use_item_description"
                          defaultValue={String(item.use_item_description)} options={YES_NO} />
                </Field>
                <Field label="Category" name="category">
                  <Select name="category" defaultValue={item.category}
                          options={ITEM_CATEGORIES.map((value) => ({ value, label: humanise(value) }))} />
                </Field>
                <Field label="Kind of laundry" name="laundry_category"
                       hint="What this counts as when a customer hands it in.">
                  <Select name="laundry_category" defaultValue={item.laundry_category ?? ""}
                          placeholder="Not laundry a customer hands in"
                          options={ITEM_TYPES.map((value) => ({
                            value, label: ITEM_TYPE_LABELS[value],
                          }))} />
                </Field>
                <Field label="Ownership" name="ownership_type">
                  <Select name="ownership_type" defaultValue={item.ownership_type} options={[
                    { value: "laundry_owned", label: "Laundry owned" },
                    { value: "customer_owned", label: "Customer owned" },
                    { value: "either", label: "Either" },
                  ]} />
                </Field>
                <Field label="Status" name="status">
                  <Select name="status" defaultValue={item.status}
                          options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
                </Field>
              </div>
            </Card>

            <Card title="Selling"
                  description="What a customer is charged, and where that money lands.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="I sell this" name="is_sell"
                       hint="Turn this off and the item stops being offered on an invoice line or a job charge, without deleting the stock record.">
                  <Select name="is_sell" defaultValue={String(item.is_sell)} options={YES_NO} />
                </Field>
                <Field label="Sell price" name="sell_price">
                  <Input name="sell_price" type="number" step="0.01" min={0}
                         defaultValue={item.sell_price} />
                </Field>
                <Field label="Selling price is" name="sell_price_basis"
                       hint="Whether the price above already contains GST.">
                  <Select name="sell_price_basis" defaultValue={item.sell_price_basis ?? ""}
                          placeholder="Not stated" options={PRICE_BASIS_OPTIONS} />
                </Field>
                <Field label="Selling unit" name="selling_unit"
                       hint="What the price is per — ea, doz, ctn. Shown beside the rate everywhere.">
                  <Input name="selling_unit" defaultValue={item.selling_unit ?? ""} placeholder="ea" />
                </Field>
                <Field label="Items per selling unit" name="items_per_selling_unit"
                       hint="How many individual items one selling unit holds.">
                  <Input name="items_per_selling_unit" type="number" step="0.01" min={0}
                         defaultValue={item.items_per_selling_unit ?? ""} />
                </Field>
                <Field label="Tax code" name="tax_code"
                       hint="The selling code, as it is in your books — GST, FRE.">
                  <Input name="tax_code" defaultValue={item.tax_code ?? ""} />
                </Field>
                <IncomeAccountField tenantId={session.tenantId} accounts={accounts}
                                    defaultValue={item.income_account_id}
                                    defaultXeroItemCode={item.xero_item_code} />
                <AccountField
                  accounts={accounts} name="cost_of_sales_account_id" label="Cost of sales account"
                  hint="Where the cost of what was sold is booked. The other half of the income account above."
                  defaultValue={item.cost_of_sales_account_id}
                />
              </div>
            </Card>

            <Card title="Buying"
                  description="What this costs to buy, and where that cost lands.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="I buy this" name="is_buy">
                  <Select name="is_buy" defaultValue={String(item.is_buy)} options={YES_NO} />
                </Field>
                <Field label="Cost price" name="cost_price">
                  <Input name="cost_price" type="number" step="0.01" min={0}
                         defaultValue={item.cost_price} />
                </Field>
                <Field label="Buying price is" name="buy_price_basis"
                       hint="Whether the cost above already contains GST.">
                  <Select name="buy_price_basis" defaultValue={item.buy_price_basis ?? ""}
                          placeholder="Not stated" options={PRICE_BASIS_OPTIONS} />
                </Field>
                <Field label="Buying unit" name="buy_unit"
                       hint="What you order in — ctn, pallet. Often not the unit you sell in.">
                  <Input name="buy_unit" defaultValue={item.buy_unit ?? ""} placeholder="ctn" />
                </Field>
                <Field label="Items per buying unit" name="buy_units_per">
                  <Input name="buy_units_per" type="number" step="0.01" min={0}
                         defaultValue={item.buy_units_per ?? ""} />
                </Field>
                <Field label="Buying tax code" name="buy_tax_code"
                       hint="Separate from the selling code above — the two are genuinely different in MYOB.">
                  <Input name="buy_tax_code" defaultValue={item.buy_tax_code ?? ""} />
                </Field>
                <AccountField
                  accounts={accounts} name="expense_account_id" label="Expense account"
                  hint="Where a purchase of this lands when it is not stocked."
                  defaultValue={item.expense_account_id}
                />
                <Field label="Supplier item code" name="supplier_item_code"
                       hint="What the supplier calls it on their invoice, which is routinely not what you call it.">
                  <Input name="supplier_item_code" defaultValue={item.supplier_item_code ?? ""} />
                </Field>
              </div>
            </Card>

            <Card title="Restocking"
                  description="Whether this is counted, and what happens when it runs low.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="I track stock for this item" name="track_stock"
                       hint="Whether it is counted at all. Most consumables are not.">
                  <Select name="track_stock" defaultValue={String(item.track_stock)} options={YES_NO} />
                </Field>
                <AccountField
                  accounts={accounts} name="asset_account_id" label="Asset account"
                  hint="Where stock on hand sits on the balance sheet."
                  defaultValue={item.asset_account_id}
                />
                <Field
                  label="Primary supplier" name="primary_supplier_id"
                  hint={(suppliers ?? []).length === 0
                    // Said out loud rather than rendered as an empty select, the
                    // same call the account fields make: a picker with nothing in
                    // it and no explanation reads as a broken screen.
                    ? "No active suppliers on file yet."
                    : "Who this is ordered from."}
                >
                  <Select
                    name="primary_supplier_id" defaultValue={item.primary_supplier_id ?? ""}
                    placeholder={(suppliers ?? []).length === 0 ? "No suppliers available" : "Not set"}
                    options={(suppliers ?? []).map((supplier) => ({
                      value: supplier.id, label: `${supplier.supplier_number} — ${supplier.name}`,
                    }))}
                  />
                </Field>
                <Field label="Minimum stock level" name="reorder_level"
                       hint="Alert when depot stock falls below this — when to reorder.">
                  <Input name="reorder_level" type="number" min={0} defaultValue={item.reorder_level} />
                </Field>
                <Field label="Default reorder quantity" name="default_reorder_qty"
                       hint="How much to order, per buying unit. A different number from the level above.">
                  <Input name="default_reorder_qty" type="number" step="0.01" min={0}
                         defaultValue={item.default_reorder_qty} />
                </Field>
                <Field label="MYOB item ID" name="myob_item_id"
                       hint={item.external_synced_at
                         ? `Last synchronised ${item.external_synced_at.slice(0, 10)}.`
                         : "Not synchronised with an external ledger yet."}>
                  <Input name="myob_item_id" defaultValue={item.myob_item_id ?? ""} />
                </Field>
              </div>
            </Card>

            <Card title="Linen you rent out"
                  description="This laundry's own stock, which predates the item master and is not part of MYOB's item page.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Rental price" name="rental_price">
                  <Input name="rental_price" type="number" step="0.01" min={0} defaultValue={item.rental_price} />
                </Field>
                <Field label="Wash-only price" name="wash_only_price">
                  <Input name="wash_only_price" type="number" step="0.01" min={0} defaultValue={item.wash_only_price} />
                </Field>
                <Field label="Replacement cost" name="replacement_cost">
                  <Input name="replacement_cost" type="number" step="0.01" min={0} defaultValue={item.replacement_cost} />
                </Field>
                <Field label="Weight (kg)" name="weight_kg">
                  <Input name="weight_kg" type="number" step="0.001" min={0} defaultValue={item.weight_kg} />
                </Field>
              </div>
            </Card>

            {/*
              One Save for all five cards, outside them rather than inside the
              last one. `FormActions` sticks to the foot of the viewport on a
              phone (§10b), so it has to belong to the form and not to whichever
              card happens to be last — buried at the bottom of a five-card page
              it would be the one control somebody has to hunt for.
            */}
            <FormActions>
              <SubmitButton>Save changes</SubmitButton>
            </FormActions>
          </form>

          <Card title="Hide this item"
                description={"Use this when you no longer stock an item. It comes off your lists " +
                             "and nothing is deleted. If it is priced on a contract that is still " +
                             "running, the app will refuse and tell you which one."}>
            <form action={archiveItem}>
              <input type="hidden" name="id" value={item.id} />
              <ConfirmSubmit
                label="Hide this item"
                eyebrow="This can be undone"
                consequence={"It will stop appearing when you take laundry in or count stock. " +
                             "Nothing is deleted, and an administrator can put it back."}
              />
            </form>
          </Card>
        </>
      ) : null}
    </div>
  );
}
