import Link from "next/link";
import { money } from "@/lib/format";
import { describePeriod } from "@/lib/domain/billing-period";
import { formatIso } from "@/lib/domain/dates";
import type { DraftSummary } from "@/lib/invoices/open-draft";
import { Badge, Card, Eyebrow } from "@/components/ui";
import { SubmitButton } from "@/components/form";

/**
 * One customer's running invoice, as a card on the open-drafts board.
 *
 * Its own module rather than a function inside the page, so `/design-preview`
 * can render it — the page around it is an async server component reading
 * Supabase, which is exactly the class of screen §10b records as having shipped
 * a doubled hairline and an invisible dark-mode edge behind a green `verify`.
 *
 * Three stages and three different next steps, so the badge carries the word as
 * well as the colour (§10b: a badge never means anything by colour alone):
 *
 *   **Ready**      the period has finished, so nothing more will join. Bill it.
 *   **Collecting** the period is running and approvals are still landing on it.
 *   **No period**  a per-job or manual invoice. It was never collecting.
 *
 * *Ready* is a suggestion and never a gate: Issue now is offered at every stage,
 * because billing on the 9th is the thing the owner asked to be able to do.
 */
export function DraftCard({
  draft, stage, mayIssue, issueAction, returnTo,
}: {
  draft: DraftSummary;
  stage: "ready" | "collecting" | "none";
  mayIssue: boolean;
  issueAction: (formData: FormData) => void | Promise<void>;
  returnTo: string;
}) {
  const period = draft.periodStart && draft.periodEnd
    ? describePeriod({ start: draft.periodStart, end: draft.periodEnd })
    : null;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>{draft.invoiceNumber}</Eyebrow>
          <h3 className="truncate text-base font-semibold">{draft.customerName}</h3>
        </div>
        {stage === "ready" ? <Badge tone="warning">Ready</Badge>
          : stage === "collecting" ? <Badge tone="info">Collecting</Badge>
          : <Badge tone="neutral">No period</Badge>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Period</dt>
          <dd className="font-medium">{period ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Jobs on it</dt>
          <dd className="font-medium tabular-nums">{draft.jobCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Running total</dt>
          <dd className="font-semibold tabular-nums">{money(draft.total)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last change</dt>
          <dd className="font-medium">
            {formatIso((draft.updatedAt ?? draft.createdAt).slice(0, 10))}
          </dd>
        </div>
      </dl>

      {draft.lineCount === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing on it yet, so there is nothing to issue.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
        <Link href={`/invoices/${draft.id}`}
              className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium
                         text-primary hover:underline">
          Open the invoice
        </Link>
        {/* Withheld rather than disabled when there is nothing on it: a button
            whose only possible outcome is a refusal is a dead end dressed as a
            choice, and the sentence above already says why. */}
        {mayIssue && draft.lineCount > 0 ? (
          <form action={issueAction} className="ml-auto">
            <input type="hidden" name="id" value={draft.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <SubmitButton size="md" pendingLabel="Issuing…">Issue now</SubmitButton>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
