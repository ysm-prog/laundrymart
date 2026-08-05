import { Suspense } from "react";
import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import type { Depot } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows,
  SkeletonStats, Stat, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { BATCH_FLOW, BATCH_STAGE_LABELS, type BatchStage } from "./stages";
import { createBatch } from "./actions";

export const metadata = { title: "Warehouse" };
export const dynamic = "force-dynamic";

type BatchRow = {
  id: string;
  batch_number: string;
  stage: BatchStage;
  machine: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  depots: { name: string } | null;
  production_batch_lines: Array<{ quantity: number; rejected_quantity: number }>;
};

export default async function WarehousePage() {
  const session = await requireCapability("warehouse.read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Warehouse"
        description="Linen through the plant, batch by batch. Every stage moves real stock."
      />

      <Suspense fallback={<SkeletonStats />}>
        <OnTheFloor />
      </Suspense>

      <Suspense fallback={<SkeletonRows rows={6} />}>
        <Batches />
      </Suspense>

      {can(session.role, "warehouse.write") ? (
        <Suspense fallback={null}>
          <NewBatch />
        </Suspense>
      ) : null}
    </div>
  );
}

/** How much is sitting in each processing stage right now. */
async function OnTheFloor() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("inventory_pools")
    .select("state, quantity")
    .in("state", [...BATCH_FLOW])
    .neq("quantity", 0)
    .returns<Array<{ state: string; quantity: number }>>();

  const byState = new Map<string, number>();
  for (const row of data ?? []) {
    byState.set(row.state, (byState.get(row.state) ?? 0) + row.quantity);
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {BATCH_FLOW.map((stage) => (
        <Stat
          key={stage}
          label={BATCH_STAGE_LABELS[stage]}
          value={String(byState.get(stage) ?? 0)}
          tone={stage === "ready_for_dispatch" && (byState.get(stage) ?? 0) > 0 ? "success" : undefined}
        />
      ))}
    </div>
  );
}

async function Batches() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("production_batches")
    .select("id, batch_number, stage, machine, started_at, completed_at, created_at, " +
            "depots(name), production_batch_lines(quantity, rejected_quantity)")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<BatchRow[]>();

  const rows = data ?? [];

  return (
    <Card title="Batches" description="The fifty most recent.">
      <DataTable
        rows={rows}
        empty={<EmptyState
          title="No batches yet"
          description="Open a batch when linen comes off a run and needs washing."
        />}
        columns={[
          {
            header: "Batch",
            cell: (batch) => (
              <Link href={`/warehouse/${batch.id}`} className="font-medium text-primary hover:underline">
                {batch.batch_number}
              </Link>
            ),
          },
          { header: "Stage", cell: (batch) => <StatusBadge status={batch.stage} /> },
          { header: "Depot", cell: (batch) => batch.depots?.name ?? "—" },
          { header: "Machine", cell: (batch) => batch.machine ?? "—" },
          {
            header: "Items",
            align: "right",
            cell: (batch) => (batch.production_batch_lines ?? [])
              .reduce((total, line) => total + line.quantity - line.rejected_quantity, 0),
          },
          {
            header: "Rejects",
            align: "right",
            cell: (batch) => (batch.production_batch_lines ?? [])
              .reduce((total, line) => total + line.rejected_quantity, 0),
          },
          {
            header: "Started",
            cell: (batch) => batch.started_at ? dateTime(batch.started_at) : "—",
          },
        ]}
      />
    </Card>
  );
}

async function NewBatch() {
  const supabase = await createClient();
  const { data: depots } = await supabase
    .from("depots").select("id, name").is("deleted_at", null).order("name")
    .returns<Pick<Depot, "id" | "name">[]>();

  return (
    <Card title="Open a batch" description="Starts in receiving — add its manifest next.">
      <form action={createBatch} className="grid gap-3 sm:grid-cols-4">
        <Field label="Depot" name="depot_id">
          <Select name="depot_id" options={[
            { value: "", label: "No depot" },
            ...(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name })),
          ]} />
        </Field>
        <Field label="Machine" name="machine" hint="Optional washer or line.">
          <Input name="machine" placeholder="Washer 3" />
        </Field>
        <Field label="Notes" name="notes" className="sm:col-span-2">
          <Input name="notes" placeholder="Off route R2, heavy soiling" />
        </Field>
        <div className="sm:col-span-4">
          <SubmitButton>Open batch</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
