import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { counted, date, money, number } from "@/lib/format";
import { archiveTableLabel } from "@/lib/archive";
import { looksLikeTestCustomer, parseCustomerList } from "@/lib/domain/test-data";
import { planPricingBackfill, planTestDataCleanup, BACKFILL_LIMIT } from "@/lib/admin/tidy";
import { DEFAULT_LATE_CUTOFF } from "@/lib/admin/tidy-defaults";
import {
  Badge, ButtonLink, CONTROL, Card, DataTable, EmptyState, Eyebrow, Notice, PageHeader, Stat, cx,
} from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/form";
import {
  archiveRecords, clearTestData, priceFinishedJobs, restoreRecords,
} from "./actions";

export const metadata = { title: "Your records" };
export const dynamic = "force-dynamic";

type Count = { table_name: string; archived: number; live: number };

/** The three rows an operator recognises. The rest are their paperwork. */
const HEADLINE = [
  { table: "customers", label: "Customers" },
  { table: "laundry_orders", label: "Jobs" },
  { table: "invoices", label: "Invoices" },
] as const;

/**
 * Hide the business records, and bring them back (0017).
 *
 * The screen exists because the archive is reversible and the operator has to
 * be able to see that it is: the counts are read through
 * `archived_record_counts()`, which reports the hidden rows *because* they are
 * hidden — an ordinary query cannot see them, by design. A screen that showed
 * nothing after an archive would look exactly like a screen that had deleted
 * everything, and the difference is the entire feature.
 */
type Search = { check?: string; customers?: string; cutoff?: string };

export default async function DataPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("admin.write");
  const params = await searchParams;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("archived_record_counts", { t: session.tenantId });

  const counts: Count[] = Array.isArray(data) ? (data as Count[]) : [];
  const total = (key: "archived" | "live") =>
    counts.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);

  const archivedTotal = total("archived");
  const liveTotal = total("live");
  const isArchived = archivedTotal > 0;

  const find = (table: string) => counts.find((row) => row.table_name === table);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Your records"
        description="Hide your records while you show the app around, price finished jobs in one go, and clear out test data. Each tool shows what it would do before it does anything."
      />

      {error ? (
        <Notice tone="danger" title="Could not read your records">
          {error.message}
        </Notice>
      ) : (
        <div className="space-y-4">
          {isArchived ? (
            <Notice tone="warning" title="Your records are hidden right now">
              {number(archivedTotal)} rows are archived. Nobody signed in can see them —
              not you, not your office, not your drivers — and nothing has been deleted.
              Restore them below whenever you want them back.
            </Notice>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            {HEADLINE.map(({ table, label }) => {
              const row = find(table);
              const live = Number(row?.live ?? 0);
              const archived = Number(row?.archived ?? 0);
              return (
                <Stat
                  key={table}
                  label={label}
                  value={number(isArchived ? archived : live)}
                  tone={isArchived ? "warning" : "default"}
                  hint={isArchived ? "hidden" : "visible in the app"}
                />
              );
            })}
          </div>

          <Card
            title={isArchived ? "Bring your records back" : "Hide your records"}
            description={
              isArchived
                ? "Everything that was archived becomes visible again, exactly as it was."
                : "Your customers, their contracts, their jobs and every invoice stop appearing anywhere in the app."
            }
          >
            <div className="space-y-4">
              <div>
                <Eyebrow>What this covers</Eyebrow>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Customers and their sites and contacts, their contracts, the laundry jobs
                  taken in for them, the stops and rounds made to them, and every invoice,
                  payment and credit note. Your sites, linen types, vehicles, drivers, people
                  and settings are left alone, so the app still knows how you work.
                </p>
              </div>

              {isArchived ? (
                <form action={restoreRecords}>
                  <ConfirmSubmit
                    label="Restore my records"
                    variant="primary"
                    eyebrow="This puts the real data back"
                    consequence={`${number(archivedTotal)} rows become visible again to everyone who can already see that part of the app.`}
                    pendingLabel="Restoring…"
                  />
                </form>
              ) : (
                <form action={archiveRecords}>
                  <ConfirmSubmit
                    label="Hide my records"
                    variant="primary"
                    eyebrow="This can be undone"
                    consequence={
                      liveTotal > 0
                        ? `${number(liveTotal)} rows are hidden from everyone until you restore them. Nothing is deleted, and this screen will bring them back.`
                        : "There is nothing to hide yet — no customers, jobs or invoices have been entered."
                    }
                    pendingLabel="Hiding…"
                  />
                </form>
              )}
            </div>
          </Card>

          <PricingBackfill tenantId={session.tenantId} checking={params.check === "pricing"} />

          <TestDataCleanup
            tenantId={session.tenantId}
            checking={params.check === "testdata"}
            customersText={params.customers ?? ""}
            cutoff={params.cutoff && /^\d{4}-\d{2}-\d{2}$/.test(params.cutoff) ? params.cutoff : DEFAULT_LATE_CUTOFF}
          />

          <Card
            title="Everything that gets archived"
            description="The full list, and how much of each is currently hidden."
          >
            <ul className="divide-y text-sm">
              {counts.map((row) => (
                <li key={row.table_name} className="flex items-center justify-between gap-4 py-2">
                  <span>{archiveTableLabel(row.table_name)}</span>
                  <span className="text-muted-foreground">
                    {Number(row.archived) > 0
                      ? `${number(Number(row.archived))} hidden`
                      : `${number(Number(row.live))} visible`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

/**
 * Price the finished jobs still waiting for one (brief 1.3) — the backlog from
 * before jobs were priced automatically on completion. Dry run first: the
 * button that prices appears only beside the list of what it would do.
 */
async function PricingBackfill({ tenantId, checking }: { tenantId: string; checking: boolean }) {
  if (!checking) {
    return (
      <Card title="Price finished jobs"
            description="Jobs are now priced the moment they are finished. This prices the ones finished before that, the same way Price this job does. It never approves anything.">
        <ButtonLink href="/admin/data?check=pricing">Check what it would do</ButtonLink>
      </Card>
    );
  }

  const supabase = await createClient();
  const { candidates, total } = await planPricingBackfill(supabase, tenantId);
  const full = candidates.filter((row) => row.outcome === "priced").length;
  const partly = candidates.filter((row) => row.outcome === "partly").length;
  const nothing = candidates.filter((row) => row.outcome === "nothing").length;

  return (
    <Card title="Price finished jobs"
          description="Nothing has been changed yet. This is what pricing them now would do."
          actions={<Link href="/admin/data" className="text-sm text-primary hover:underline">Close</Link>}>
      {candidates.length === 0 ? (
        <EmptyState title="Nothing to price" description="Every finished job awaiting review already has charges." />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Priced in full" value={String(full)} hint="Ready to check and approve" />
            <Stat label="Partly priced" value={String(partly)} hint="Go on the Needs a price list"
                  tone={partly > 0 ? "warning" : "default"} />
            <Stat label="Nothing to price it by" value={String(nothing)} hint="Go on the Needs a price list"
                  tone={nothing > 0 ? "warning" : "default"} />
          </div>
          {total > candidates.length ? (
            <Notice tone="info">
              {total} jobs are waiting; this does the oldest {BACKFILL_LIMIT}. Run it again for the rest.
            </Notice>
          ) : null}
          <DataTable
            rows={candidates}
            empty={<EmptyState title="Nothing to price" />}
            columns={[
              {
                header: "Job",
                cell: (row) => (
                  <Link href={`/orders/${row.id}`} className="font-medium text-primary hover:underline">
                    {row.orderNumber}
                  </Link>
                ),
              },
              { header: "Customer", cell: (row) => row.customerName },
              { header: "Finished", cell: (row) => date(row.completedAt), hideBelow: "sm" },
              {
                header: "Would be",
                cell: (row) => row.outcome === "priced"
                  ? <Badge tone="success">Priced</Badge>
                  : row.outcome === "partly"
                    ? <Badge tone="warning">{`Partly — ${counted(row.unpriced, "row")} unpriced`}</Badge>
                    : <Badge tone="warning">Needs a price</Badge>,
              },
              { header: "Value", cell: (row) => row.lines > 0 ? money(row.subtotal) : "—", align: "right" },
            ]}
          />
          <form action={priceFinishedJobs}>
            <ConfirmSubmit
              label={`Price ${counted(candidates.length, "job")}`}
              variant="primary"
              eyebrow="Nothing is approved"
              consequence={`Charges are written onto ${counted(candidates.length, "job")} exactly as Price this job would. Each one still waits for you to check and approve it.`}
              cancelLabel="Not now"
              pendingLabel="Pricing…"
            />
          </form>
        </div>
      )}
    </Card>
  );
}

/**
 * Clear out test data (brief 1.8, gap G10). The list is typed, never assumed —
 * Darshan confirms which customers are test records before this runs on the
 * real laundry — and the dry run shows every invoice, job and customer it will
 * touch before the button that acts appears.
 */
async function TestDataCleanup({
  tenantId, checking, customersText, cutoff,
}: { tenantId: string; checking: boolean; customersText: string; cutoff: string }) {
  const supabase = await createClient();
  const { data: customerNames } = await supabase
    .from("customers").select("customer_number, business_name")
    .eq("tenant_id", tenantId).neq("status", "archived")
    .returns<Array<{ customer_number: string; business_name: string }>>();
  const suggestions = (customerNames ?? []).filter((row) => looksLikeTestCustomer(row.business_name));
  const entries = parseCustomerList(customersText);
  const plan = checking ? await planTestDataCleanup(supabase, tenantId, entries, cutoff) : null;

  const totals = plan ? {
    customers: plan.customers.length,
    voids: plan.customers.reduce((sum, row) => sum + row.voids.length, 0),
    blocked: plan.customers.reduce((sum, row) => sum + row.blocked.length, 0),
    cancels: plan.customers.reduce((sum, row) => sum + row.cancels.length, 0),
    writeOffs: plan.customers.reduce((sum, row) => sum + row.writeOffs.length, 0),
  } : null;

  return (
    <Card title="Clear out test data"
          description="Archives test customers, voids their invoices with the reason “Test data” (never deletes them), and cancels their open jobs. Check the list before you run it — this is the real laundry.">
      <form method="get" action="/admin/data" className="space-y-3">
        <input type="hidden" name="check" value="testdata" />
        <label className="block">
          <span className="text-sm font-medium">The customers to clear, one per line</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            The name exactly as it is on the customer’s record, or their customer number. Nothing else is matched.
          </span>
          <textarea name="customers" rows={5} defaultValue={customersText}
                    placeholder="CUST00515"
                    className={cx(CONTROL, "mt-1.5 font-normal")} />
        </label>
        <label className="block max-w-xs">
          <span className="text-sm font-medium">Late jobs are those still on a round dated before</span>
          <input type="date" name="cutoff" defaultValue={cutoff} className={cx(CONTROL, "mt-1.5")} />
        </label>
        <SubmitButton variant="secondary" size="md" pendingLabel="Checking…">Check what it would do</SubmitButton>
      </form>

      {suggestions.length > 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Names that look like test data:{" "}
          {suggestions.map((row) => `${row.business_name} (${row.customer_number})`).join(", ")}.
          These are only suggestions.
        </p>
      ) : null}

      {plan && totals ? (
        <div className="mt-6 space-y-4 border-t pt-4">
          <Eyebrow>What it would do — nothing has changed yet</Eyebrow>
          {plan.notFound.length > 0 ? (
            <Notice tone="warning" title="Not found">
              No customer is called {plan.notFound.map((entry) => `“${entry}”`).join(", ")}. Check the spelling.
            </Notice>
          ) : null}
          {plan.customers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No customers matched, so no customer would be changed.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {plan.customers.map((customer) => (
                <li key={customer.id} className="space-y-1 p-3">
                  <p className="font-medium">
                    {customer.name} <span className="text-muted-foreground">· {customer.number}</span>
                  </p>
                  <p className="text-muted-foreground">
                    Archived.
                    {customer.voids.length > 0
                      ? ` Void ${customer.voids.map((invoice) => `${invoice.number} (${money(invoice.total)})`).join(", ")}.`
                      : " No invoices to void."}
                    {customer.cancels.length > 0
                      ? ` Cancel ${customer.cancels.map((job) => job.number).join(", ")}.` : ""}
                    {customer.writeOffs.length > 0
                      ? ` Take ${customer.writeOffs.map((job) => job.number).join(", ")} out of billing.` : ""}
                  </p>
                  {customer.blocked.map((invoice) => (
                    <p key={invoice.number} className="text-danger">{invoice.number} stays as it is: {invoice.reason}</p>
                  ))}
                </li>
              ))}
            </ul>
          )}

          <form action={clearTestData} className="space-y-3">
            <input type="hidden" name="customers" value={customersText} />
            <input type="hidden" name="cutoff" value={cutoff} />
            {plan.lateAssigned.length > 0 ? (
              <fieldset className="rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">
                  {counted(plan.lateAssigned.length, "job")} still waiting on a round dated before {date(cutoff)}
                </legend>
                <p className="text-sm text-muted-foreground">
                  {plan.lateAssigned.slice(0, 12).map((job) => `${job.number} (${job.customer}, ${date(job.date)})`).join(", ")}
                  {plan.lateAssigned.length > 12 ? ` and ${plan.lateAssigned.length - 12} more` : ""}.
                </p>
                <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                  <input type="checkbox" name="close_late" value="1" className="size-[1.15rem] accent-primary" />
                  Close these too — they are cancelled with a note saying why
                </label>
              </fieldset>
            ) : null}
            {totals.customers > 0 || plan.lateAssigned.length > 0 ? (
              <ConfirmSubmit
                label="Clear out this test data"
                eyebrow="Voids, cancels and archives — nothing is deleted"
                consequence={`${counted(totals.customers, "customer")} archived, ${counted(totals.voids, "invoice")} voided with the reason “Test data”, ${counted(totals.cancels, "job")} cancelled and ${counted(totals.writeOffs, "finished job")} taken out of billing.${totals.blocked > 0 ? ` ${counted(totals.blocked, "invoice")} cannot be voided and will stay as they are.` : ""}`}
                cancelLabel="Not yet"
                pendingLabel="Clearing…"
              />
            ) : null}
          </form>
        </div>
      ) : null}
    </Card>
  );
}
