import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { number } from "@/lib/format";
import type { InventoryPool, Item } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, PageHeader, humanise,
} from "@/components/ui";
import { Field, FormActions, Input, Select, SubmitButton } from "@/components/form";
import { ITEM_CATEGORIES } from "../categories";
import { archiveItem, updateItem } from "../actions";

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
  const [{ data: item }, { data: pools }] = await Promise.all([
    supabase.from("items")
      .select("id, sku, name, category, ownership_type, replacement_cost, rental_price, wash_only_price, weight_kg, reorder_level, status")
      .eq("id", id).maybeSingle<Item>(),
    supabase.from("inventory_pools")
      .select("id, item_id, owner_type, state, customer_id, depot_id, vehicle_id, quantity, reorder_level")
      .eq("item_id", id).neq("quantity", 0).order("state")
      .returns<InventoryPool[]>(),
  ]);

  if (!item) notFound();

  const onHand = (pools ?? []).reduce((total, pool) => total + pool.quantity, 0);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={item.name}
        description={`${item.sku} · ${humanise(item.category)} · ${number(onHand)} in circulation`}
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
                <Field label="Name" name="name" required>
                  <Input name="name" required defaultValue={item.name} />
                </Field>
                <Field label="SKU" name="sku" required>
                  <Input name="sku" required defaultValue={item.sku} />
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

          <Card title="Danger zone"
                description="Archiving is refused while the item is priced on an active service agreement.">
            <form action={archiveItem}>
              <input type="hidden" name="id" value={item.id} />
              <Button variant="danger">Archive item</Button>
            </form>
          </Card>
        </>
      ) : null}
    </div>
  );
}
