import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { counted, money } from "@/lib/format";
import { emailIsConfigured } from "@/lib/email/send";
import { loadStatementList } from "@/lib/invoices/statement";
import { longDate } from "@/lib/pdf/line-display";
import { Card, EmptyState, Notice, PageContainer, PageHeader, Stat } from "@/components/ui";
import { InvoiceSelection } from "../invoice-selection";
import { sendSelectedStatements } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Statements" };

const BASE = "/invoices/statements";

/**
 * Who a statement can go to, and what it would say.
 *
 * The list is customers with something open since the trusted day. Older imported
 * balances stay off (`lib/domain/statement.ts`), and the notice below says how much,
 * because whoever presses Send is the one person who has to know the figure is not
 * the customer's whole history.
 */
export default async function StatementsPage() {
  const session = await requireCapability("invoices.read");
  const supabase = await createClient();
  const list = await loadStatementList(supabase, session.tenantId);

  const sendable = list.filter((row) => row.statement.rows.length > 0);
  const total = sendable.reduce((sum, row) => sum + row.statement.total, 0);
  const overdue = sendable.reduce((sum, row) => sum + row.statement.overdue, 0);
  const excludedCount = list.reduce((sum, row) => sum + row.statement.excluded.count, 0);
  const excludedAmount = list.reduce((sum, row) => sum + row.statement.excluded.amount, 0);
  const trustedFrom = list[0]?.statement.trustedFrom;

  const maySend = can(session.role, "invoices.send") && can(session.role, "invoices.bulk");
  const mailReady = emailIsConfigured();

  return (
    <PageContainer>
      <PageHeader
        title="Statements"
        description="What each customer owes, aged. Open a customer to view one, or tick several here to email them."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Customers" value={String(sendable.length)} />
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

      <Card title="Customers with something outstanding">
        {sendable.length === 0 ? (
          <EmptyState title="Nothing outstanding"
                      description="No customer has an open invoice to put on a statement." />
        ) : maySend && mailReady ? (
          <InvoiceSelection
            invoices={sendable.map((row) => ({
              id: row.customerId,
              invoiceNumber: [
                row.customerNumber,
                counted(row.statement.rows.length, "invoice"),
                row.billingEmail ?? "no billing email",
              ].join(" · "),
              customerName: row.name,
              total: row.statement.total,
              status: "issued",
            }))}
            returnTo={BASE}
            action={sendSelectedStatements}
            verb="Email statements"
            pendingLabel="Sending…"
            selectAllLabel={`Select all ${sendable.length}`}
          />
        ) : (
          <ul className="divide-y">
            {sendable.map((row) => (
              <li key={row.customerId} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
                <a href={`/api/customers/${row.customerId}/statement`} target="_blank" rel="noreferrer"
                   className="font-medium text-primary underline">{row.name}</a>
                <span className="tabular-nums">{money(row.statement.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
