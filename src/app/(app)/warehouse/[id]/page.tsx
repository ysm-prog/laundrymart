import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import type { Item } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, Notice,
  PageHeader, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import {
  BATCH_FLOW, BATCH_STAGE_LABELS, REJECT_DESTINATIONS, STAGE_ACTION_LABELS,
  isFlowStage, nextStage, type BatchStage,
} from "../stages";
import {
  addBatchLine, advanceBatch, cancelBatch, completeBatch, rejectFromBatch, removeBatchLine,
} from "../actions";

export const dynamic = "force-dynamic";

type BatchDetail = {
  id: string;
  batch_number: string;
  stage: BatchStage;
  machine: string | null;
  notes: string | null;
  cancel_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  depot_id: string | null;
  route_id: string | null;
  depots: { name: string } | null;
  daily_routes: { code: string } | null;
};

type LineRow = {
  id: string;
  item_id: string;
  owner_type: "laundry_owned" | "customer_owned";
  customer_id: string | null;
  quantity: number;
  driver_quantity: number | null;
  rejected_quantity: number;
  notes: string | null;
  items: { name: string; sku: string } | null;
  customers: { business_name: string } | null;
};

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("warehouse.read");
  const writable = can(session.role, "warehouse.write");

  const supabase = await createClient();
  const [{ data: batch }, { data: lines }] = await Promise.all([
    supabase
      .from("production_batches")
      .select("id, batch_number, stage, machine, notes, cancel_reason, started_at, " +
              "completed_at, created_at, depot_id, route_id, depots(name), daily_routes(code)")
      .eq("id", id)
      .maybeSingle<BatchDetail>(),
    supabase
      .from("production_batch_lines")
      .select("id, item_id, owner_type, customer_id, quantity, driver_quantity, " +
              "rejected_quantity, notes, items(name, sku), customers(business_name)")
      .eq("batch_id", id)
      .order("created_at")
      .returns<LineRow[]>(),
  ]);

  if (!batch) notFound();

  const rows = lines ?? [];
  const inFlow = isFlowStage(batch.stage);
  const target = inFlow ? nextStage(batch.stage) : null;
  const receiving = batch.stage === "received";
  const processing = rows.reduce((total, line) => total + line.quantity - line.rejected_quantity, 0);
  const rejected = rows.reduce((total, line) => total + line.rejected_quantity, 0);
  // Only lines counted off a run carry a driver figure, so a hand-built batch
  // shows no variance column rather than a column of dashes.
  const counted = rows.filter((line) => line.driver_quantity != null);
  const variance = counted.reduce(
    (total, line) => total + line.quantity - (line.driver_quantity ?? 0), 0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Batch ${batch.batch_number}`}
        description={[
          batch.daily_routes ? `Counted off run ${batch.daily_routes.code}` : null,
          batch.depots?.name ?? "No depot",
          batch.machine,
          `${processing} item(s) in the batch`,
        ].filter(Boolean).join(" · ")}
        actions={
          <>
            <StatusBadge status={batch.stage} />
            <ButtonLink href="/warehouse">All batches</ButtonLink>
          </>
        }
      />

      {batch.stage === "cancelled" ? (
        <Notice tone="warning" title="This batch was cancelled">
          {batch.cancel_reason ?? "No reason recorded."} Its linen went back to the depot.
        </Notice>
      ) : null}

      {batch.stage === "completed" ? (
        <Notice tone="success" title="Batch complete">
          Finished {dateTime(batch.completed_at)}. The linen is staged for dispatch.
        </Notice>
      ) : null}

      <Card title="Progress">
        <ol className="flex flex-wrap gap-2">
          {BATCH_FLOW.map((stage) => {
            const position = BATCH_FLOW.indexOf(stage);
            const current = BATCH_FLOW.indexOf(batch.stage as (typeof BATCH_FLOW)[number]);
            const done = inFlow ? position < current : batch.stage === "completed";
            const active = stage === batch.stage;
            return (
              <li
                key={stage}
                className={`border px-3 py-1 text-xs font-medium ${
                  active ? "border-primary text-primary"
                    : done ? "border-success/40 bg-success/10 text-success"
                    : "text-muted-foreground"}`}
              >
                {done && !active ? "✓ " : ""}{BATCH_STAGE_LABELS[stage]}
              </li>
            );
          })}
        </ol>

        {writable && inFlow ? (
          <div className="mt-4 space-y-3 border-t pt-4">
            <form action={target ? advanceBatch : completeBatch}>
              <input type="hidden" name="id" value={batch.id} />
              <Button variant="primary">
                {STAGE_ACTION_LABELS[isFlowStage(batch.stage) ? batch.stage : "received"]}
              </Button>
            </form>

            {/* Folded away: stopping a batch mid-wash is rare, and a red button
                sitting beside the one used every hour invites the wrong press. */}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Something went wrong with this batch
              </summary>
              <form action={cancelBatch} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="id" value={batch.id} />
                <Field label="What happened?" name="cancel_reason">
                  <Input name="cancel_reason" required placeholder="Machine breakdown" />
                </Field>
                <SubmitButton variant="danger">Stop this batch</SubmitButton>
              </form>
              <p className="mt-2 text-muted-foreground">
                The linen goes back to the depot shelf and can be counted into a new batch.
              </p>
            </details>
          </div>
        ) : null}

        {writable && receiving ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Fix the numbers now if they are wrong. Once washing starts they are locked, because
            every stock movement after that is worked out from them.
          </p>
        ) : null}
      </Card>

      <Card
        title="What's in this batch"
        description={[
          `${processing} item(s) going through`,
          rejected > 0 ? `${rejected} set aside` : null,
          counted.length > 0 && variance !== 0
            ? `${Math.abs(variance)} ${variance < 0 ? "short of" : "more than"} the driver's count`
            : null,
        ].filter(Boolean).join(" · ")}
      >
        <DataTable
          rows={rows}
          empty={<EmptyState
            title="Nothing on this batch yet"
            description="Add what is on the trolley before starting the wash."
          />}
          columns={[
            {
              header: "Item",
              cell: (line) => line.items ? `${line.items.name} (${line.items.sku})` : "Unknown item",
            },
            // Only worth a column when some of it is not ours — otherwise it is
            // a column that says "Ours" all the way down.
            ...(rows.some((line) => line.owner_type === "customer_owned") ? [{
              header: "Owner",
              cell: (line: LineRow) => line.owner_type === "customer_owned"
                ? `${line.customers?.business_name ?? "Customer"} (theirs)`
                : "Ours",
            }] : []),
            ...(counted.length > 0 ? [{
              header: "Driver said",
              align: "right" as const,
              cell: (line: LineRow) => line.driver_quantity ?? "—",
            }, {
              header: "We counted",
              align: "right" as const,
              cell: (line: LineRow) => {
                if (line.driver_quantity == null) return line.quantity;
                const difference = line.quantity - line.driver_quantity;
                return difference === 0
                  ? line.quantity
                  : `${line.quantity} (${difference > 0 ? "+" : ""}${difference})`;
              },
            }] : []),
            { header: "In batch", align: "right", cell: (line) => line.quantity - line.rejected_quantity },
            { header: "Set aside", align: "right", cell: (line) => line.rejected_quantity || "—" },
            {
              header: "",
              cell: (line) => writable && receiving ? (
                <form action={removeBatchLine}>
                  <input type="hidden" name="id" value={line.id} />
                  <input type="hidden" name="batch_id" value={batch.id} />
                  <Button variant="ghost">Remove</Button>
                </form>
              ) : null,
            },
          ]}
        />
      </Card>

      {writable && receiving ? <AddLine batchId={batch.id} /> : null}

      {writable && inFlow && !receiving && rows.length > 0 ? (
        <Card
          title="Found something torn or stained"
          description="Take it out of the batch so the rest of the run stops counting it."
        >
          <form action={rejectFromBatch} className="grid gap-3 sm:grid-cols-4">
            <input type="hidden" name="batch_id" value={batch.id} />
            <Field label="Which item" name="line_id" className="sm:col-span-2">
              <Select name="line_id" options={rows
                .filter((line) => line.quantity - line.rejected_quantity > 0)
                .map((line) => ({
                  value: line.id,
                  label: `${line.items?.name ?? "Item"} — ${line.quantity - line.rejected_quantity} left`,
                }))} />
            </Field>
            <Field label="How many" name="quantity">
              <Input name="quantity" type="number" min={1} defaultValue="1" required />
            </Field>
            <Field label="What now" name="destination">
              <Select name="destination" defaultValue="in_repair"
                      options={REJECT_DESTINATIONS.map((option) => ({
                        value: option.value, label: option.label,
                      }))} />
            </Field>
            <Field label="Notes" name="notes" className="sm:col-span-3">
              <Input name="notes" placeholder="Tear along the hem" />
            </Field>
            <div className="sm:col-span-4">
              <SubmitButton variant="secondary">Take it out</SubmitButton>
            </div>
          </form>
        </Card>
      ) : null}

      {batch.notes ? (
        <Card title="Notes"><p className="text-sm">{batch.notes}</p></Card>
      ) : null}
    </div>
  );
}

async function AddLine({ batchId }: { batchId: string }) {
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("items").select("id, name, sku")
    .eq("status", "active").is("deleted_at", null).order("name")
    .returns<Pick<Item, "id" | "name" | "sku">[]>();

  return (
    <Card
      title="Add something the driver missed"
      description="For linen on the trolley that was not on the run — a walk-in, or a bag found on the dock."
    >
      <form action={addBatchLine} className="grid gap-3 sm:grid-cols-4">
        <input type="hidden" name="batch_id" value={batchId} />
        <Field label="Item" name="item_id" required className="sm:col-span-2">
          <Select name="item_id" required options={(items ?? []).map((item) => ({
            value: item.id, label: `${item.name} (${item.sku})`,
          }))} />
        </Field>
        <Field label="How many" name="quantity" required>
          <Input name="quantity" type="number" min={1} defaultValue="1" required />
        </Field>
        <div className="sm:col-span-4">
          <SubmitButton variant="secondary">Add it</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
