import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, today } from "@/lib/format";
import type { PublicHoliday } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, Notice, PageHeader, SkeletonRows,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { addHoliday, removeHoliday } from "../actions";

export const metadata = { title: "Public holidays" };
export const dynamic = "force-dynamic";

const REGIONS = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((value) => ({ value, label: value }));

export default async function HolidaysPage() {
  const session = await requireCapability("admin.read");
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

      <Suspense fallback={<SkeletonRows rows={6} />}>
        <HolidayList writable={writable} />
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

async function HolidayList({ writable }: { writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("public_holidays")
    .select("id, holiday_date, name, region")
    .gte("holiday_date", `${today().slice(0, 4)}-01-01`)
    .order("holiday_date")
    .returns<PublicHoliday[]>();

  return (
    <DataTable
      rows={data ?? []}
      empty={<EmptyState title="No holidays loaded"
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
              <button type="submit" className="text-xs text-danger hover:underline">Remove</button>
            </form>
          ) : null),
        },
      ]}
    />
  );
}
