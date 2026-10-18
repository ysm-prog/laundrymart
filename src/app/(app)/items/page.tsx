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
import { FilterChips } from "@/components/filters";
import { IncomeAccountField } from "./income-account-field";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "@/lib/domain/laundry-orders";
import { PRICE_BASIS_OPTIONS, sellPriceLabel } from "@/lib/domain/items";
import { ITEM_CATEGORIES } from "./categories";
import { ITEM_COLUMNS } from "./columns";
import { createItem, setItemActive } from "./actions";
import { findDuplicateItems } from "@/lib/domain/item-duplicates";

export const metadata = { title: "Items" };
export const dynamic = "force-dynamic";

type Search = { q?: string; category?: string; status?: string; error?: string; ok?: string };

export default async function ItemsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("items.read");
  const writable = can(session.role, "items.write");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Items"
        description="Your master item list, under the codes your books use. Everything else in the app names an item from here — a job’s laundry, its charges, an invoice line and every report."
      />
      <ListControls
        action="/items"
        q={params.q}
        params={params}
        filterKeys={["q", "category", "status"]}
        placeholder="Item code, name or description…"
        chips={
          <>
            {/* Brief 3.5: inactive items are hidden from every picker; this is
                where they can still be found and brought back. */}
            <FilterChips
              basePath="/items" params={params} name="status" label="Status"
              allLabel="Any status"
              options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]}
            />
            <FilterChips
              basePath="/items" params={params} name="category" label="Item category"
              allLabel="All items"
              options={ITEM_CATEGORIES.map((value) => ({ value, label: humanise(value) }))}
            />
          </>
        }
      />

      <Suspense fallback={<SkeletonRows rows={2} />}>
        <Duplicates tenantId={session.tenantId} writable={writable} />
      </Suspense>

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={6} />}>
        <ItemList params={params} tenantId={session.tenantId} />
      </Suspense>

      {writable ? <NewItemForm tenantId={session.tenantId} /> : null}
    </div>
  );
}

/**
 * Possible duplicates (brief 3.5): two or more active items under one name.
 * Each can be made inactive here — soft, so every old job and invoice keeps it.
 */
async function Duplicates({ tenantId, writable }: { tenantId: string; writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase.from("items")
    .select("id, item_code, name, status, sell_price")
    .eq("tenant_id", tenantId).is("deleted_at", null)
    .returns<Array<{ id: string; item_code: string | null; name: string; status: string; sell_price: number | null }>>();
  const groups = findDuplicateItems(data ?? []);
  if (groups.length === 0) return null;

  return (
    <Card title="Possible duplicates"
          description={`${groups.length} name${groups.length === 1 ? " is" : "s are"} used by more than one active code. Keep the one you price on and make the others inactive — they stay on old jobs and invoices.`}>
      <ul className="space-y-4">
        {groups.slice(0, 12).map((group) => (
          <li key={group[0]!.id}>
            <p className="text-sm font-semibold">{group[0]!.name}</p>
            <ul className="mt-1 divide-y rounded-lg border">
              {group.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <a href={`/items/${item.id}`} className="font-mono font-medium text-primary hover:underline">
                      {item.item_code ?? "no code"}
                    </a>
                    <span className="text-muted-foreground"> · {money(item.sell_price)} · </span>
                    <StatusBadge status={item.status} />
                  </span>
                  {writable ? (
                    <form action={setItemActive}>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="status" value={item.status === "active" ? "inactive" : "active"} />
                      <SubmitButton size="md" variant="secondary" pendingLabel="Saving…">
                        {item.status === "active" ? "Make inactive" : "Make active"}
                      </SubmitButton>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  );
}

async function ItemList({ params, tenantId }: { params: Search; tenantId: string }) {
  const supabase = await createClient();
  let query = supabase
    .from("items")
    .select(ITEM_COLUMNS)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    // By code, because that is what the list is scanned by. Staff look for
    // TOW001 and read down; alphabetical by name puts the towels in three places.
    .order("item_code", { nullsFirst: false })
    .order("name");

  if (params.category) query = query.eq("category", params.category);
  if (params.status === "active" || params.status === "inactive") query = query.eq("status", params.status);
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
      empty={<EmptyState title="No items yet"
                         description="Add the items you handle, or import them from your accounting system. Everything else in the app names an item from this list." />}
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
        {
          // **The unit rides with the price.** A rate on its own is ambiguous the
          // moment a laundry sells anything by the box: $0.22 and $0.22 read
          // identically whether one is per towel and the other per hundred, and
          // the unit is the only thing on the row that tells them apart.
          header: "Sell price", align: "right",
          cell: (row) => sellPriceLabel(money(row.sell_price), row.selling_unit),
        },
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
        {/*
          The two selling fields that have to be answered *at creation time*,
          because they change what the price above means. Everything else 0044
          added is edited on the detail page — an add form asking twenty-odd
          questions is the wall of inputs `FormSection` exists to prevent, and
          none of the rest is needed before the item can be used.
        */}
        <Field label="Selling unit" name="selling_unit"
               hint="What the price is per — ea, doz, ctn. Shown beside the rate everywhere.">
          <Input name="selling_unit" placeholder="ea" />
        </Field>
        <Field label="Selling price is" name="sell_price_basis"
               hint="Whether the price above already contains GST.">
          <Select name="sell_price_basis" placeholder="Not stated"
                  options={PRICE_BASIS_OPTIONS} />
        </Field>
        <Field label="Cost price" name="cost_price">
          <Input name="cost_price" type="number" step="0.01" min={0} defaultValue="0" />
        </Field>
        <Field label="Tax code" name="tax_code" hint="As it is in your books — GST, FRE.">
          <Input name="tax_code" placeholder="GST" />
        </Field>
        <IncomeAccountField tenantId={tenantId} />
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
