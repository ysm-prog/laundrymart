import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import type { Customer, Item } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, Notice,
  PageHeader, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import {
  BATCH_FLOW, BATCH_STAGE_LABELS, REJECT_DESTINATIONS, isFlowStage, nextStage,
  type BatchStage,
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
  depots: { name: string } | null;
};

type LineRow = {
  id: string;
  item_id: string;
  owner_type: "laundry_owned" | "customer_owned";
  customer_id: string | null;
  quantity: number;
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
              "completed_at, created_at, depot_id, depots(name)")
      .eq("id", id)
      .maybeSingle<BatchDetail>(),
    supabase
      .from("production_batch_lines")
      .select("id, item_id, owner_type, customer_id, quantity, rejected_quantity, notes, " +
              "items(name, sku), customers(business_name)")
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

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Batch ${batch.batch_number}`}
        description={[
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
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
            {target ? (
              <form action={advanceBatch}>
                <input type="hidden" name="id" value={batch.id} />
                <Button variant="primary">Move to {BATCH_STAGE_LABELS[target].toLowerCase()}</Button>
              </form>
            ) : (
              <form action={completeBatch}>
                <input type="hidden" name="id" value={batch.id} />
                <Button variant="primary">Complete batch</Button>
              </form>
            )}

            <form action={cancelBatch} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={batch.id} />
              <Field label="Cancel reason" name="cancel_reason">
                <Input name="cancel_reason" required placeholder="Machine breakdown" />
              </Field>
              <SubmitButton variant="danger">Cancel batch</SubmitButton>
            </form>
          </div>
        ) : null}

        {writable && receiving ? (
          <p className="mt-3 text-xs text-muted-foreground">
            The manifest can only be edited while the batch is in receiving — after that its
            quantities are what every stock movement was calculated from.
          </p>
        ) : null}
      </Card>

      <Card
        title="Manifest"
        description={rejected > 0 ? `${processing} in the batch · ${rejected} pulled out` : undefined}
      >
        <DataTable
          rows={rows}
          empty={<EmptyState
            title="Nothing on this batch yet"
            description="Add what came off the run before starting the wash."
          />}
          columns={[
            {
              header: "Item",
              cell: (line) => line.items ? `${line.items.name} (${line.items.sku})` : "Unknown item",
            },
            {
              header: "Owner",
              cell: (line) => line.owner_type === "customer_owned"
                ? `${line.customers?.business_name ?? "Customer"} (theirs)`
                : "Ours",
            },
            { header: "In batch", align: "right", cell: (line) => line.quantity - line.rejected_quantity },
            { header: "Rejected", align: "right", cell: (line) => line.rejected_quantity || "—" },
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
          title="Pull an item out"
          description="Rejected stock leaves the batch and stops being washed on paper."
        >
          <form action={rejectFromBatch} className="grid gap-3 sm:grid-cols-4">
            <input type="hidden" name="batch_id" value={batch.id} />
            <Field label="Line" name="line_id" className="sm:col-span-2">
              <Select name="line_id" options={rows
                .filter((line) => line.quantity - line.rejected_quantity > 0)
                .map((line) => ({
                  value: line.id,
                  label: `${line.items?.name ?? "Item"} — ${line.quantity - line.rejected_quantity} left`,
                }))} />
            </Field>
            <Field label="Quantity" name="quantity">
              <Input name="quantity" type="number" min={1} defaultValue="1" required />
            </Field>
            <Field label="Send to" name="destination">
              <Select name="destination" defaultValue="in_repair"
                      options={REJECT_DESTINATIONS.map((option) => ({
                        value: option.value, label: option.label,
                      }))} />
            </Field>
            <Field label="Notes" name="notes" className="sm:col-span-3">
              <Input name="notes" placeholder="Tear along the hem" />
            </Field>
            <div className="sm:col-span-4">
              <SubmitButton variant="secondary">Record reject</SubmitButton>
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
  const [{ data: items }, { data: customers }] = await Promise.all([
    supabase.from("items").select("id, name, sku")
      .eq("status", "active").is("deleted_at", null).order("name")
      .returns<Pick<Item, "id" | "name" | "sku">[]>(),
    supabase.from("customers").select("id, business_name")
      .is("deleted_at", null).order("business_name")
      .returns<Pick<Customer, "id" | "business_name">[]>(),
  ]);

  return (
    <Card title="Add to the manifest">
      <form action={addBatchLine} className="grid gap-3 sm:grid-cols-4">
        <input type="hidden" name="batch_id" value={batchId} />
        <Field label="Item" name="item_id" required>
          <Select name="item_id" required options={(items ?? []).map((item) => ({
            value: item.id, label: `${item.name} (${item.sku})`,
          }))} />
        </Field>
        <Field label="Owner" name="owner_type">
          <Select name="owner_type" defaultValue="laundry_owned" options={[
            { value: "laundry_owned", label: "Ours" },
            { value: "customer_owned", label: "Customer's own" },
          ]} />
        </Field>
        <Field label="Customer" name="customer_id"
               hint="Required for customer-owned linen, so it goes back to them.">
          <Select name="customer_id" options={[
            { value: "", label: "Not customer-owned" },
            ...(customers ?? []).map((customer) => ({
              value: customer.id, label: customer.business_name,
            })),
          ]} />
        </Field>
        <Field label="Quantity" name="quantity" required>
          <Input name="quantity" type="number" min={1} defaultValue="1" required />
        </Field>
        <div className="sm:col-span-4">
          <SubmitButton>Add line</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
