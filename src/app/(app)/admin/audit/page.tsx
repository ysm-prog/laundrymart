import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { dateTime } from "@/lib/format";
import type { AuditLog } from "@/lib/db/types";
import {
  DataTable, EmptyState, PageHeader, SkeletonRows, humanise,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

type Search = { q?: string; entity?: string; page?: string; error?: string; ok?: string };

const ENTITIES = [
  "customer", "service_agreement", "item", "vehicle", "driver", "depot",
  "route_template", "daily_route", "job", "pickup", "delivery",
  "inventory_movement", "invoice", "payment", "credit_note", "membership",
  "public_holiday", "offline_sync",
];

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  await requireCapability("admin.read");

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Append-only record of every write, kept for compliance and incident review."
      />
      <ListControls
        action="/admin/audit"
        q={params.q}
        filters={[{
          name: "entity", label: "Entity", value: params.entity,
          options: ENTITIES.map((value) => ({ value, label: humanise(value) })),
        }]}
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={10} />}>
        <AuditList params={params} />
      </Suspense>
    </div>
  );
}

async function AuditList({ params }: { params: Search }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("audit_logs")
    .select("id, entity, entity_id, action, summary, created_at, actor_id", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (params.entity) query = query.eq("entity", params.entity);
  if (params.q) query = query.ilike("summary", `%${params.q}%`);

  const { data, count } = await query.returns<AuditLog[]>();

  return (
    <>
      <DataTable
        rows={data ?? []}
        empty={<EmptyState title="Nothing recorded yet" description="Writes appear here as soon as they happen." />}
        columns={[
          { header: "When", cell: (row) => dateTime(row.created_at) },
          { header: "Entity", cell: (row) => humanise(row.entity) },
          { header: "Action", cell: (row) => humanise(row.action) },
          { header: "Detail", cell: (row) => row.summary ?? "—", hideBelow: "sm" },
          {
            header: "Actor",
            cell: (row) => (row.actor_id ? <span className="font-mono text-xs">{row.actor_id.slice(0, 8)}…</span> : "system"),
            hideBelow: "md",
          },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/admin/audit" />
    </>
  );
}
