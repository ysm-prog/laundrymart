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
import { ITEM_CATEGORIES } from "./categories";
import { createItem } from "./actions";

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
        description="Linen types you rent, wash and replace. Prices here are the default when an agreement does not override them."
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

      {writable ? <NewItemForm /> : null}
    </div>
  );
}

async function ItemList({ params }: { params: Search }) {
  const supabase = await createClient();
  let query = supabase
    .from("items")
    .select("id, sku, name, category, ownership_type, replacement_cost, rental_price, wash_only_price, weight_kg, reorder_level, status")
    .is("deleted_at", null)
    .order("name");

  if (params.category) query = query.eq("category", params.category);
  if (params.q) {
    const term = `%${params.q}%`;
    query = query.or(`name.ilike.${term},sku.ilike.${term}`);
  }

  const { data } = await query.returns<Item[]>();

  return (
    <DataTable
      rows={data ?? []}
      rowHref={(row) => `/items/${row.id}`}
      empty={<EmptyState title="No items yet" description="Add the linen types you handle to start pricing agreements." />}
      columns={[
        { header: "Item", cell: (row) => row.name },
        { header: "SKU", cell: (row) => row.sku, hideBelow: "sm" },
        { header: "Category", cell: (row) => humanise(row.category), hideBelow: "md" },
        { header: "Rental", cell: (row) => money(row.rental_price), align: "right" },
        { header: "Wash only", cell: (row) => money(row.wash_only_price), align: "right", hideBelow: "sm" },
        { header: "Replacement", cell: (row) => money(row.replacement_cost), align: "right", hideBelow: "lg" },
        { header: "Weight", cell: (row) => `${number(row.weight_kg)} kg`, align: "right", hideBelow: "lg" },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
      ]}
    />
  );
}

function NewItemForm() {
  return (
    <Card title="Add an item">
      <form action={createItem} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name" name="name" required>
          <Input name="name" required placeholder="Bath Towel — White" />
        </Field>
        <Field label="SKU" name="sku" required>
          <Input name="sku" required placeholder="BT-WHT-01" />
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
