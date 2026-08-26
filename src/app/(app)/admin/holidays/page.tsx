import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, today } from "@/lib/format";
import type { PublicHoliday } from "@/lib/db/types";
import {
  Button, Card, DataTable, EmptyState, Notice, PageHeader, SkeletonRows,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import { addHoliday, removeHoliday } from "../actions";

export const metadata = { title: "Public holidays" };
export const dynamic = "force-dynamic";

const REGIONS = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((value) => ({ value, label: value }));

type Search = { q?: string; region?: string; year?: string };
const FILTER_KEYS = ["q", "region", "year"] as const;

export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("admin.read");
  const params = await searchParams;
  const writable = can(session.role, "admin.write");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Public holidays"
        description="Days you do not normally serve. Each contract decides whether to skip the day, move it, or work it at a surcharge."
      />

      <Notice tone="info">
        Holidays entered here drive service-date generation, route generation and billing.
        Load each state you operate in — an empty calendar means every holiday is treated as a normal service day.
      </Notice>

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={6} />}>
        <HolidayList params={params} writable={writable} />
      </Suspense>

      {writable ? (
        <Card title="Add a public holiday">
          <form action={addHoliday} className="grid gap-4 sm:grid-cols-4">
            <Field label="Date" name="holiday_date" required>
              <Input name="holiday_date" type="date" required defaultValue={today()} />
            </Field>
            <Field label="Name" name="name" required>
              <Input name="name" required placeholder="Australia Day" />
            </Field>
            <Field label="Region" name="region">
              <Select name="region" options={REGIONS} defaultValue="NSW" />
            </Field>
            <div className="flex items-end">
              <SubmitButton>Add holiday</SubmitButton>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

async function HolidayList({ params, writable }: { params: Search; writable: boolean }) {
  const supabase = await createClient();
  /**
   * A named year, or this year onwards.
   *
   * The old query was "this year onwards" with no way back, which meant last
   * year's calendar — the thing you check when a contract billed a surcharge you
   * did not expect — was unreachable from the screen that owns it.
   */
  const year = /^\d{4}$/.test(params.year ?? "") ? params.year! : null;
  const { data } = await supabase
    .from("public_holidays")
    .select("id, holiday_date, name, region")
    .gte("holiday_date", year ? `${year}-01-01` : `${today().slice(0, 4)}-01-01`)
    .lte("holiday_date", year ? `${year}-12-31` : "9999-12-31")
    .order("holiday_date")
    .returns<PublicHoliday[]>();

  const all = data ?? [];
  const term = params.q?.trim().toLowerCase();
  const rows = all.filter((row) => {
    if (term && !row.name.toLowerCase().includes(term)) return false;
    if (params.region && row.region !== params.region) return false;
    return true;
  });
  const filtered = isFiltered(params, FILTER_KEYS);
  const regionCount = (region: string) => all.filter((row) => row.region === region).length;
  const thisYear = Number(today().slice(0, 4));

  return (
    <>
    <ListControls
      action="/admin/holidays"
      q={params.q}
      params={params}
      filterKeys={FILTER_KEYS}
      placeholder="Holiday name…"
      filters={[{
        name: "year", label: "Year", value: params.year,
        // Two back and two forward: far enough to answer "what did we do last
        // Australia Day?" and to load next year's calendar before it arrives.
        options: [thisYear - 2, thisYear - 1, thisYear, thisYear + 1, thisYear + 2]
          .map((value) => ({ value: String(value), label: String(value) })),
      }]}
      chips={
        /* A laundry operates in one or two states, so region is the filter that
           actually gets used — and eight chips of which six show nothing would
           be furniture, so only the regions with holidays loaded are offered. */
        <FilterChips
          basePath="/admin/holidays" params={params} name="region" label="Region"
          allLabel="Every region" allCount={all.length}
          options={REGIONS
            .filter((region) => regionCount(region.value) > 0)
            .map((region) => ({ ...region, count: regionCount(region.value) }))}
        />
      }
      summary={
        <FilterSummary basePath="/admin/holidays" shown={rows.length} total={all.length}
                       noun="holiday" filtered={filtered} />
      }
    />
    <DataTable
      rows={rows}
      empty={filtered
        ? <EmptyState title="No holidays match those filters"
                      description="Try another region or year, or clear the filters above." />
        : <EmptyState title="No holidays loaded"
                         description="Until you add holidays, agreements will service every scheduled day." />}
      columns={[
        { header: "Date", cell: (row) => date(row.holiday_date) },
        { header: "Holiday", cell: (row) => row.name },
        { header: "Region", cell: (row) => row.region },
        {
          header: "",
          align: "right",
          cell: (row) => (writable ? (
            <form action={removeHoliday}>
              <input type="hidden" name="id" value={row.id} />
              <Button variant="dangerGhost">Remove</Button>
            </form>
          ) : null),
        },
      ]}
    />
    </>
  );
}
