import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { counted, money } from "@/lib/format";
import { emailIsConfigured } from "@/lib/email/send";
import { loadStatementList } from "@/lib/invoices/statement";
import {
  parseStatementDate, parseStatementSort, statementHasContent, statementListView,
  type StatementListRow,
} from "@/lib/domain/statement";
import { businessToday } from "@/lib/domain/timezone";
import { longDate } from "@/lib/pdf/line-display";
import {
  Button, Card, CONTROL, EmptyState, Notice, PageContainer, PageHeader, SELECT_CHEVRON, Stat,
} from "@/components/ui";
import { StatementSelection } from "./statement-selection";
import { emailStatement, sendSelectedStatements } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Statements" };

const BASE = "/invoices/statements";

/**
 * Who a statement can go to, and what it would say (ysm-hub's Customer
 * statements, on this app's rules).
 *
 * The statement date, the "up to that date" choice, the search and the order all
 * live in the URL, so a filtered list survives a send and can be bookmarked. Older
 * imported balances stay off (`lib/domain/statement.ts`), and the notice below
 * says how much, because whoever presses Send is the one person who has to know
 * the figure is not the customer's whole history.
 */
export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireCapability("invoices.read");
  const params = await searchParams;
  const today = businessToday();
  const asAt = parseStatementDate(params.as_at, today);
  const upToAsAt = params.later !== "1";
  const q = params.q?.trim() ?? "";
  const sort = parseStatementSort(params.sort);

  const supabase = await createClient();
  const list = await loadStatementList(supabase, session.tenantId, { asAt, upToAsAt });

  const rows: StatementListRow[] = list.map((row) => ({
    customerId: row.customerId,
    name: row.name,
    customerNumber: row.customerNumber,
    contactName: row.contactName,
    phone: row.phone,
    billingEmail: row.billingEmail,
    total: row.statement.total,
    overdue: row.statement.overdue,
    invoices: row.statement.rows.length,
  }));
  const shown = statementListView(rows, { q, sort });
  const owing = list.filter((row) => statementHasContent(row.statement));

  const total = shown.reduce((sum, row) => sum + row.total, 0);
  const overdue = shown.reduce((sum, row) => sum + row.overdue, 0);
  const excludedCount = list.reduce((sum, row) => sum + row.statement.excluded.count, 0);
  const excludedAmount = list.reduce((sum, row) => sum + row.statement.excluded.amount, 0);
  const laterCount = list.reduce((sum, row) => sum + row.statement.later.count, 0);
  const trustedFrom = list[0]?.statement.trustedFrom;

  const canSend = can(session.role, "invoices.send") && can(session.role, "invoices.bulk")
    && emailIsConfigured();
  const filtered = Boolean(q) || asAt !== today || !upToAsAt || sort !== "balance";
  const returnTo = `${BASE}?${new URLSearchParams({
    as_at: asAt, ...(upToAsAt ? {} : { later: "1" }), ...(q ? { q } : {}), sort,
  }).toString()}`;

  return (
    <PageContainer>
      <PageHeader
        title="Statements"
        description="What each customer owes as at a date, aged. View or download one, or email it — one customer or a selection."
      />

      <Card>
        <form method="get" action={BASE} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Statement date
            <input type="date" name="as_at" defaultValue={asAt} max={today}
                   className={`${CONTROL} sm:w-44`} />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium sm:min-w-56">
            Customer
            <input type="search" name="q" defaultValue={q}
                   placeholder="Name, number, contact or email" className={CONTROL} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Order
            <select name="sort" defaultValue={sort} className={`${CONTROL} ${SELECT_CHEVRON} sm:w-48`}>
              <option value="balance">Largest balance first</option>
              <option value="overdue">Most overdue first</option>
              <option value="name">By name</option>
            </select>
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" name="later" value="1" defaultChecked={!upToAsAt}
                   className="size-[1.15rem] rounded border-strong accent-primary" />
            Include invoices issued after the statement date
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" size="md">Show</Button>
            {filtered ? (
              <Link href={BASE} className="text-sm font-medium text-primary underline">Reset</Link>
            ) : null}
          </div>
        </form>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Customers" value={String(shown.length)} />
        <Stat label="Outstanding" value={money(total)} />
        <Stat label="Overdue" value={money(overdue)} />
      </div>

      {excludedCount > 0 && trustedFrom ? (
        <Notice tone="warning" title="Older MYOB balances are not on these statements">
          {counted(excludedCount, "imported invoice")} dated before {longDate(trustedFrom)}, adding up
          to {money(excludedAmount)}, are left off because their payments were never brought across.
          Check a customer&apos;s balance in Xero if the figure here looks low.
        </Notice>
      ) : null}

      {laterCount > 0 ? (
        <Notice tone="info" title={`Invoices issued after ${longDate(asAt)} are left off`}>
          {counted(laterCount, "open invoice")} issued after the statement date will appear on the next
          statement. Tick &ldquo;Include invoices issued after the statement date&rdquo; to put them on this one.
        </Notice>
      ) : null}

      <Card title={`Statements as at ${longDate(asAt)}`}>
        {shown.length === 0 ? (
          q && owing.length > 0 ? (
            <EmptyState title="No customer matches that search"
                        description={`${counted(owing.length, "customer")} owe something as at this date.`} />
          ) : (
            <EmptyState title="Nothing outstanding"
                        description="No customer has an open invoice to put on a statement as at this date." />
          )
        ) : (
          <StatementSelection
            rows={shown}
            asAt={asAt}
            asAtLabel={longDate(asAt)}
            upToAsAt={upToAsAt}
            returnTo={returnTo}
            sendOne={emailStatement}
            sendSelected={sendSelectedStatements}
            canSend={canSend}
          />
        )}
      </Card>
    </PageContainer>
  );
}
