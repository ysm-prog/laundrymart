import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import { AGING_BUCKETS, AGING_LABELS } from "@/lib/domain/receivables";
import { emailIsConfigured } from "@/lib/email/send";
import { loadStatement } from "@/lib/invoices/statement";
import { longDate } from "@/lib/pdf/line-display";
import { Card, Notice } from "@/components/ui";
import { Field, Input } from "@/components/form";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { emailStatement } from "../../invoices/statements/actions";

/**
 * This customer's statement: the balance, aged, with a way to view and send it.
 * Rendered for `invoices.read`; the send form needs `invoices.send` on top.
 */
export async function StatementCard({ customerId, canSend }: { customerId: string; canSend: boolean }) {
  const session = await requireSession();
  const supabase = await createClient();
  const data = await loadStatement(supabase, session.tenantId, customerId);
  if (!data) return null;

  const { statement, customer } = data;
  const empty = statement.rows.length === 0;
  const href = `/customers/${customerId}`;

  return (
    <Card title="Statement" description={`As at ${longDate(statement.asAt)}.`}>
      <div className="space-y-4">
        {empty ? (
          <p className="text-sm text-muted-foreground">Nothing outstanding to put on a statement.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <dt className="text-xs text-muted-foreground">Amount due</dt>
              <dd className="font-semibold tabular-nums">{money(statement.total)}</dd>
            </div>
            {AGING_BUCKETS.map((bucket) => (
              <div key={bucket}>
                <dt className="text-xs text-muted-foreground">{AGING_LABELS[bucket]}</dt>
                <dd className="tabular-nums">{money(statement.buckets[bucket])}</dd>
              </div>
            ))}
          </dl>
        )}

        {statement.excluded.count > 0 ? (
          <Notice tone="warning" title="Older MYOB invoices are left off">
            {statement.excluded.count} imported {statement.excluded.count === 1 ? "invoice" : "invoices"} from
            before {longDate(statement.trustedFrom)}, adding up to {money(statement.excluded.amount)}, are not
            on this statement, because their payments were never brought across. The statement tells the
            customer it starts from that date.
          </Notice>
        ) : null}

        {empty ? null : (
          <div className="flex flex-wrap items-end gap-3">
            {/* A route handler, not a page, so a plain anchor. */}
            <a href={`/api/customers/${customerId}/statement`} target="_blank" rel="noreferrer"
               className="inline-flex items-center justify-center rounded-md border px-3 py-2
 text-sm font-medium transition hover:bg-surface-muted">
              View PDF
            </a>
          </div>
        )}

        {!empty && canSend && emailIsConfigured() ? (
          <form action={emailStatement} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={customerId} />
            <input type="hidden" name="return_to" value={href} />
            <Field label="Email to" name="to"
                   hint={customer.billing_email
                     ? "Leave blank to use the customer's billing email."
                     : "This customer has no billing email on file."}>
              <Input name="to" type="email"
                     placeholder={customer.billing_email ?? "accounts@customer.com.au"} />
            </Field>
            <ConfirmSubmit
              label="Email statement"
              variant="primary"
              eyebrow="It leaves straight away"
              consequence={`Email this statement for ${money(statement.total)}${customer.billing_email
                ? ` to ${customer.billing_email}, unless you typed another address` : ""}?`}
              cancelLabel="Not yet"
              pendingLabel="Sending…"
            />
          </form>
        ) : null}
      </div>
    </Card>
  );
}
