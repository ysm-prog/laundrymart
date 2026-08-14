import Link from "next/link";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can, type Role } from "@/lib/roles";
import { date as formatDate, money } from "@/lib/format";
import { Card, EmptyState, Notice, PageHeader, StatusBadge } from "@/components/ui";

export const metadata = { title: "Search" };
export const dynamic = "force-dynamic";

/**
 * One box, everything with a name or a number on it.
 *
 * The context bar has always had a search field; it submitted to the customers
 * list, so typing an invoice number into the only search box in the app
 * returned "no customers match those filters". People stop trusting a search
 * that answers a different question than the one asked.
 *
 * Every group is capability-gated the same way its own screen is, and each
 * query is a plain `ilike` against a column the operator can actually see on a
 * document — a customer name, an invoice number, a rego. No full-text index is
 * needed at this size, and adding one would be a schema change in a pass that
 * deliberately makes none.
 */

const LIMIT = 6;

type Group = {
  label: string;
  hint: string;
  rows: Array<{ href: string; title: string; detail: string; trailing?: React.ReactNode }>;
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const session = await requireSession();
  const term = (q ?? "").trim();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Search"
        description="Type a business name, an invoice number, a stop number or a rego."
      />

      {/* Repeated here rather than only in the context bar: the bar's field is
          hidden below `sm`, and search is the screen a phone user lands on. */}
      <form action="/search" className="flex gap-2">
        <label htmlFor="q" className="sr-only">Search</label>
        <input
          id="q" name="q" type="search" defaultValue={term} autoFocus
          placeholder="Harbour Hotel · INV-0042 · ABC123"
          className="rounded-lg min-h-9 w-full max-w-[520px] border border-strong bg-surface-muted px-2.5 py-1.5
 text-sm placeholder:text-muted-foreground"
        />
        <button type="submit"
                className="rounded-lg min-h-9 bg-action px-3 py-1.5 text-sm font-medium text-action-foreground">
          Search
        </button>
      </form>

      {term.length === 0 ? (
        <Notice tone="info" title="What you can look up">
          Customers and their sites, contracts, invoices, stops, item types,
          drivers and vehicles — whatever your role can already open.
        </Notice>
      ) : (
        <Results term={term} role={session.role} />
      )}
    </div>
  );
}

async function Results({ term, role }: { term: string; role: Role }) {
  const groups = await search(term, role);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  if (total === 0) {
    return (
      <EmptyState
        title={`Nothing found for “${term}”`}
        description="Check the spelling, or try part of the name — a search for “harb” finds “Harbour Hotel”."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {total} match{total === 1 ? "" : "es"} for “{term}”.
      </p>
      {groups.map((group) => (
        <Card key={group.label} title={group.label} description={group.hint} className="[&>div]:p-0">
          <ul>
            {group.rows.map((row) => (
              <li key={row.href} className="border-b last:border-b-0">
                <Link href={row.href}
                      className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5
 transition hover:bg-surface-muted">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{row.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
                  </span>
                  {row.trailing ? <span className="shrink-0">{row.trailing}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

/**
 * PostgREST's `or=` filter takes a comma-separated list, so a comma or a
 * parenthesis in the term would be read as filter syntax rather than as text.
 * Strip those and the `%`/`_` wildcards, then wrap the remainder ourselves.
 */
function pattern(term: string): string {
  return `%${term.replace(/[,()%_*\\]/g, " ").trim()}%`;
}

async function search(term: string, role: Role): Promise<Group[]> {
  const supabase = await createClient();
  const like = pattern(term);
  if (like === "%%") return [];

  const groups: Group[] = [];

  const [customers, agreements, invoices, jobs, items, drivers, vehicles] = await Promise.all([
    can(role, "customers.read")
      ? supabase.from("customers")
          .select("id, customer_number, business_name, trading_name, billing_suburb, status")
          .or(`business_name.ilike.${like},trading_name.ilike.${like},customer_number.ilike.${like}`)
          .is("deleted_at", null).order("business_name").limit(LIMIT)
          .returns<Array<{
            id: string; customer_number: string; business_name: string;
            trading_name: string | null; billing_suburb: string | null; status: string;
          }>>()
      : empty(),
    can(role, "agreements.read")
      ? supabase.from("service_agreements")
          .select("id, agreement_number, status, start_date, customers(business_name)")
          .ilike("agreement_number", like)
          .is("deleted_at", null).order("agreement_number").limit(LIMIT)
          .returns<Array<{
            id: string; agreement_number: string; status: string; start_date: string;
            customers: { business_name: string } | null;
          }>>()
      : empty(),
    can(role, "invoices.read")
      ? supabase.from("invoices")
          .select("id, invoice_number, status, issue_date, balance, customers(business_name)")
          .ilike("invoice_number", like)
          .is("deleted_at", null).order("issue_date", { ascending: false }).limit(LIMIT)
          .returns<Array<{
            id: string; invoice_number: string; status: string; issue_date: string;
            balance: number; customers: { business_name: string } | null;
          }>>()
      : empty(),
    can(role, "routes.read")
      ? supabase.from("jobs")
          .select("id, job_number, scheduled_date, service_type, status, customers(business_name)")
          .ilike("job_number", like)
          .is("deleted_at", null).order("scheduled_date", { ascending: false }).limit(LIMIT)
          .returns<Array<{
            id: string; job_number: string; scheduled_date: string; service_type: string;
            status: string; customers: { business_name: string } | null;
          }>>()
      : empty(),
    can(role, "items.read")
      ? supabase.from("items")
          .select("id, sku, name, category")
          .or(`name.ilike.${like},sku.ilike.${like}`)
          .is("deleted_at", null).order("name").limit(LIMIT)
          .returns<Array<{ id: string; sku: string; name: string; category: string }>>()
      : empty(),
    can(role, "fleet.read")
      ? supabase.from("drivers")
          .select("id, full_name, employee_number, status")
          .or(`full_name.ilike.${like},employee_number.ilike.${like}`)
          .is("deleted_at", null).order("full_name").limit(LIMIT)
          .returns<Array<{
            id: string; full_name: string; employee_number: string | null; status: string;
          }>>()
      : empty(),
    can(role, "fleet.read")
      ? supabase.from("vehicles")
          .select("id, registration, make, model, maintenance_status")
          .or(`registration.ilike.${like},make.ilike.${like},model.ilike.${like}`)
          .is("deleted_at", null).order("registration").limit(LIMIT)
          .returns<Array<{
            id: string; registration: string; make: string | null;
            model: string | null; maintenance_status: string;
          }>>()
      : empty(),
  ]);

  push(groups, "Customers", "Businesses you collect from", (customers.data ?? []).map((row) => ({
    href: `/customers/${row.id}`,
    title: row.business_name,
    detail: [row.customer_number, row.trading_name, row.billing_suburb].filter(Boolean).join(" · "),
    trailing: <StatusBadge status={row.status} />,
  })));

  push(groups, "Contracts", "What you have agreed to do, and for how much",
    (agreements.data ?? []).map((row) => ({
      href: `/agreements/${row.id}`,
      title: `${row.agreement_number} · ${row.customers?.business_name ?? "Unknown customer"}`,
      detail: `Starts ${formatDate(row.start_date)}`,
      trailing: <StatusBadge status={row.status} />,
    })));

  push(groups, "Invoices", "Bills raised against a customer",
    (invoices.data ?? []).map((row) => ({
      href: `/invoices/${row.id}`,
      title: `${row.invoice_number} · ${row.customers?.business_name ?? "Unknown customer"}`,
      detail: `Issued ${formatDate(row.issue_date)} · ${money(row.balance)} outstanding`,
      trailing: <StatusBadge status={row.status} />,
    })));

  push(groups, "Stops", "Visits to a customer", (jobs.data ?? []).map((row) => ({
    href: `/jobs/${row.id}`,
    title: `${row.job_number} · ${row.customers?.business_name ?? "Unknown customer"}`,
    detail: `${formatDate(row.scheduled_date)} · ${row.service_type.replace(/_/g, " ")}`,
    trailing: <StatusBadge status={row.status} />,
  })));

  push(groups, "Item types", "The linen you handle", (items.data ?? []).map((row) => ({
    href: `/items/${row.id}`,
    title: row.name,
    detail: `${row.sku} · ${row.category.replace(/_/g, " ")}`,
  })));

  push(groups, "Drivers", "People who drive", (drivers.data ?? []).map((row) => ({
    href: "/drivers",
    title: row.full_name,
    detail: row.employee_number ?? "No employee number",
    trailing: <StatusBadge status={row.status} />,
  })));

  push(groups, "Vehicles", "Trucks and trailers", (vehicles.data ?? []).map((row) => ({
    href: "/vehicles",
    title: row.registration,
    detail: [row.make, row.model].filter(Boolean).join(" ") || "No make recorded",
    trailing: <StatusBadge status={row.maintenance_status} />,
  })));

  return groups;
}

function push(groups: Group[], label: string, hint: string, rows: Group["rows"]) {
  if (rows.length > 0) groups.push({ label, hint, rows });
}

/** A role that cannot open a group contributes no rows rather than no page. */
function empty() {
  return Promise.resolve({ data: [] as never[] });
}
