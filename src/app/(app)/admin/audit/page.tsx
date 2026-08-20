import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { listMembers, memberNames } from "@/lib/directory";
import { dateTime } from "@/lib/format";
import type { AuditLog } from "@/lib/db/types";
import {
  DataTable, EmptyState, PageHeader, SkeletonRows, humanise,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";

export const metadata = { title: "Activity log" };
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
        title="Activity log" eyebrow="Audit log"
        description="Every change anyone has made. Nothing is ever removed from this list."
      />
      <ListControls
        action="/admin/audit"
        q={params.q}
        filters={[{
          name: "entity", label: "record type", value: params.entity,
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

  // Who did it, in words. This column showed eight characters of a UUID, which
  // is the one thing an audit log must not do — a record of who changed what is
  // only a record if the "who" is a person. Every member resolves here, platform
  // administrators included: they are not offered in a picker anywhere, but a
  // change one of them made still has to say so.
  const names = memberNames(await listMembers());

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
            cell: (row) => (row.actor_id
              ? names.get(row.actor_id) ?? <span className="text-xs">{row.actor_id.slice(0, 8)}…</span>
              : "system"),
            hideBelow: "md",
          },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/admin/audit" />
    </>
  );
}
