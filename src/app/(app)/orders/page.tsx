import { Suspense } from "react";
import Link from "next/link";
import { requireCapability, requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date as formatDate, dateTime } from "@/lib/format";
import { listMembers, memberNames } from "@/lib/directory";
import {
  ORDER_PRIORITIES, ORDER_STATUSES, ORDER_STATUS_LABELS, PRIORITY_LABELS,
  isOverdue, summariseItems,
} from "@/lib/domain/laundry-orders";
import {
  addDays, businessToday, formatAdelaideDate, toInstant, weekBounds,
} from "@/lib/domain/timezone";
import {
  Badge, ButtonLink, CONTROL, DataTable, EmptyState, Notice,
  PageHeader, SkeletonRows, SkeletonStats, Stat, StatusBadge, cx,
} from "@/components/ui";
import { Pagination, pageFrom, rangeFor } from "@/components/list-controls";
import { listActiveBoards } from "@/lib/runs/my-runs";

export const metadata = { title: "Customer laundry" };
export const dynamic = "force-dynamic";

type Search = {
  q?: string;
  status?: string;
  priority?: string;
  customer?: string;
  when?: string;
  date?: string;
  /** Assignment state: "unassigned", "assigned", or "ready-unassigned". */
  run?: string;
  /** A specific assigned board. */
  board?: string;
  /** A specific assigned delivery date. */
  assigned?: string;
  page?: string;
};

/** Every filter this list understands — one list, so nothing is forgotten. */
function isFiltered(params: Search): boolean {
  return Boolean(
    params.q || params.status || params.priority || params.customer
    || params.when || params.date || params.run || params.board || params.assigned,
  );
}

type Row = {
  id: string;
  order_number: string;
  status: string;
  priority: string;
  received_at: string;
  due_date: string | null;
  expected_delivery_date: string | null;
  delivery_required: boolean;
  assigned_to: string | null;
  /**
   * Who is delivering this job and when — read straight off the job, because
   * since 0016 that is where the assignment lives. No embed, no join through the
   * routing module, and therefore nothing that can disagree with what My Runs
   * shows the board.
   */
  assigned_board_id: string | null;
  assigned_delivery_date: string | null;
  boards: { id: string; name: string } | null;
  customers: { id: string; business_name: string; trading_name: string | null } | null;
  laundry_order_items: Array<{
    item_type: string;
    custom_description: string | null;
    quantity_type: string;
    exact_quantity: number | null;
    bag_count: number | null;
    estimated_quantity: number | null;
  }>;
};

export default async function JobsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("orders.read");

  return (
    <div>
      <PageHeader
        title="Customer laundry"
        description="Laundry people have left with us, from the counter through to getting it back to them."
        actions={can(session.role, "orders.write")
          ? <ButtonLink href="/orders/new" variant="primary">Take in laundry</ButtonLink>
          : null}
      />

      <Suspense fallback={<div className="mb-4"><SkeletonStats count={7} /></div>}>
        <SummaryStrip />
      </Suspense>

      <Filters params={params} />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <JobList params={params} canCreate={can(session.role, "orders.write")} />
      </Suspense>
    </div>
  );
}

/* ------------------------------------------------------------------ cards */

/**
 * Seven head-only counts. Every one is a query against the database rather than a
 * tally of the page's rows — a summary computed from the current page would
 * quietly mean "on this page", which is the sort of number people make decisions
 * on and should not.
 *
 * Each card is a link that applies its own filter to the list below, so the
 * number and the rows behind it can never disagree.
 */
async function SummaryStrip() {
  const supabase = await createClient();
  const today = businessToday();
  const head = { count: "exact" as const, head: true };
  const notFinished = ["status", "in", "(completed,cancelled)"] as const;

  const [fresh, working, ready, assigned, out, completedToday, overdue] = await Promise.all([
    supabase.from("laundry_orders").select("id", head).eq("status", "new"),
    supabase.from("laundry_orders").select("id", head).eq("status", "in_progress"),
    supabase.from("laundry_orders").select("id", head).eq("status", "ready_for_delivery"),
    supabase.from("laundry_orders").select("id", head).eq("status", "assigned"),
    supabase.from("laundry_orders").select("id", head).eq("status", "out_for_delivery"),
    supabase.from("laundry_orders").select("id", head)
      .eq("status", "completed")
      // "Today" is the laundry's day, not UTC's: the boundary is midnight in the
      // business timezone, converted to the instant the column is stored in.
      .gte("completed_at", toInstant(today, "00:00"))
      .lt("completed_at", toInstant(addDays(today, 1), "00:00")),
    supabase.from("laundry_orders").select("id", head)
      .lt("due_date", today).not(...notFinished),
  ]);

  const cards = [
    { label: "New", value: fresh.count, href: "/orders?status=new" },
    { label: "In progress", value: working.count, href: "/orders?status=in_progress" },
    { label: "Ready", value: ready.count, href: "/orders?status=ready_for_delivery" },
    { label: "Assigned", value: assigned.count, href: "/orders?status=assigned" },
    { label: "Out for delivery", value: out.count, href: "/orders?status=out_for_delivery" },
    { label: "Completed today", value: completedToday.count, href: "/orders?status=completed" },
    { label: "Overdue", value: overdue.count, href: "/orders?when=overdue", danger: true },
  ];

  // Separate cards rather than one joined strip: the strip left an empty grey
  // cell whenever the count did not fill the row, and square corners among
  // rounded panels everywhere else.
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {cards.map((card) => (
        <Stat
          key={card.label}
          label={card.label}
          value={card.value ?? 0}
          href={card.href}
          tone={card.danger && (card.value ?? 0) > 0 ? "danger" : "default"}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- filters */

const WHEN_OPTIONS = [
  { value: "", label: "Any date" },
  { value: "today", label: "Due today" },
  { value: "tomorrow", label: "Due tomorrow" },
  { value: "week", label: "Due this week" },
  { value: "overdue", label: "Overdue" },
];

const RUN_OPTIONS = [
  { value: "", label: "Any assignment" },
  { value: "ready-unassigned", label: "Ready for delivery — unassigned" },
  { value: "unassigned", label: "No board" },
  { value: "assigned", label: "Has a board" },
];

/**
 * One GET form carrying every filter, so the filtered list lives in the URL and
 * survives a bookmark, a share and a page of results.
 *
 * Written here rather than through `ListControls` for one reason: the custom
 * date filter needs a date picker, and that component only renders selects. It
 * uses the same shared `CONTROL` skin, so it is the same control as every other
 * input in the app — which is the drift `ListControls` exists to prevent.
 */
async function Filters({ params }: { params: Search }) {
  const session = await requireSession();
  const supabase = await createClient();
  const [{ data: customers }, boards] = await Promise.all([
    supabase
      .from("customers")
      .select("id, business_name")
      .eq("tenant_id", session.tenantId)
      .is("deleted_at", null)
      .order("business_name")
      .limit(200)
      .returns<{ id: string; business_name: string }[]>(),
    listActiveBoards(supabase, session.tenantId),
  ]);

  return (
    <form method="get" action="/orders" className="mb-4 flex flex-wrap items-end gap-2">
      <div className="min-w-[14rem] flex-1">
        <label htmlFor="q" className="sr-only">Search jobs</label>
        <input id="q" name="q" type="search" defaultValue={params.q} className={CONTROL}
               placeholder="Job number, customer, phone or email…" />
      </div>

      <div>
        <label htmlFor="status" className="sr-only">Status</label>
        <select id="status" name="status" defaultValue={params.status ?? ""}
                className={cx(CONTROL, "w-auto")}>
          <option value="">Any status</option>
          {ORDER_STATUSES.map((value) => (
            <option key={value} value={value}>{ORDER_STATUS_LABELS[value]}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="priority" className="sr-only">Priority</label>
        <select id="priority" name="priority" defaultValue={params.priority ?? ""}
                className={cx(CONTROL, "w-auto")}>
          <option value="">Any priority</option>
          {ORDER_PRIORITIES.map((value) => (
            <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="customer" className="sr-only">Customer</label>
        <select id="customer" name="customer" defaultValue={params.customer ?? ""}
                className={cx(CONTROL, "w-auto max-w-[14rem]")}>
          <option value="">Any customer</option>
          {(customers ?? []).map((customer) => (
            <option key={customer.id} value={customer.id}>{customer.business_name}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="when" className="sr-only">Due</label>
        <select id="when" name="when" defaultValue={params.when ?? ""}
                className={cx(CONTROL, "w-auto")}>
          {WHEN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="run" className="sr-only">Delivery run</label>
        <select id="run" name="run" defaultValue={params.run ?? ""}
                className={cx(CONTROL, "w-auto")}>
          {RUN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="board" className="sr-only">Assigned board</label>
        <select id="board" name="board" defaultValue={params.board ?? ""}
                className={cx(CONTROL, "w-auto max-w-[12rem]")}>
          <option value="">Any board</option>
          {boards.map((board) => (
            <option key={board.id} value={board.id}>{board.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="date" className="sr-only">Due on a specific date</label>
        <input id="date" name="date" type="date" defaultValue={params.date}
               className={cx(CONTROL, "w-auto")} title="Due date" />
      </div>

      <div>
        <label htmlFor="assigned" className="sr-only">Assigned delivery date</label>
        <input id="assigned" name="assigned" type="date" defaultValue={params.assigned}
               className={cx(CONTROL, "w-auto")} title="Assigned delivery date" />
      </div>

      <button type="submit"
              className="rounded-lg inline-flex min-h-9 items-center border border-strong bg-surface px-3 py-1.5
 text-sm font-medium transition hover:bg-surface-muted">
        Search
      </button>
      {isFiltered(params) ? (
        <Link href="/orders"
              className="inline-flex min-h-9 items-center px-2 text-sm text-primary hover:underline">
          Clear
        </Link>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------- list */

async function JobList({ params, canCreate }: { params: Search; canCreate: boolean }) {
  const session = await requireSession();
  const supabase = await createClient();
  const today = businessToday();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("laundry_orders")
    .select(
      "id, order_number, status, priority, received_at, due_date, expected_delivery_date, " +
      "delivery_required, assigned_to, assigned_board_id, assigned_delivery_date, " +
      "customers(id, business_name, trading_name), " +
      // Disambiguated by constraint name on purpose. Since 0016 `laundry_orders`
      // has two foreign keys to `drivers` and one to `boards`, so every embed
      // on it is named. An ambiguous one is rejected by
      // PostgREST at request time: compile-clean, test-clean and dead in
      // production (see the 2026-08-05 changelog).
      "boards!laundry_orders_assigned_board_id_fkey(id, name), " +
      "laundry_order_items(item_type, custom_description, quantity_type, exact_quantity, " +
      "bag_count, estimated_quantity)",
      { count: "exact" },
    )
    // This laundry's jobs. For ten of the eleven roles RLS already says so;
    // for a platform admin it does not (0019), and a list mixing two
    // businesses' jobs is how one of them gets worked on from inside the other.
    .eq("tenant_id", session.tenantId)
    .order("received_at", { ascending: false })
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.priority) query = query.eq("priority", params.priority);
  if (params.customer) query = query.eq("customer_id", params.customer);

  // The date filters all read the generated `due_date`, which is already the
  // delivery date or the collection date depending on the job's workflow — so
  // "due tomorrow" means the same thing on both kinds of job.
  if (params.when === "today") query = query.eq("due_date", today);
  else if (params.when === "tomorrow") query = query.eq("due_date", addDays(today, 1));
  else if (params.when === "week") {
    const { start, end } = weekBounds(today);
    query = query.gte("due_date", start).lte("due_date", end);
  } else if (params.when === "overdue") {
    query = query.lt("due_date", today).not("status", "in", "(completed,cancelled)");
  }
  if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    query = query.eq("due_date", params.date);
  }

  // Assignment state. "Ready for delivery, unassigned" is one option rather than
  // two filters the user has to know to combine, because it is *the* question
  // the office asks every morning: what is ready to go out and given to nobody?
  if (params.run === "unassigned") query = query.is("assigned_board_id", null);
  else if (params.run === "assigned") query = query.not("assigned_board_id", "is", null);
  else if (params.run === "ready-unassigned") {
    query = query.is("assigned_board_id", null)
      .eq("delivery_required", true)
      .eq("status", "ready_for_delivery");
  }
  if (params.board) query = query.eq("assigned_board_id", params.board);
  if (params.assigned && /^\d{4}-\d{2}-\d{2}$/.test(params.assigned)) {
    query = query.eq("assigned_delivery_date", params.assigned);
  }

  if (params.q) {
    const term = `%${params.q.trim()}%`;
    // Customer details live on the customer row, so they are resolved to ids
    // first and folded into one `or` — the alternative, filtering the embedded
    // resource, narrows the embed rather than the list of jobs.
    const { data: matches } = await supabase
      .from("customers")
      .select("id")
      .is("deleted_at", null)
      .or(
        `business_name.ilike.${term},trading_name.ilike.${term},` +
        `phone.ilike.${term},billing_email.ilike.${term},customer_number.ilike.${term}`,
      )
      .limit(100)
      .returns<{ id: string }[]>();

    const ids = (matches ?? []).map((row) => row.id);
    query = ids.length
      ? query.or(`order_number.ilike.${term},customer_id.in.(${ids.join(",")})`)
      : query.ilike("order_number", term);
  }

  const { data, count, error } = await query.returns<Row[]>();
  if (error) {
    // Never the raw SQL: the operator gets a sentence, the log gets the rest.
    console.error("job list query failed", error.message);
    return (
      <Notice tone="danger" title="That list could not be loaded">
        Something went wrong fetching your jobs. Try again, or narrow the filters.
      </Notice>
    );
  }

  // Every member, not just the pickable ones: this renders who a job is
  // assigned to, and a record must still name somebody the picker no
  // longer offers.
  const names = memberNames(await listMembers());
  const filtered = isFiltered(params);

  return (
    <>
      <DataTable
        label="Jobs"
        rows={data ?? []}
        rowHref={(row) => `/orders/${row.id}`}
        rowClassName={(row) => (isOverdue(row, today) ? "border-l-[3px] border-l-danger" : "")}
        empty={
          <EmptyState
            title={filtered ? "No jobs match those filters" : "No jobs yet"}
            description={filtered
              ? "Try a broader search, or clear the filters."
              : "Take in a customer's laundry and it appears here, with its own job number."}
            action={canCreate && !filtered
              ? <ButtonLink href="/orders/new" variant="primary">Create new job</ButtonLink>
              : null}
          />
        }
        columns={[
          { header: "Job", cell: (row) => row.order_number },
          {
            header: "Customer",
            cell: (row) => row.customers?.business_name ?? "—",
          },
          {
            header: "Laundry",
            cell: (row) => summariseItems(row.laundry_order_items ?? []),
            hideBelow: "lg",
          },
          { header: "Received", cell: (row) => dateTime(row.received_at), hideBelow: "lg" },
          {
            // One column for both workflows, because a job has exactly one date
            // that matters and which column it comes from is an implementation
            // detail the counter should never have to hold in their head.
            header: "Due",
            cell: (row) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <span>{row.due_date ? formatDate(row.due_date) : "Not set"}</span>
                {isOverdue(row, today) ? <Badge tone="danger">Late</Badge> : null}
                {!row.delivery_required ? <Badge>Pickup</Badge> : null}
              </span>
            ),
          },
          {
            header: "Priority",
            cell: (row) => (row.priority === "urgent"
              ? <Badge tone="warning">Urgent</Badge>
              : <span className="text-muted-foreground">Normal</span>),
            hideBelow: "md",
          },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
          {
            header: "Looked after by",
            cell: (row) => (row.assigned_to ? names.get(row.assigned_to) ?? "—" : "—"),
            hideBelow: "lg",
          },
          {
            // Who is delivering it, and on what day. A pickup job says so
            // instead of reading as work nobody has picked up — it is not
            // delivery work and never will be.
            header: "Driver",
            cell: (row) => <AssignmentCell row={row} />,
            hideBelow: "md",
          },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/orders" />
    </>
  );
}

function AssignmentCell({ row }: { row: Row }) {
  if (!row.delivery_required) return <span className="text-muted-foreground">Pickup</span>;
  if (!row.assigned_board_id) return <Badge>Unassigned</Badge>;

  return (
    <span className="flex flex-col">
      <span>{row.boards?.name ?? "Assigned"}</span>
      <span className="text-sm text-muted-foreground">
        {formatAdelaideDate(row.assigned_delivery_date, "short")}
      </span>
    </span>
  );
}
