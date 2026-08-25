import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { money, number } from "@/lib/format";
import type { Item } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls } from "@/components/list-controls";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "@/lib/domain/laundry-orders";
import { ITEM_CATEGORIES } from "./categories";
import { createItem } from "./actions";
import { accountOptionLabel, listIncomeAccounts } from "@/lib/accounts";

export const metadata = { title: "Items" };
export const dynamic = "force-dynamic";

type Search = { q?: string; category?: string; error?: string; ok?: string };

export default async function ItemsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("items.read");
  const writable = can(session.role, "items.write");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Items"
        description="Every item you handle, under the code your books already use. Prices here apply unless a customer’s contract sets its own."
      />
      <ListControls
        action="/items"
        q={params.q}
        filters={[{
          name: "category", label: "Category", value: params.category,
          options: ITEM_CATEGORIES.map((value) => ({ value, label: humanise(value) })),
        }]}
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={6} />}>
        <ItemList params={params} />
      </Suspense>

      {writable ? <NewItemForm tenantId={session.tenantId} /> : null}
    </div>
  );
}

async function ItemList({ params }: { params: Search }) {
  const supabase = await createClient();
  let query = supabase
    .from("items")
    .select("id, sku, item_code, name, description, category, laundry_category, " +
            "ownership_type, is_sell, is_buy, sell_price, cost_price, tax_code, " +
            "replacement_cost, rental_price, wash_only_price, weight_kg, reorder_level, " +
            "myob_item_id, myob_item_code, external_synced_at, status")
    .is("deleted_at", null)
    // By code, because that is what the list is scanned by. Staff look for
    // TOW001 and read down; alphabetical by name puts the towels in three places.
    .order("item_code", { nullsFirst: false })
    .order("name");

  if (params.category) query = query.eq("category", params.category);
  if (params.q) {
    const term = `%${params.q}%`;
    // The code first, because typing `TOW` is how staff search.
    query = query.or(`item_code.ilike.${term},name.ilike.${term},sku.ilike.${term}`);
  }

  const { data } = await query.returns<Item[]>();

  return (
    <DataTable
      rows={data ?? []}
      rowHref={(row) => `/items/${row.id}`}
      empty={<EmptyState title="No items yet" description="Add the linen types you handle to start pricing agreements." />}
      columns={[
        {
          // The code leads the row for the same reason it leads every label:
          // two items can be called "Bath Towel" and only one is TOW001.
          header: "Code",
          cell: (row) => (
            <span className="font-mono text-sm font-medium">{row.item_code ?? "—"}</span>
          ),
        },
        { header: "Item", cell: (row) => row.name },
        { header: "Kind of laundry", hideBelow: "lg",
          cell: (row) => (row.laundry_category ? humanise(row.laundry_category) : "—") },
        {
          header: "Sell / Buy", hideBelow: "md",
          // MYOB's own two flags, shown as words rather than ticks so the column
          // reads without a legend.
          cell: (row) => [row.is_sell ? "Sell" : null, row.is_buy ? "Buy" : null]
            .filter(Boolean).join(" · ") || "—",
        },
        { header: "Sell price", cell: (row) => money(row.sell_price), align: "right" },
        { header: "Cost", cell: (row) => money(row.cost_price), align: "right", hideBelow: "sm" },
        { header: "Rental", cell: (row) => money(row.rental_price), align: "right", hideBelow: "lg" },
        { header: "Weight", cell: (row) => `${number(row.weight_kg)} kg`, align: "right", hideBelow: "lg" },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
      ]}
    />
  );
}

const LAUNDRY_CATEGORY_OPTIONS = ITEM_TYPES.map((value) => ({
  value, label: ITEM_TYPE_LABELS[value],
}));

/**
 * Loads its own accounts rather than being handed them, so the page above stays
 * one read for a role that cannot see this form at all.
 */
async function NewItemForm({ tenantId }: { tenantId: string }) {
  const accounts = await listIncomeAccounts(await createClient(), tenantId);
  return (
    <Card
      title="Add an item"
      description="Use the same code as your books. It has to be unique, and it is what staff will type."
    >
      <form action={createItem} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Item code" name="item_code" required
               hint="What staff type — TOW001. No spaces.">
          <Input name="item_code" required placeholder="TOW001" />
        </Field>
        <Field label="Name" name="name" required>
          <Input name="name" required placeholder="Bath Towel — White" />
        </Field>
        <Field label="Description" name="description" className="sm:col-span-2">
          <Input name="description" placeholder="Bath Towel — Commercial, white" />
        </Field>
        <Field label="SKU" name="sku" required hint="The stock code, if it differs from the item code.">
          <Input name="sku" required placeholder="BT-WHT-01" />
        </Field>
        <Field label="Kind of laundry" name="laundry_category"
               hint="What this counts as when a customer hands it in. Leave blank for rental linen only.">
          <Select name="laundry_category" placeholder="Not laundry a customer hands in"
                  options={LAUNDRY_CATEGORY_OPTIONS} />
        </Field>
        <Field label="I sell this" name="is_sell">
          <Select name="is_sell" defaultValue="true"
                  options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
        </Field>
        <Field label="I buy this" name="is_buy">
          <Select name="is_buy" defaultValue="false"
                  options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
        </Field>
        <Field label="Sell price" name="sell_price">
          <Input name="sell_price" type="number" step="0.01" min={0} defaultValue="0" />
        </Field>
        <Field label="Cost price" name="cost_price">
          <Input name="cost_price" type="number" step="0.01" min={0} defaultValue="0" />
        </Field>
        <Field label="Tax code" name="tax_code" hint="As it is in your books — GST, FRE.">
          <Input name="tax_code" placeholder="GST" />
        </Field>
        <Field label="Income account" name="income_account_id"
               hint="Where an invoice line for this item is coded. Used when the invoice goes to Xero.">
          <Select name="income_account_id" placeholder="Not coded"
                  options={accounts.map((a) => ({ value: a.id, label: accountOptionLabel(a) }))} />
        </Field>
        <Field label="Xero item code" name="xero_item_code"
               hint="This item's code in Xero, if it has one. Blank means no ItemCode is sent.">
          <Input name="xero_item_code" placeholder="TOW001" />
        </Field>
        <Field label="MYOB item ID" name="myob_item_id"
               hint="Optional. Filled in by an import; kept so the two systems can be reconciled.">
          <Input name="myob_item_id" />
        </Field>
        <Field label="Category" name="category">
          <Select name="category" defaultValue="bath_towel"
                  options={ITEM_CATEGORIES.map((value) => ({ value, label: humanise(value) }))} />
        </Field>
        <Field label="Ownership" name="ownership_type">
          <Select name="ownership_type" defaultValue="laundry_owned" options={[
            { value: "laundry_owned", label: "Laundry owned" },
            { value: "customer_owned", label: "Customer owned" },
            { value: "either", label: "Either" },
          ]} />
        </Field>
        <Field label="Rental price" name="rental_price">
          <Input name="rental_price" type="number" step="0.01" min={0} defaultValue="0" />
        </Field>
        <Field label="Wash-only price" name="wash_only_price">
          <Input name="wash_only_price" type="number" step="0.01" min={0} defaultValue="0" />
        </Field>
        <Field label="Replacement cost" name="replacement_cost">
          <Input name="replacement_cost" type="number" step="0.01" min={0} defaultValue="0" />
        </Field>
        <Field label="Weight (kg)" name="weight_kg">
          <Input name="weight_kg" type="number" step="0.001" min={0} defaultValue="0" />
        </Field>
        <Field label="Reorder level" name="reorder_level" hint="Alert when depot stock falls below this">
          <Input name="reorder_level" type="number" min={0} defaultValue="0" />
        </Field>
        <Field label="Status" name="status">
          <Select name="status" defaultValue="active"
                  options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
        </Field>
        <div className="flex items-end lg:col-span-2">
          <SubmitButton>Add item</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
