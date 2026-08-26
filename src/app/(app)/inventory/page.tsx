import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { dateTime, number } from "@/lib/format";
import type { Depot, Item } from "@/lib/db/types";
import {
  Badge, Card, DataTable, EmptyState, PageHeader, SkeletonRows,
  SkeletonStats, Stat, humanise,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls } from "@/components/list-controls";
import { FilterSummary, PeriodFilter, ToggleChips } from "@/components/filters";
import { isFiltered, parseMulti } from "@/lib/filters";
import { ACTIVITY_PERIOD_PRESETS, resolvePeriod } from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";
import { CIRCULATING_STATES, INVENTORY_STATES, MOVEMENT_REASONS } from "./states";
import { moveStock } from "./actions";

export const metadata = { title: "Stock" };
export const dynamic = "force-dynamic";

/**
 * Two lists on one screen, so two filters — and deliberately **one** search box.
 *
 * `state` narrows the holdings table (where is my linen?) and `q`/`reason`/
 * `period` narrow the movement history (what happened to it?). The holdings
 * table gets chips and no box of its own: two search fields on one page, both
 * spelled `q`, would be one value with two controls disagreeing about it — and
 * the second would have carried a duplicate DOM id, so its label would point at
 * the first.
 */
type Search = {
  q?: string; state?: string; reason?: string; period?: string; from?: string; to?: string;
};
const STOCK_KEYS = ["state"] as const;
const MOVEMENT_KEYS = ["q", "reason", "period", "from", "to"] as const;

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("inventory.read");
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock"
        description="How much of each item you have, where it is, and every movement that put it there."
      />

      <Suspense key={`stock:${JSON.stringify(params)}`} fallback={<SkeletonStats />}>
        <Position params={params} />
      </Suspense>

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Replenishment />
      </Suspense>

      <Suspense key={`moves:${JSON.stringify(params)}`} fallback={<SkeletonRows rows={6} />}>
        <Movements params={params} />
      </Suspense>

      {can(session.role, "inventory.write") ? (
        <Suspense fallback={null}>
          <MoveForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function Position({ params }: { params: Search }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("inventory_pools")
    .select("state, owner_type, quantity, items(name, sku)")
    .neq("quantity", 0)
    .returns<Array<{ state: string; owner_type: string; quantity: number; items: { name: string; sku: string } | null }>>();

  const rows = data ?? [];
  const byState = new Map<string, number>();
  for (const row of rows) byState.set(row.state, (byState.get(row.state) ?? 0) + row.quantity);

  const circulating = CIRCULATING_STATES.reduce((total, state) => total + (byState.get(state) ?? 0), 0);
  const atCustomer = byState.get("at_customer") ?? 0;
  const inTransit = byState.get("in_transit") ?? 0;
  const lost = (byState.get("lost") ?? 0) + (byState.get("written_off") ?? 0);

  // One row per item + state, largest holdings first.
  const detail = new Map<string, { item: string; state: string; owner: string; quantity: number }>();
  for (const row of rows) {
    const key = `${row.items?.sku ?? "?"}|${row.state}|${row.owner_type}`;
    const existing = detail.get(key);
    detail.set(key, {
      item: row.items ? `${row.items.name} (${row.items.sku})` : "Unknown item",
      state: row.state,
      owner: row.owner_type,
      quantity: (existing?.quantity ?? 0) + row.quantity,
    });
  }

  const allDetail = [...detail.values()].sort((a, b) => b.quantity - a.quantity);

  // The tiles are deliberately computed above from every pool, filtered or not:
  // "in circulation" is a fact about the laundry, not about what is on screen.
  const states = parseMulti(params.state, INVENTORY_STATES);
  const detailRows = states.length
    ? allDetail.filter((row) => states.includes(row.state))
    : allDetail;
  const stockFiltered = isFiltered(params, STOCK_KEYS);
  const stateCount = (state: string) => allDetail.filter((row) => row.state === state).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="In circulation" value={number(circulating)} hint="Everything we still expect back" />
        <Stat label="At customers" value={number(atCustomer)} />
        <Stat label="In transit" value={number(inTransit)} />
        <Stat label="Lost / written off" value={number(lost)} tone={lost > 0 ? "warning" : "default"} />
      </div>

      <Card title="Stock by item and state">
        <div className="mb-4 flex flex-col gap-3">
          <ToggleChips
            basePath="/inventory" params={params} name="state" label="Where the stock is"
            allLabel="Everywhere" allCount={allDetail.length}
            options={INVENTORY_STATES
              // Twelve states, and a laundry is usually only using five. A chip
              // for a state holding nothing promises rows it cannot show.
              .filter((state) => stateCount(state) > 0)
              .map((state) => ({
                value: state, label: humanise(state), count: stateCount(state),
              }))}
          />
          <FilterSummary basePath="/inventory" shown={detailRows.length} total={allDetail.length}
                         noun="holding" filtered={stockFiltered} />
        </div>
        <DataTable
          rows={detailRows}
          empty={stockFiltered
            ? <EmptyState title="No stock matches those filters"
                          description="Try another state, or clear the filters above." />
            : <EmptyState title="No stock recorded yet"
                             description="Record a purchase movement to bring stock into the system." />}
          columns={[
            { header: "Item", cell: (row) => row.item },
            { header: "State", cell: (row) => humanise(row.state) },
            { header: "Owner", cell: (row) => humanise(row.owner), hideBelow: "sm" },
            { header: "Quantity", cell: (row) => number(row.quantity), align: "right" },
          ]}
        />
      </Card>
    </div>
  );
}

async function Replenishment() {
  const supabase = await createClient();
  const [{ data: items }, { data: pools }] = await Promise.all([
    supabase.from("items").select("id, name, sku, reorder_level")
      .eq("status", "active").is("deleted_at", null).gt("reorder_level", 0)
      .returns<Pick<Item, "id" | "name" | "sku" | "reorder_level">[]>(),
    supabase.from("inventory_pools").select("item_id, state, quantity")
      .in("state", ["at_depot", "ready_for_dispatch"]),
  ]);

  const available = new Map<string, number>();
  for (const pool of pools ?? []) {
    available.set(pool.item_id, (available.get(pool.item_id) ?? 0) + pool.quantity);
  }

  const low = (items ?? [])
    .map((item) => ({ ...item, onHand: available.get(item.id) ?? 0 }))
    .filter((item) => item.onHand < item.reorder_level)
    .sort((a, b) => a.onHand - b.onHand);

  return (
    <Card title="Replenishment alerts"
          description="Depot stock below the item's reorder level.">
      <DataTable
        rows={low}
        rowHref={(row) => `/items/${row.id}`}
        empty={<EmptyState title="Nothing needs replenishing"
                           description="Every item with a reorder level has enough depot stock." />}
        columns={[
          { header: "Item", cell: (row) => `${row.name} (${row.sku})` },
          { header: "At depot", cell: (row) => number(row.onHand), align: "right" },
          { header: "Reorder level", cell: (row) => number(row.reorder_level), align: "right", hideBelow: "sm" },
          {
            header: "Shortfall",
            cell: (row) => <Badge tone="warning">{number(row.reorder_level - row.onHand)} short</Badge>,
            align: "right",
          },
        ]}
      />
    </Card>
  );
}

async function Movements({ params }: { params: Search }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("inventory_movements")
    .select("id, quantity, from_state, to_state, reason, notes, occurred_at, items(name, sku)")
    .order("occurred_at", { ascending: false })
    .limit(50)
    .returns<Array<{
      id: string; quantity: number; from_state: string | null; to_state: string | null;
      reason: string; notes: string | null; occurred_at: string;
      items: { name: string; sku: string } | null;
    }>>();

  const all = data ?? [];
  const period = resolvePeriod(params, businessToday(), "all");
  const reasons = parseMulti(params.reason, MOVEMENT_REASONS);
  const term = params.q?.trim().toLowerCase();
  const rows = all.filter((row) => {
    if (term && !`${row.items?.name ?? ""} ${row.items?.sku ?? ""}`.toLowerCase().includes(term)) {
      return false;
    }
    if (reasons.length && !reasons.includes(row.reason)) return false;
    if (period.range) {
      const day = row.occurred_at.slice(0, 10);
      if (day < period.range.start || day > period.range.end) return false;
    }
    return true;
  });
  const filtered = isFiltered(params, MOVEMENT_KEYS);
  const reasonCount = (reason: string) => all.filter((row) => row.reason === reason).length;

  return (
    <Card title="Recent movements" description="Every state change, newest first.">
      <ListControls
        action="/inventory"
        q={params.q}
        params={params}
        filterKeys={MOVEMENT_KEYS}
        placeholder="Item name or code…"
        chips={
          <>
            <ToggleChips
              basePath="/inventory" params={params} name="reason" label="Why it moved"
              allLabel="Every reason" allCount={all.length}
              options={MOVEMENT_REASONS
                .filter((reason) => reasonCount(reason) > 0)
                .map((reason) => ({
                  value: reason, label: humanise(reason), count: reasonCount(reason),
                }))}
            />
            <PeriodFilter
              basePath="/inventory" params={params} period={period}
              presets={ACTIVITY_PERIOD_PRESETS} today={businessToday()} label="Moved in"
              hideCustomWhenPreset
            />
          </>
        }
        summary={
          <FilterSummary basePath="/inventory" shown={rows.length} total={all.length}
                         noun="movement" filtered={filtered} />
        }
      />
      <DataTable
        rows={rows}
        empty={filtered
          ? <EmptyState title="No movements match those filters"
                        description="Try another reason or a wider period, or clear the filters above." />
          : <EmptyState title="No movements recorded yet" />}
        columns={[
          { header: "When", cell: (row) => dateTime(row.occurred_at) },
          { header: "Item", cell: (row) => row.items?.name ?? "Unknown item" },
          { header: "Quantity", cell: (row) => number(row.quantity), align: "right" },
          {
            header: "Movement",
            cell: (row) => `${humanise(row.from_state) === "—" ? "New" : humanise(row.from_state)} → ${
              humanise(row.to_state) === "—" ? "Written off" : humanise(row.to_state)}`,
            hideBelow: "sm",
          },
          { header: "Reason", cell: (row) => humanise(row.reason), hideBelow: "md" },
        ]}
      />
    </Card>
  );
}

async function MoveForm() {
  const supabase = await createClient();
  const [{ data: items }, { data: depots }] = await Promise.all([
    supabase.from("items").select("id, name, sku")
      .eq("status", "active").is("deleted_at", null).order("name")
      .returns<Pick<Item, "id" | "name" | "sku">[]>(),
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
  ]);

  const stateOptions = INVENTORY_STATES.map((value) => ({ value, label: humanise(value) }));

  return (
    <Card title="Adjust stock"
          description="Leave the source blank to bring new stock in; leave the destination blank to write stock off.">
      <form action={moveStock} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Item" name="item_id" required>
          <Select name="item_id" required placeholder="Choose an item"
                  options={(items ?? []).map((item) => ({ value: item.id, label: `${item.name} (${item.sku})` }))} />
        </Field>
        <Field label="Quantity" name="quantity" required>
          <Input name="quantity" type="number" min={1} required defaultValue="1" inputMode="numeric" />
        </Field>
        <Field label="Owner" name="owner_type">
          <Select name="owner_type" defaultValue="laundry_owned" options={[
            { value: "laundry_owned", label: "Laundry owned" },
            { value: "customer_owned", label: "Customer owned" },
          ]} />
        </Field>
        <Field label="Reason" name="reason">
          <Select name="reason" defaultValue="manual"
                  options={MOVEMENT_REASONS.map((value) => ({ value, label: humanise(value) }))} />
        </Field>
        <Field label="From state" name="from_state">
          <Select name="from_state" placeholder="New stock" options={stateOptions} />
        </Field>
        <Field label="To state" name="to_state">
          <Select name="to_state" placeholder="Write off" options={stateOptions} defaultValue="at_depot" />
        </Field>
        <Field label="From depot" name="from_depot">
          <Select name="from_depot" placeholder="—"
                  options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
        </Field>
        <Field label="To depot" name="to_depot">
          <Select name="to_depot" placeholder="—"
                  options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
        </Field>
        <Field label="Notes" name="notes" className="sm:col-span-2">
          <Input name="notes" placeholder="Annual stock count adjustment" />
        </Field>
        <div className="flex items-end lg:col-span-2">
          <SubmitButton>Record movement</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
