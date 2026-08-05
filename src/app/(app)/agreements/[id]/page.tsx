import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, money, today } from "@/lib/format";
import { addDays } from "@/lib/domain/dates";
import {
  HOLIDAY_RULE_LABELS, describePattern, generateServiceDates, parsePattern,
  type HolidayRule,
} from "@/lib/domain/service-calendar";
import { CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import type { CustomerLocation, Depot, Item, ServiceAgreement, ServiceAgreementLine } from "@/lib/db/types";
import {
  Badge, Button, ButtonLink, Card, DataTable, EmptyState, FlashMessages,
  PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { Checkbox, Field, Input, Select, SubmitButton } from "@/components/form";
import { AgreementForm } from "../agreement-form";
import {
  addAgreementLine, createNewVersion, removeAgreementLine, setAgreementStatus, updateAgreement,
} from "../actions";

export const dynamic = "force-dynamic";

const PREVIEW_DAYS = 56;

export default async function AgreementDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const flash = await searchParams;
  const session = await requireCapability("agreements.read");
  const writable = can(session.role, "agreements.write");

  const supabase = await createClient();
  const { data: agreement } = await supabase
    .from("service_agreements")
    .select("*")
    .eq("id", id)
    .maybeSingle<ServiceAgreement & { supersedes_id: string | null }>();

  if (!agreement) notFound();

  return (
    <div className="space-y-6">
      <FlashMessages error={flash.error} ok={flash.ok} />
      <PageHeader
        title={`${agreement.agreement_number} · version ${agreement.version}`}
        description={
          `${describePattern(parsePattern(agreement.pickup_pattern))} pickups · ` +
          `${HOLIDAY_RULE_LABELS[agreement.holiday_rule as HolidayRule] ?? agreement.holiday_rule}`
        }
        actions={
          <>
            <StatusBadge status={agreement.status} />
            <ButtonLink href={`/customers/${agreement.customer_id}`}>Customer</ButtonLink>
            {writable ? <StatusActions id={id} status={agreement.status} /> : null}
          </>
        }
      />

      <Suspense fallback={<SkeletonRows rows={4} />}>
        <CalendarPreview agreement={agreement} />
      </Suspense>

      <Suspense fallback={<SkeletonRows rows={4} />}>
        <PricedLines agreementId={id} writable={writable} />
      </Suspense>

      {writable ? (
        <Suspense fallback={<SkeletonRows rows={6} />}>
          <EditSection agreement={agreement} />
        </Suspense>
      ) : null}
    </div>
  );
}

function StatusActions({ id, status }: { id: string; status: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {status !== "active" ? (
        <form action={setAgreementStatus}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value="active" />
          <Button variant="primary">Activate</Button>
        </form>
      ) : (
        <form action={setAgreementStatus}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value="suspended" />
          <Button variant="secondary">Suspend</Button>
        </form>
      )}
      <form action={createNewVersion}>
        <input type="hidden" name="id" value={id} />
        <Button variant="secondary">New version</Button>
      </form>
    </div>
  );
}

/**
 * The screen that makes the pattern trustworthy: the actual dates this agreement
 * produces over the next eight weeks, with holiday moves called out.
 */
async function CalendarPreview({ agreement }: { agreement: ServiceAgreement }) {
  const supabase = await createClient();
  const from = today();
  const to = addDays(from, PREVIEW_DAYS);

  const { data: holidayRows } = await supabase
    .from("public_holidays")
    .select("holiday_date, name")
    .eq("region", agreement.holiday_region)
    .gte("holiday_date", from)
    .lte("holiday_date", to);

  const holidays = (holidayRows ?? []).map((row) => row.holiday_date as string);
  const options = {
    from, to,
    holidays,
    holidayRule: agreement.holiday_rule as HolidayRule,
    startDate: agreement.start_date,
    endDate: agreement.end_date,
  };

  const pickups = generateServiceDates({ ...options, pattern: parsePattern(agreement.pickup_pattern) });
  const deliveries = generateServiceDates({ ...options, pattern: parsePattern(agreement.delivery_pattern) });

  return (
    <Card
      title={`Service calendar — next ${PREVIEW_DAYS} days`}
      description={
        holidays.length
          ? `${holidays.length} public holiday(s) in this window for ${agreement.holiday_region}.`
          : `No public holidays loaded for ${agreement.holiday_region} in this window.`
      }
      actions={<Link href="/admin/holidays" className="text-sm text-primary hover:underline">Manage holidays</Link>}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <DateList title="Pickups" dates={pickups} />
        <DateList title="Deliveries" dates={deliveries} />
      </div>
    </Card>
  );
}

function DateList({
  title, dates,
}: {
  title: string;
  dates: ReturnType<typeof generateServiceDates>;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">{title} · {dates.length} visit(s)</h3>
      {dates.length === 0 ? (
        <EmptyState title="No visits in this window"
                    description="Check the pattern and the agreement's start date." />
      ) : (
        <ul className="space-y-1 text-sm">
          {dates.map((entry) => (
            <li key={entry.date} className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{date(entry.date)}</span>
              {entry.movedFromHoliday ? (
                <Badge tone="warning">moved from {date(entry.scheduledDate)}</Badge>
              ) : null}
              {entry.isPublicHoliday && !entry.movedFromHoliday ? (
                <Badge tone="info">public holiday</Badge>
              ) : null}
              {entry.isWeekend ? <Badge tone="info">weekend</Badge> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function PricedLines({ agreementId, writable }: { agreementId: string; writable: boolean }) {
  const supabase = await createClient();
  const [{ data: lines }, { data: items }] = await Promise.all([
    supabase.from("service_agreement_lines")
      .select("id, agreement_id, item_id, charge_type, pricing_model, unit_price, percentage, standard_quantity, included_quantity, taxable")
      .eq("agreement_id", agreementId).order("charge_type")
      .returns<ServiceAgreementLine[]>(),
    supabase.from("items").select("id, name, sku").is("deleted_at", null).eq("status", "active").order("name")
      .returns<Pick<Item, "id" | "name" | "sku">[]>(),
  ]);

  const itemName = new Map((items ?? []).map((item) => [item.id, `${item.name} (${item.sku})`]));

  return (
    <Card title="Priced lines"
          description="These take precedence over item defaults when an invoice is generated.">
      <DataTable
        rows={lines ?? []}
        empty={<EmptyState title="No priced lines yet"
                           description="Without lines, billing falls back to each item's default price." />}
        columns={[
          { header: "Item", cell: (row) => (row.item_id ? itemName.get(row.item_id) ?? "—" : "—") },
          {
            header: "Charge",
            cell: (row) => CHARGE_TYPE_LABELS[row.charge_type as ChargeType] ?? humanise(row.charge_type),
          },
          { header: "Model", cell: (row) => humanise(row.pricing_model), hideBelow: "md" },
          { header: "Unit price", cell: (row) => money(row.unit_price), align: "right" },
          { header: "Standard qty", cell: (row) => row.standard_quantity, align: "right", hideBelow: "lg" },
          {
            header: "",
            cell: (row) => (writable ? (
              <form action={removeAgreementLine}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="agreement_id" value={agreementId} />
                <button type="submit" className="text-xs text-danger hover:underline">Remove</button>
              </form>
            ) : null),
            align: "right",
          },
        ]}
      />

      {writable ? (
        <form action={addAgreementLine} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="agreement_id" value={agreementId} />
          <Field label="Item" name="item_id">
            <Select name="item_id" placeholder="No specific item"
                    options={(items ?? []).map((item) => ({ value: item.id, label: `${item.name} (${item.sku})` }))} />
          </Field>
          <Field label="Charge type" name="charge_type">
            <Select name="charge_type" defaultValue="rental"
                    options={Object.entries(CHARGE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
          </Field>
          <Field label="Pricing model" name="pricing_model">
            <Select name="pricing_model" defaultValue="per_item" options={[
              { value: "per_item", label: "Per item" },
              { value: "per_kg", label: "Per kg" },
              { value: "per_collection", label: "Per collection" },
              { value: "monthly", label: "Monthly" },
              { value: "percentage", label: "Percentage" },
            ]} />
          </Field>
          <Field label="Unit price" name="unit_price">
            <Input name="unit_price" type="number" step="0.01" min={0} defaultValue="0" />
          </Field>
          <Field label="Standard quantity" name="standard_quantity">
            <Input name="standard_quantity" type="number" step="0.01" min={0} defaultValue="0" />
          </Field>
          <Field label="Included quantity" name="included_quantity"
                 hint="Quantity covered before the unit price applies">
            <Input name="included_quantity" type="number" step="0.01" min={0} defaultValue="0" />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox name="taxable" label="GST applies" defaultChecked />
          </div>
          <div className="flex items-end">
            <SubmitButton variant="secondary">Add line</SubmitButton>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

async function EditSection({ agreement }: { agreement: ServiceAgreement }) {
  const supabase = await createClient();
  const [{ data: customers }, { data: locations }, { data: depots }] = await Promise.all([
    supabase.from("customers").select("id, business_name, customer_number")
      .is("deleted_at", null).order("business_name"),
    supabase.from("customer_locations").select("id, name, customer_id")
      .eq("customer_id", agreement.customer_id).is("deleted_at", null).order("name")
      .returns<Pick<CustomerLocation, "id" | "name" | "customer_id">[]>(),
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
  ]);

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Edit agreement
      </h2>
      <AgreementForm
        action={updateAgreement}
        agreement={agreement}
        customers={customers ?? []}
        locations={locations ?? []}
        depots={depots ?? []}
        cancelHref="/agreements"
        submitLabel="Save changes"
      />
    </div>
  );
}
