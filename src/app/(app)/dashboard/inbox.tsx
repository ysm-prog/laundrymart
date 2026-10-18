import Link from "next/link";
import type { ReactNode } from "react";
import type { Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { counted, date as formatDate, money, relativeDays } from "@/lib/format";
import { Badge, CONTROL_AUTO, Card, SELECT_CHEVRON, cx, humanise } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { parseExceptionNotes } from "@/lib/exceptions";
import { arTrustedFrom, trustedReceivablesFilter } from "@/lib/domain/receivables";
import { getAdelaideToday } from "@/lib/domain/timezone";
import { nextDeliveryDay, isReadyDraft } from "@/lib/domain/automation";
import { INBOX_ROWS, INBOX_SECTIONS, moreThan, type InboxSection } from "@/lib/domain/inbox";
import { loadHolidaySet } from "@/lib/runs/holidays";
import { loadOpenDrafts } from "@/lib/invoices/open-draft";
import { loadIssueReadiness } from "@/lib/invoices/issue";
import { assignJobToBoard } from "@/app/(app)/my-runs/actions";
import { issueInvoice } from "@/app/(app)/invoices/actions";
import { IssueControl } from "@/app/(app)/invoices/issue-control";

/**
 * Today's five inbox sections (brief 3.2).
 *
 * Each is its own server component so one slow read does not hold up the
 * other four, and each reads only what it shows. Every read names the tenant
 * (§23): a platform admin's session reads every laundry, and three of these
 * sections post an id straight back into a write scoped to this one.
 */

const BACK = "/dashboard";

type Row = { key: string; who: ReactNode; what: ReactNode; action: ReactNode };

function Section({
  section, rows, total, moreHref,
}: {
  section: InboxSection; rows: Row[]; total: number; moreHref?: string;
}) {
  const meta = INBOX_SECTIONS.find((entry) => entry.key === section)!;
  const more = moreThan(total, rows.length);
  return (
    <Card
      title={meta.title}
      actions={total > 0 ? <Badge tone="warning">{total}</Badge> : <Badge tone="success">Clear</Badge>}
      bodyClassName={rows.length > 0 ? "p-0" : undefined}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{meta.empty}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.key}
                className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{row.who}</p>
                <p className="text-sm text-muted-foreground">{row.what}</p>
              </div>
              <div className="shrink-0">{row.action}</div>
            </li>
          ))}
          {more ? (
            <li className="px-5 py-3 text-sm">
              {moreHref ? (
                <Link href={moreHref} className="font-medium text-primary hover:underline">
                  {more} →
                </Link>
              ) : <span className="text-muted-foreground">{more}</span>}
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

function ActionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href}
          className="inline-flex min-h-10 items-center rounded-lg border px-3 text-sm font-medium
                     text-primary transition hover:bg-surface-muted">
      {children}
    </Link>
  );
}

/* ---------------------------------------------------------- needs a price */

export async function NeedsPrice({ session }: { session: Session }) {
  const supabase = await createClient();
  const { data, count } = await supabase
    .from("laundry_orders")
    .select("id, order_number, completed_at, customers(business_name)", { count: "exact" })
    .eq("tenant_id", session.tenantId)
    .eq("billing_hold_reason", "needs_price")
    .eq("billing_status", "awaiting_review")
    .order("completed_at", { ascending: true, nullsFirst: false })
    .limit(INBOX_ROWS)
    .returns<Array<{
      id: string; order_number: string; completed_at: string | null;
      customers: { business_name: string } | null;
    }>>();

  const rows: Row[] = (data ?? []).map((job) => ({
    key: job.id,
    who: job.customers?.business_name ?? "Unknown customer",
    what: <>{job.order_number} · finished {job.completed_at ? formatDate(job.completed_at) : "—"} · some of its laundry has no price</>,
    // The fix is a price, which is a decision about this job's lines: the
    // charges card on the job is where that is made.
    action: <ActionLink href={`/orders/${job.id}`}>Price it</ActionLink>,
  }));
  return <Section section="needs_price" rows={rows} total={count ?? rows.length}
                  moreHref="/invoices/awaiting?priced=needs_price" />;
}

/* --------------------------------------------------------- needs a driver */

/**
 * Ready delivery jobs on no round. The row carries the assignment itself — a
 * board and a day, defaulting to the same next delivery day the automatic
 * assignment would pick (2.2) — and posts to the job page's own Assign action,
 * so the eligibility rules, the activity and the audit are the same press.
 */
export async function NeedsDriver({ session }: { session: Session }) {
  const supabase = await createClient();
  const today = getAdelaideToday();
  const [jobs, boards, holidays] = await Promise.all([
    supabase.from("laundry_orders")
      .select("id, order_number, expected_delivery_date, customers(business_name, collection_board_id)",
              { count: "exact" })
      .eq("tenant_id", session.tenantId)
      .eq("status", "ready_for_delivery").eq("delivery_required", true)
      .is("assigned_board_id", null)
      .order("expected_delivery_date", { ascending: true, nullsFirst: false })
      .limit(INBOX_ROWS)
      .returns<Array<{
        id: string; order_number: string; expected_delivery_date: string | null;
        customers: { business_name: string; collection_board_id: string | null } | null;
      }>>(),
    supabase.from("boards").select("id, name")
      .eq("tenant_id", session.tenantId).eq("status", "active").is("deleted_at", null)
      .order("name").returns<Array<{ id: string; name: string }>>(),
    loadHolidaySet(supabase, session.tenantId, today),
  ]);

  const boardList = boards.data ?? [];
  const rows: Row[] = (jobs.data ?? []).map((job) => {
    const day = nextDeliveryDay(job.expected_delivery_date, today, holidays);
    return {
      key: job.id,
      who: job.customers?.business_name ?? "Unknown customer",
      what: <>{job.order_number} · wanted {job.expected_delivery_date ? formatDate(job.expected_delivery_date) : "as soon as possible"} · the customer has no round</>,
      action: boardList.length === 0 ? (
        <span className="text-sm text-muted-foreground">Add a board first</span>
      ) : (
        <form action={assignJobToBoard} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="order_id" value={job.id} />
          <input type="hidden" name="return_to" value={BACK} />
          <label className="sr-only" htmlFor={`board-${job.id}`}>Board for {job.order_number}</label>
          <select id={`board-${job.id}`} name="board_id" required
                  defaultValue={job.customers?.collection_board_id ?? boardList[0]!.id}
                  className={cx(CONTROL_AUTO, SELECT_CHEVRON)}>
            {boardList.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </select>
          <label className="sr-only" htmlFor={`day-${job.id}`}>Delivery day for {job.order_number}</label>
          <input id={`day-${job.id}`} type="date" name="assigned_delivery_date" required
                 defaultValue={day} min={today} className={CONTROL_AUTO} />
          <SubmitButton size="md" pendingLabel="Assigning…">Assign</SubmitButton>
        </form>
      ),
    };
  });
  return <Section section="needs_driver" rows={rows} total={jobs.count ?? rows.length}
                  moreHref="/orders?run=ready-unassigned" />;
}

/* ------------------------------------------------- problems and failures */

export async function Problems({ session }: { session: Session }) {
  const supabase = await createClient();
  const [stops, missing] = await Promise.all([
    supabase.from("jobs")
      .select("id, job_number, scheduled_date, exception_reason, exception_notes, customers(business_name)",
              { count: "exact" })
      .eq("tenant_id", session.tenantId).eq("status", "exception")
      .order("scheduled_date", { ascending: true }).limit(INBOX_ROWS)
      .returns<Array<{
        id: string; job_number: string; scheduled_date: string;
        exception_reason: string | null; exception_notes: string | null;
        customers: { business_name: string } | null;
      }>>(),
    supabase.from("pickup_lines")
      .select("id, missing_quantity, pickups!inner(pickup_date, job_id, customers(business_name)), items(name)")
      .eq("tenant_id", session.tenantId)
      .gt("missing_quantity", 0).order("created_at", { ascending: false }).limit(4)
      .returns<Array<{
        id: string; missing_quantity: number;
        pickups: { pickup_date: string; job_id: string; customers: { business_name: string } | null } | null;
        items: { name: string } | null;
      }>>(),
  ]);
  const writes = can(session.role, "operations.write");

  const rows: Row[] = [
    ...(stops.data ?? []).map((stop): Row => ({
      key: stop.id,
      who: stop.customers?.business_name ?? "Unknown customer",
      what: <>{stop.job_number} · {formatDate(stop.scheduled_date)} · {
        parseExceptionNotes(stop.exception_notes).note || humanise(stop.exception_reason).toLowerCase()
      }</>,
      action: <ActionLink href={`/jobs/${stop.id}`}>{writes ? "Resolve" : "Open"}</ActionLink>,
    })),
    ...(missing.data ?? []).flatMap((line): Row[] => line.pickups ? [{
      key: line.id,
      who: line.pickups.customers?.business_name ?? "Unknown customer",
      what: <>{line.missing_quantity} × {line.items?.name ?? "item"} short at collection on {formatDate(line.pickups.pickup_date)}</>,
      action: <ActionLink href={`/jobs/${line.pickups.job_id}`}>Look into it</ActionLink>,
    }] : []),
  ];
  return <Section section="problems" rows={rows}
                  total={(stops.count ?? 0) + (missing.data?.length ?? 0)}
                  moreHref="/operations/exceptions" />;
}

/* -------------------------------------------------- drafts ready to issue */

/**
 * Drafts whose period has ended and that carry something to issue — the same
 * rule Issue and send all ready uses (`isReadyDraft`). Issue is the drafts
 * board's own control, so the 1.1 gate and the confirm come with it.
 */
export async function DraftsReady({ session }: { session: Session }) {
  const supabase = await createClient();
  const today = getAdelaideToday();
  const mayIssue = can(session.role, "invoices.write");
  const mayEditSettings = can(session.role, "admin.write");
  const [drafts, readiness] = await Promise.all([
    loadOpenDrafts(supabase, session.tenantId),
    mayIssue ? loadIssueReadiness(supabase, session.tenantId, mayEditSettings) : Promise.resolve(null),
  ]);
  const ready = drafts.filter((draft) => isReadyDraft(draft, today));

  const rows: Row[] = ready.slice(0, INBOX_ROWS).map((draft) => ({
    key: draft.id,
    who: draft.customerName,
    what: <>{draft.invoiceNumber} · {counted(draft.jobCount, "job")} · {money(draft.total)}</>,
    action: mayIssue ? (
      <IssueControl invoiceId={draft.id} invoiceNumber={draft.invoiceNumber} total={draft.total}
                    action={issueInvoice} returnTo={BACK} blocked={readiness?.blocked ?? null}
                    settingsHref={mayEditSettings ? "/admin/invoicing" : null} label="Issue" />
    ) : <ActionLink href={`/invoices/${draft.id}`}>Open</ActionLink>,
  }));
  return <Section section="drafts_ready" rows={rows} total={ready.length}
                  moreHref="/invoices/drafts?stage=ready" />;
}

/* ----------------------------------------------------------------- overdue */

/** Trusted invoices only (brief 1.9): MYOB history before the trusted day is left out. */
export async function Overdue({ session }: { session: Session }) {
  const supabase = await createClient();
  const today = getAdelaideToday();
  const { data: tenant } = await supabase.from("tenants").select("settings")
    .eq("id", session.tenantId).maybeSingle<{ settings: unknown }>();
  const trusted = arTrustedFrom(tenant?.settings);

  const { data, count } = await supabase.from("invoices")
    .select("id, invoice_number, due_date, balance, customers(business_name)", { count: "exact" })
    .eq("tenant_id", session.tenantId)
    .in("status", ["issued", "part_paid", "overdue"])
    .gt("balance", 0.005).neq("invoice_type", "credit")
    .lt("due_date", today).is("deleted_at", null)
    .or(trustedReceivablesFilter(trusted))
    .order("balance", { ascending: false }).limit(INBOX_ROWS)
    .returns<Array<{
      id: string; invoice_number: string; due_date: string | null; balance: number;
      customers: { business_name: string } | null;
    }>>();

  const rows: Row[] = (data ?? []).map((invoice) => ({
    key: invoice.id,
    who: invoice.customers?.business_name ?? "Unknown customer",
    what: <>{invoice.invoice_number} · {money(invoice.balance)} · {counted(relativeDays(invoice.due_date ?? today, today), "day")} past terms</>,
    action: <ActionLink href={`/invoices/${invoice.id}`}>Chase</ActionLink>,
  }));
  return <Section section="overdue" rows={rows} total={count ?? rows.length}
                  moreHref="/invoices?status=overdue" />;
}
