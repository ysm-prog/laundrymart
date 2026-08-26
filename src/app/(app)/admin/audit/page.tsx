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
import { FilterChips, PeriodFilter } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import {
  ACTIVITY_PERIOD_PRESETS, resolvePeriod, type ResolvedPeriod,
} from "@/lib/domain/dates";
import { businessToday, getAdelaideDayRange } from "@/lib/domain/timezone";

export const metadata = { title: "Activity log" };
export const dynamic = "force-dynamic";

type Search = {
  q?: string; entity?: string; action?: string; period?: string; from?: string; to?: string;
  page?: string; error?: string; ok?: string;
};
const FILTER_KEYS = ["q", "entity", "action", "period", "from", "to"] as const;

/** The four verbs `recordAudit()` writes. Read once, acted on constantly. */
const ACTIONS = [
  { value: "create", label: "Created" },
  { value: "update", label: "Changed" },
  { value: "delete", label: "Deleted" },
  { value: "status_change", label: "Status changed" },
] as const;

const ENTITIES = [
  "customer", "service_agreement", "item", "vehicle", "driver", "depot",
  "route_template", "daily_route", "job", "pickup", "delivery",
  "inventory_movement", "invoice", "payment", "credit_note", "membership",
  "public_holiday", "offline_sync",
];

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  // All time by default: the log is the whole history and narrowing it on open
  // would hide the thing somebody came here to find.
  const period = resolvePeriod(params, businessToday(), "all");
  await requireCapability("admin.read");

  return (
    <div>
      <PageHeader
        title="Activity log"
        description="Every change anyone has made. Nothing is ever removed from this list."
      />
      <ListControls
        action="/admin/audit"
        q={params.q}
        params={params}
        filterKeys={FILTER_KEYS}
        placeholder="What was written in the detail…"
        filters={[{
          name: "entity", label: "record type", value: params.entity,
          options: ENTITIES.map((value) => ({ value, label: humanise(value) })),
        }]}
        chips={
          <>
            {/* The period is the filter this screen was missing. An audit log is
                read to answer "what happened on the 14th?", and without a window
                that is a hunt through pages of everything. */}
            <PeriodFilter
              basePath="/admin/audit" params={params} period={period}
              presets={ACTIVITY_PERIOD_PRESETS} today={businessToday()} label="Happened in"
              hideCustomWhenPreset
            />
            <FilterChips
              basePath="/admin/audit" params={params} name="action" label="What was done"
              allLabel="Everything" options={ACTIONS}
            />
          </>
        }
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={10} />}>
        <AuditList params={params} period={period} />
      </Suspense>
    </div>
  );
}

async function AuditList({ params, period }: { params: Search; period: ResolvedPeriod }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("audit_logs")
    .select("id, entity, entity_id, action, summary, created_at, actor_id", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (params.entity) query = query.eq("entity", params.entity);
  if (params.action) query = query.eq("action", params.action);
  if (params.q) query = query.ilike("summary", `%${params.q}%`);
  if (period.range) {
    // `created_at` is a timestamp and the window is a pair of operational days,
    // so the end has to reach the *end* of its day — `<= 2026-08-26` on a
    // timestamp means midnight, and would drop everything that happened during it.
    query = query
      .gte("created_at", getAdelaideDayRange(period.range.start).start)
      .lt("created_at", getAdelaideDayRange(period.range.end).end);
  }

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
        empty={isFiltered(params, FILTER_KEYS)
          ? <EmptyState title="Nothing matches those filters"
                        description="Try a wider period, or clear the filters above." />
          : <EmptyState title="Nothing recorded yet" description="Writes appear here as soon as they happen." />}
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
