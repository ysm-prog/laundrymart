import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, money } from "@/lib/format";
import { describePattern, parsePattern } from "@/lib/domain/service-calendar";
import { isOverdue, summariseItems } from "@/lib/domain/laundry-orders";
import { businessToday } from "@/lib/domain/timezone";
import type {
  Customer, CustomerContact, CustomerLocation, Invoice, Job, ServiceAgreement,
} from "@/lib/db/types";
import {
  Badge, ButtonLink, Card, DataTable, EmptyState, PageHeader,
  SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Checkbox, Field, Input, SubmitButton } from "@/components/form";
import { addContact, addLocation } from "../actions";
import { BillingAndPricing } from "./billing-section";

export const dynamic = "force-dynamic";

type Params = { id: string };

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const session = await requireCapability("customers.read");
  const writable = can(session.role, "customers.write");

  const supabase = await createClient();
  const { data: customer } = await supabase
    .from("customers")
    .select(
      "id, customer_number, business_name, trading_name, abn, billing_address_line1, " +
      "billing_suburb, billing_state, billing_postcode, billing_email, phone, " +
      "payment_terms_days, purchase_order_number, special_instructions, notes, status, " +
      "depot_id, created_at",
    )
    .eq("id", id)
    .maybeSingle<Customer>();

  if (!customer) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.business_name}
        description={`${customer.customer_number}${customer.trading_name ? ` · trading as ${customer.trading_name}` : ""}`}
        actions={
          <>
            <StatusBadge status={customer.status} />
            {writable ? <ButtonLink href={`/customers/${id}/edit`}>Edit</ButtonLink> : null}
            {can(session.role, "agreements.write")
              ? <ButtonLink href={`/agreements/new?customer=${id}`} variant="primary">New agreement</ButtonLink>
              : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Contact details, not money. Payment terms and the invoice email moved
            into the Billing & pricing section below, which is gated on
            `billing.read` — they are finance answers, and this card is read by
            dispatch and the counter. The ABN and the postal address stay here:
            both are how you find and address the business. */}
        <Card title="Contact &amp; address" className="lg:col-span-1">
          <dl className="space-y-2 text-sm">
            <Row label="ABN" value={customer.abn ?? "—"} />
            <Row label="Phone" value={customer.phone ?? "—"} />
            <Row label="PO number" value={customer.purchase_order_number ?? "—"} />
            <Row
              label="Address"
              value={[customer.billing_address_line1, customer.billing_suburb,
                      customer.billing_state, customer.billing_postcode]
                .filter(Boolean).join(", ") || "—"}
            />
          </dl>
        </Card>

        <Card title="Operational notes" className="lg:col-span-2">
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-medium">Special instructions</p>
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {customer.special_instructions || "None recorded."}
              </p>
            </div>
            <div>
              <p className="font-medium">Internal notes</p>
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {customer.notes || "None recorded."}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Money is a separate permission from the customer record. A dispatcher
          holds `customers.write` and none of the billing capabilities, so they
          edit sites and contacts and never see a rate. RLS says the same thing
          independently (migration 0017), so this is the courtesy, not the gate. */}
      {can(session.role, "billing.read") ? (
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <BillingAndPricing customerId={id} writable={can(session.role, "billing.write")} />
        </Suspense>
      ) : null}

      <Suspense fallback={<SkeletonRows rows={3} />}>
        <Sites customerId={id} writable={writable} />
      </Suspense>

      <Suspense fallback={<SkeletonRows rows={3} />}>
        <Contacts customerId={id} writable={writable} />
      </Suspense>

      <Suspense fallback={<SkeletonRows rows={3} />}>
        <Agreements customerId={id} />
      </Suspense>

      {can(session.role, "orders.read") ? (
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <LaundryJobs customerId={id} canCreate={can(session.role, "orders.write")} />
        </Suspense>
      ) : null}

      <Suspense fallback={<SkeletonRows rows={3} />}>
        <History customerId={id} showInvoices={can(session.role, "invoices.read")} />
      </Suspense>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

async function Sites({ customerId, writable }: { customerId: string; writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("customer_locations")
    .select("id, customer_id, name, address_line1, suburb, state, postcode, access_notes, is_pickup, is_delivery, is_primary, status")
    .eq("customer_id", customerId).is("deleted_at", null).order("name")
    .returns<CustomerLocation[]>();

  return (
    <Card title="Sites" description="Pickup and delivery addresses for this customer.">
      <DataTable
        rows={data ?? []}
        empty={<EmptyState title="No sites yet" description="Add at least one site before building routes." />}
        columns={[
          { header: "Site", cell: (row) => row.name },
          {
            header: "Address",
            cell: (row) => [row.address_line1, row.suburb, row.state, row.postcode].filter(Boolean).join(", ") || "—",
            hideBelow: "sm",
          },
          {
            header: "Services",
            cell: (row) => [row.is_pickup && "Pickup", row.is_delivery && "Delivery"].filter(Boolean).join(" + ") || "—",
          },
        ]}
      />

      {writable ? (
        <form action={addLocation} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2">
          <input type="hidden" name="customer_id" value={customerId} />
          <Field label="Site name" name="name" required>
            <Input name="name" required placeholder="Main kitchen" />
          </Field>
          <Field label="Address" name="address_line1">
            <Input name="address_line1" />
          </Field>
          <Field label="Suburb" name="suburb">
            <Input name="suburb" />
          </Field>
          <Field label="Access notes" name="access_notes">
            <Input name="access_notes" placeholder="Rear loading dock, gate code 4821" />
          </Field>
          <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
            <Checkbox name="is_pickup" label="Pickup site" defaultChecked />
            <Checkbox name="is_delivery" label="Delivery site" defaultChecked />
            <SubmitButton variant="secondary">Add site</SubmitButton>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

async function Contacts({ customerId, writable }: { customerId: string; writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("customer_contacts")
    .select("id, customer_id, name, role, email, phone, is_primary")
    .eq("customer_id", customerId).is("deleted_at", null).order("name")
    .returns<CustomerContact[]>();

  return (
    <Card title="Contacts">
      <DataTable
        rows={data ?? []}
        empty={<EmptyState title="No contacts yet" />}
        columns={[
          { header: "Name", cell: (row) => row.name },
          { header: "Role", cell: (row) => row.role ?? "—", hideBelow: "sm" },
          { header: "Email", cell: (row) => row.email ?? "—", hideBelow: "md" },
          { header: "Phone", cell: (row) => row.phone ?? "—" },
        ]}
      />

      {writable ? (
        <form action={addContact} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2">
          <input type="hidden" name="customer_id" value={customerId} />
          <Field label="Name" name="name" required>
            <Input name="name" required />
          </Field>
          <Field label="Role" name="role">
            <Input name="role" placeholder="Venue manager" />
          </Field>
          <Field label="Email" name="email">
            <Input name="email" type="email" />
          </Field>
          <Field label="Phone" name="phone">
            <Input name="phone" type="tel" />
          </Field>
          <div className="flex items-center gap-4 sm:col-span-2">
            <Checkbox name="is_primary" label="Primary contact" />
            <SubmitButton variant="secondary">Add contact</SubmitButton>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

async function Agreements({ customerId }: { customerId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("service_agreements")
    .select("id, agreement_number, version, status, start_date, end_date, pickup_pattern, delivery_pattern, minimum_charge, holiday_rule")
    .eq("customer_id", customerId).is("deleted_at", null)
    .order("start_date", { ascending: false })
    .returns<Pick<ServiceAgreement,
      "id" | "agreement_number" | "version" | "status" | "start_date" | "end_date" |
      "pickup_pattern" | "delivery_pattern" | "minimum_charge" | "holiday_rule">[]>();

  return (
    <Card title="Contracts">
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/agreements/${row.id}`}
        empty={<EmptyState title="No service agreement" description="Routes and billing both derive from the agreement." />}
        columns={[
          { header: "Agreement", cell: (row) => `${row.agreement_number} v${row.version}` },
          { header: "Pickup pattern", cell: (row) => describePattern(parsePattern(row.pickup_pattern)), hideBelow: "sm" },
          { header: "Minimum", cell: (row) => money(row.minimum_charge), hideBelow: "md", align: "right" },
          { header: "Starts", cell: (row) => date(row.start_date), hideBelow: "lg" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
    </Card>
  );
}

/**
 * The customer's laundry jobs, read through the existing `customer_id` key —
 * nothing about a job is copied onto the customer row. Ten most recent, newest
 * first, with the whole list one click away.
 *
 * Deliberately separate from "Recent jobs" below, which is the *routing* module:
 * that lists stops on a driver's run, this lists laundry taken in at the counter.
 * Same word, two records, and putting them in one table would suggest they were
 * the same thing.
 */
async function LaundryJobs({
  customerId, canCreate,
}: { customerId: string; canCreate: boolean }) {
  const supabase = await createClient();
  const today = businessToday();
  const { data } = await supabase
    .from("laundry_orders")
    .select(
      "id, order_number, status, priority, received_at, due_date, delivery_required, " +
      "laundry_order_items(item_type, custom_description, quantity_type, exact_quantity, " +
      "bag_count, estimated_quantity)",
    )
    .eq("customer_id", customerId)
    .order("received_at", { ascending: false })
    .limit(10)
    .returns<Array<{
      id: string; order_number: string; status: string; priority: string;
      received_at: string; due_date: string | null; delivery_required: boolean;
      laundry_order_items: Array<{
        item_type: string; custom_description: string | null; quantity_type: string;
        exact_quantity: number | null; bag_count: number | null; estimated_quantity: number | null;
      }>;
    }>>();

  return (
    <Card
      title="Jobs"
      description="Laundry taken in for this customer, newest first."
      actions={
        <>
          <Link href={`/orders?customer=${customerId}`} className="text-sm text-primary hover:underline">
            All jobs
          </Link>
          {canCreate ? <ButtonLink href={`/orders/new?customer=${customerId}`}>New job</ButtonLink> : null}
        </>
      }
    >
      <DataTable
        label="Laundry jobs"
        rows={data ?? []}
        rowHref={(row) => `/orders/${row.id}`}
        empty={
          <EmptyState
            title="No jobs yet"
            description="Nothing has been taken in for this customer."
            action={canCreate
              ? <ButtonLink href={`/orders/new?customer=${customerId}`} variant="primary">Take in laundry</ButtonLink>
              : null}
          />
        }
        columns={[
          { header: "Job", cell: (row) => row.order_number },
          { header: "Received", cell: (row) => date(row.received_at) },
          {
            header: "Laundry",
            cell: (row) => summariseItems(row.laundry_order_items ?? []),
            hideBelow: "md",
          },
          {
            header: "Due",
            cell: (row) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <span>{row.due_date ? date(row.due_date) : "Not set"}</span>
                {isOverdue(row, today) ? <Badge tone="danger">Late</Badge> : null}
              </span>
            ),
            hideBelow: "sm",
          },
          {
            header: "Priority",
            cell: (row) => (row.priority === "urgent" ? <Badge tone="warning">Urgent</Badge> : "Normal"),
            hideBelow: "lg",
          },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
    </Card>
  );
}

async function History({ customerId, showInvoices }: { customerId: string; showInvoices: boolean }) {
  const supabase = await createClient();

  const [jobs, invoices] = await Promise.all([
    supabase.from("jobs")
      .select("id, job_number, scheduled_date, service_type, status, progress_status, customer_id, location_id, route_id, driver_id, agreement_id, arrived_at, completed_at, exception_reason, exception_notes, notes, sequence")
      .eq("customer_id", customerId).order("scheduled_date", { ascending: false }).limit(10)
      .returns<Job[]>(),
    showInvoices
      ? supabase.from("invoices")
          .select("id, invoice_number, status, issue_date, due_date, total, balance")
          .eq("customer_id", customerId).order("issue_date", { ascending: false }).limit(10)
      : Promise.resolve({ data: [] as Pick<Invoice, "id" | "invoice_number" | "status" | "issue_date" | "due_date" | "total" | "balance">[] }),
  ]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Recent jobs">
        <DataTable
          rows={jobs.data ?? []}
          rowHref={(row) => `/jobs/${row.id}`}
          empty={<EmptyState title="No jobs recorded yet" />}
          columns={[
            { header: "Job", cell: (row) => row.job_number },
            { header: "Date", cell: (row) => date(row.scheduled_date) },
            { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
          ]}
        />
      </Card>

      {showInvoices ? (
        <Card title="Recent invoices"
              actions={<Link href={`/invoices?customer=${customerId}`} className="text-sm text-primary hover:underline">All</Link>}>
          <DataTable
            rows={invoices.data ?? []}
            rowHref={(row) => `/invoices/${row.id}`}
            empty={<EmptyState title="No invoices yet" />}
            columns={[
              { header: "Invoice", cell: (row) => row.invoice_number },
              { header: "Total", cell: (row) => money(row.total), align: "right" },
              { header: "Balance", cell: (row) => money(row.balance), align: "right", hideBelow: "sm" },
              { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}
