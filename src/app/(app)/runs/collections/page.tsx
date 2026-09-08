import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getAdelaideToday, formatAdelaideDate, isCalendarDate, addDays } from "@/lib/domain/timezone";
import { counted } from "@/lib/format";
import { COLLECTION_DUE_TEXT, weekdayName } from "@/lib/domain/collections";
import { isoWeekday } from "@/lib/domain/dates";
import { dueCollections, type DueCollection } from "@/lib/runs/collections";
import {
  Badge, ButtonLink, Card, DataTable, EmptyState, Notice, PageHeader, Stat,
} from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { createCollectionStops } from "../actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Due for collection" };

/**
 * Due for collection — the standing weekly round, for one day.
 *
 * The owner's description of the business: *"Customer gives us towels weekly,
 * we bill monthly per item collected."* This is the weekly half. The monthly
 * half already worked: prices are per item code, and since 0040 every approved
 * job joins that customer's running draft.
 *
 * **What the button creates is a stop, not a laundry order**, which is the
 * owner's own choice and is also the only shape the database accepts — a job
 * with nothing collected yet has no items, and
 * `chk_laundry_orders_assignment_delivery` refuses a round on a job that is not
 * a delivery. A `jobs` row with `service_type = 'pickup'` is what `/run`
 * already reads to offer the collection capture, and it works with no signal.
 * What comes back is then taken in at the counter and priced per item, exactly
 * as this laundry's fifteen jobs already are.
 *
 * **Under Runs rather than under Customers**, because the *arrangement* is a
 * customer's (it is edited on their record) and the *day* is a round's. This
 * screen is opened each morning, so it belongs with the day.
 */

type Search = { date?: string };

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  /**
   * `routes.write`, not `routes.read` — the same gate as the tab.
   *
   * The screen is a list of customers, and `customers.read` is this app's line
   * for "you may look a customer up": a board and a driver hold `routes.read`
   * and not that, so opening the area to them would show a round every business
   * in the laundry on a screen it cannot act on. Every holder of `routes.write`
   * also holds `customers.read` — pinned in `roles.test.ts`, so a capability
   * change that parted them fails a test rather than quietly widening this.
   */
  const session = await requireCapability("routes.write");
  const params = await searchParams;
  const today = getAdelaideToday();
  const date = params.date && isCalendarDate(params.date) ? params.date : today;

  const supabase = await createClient();
  // Named rather than left to RLS (§23): every customer id here is posted back
  // into a write scoped to the laundry the person is working in, and
  // `is_member()` is true of every laundry for a platform admin.
  const due = await dueCollections(supabase, session.tenantId, date);

  const ready = due.filter((row) => row.state === "ready");
  const onTheRun = due.filter((row) => row.state === "on_the_run");
  const noRound = due.filter((row) => row.state === "no_round");
  const paused = due.filter((row) => row.state === "paused");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Due for collection"
        description={`Customers collected every ${weekdayName(isoWeekday(date)) ?? "day"}, and whether they are on a round yet.`}
      />

      <Card title="Day">
        <DayNav date={date} today={today} />
      </Card>

      {due.length === 0 ? (
        <EmptyState
          title={`Nobody is collected on a ${weekdayName(isoWeekday(date))}`}
          description="A standing collection is set on a customer's own record — a day of the week and the round that calls. Set one and they appear here every week."
          action={<ButtonLink href="/customers">Open Customers</ButtonLink>}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Due" value={due.length} hint={formatAdelaideDate(date, "long")} />
            <Stat label="To put on a round" value={ready.length}
                  tone={ready.length ? "warning" : "default"} />
            <Stat label="Already on the run" value={onTheRun.length} tone="success" />
            <Stat label="No round set" value={noRound.length}
                  tone={noRound.length ? "danger" : "default"}
                  hint={noRound.length ? "These reach nobody's van" : undefined} />
          </div>

          <Card
            title="Put them on their rounds"
            description="Creates one collection stop per customer, on the round their record names. Pressing it again is safe — a customer already on the run is skipped."
          >
            {ready.length === 0 ? (
              <Notice tone="info">
                Nothing to raise: every collection due on this day is already on a round,
                or is waiting on something below.
              </Notice>
            ) : (
              <form action={createCollectionStops} className="space-y-3">
                <input type="hidden" name="date" value={date} />
                <input type="hidden" name="return_to" value={`/runs/collections?date=${date}`} />
                {/* Stated rather than guarded behind a confirm strip:
                    `ConfirmSubmit` is this app's answer to a *destructive*
                    action, and adding a call to a run is neither destructive
                    nor irreversible — a stop the office does not want is
                    cancelled on the run. What a person does need before
                    pressing is what it will and will not do, so that is the
                    sentence. */}
                <p className="text-sm text-muted-foreground">
                  This adds {counted(ready.length, "stop")} to{" "}
                  {counted(new Set(ready.map((row) => row.boardId)).size, "round")} for{" "}
                  {formatAdelaideDate(date, "long")}. Each round sees the call on
                  {" "}<strong className="font-medium text-foreground">At the depot</strong>{" "}
                  and records what is collected there. Nothing is billed by this — what comes
                  back is taken in at the counter and priced per item, as it is today.
                </p>
                <SubmitButton pendingLabel="Putting them on…">
                  {`Create ${counted(ready.length, "collection stop")}`}
                </SubmitButton>
              </form>
            )}
          </Card>

          <Group
            title={`To put on a round · ${ready.length}`}
            rows={ready}
            empty="Nothing waiting."
          />
          <Group
            title={`No round set · ${noRound.length}`}
            rows={noRound}
            empty="Every due customer has a round."
            notice={noRound.length ? "These customers are due today and will not appear on anyone's van. Choose a collection round on each record." : undefined}
          />
          <Group
            title={`Already on the run · ${onTheRun.length}`}
            rows={onTheRun}
            empty="None yet."
          />
          <Group
            title={`Paused · ${paused.length}`}
            rows={paused}
            empty="No paused customers are due."
            notice={paused.length ? "A standing collection does not resume for a customer who is on hold, inactive or still a prospect. Change their status on their record to start collecting again." : undefined}
          />
        </>
      )}
    </div>
  );
}

/** Yesterday / today / tomorrow, as plain links so the page stays shareable. */
function DayNav({ date, today }: { date: string; today: string }) {
  const href = (target: string) => `/runs/collections?date=${target}`;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-2">
        <ButtonLink href={href(addDays(date, -1))} variant="secondary">Previous</ButtonLink>
        <ButtonLink href={href(today)} variant={date === today ? "primary" : "secondary"}>
          Today
        </ButtonLink>
        <ButtonLink href={href(addDays(date, 1))} variant="secondary">Next</ButtonLink>
      </div>
      <form method="get" action="/runs/collections" className="flex items-end gap-2">
        <div>
          <label htmlFor="collections-date" className="mb-1 block text-sm font-medium">Date</label>
          <input
            id="collections-date" name="date" type="date" defaultValue={date}
            className="min-h-11 rounded-lg border border-border bg-surface px-3"
          />
        </div>
        <ButtonLink href={href(date)} variant="secondary">Show</ButtonLink>
      </form>
      <p className="text-sm text-muted-foreground">{formatAdelaideDate(date, "long")}</p>
    </div>
  );
}

function Group({
  title, rows, empty, notice,
}: { title: string; rows: DueCollection[]; empty: string; notice?: string }) {
  if (rows.length === 0) {
    return <Card title={title}><p className="text-sm text-muted-foreground">{empty}</p></Card>;
  }
  return (
    <Card title={title}>
      {notice ? <div className="mb-3"><Notice tone="warning">{notice}</Notice></div> : null}
      <DataTable
        bare
        label={title}
        rows={rows}
        empty={<p className="text-sm text-muted-foreground">{empty}</p>}
        columns={[
          {
            header: "Customer",
            cell: (row) => (
              <Link href={`/customers/${row.customerId}`} className="font-medium hover:underline">
                {row.businessName}
              </Link>
            ),
          },
          { header: "Number", cell: (row) => row.customerNumber, hideBelow: "md" },
          {
            header: "Round",
            cell: (row) => row.boardName ?? <span className="text-muted-foreground">Not set</span>,
          },
          {
            header: "Status",
            cell: (row) => (
              <span className="flex flex-wrap items-center gap-2">
                {row.status && row.status !== "active" ? <Badge tone="warning">{row.status}</Badge> : null}
                <span className="text-sm text-muted-foreground">{COLLECTION_DUE_TEXT[row.state]}</span>
              </span>
            ),
          },
          {
            header: "Stop",
            cell: (row) => (row.stopId
              ? <Link href={`/jobs/${row.stopId}`} className="hover:underline">{row.stopNumber}</Link>
              : <span className="text-muted-foreground">—</span>),
            hideBelow: "lg",
          },
        ]}
      />
    </Card>
  );
}
