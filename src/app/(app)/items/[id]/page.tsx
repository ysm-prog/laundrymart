import { ConfirmSubmit } from "@/components/confirm-submit";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { number } from "@/lib/format";
import type { InventoryPool, Item } from "@/lib/db/types";
import {
  ButtonLink, Card, DataTable, EmptyState, PageHeader, humanise,
} from "@/components/ui";
import { Field, FormActions, Input, Select, SubmitButton } from "@/components/form";
import { ITEM_CATEGORIES } from "../categories";
import { archiveItem, updateItem } from "../actions";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "@/lib/domain/laundry-orders";
import { accountOptionLabel, listIncomeAccounts } from "@/lib/accounts";

export const dynamic = "force-dynamic";

export default async function ItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("items.read");
  const writable = can(session.role, "items.write");

  const supabase = await createClient();
  // The account list is only ever used by the edit form below, so it is read
  // alongside the item rather than in a second round trip. Empty for a role
  // that cannot see the chart, which cannot happen here — every `items.write`
  // holder also holds `purchases.read` (pinned in `roles.test.ts`).
  const [{ data: item }, { data: pools }, accounts] = await Promise.all([
    supabase.from("items")
      .select("id, sku, item_code, name, description, category, laundry_category, " +
              "ownership_type, is_sell, is_buy, sell_price, cost_price, tax_code, " +
              "income_account_id, xero_item_code, " +
              "replacement_cost, rental_price, wash_only_price, weight_kg, reorder_level, " +
              "myob_item_id, myob_item_code, external_synced_at, status")
      .eq("id", id).maybeSingle<Item>(),
    supabase.from("inventory_pools")
      .select("id, item_id, owner_type, state, customer_id, depot_id, vehicle_id, quantity, reorder_level")
      .eq("item_id", id).neq("quantity", 0).order("state")
      .returns<InventoryPool[]>(),
    listIncomeAccounts(supabase, session.tenantId),
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
          <form action={updateItem}>
            <Card title="Details">
              <input type="hidden" name="id" value={item.id} />
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
                <Field label="Kind of laundry" name="laundry_category"
                       hint="What this counts as when a customer hands it in.">
                  <Select name="laundry_category" defaultValue={item.laundry_category ?? ""}
                          placeholder="Not laundry a customer hands in"
                          options={ITEM_TYPES.map((value) => ({
                            value, label: ITEM_TYPE_LABELS[value],
                          }))} />
                </Field>
                <Field label="I sell this" name="is_sell">
                  <Select name="is_sell" defaultValue={String(item.is_sell)}
                          options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                </Field>
                <Field label="I buy this" name="is_buy">
                  <Select name="is_buy" defaultValue={String(item.is_buy)}
                          options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                </Field>
                <Field label="Sell price" name="sell_price">
                  <Input name="sell_price" type="number" step="0.01" min={0}
                         defaultValue={item.sell_price} />
                </Field>
                <Field label="Cost price" name="cost_price">
                  <Input name="cost_price" type="number" step="0.01" min={0}
                         defaultValue={item.cost_price} />
                </Field>
                <Field label="Tax code" name="tax_code">
                  <Input name="tax_code" defaultValue={item.tax_code ?? ""} />
                </Field>
                <Field label="Income account" name="income_account_id"
                       hint="Where an invoice line for this item is coded. Used when the invoice goes to Xero.">
                  <Select name="income_account_id" placeholder="Not coded"
                          defaultValue={item.income_account_id ?? ""}
                          options={accounts.map((a) => ({
                            value: a.id, label: accountOptionLabel(a),
                          }))} />
                </Field>
                <Field label="Xero item code" name="xero_item_code"
                       hint="This item's code in Xero, if it has one. Blank means no ItemCode is sent — nothing is guessed, because Xero refuses an invoice naming a code it does not have.">
                  <Input name="xero_item_code" defaultValue={item.xero_item_code ?? ""} />
                </Field>
                <Field label="MYOB item ID" name="myob_item_id"
                       hint={item.external_synced_at
                         ? `Last synchronised ${item.external_synced_at.slice(0, 10)}.`
                         : "Not synchronised with an external ledger yet."}>
                  <Input name="myob_item_id" defaultValue={item.myob_item_id ?? ""} />
                </Field>
                <Field label="Category" name="category">
                  <Select name="category" defaultValue={item.category}
                          options={ITEM_CATEGORIES.map((value) => ({ value, label: humanise(value) }))} />
                </Field>
                <Field label="Ownership" name="ownership_type">
                  <Select name="ownership_type" defaultValue={item.ownership_type} options={[
                    { value: "laundry_owned", label: "Laundry owned" },
                    { value: "customer_owned", label: "Customer owned" },
                    { value: "either", label: "Either" },
                  ]} />
                </Field>
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
                <Field label="Reorder level" name="reorder_level">
                  <Input name="reorder_level" type="number" min={0} defaultValue={item.reorder_level} />
                </Field>
                <Field label="Status" name="status">
                  <Select name="status" defaultValue={item.status}
                          options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
                </Field>
              </div>
              <div className="mt-4">
                <FormActions>
                  <SubmitButton>Save changes</SubmitButton>
                </FormActions>
              </div>
            </Card>
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
