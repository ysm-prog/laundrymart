import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { counted, money } from "@/lib/format";
import { businessToday } from "@/lib/domain/timezone";
import { isFiltered } from "@/lib/filters";
import { loadOpenDrafts, type DraftSummary } from "@/lib/invoices/open-draft";
import { DraftCard } from "./draft-card";
import {
  ButtonLink, Card, EmptyState, Notice, PageContainer, PageHeader, Stat,
} from "@/components/ui";
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary } from "@/components/filters";
import { InvoiceSelection } from "../invoice-selection";
import { issueInvoice } from "../actions";
import { issueSelectedInvoices } from "../bulk-actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Open drafts" };

const BASE = "/invoices/drafts";

type Search = { q?: string; stage?: string };
const FILTER_KEYS = ["q", "stage"] as const;

/**
 * The drafts that are still collecting — one per customer per billing period.
 *
 * **The screen the owner's month end was missing.** Approving a job now puts its
 * charges straight onto that customer's invoice for the period, and the next job
 * joins the same one; what had nowhere to live was the question that follows —
 * *what is accumulating, and what is ready to go out?* The register could not
 * answer it: it lists drafts among issued, paid, overdue and void invoices with
 * nothing saying which are still filling up.
 *
 * Three stages, because they are three different decisions:
 *
 *   **Ready to issue**  — the period has finished. Bill it.
 *   **Still collecting** — the period is running. Leave it; jobs are still joining.
 *   **No period**       — a per-job or manual invoice. It was never collecting.
 *
 * *Ready* is a suggestion and never a gate. The whole point of the change is that
 * the owner bills when they choose: an invoice may be issued on the 9th, or twice
 * in one month, and this screen offers Issue now on every row whatever its stage.
 *
 * Laid out in columns rather than as one long list (§10b), because at month end
 * this is read as a board — twelve customers, twelve totals, scanned at once —
 * and a single column of twelve cards is a page nobody reaches the bottom of.
 */
export default async function OpenDraftsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("invoices.read");
  const params = await searchParams;
  const supabase = await createClient();
  const today = businessToday();

  const drafts = await loadOpenDrafts(supabase, session.tenantId);
  const mayIssue = can(session.role, "invoices.write");
  const mayBulk = mayIssue && can(session.role, "invoices.bulk");

  /**
   * Which stage a draft is in.
   *
   * `period_end` and today, and nothing else: a draft whose window has closed is
   * one nothing more can join, because a job completed tomorrow belongs to
   * tomorrow's period and opens its own. That is the whole of "ready".
   */
  const stageOf = (draft: DraftSummary): "ready" | "collecting" | "none" => {
    if (!draft.periodEnd) return "none";
    return draft.periodEnd < today ? "ready" : "collecting";
  };

  const withStage = drafts.map((draft) => ({ draft, stage: stageOf(draft) }));
  const countOf = (stage: string) => withStage.filter((row) => row.stage === stage).length;

  const term = (params.q ?? "").trim().toLowerCase();
  const shown = withStage.filter(({ draft, stage }) => {
    if (params.stage && stage !== params.stage) return false;
    if (!term) return true;
    return draft.customerName.toLowerCase().includes(term)
      || draft.invoiceNumber.toLowerCase().includes(term);
  });

  const totalValue = shown.reduce((sum, row) => sum + row.draft.total, 0);
  const totalJobs = shown.reduce((sum, row) => sum + row.draft.jobCount, 0);
  const readyValue = withStage
    .filter((row) => row.stage === "ready")
    .reduce((sum, row) => sum + row.draft.total, 0);

  const selectable = shown
    // A draft with nothing on it cannot be issued into a document — there would
    // be no lines and no total — so it is shown but not offered to the bulk
    // form. A tick that can only fail is worse than no tick.
    .filter((row) => row.draft.lineCount > 0)
    .map((row) => ({
      id: row.draft.id,
      invoiceNumber: row.draft.invoiceNumber,
      customerName: row.draft.customerName,
      total: row.draft.total,
      status: "draft",
    }));

  return (
    <PageContainer>
      <PageHeader
        title="Open drafts"
        description="One invoice per customer per billing period, collecting each job as it is
                     approved. Issue one whenever you are ready — you do not have to wait for
                     month end."
        actions={<ButtonLink href="/invoices" variant="secondary">Invoice register</ButtonLink>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open drafts" value={drafts.length} />
        <Stat label="Ready to issue" value={countOf("ready")}
              hint={countOf("ready") > 0 ? money(readyValue) : "Nothing has finished its period"}
              tone={countOf("ready") > 0 ? "warning" : "default"} />
        <Stat label="Still collecting" value={countOf("collecting")} />
        <Stat label="Value on screen" value={money(totalValue)}
              hint={counted(totalJobs, "job")} />
      </div>

      <ListControls
        action={BASE}
        q={params.q}
        params={params as Record<string, string | undefined>}
        filterKeys={FILTER_KEYS}
        placeholder="Search by customer or invoice number…"
        chips={
          <FilterChips
            basePath={BASE}
            params={params as Record<string, string | undefined>}
            name="stage"
            label="Stage"
            allCount={withStage.length}
            options={[
              { value: "ready", label: "Ready to issue", count: countOf("ready"),
                title: "The billing period has finished — nothing more will join these" },
              { value: "collecting", label: "Still collecting", count: countOf("collecting"),
                title: "The period is still running, so approved jobs are still joining" },
              ...(countOf("none") > 0
                ? [{ value: "none", label: "No period", count: countOf("none"),
                     title: "Per-job and manual invoices, which were never collecting" }]
                : []),
            ]}
          />
        }
        summary={
          <FilterSummary
            basePath={BASE}
            shown={shown.length}
            total={withStage.length}
            noun="draft"
            filtered={isFiltered(params as Record<string, string | undefined>, FILTER_KEYS)}
          />
        }
      />

      {/* Two columns from `lg`: the board on the left, the one bulk control on
          the right where it stays in view while the board scrolls. */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {shown.length === 0 ? (
            <EmptyState
              title={withStage.length === 0
                ? "No drafts are collecting yet"
                : "No drafts match those filters"}
              description={withStage.length === 0
                ? "Approve a job's charges and this laundry's invoice for that period opens here."
                : "Clear the filters to see every open draft."}
              action={withStage.length === 0
                ? <ButtonLink href="/invoices/awaiting">Awaiting invoice</ButtonLink>
                : <ButtonLink href={BASE} variant="secondary">Clear filters</ButtonLink>}
            />
          ) : (
            /* The board itself splits again on a wide screen, so twelve drafts
               read as a grid rather than as twelve screens of scrolling. */
            <div className="grid gap-4 sm:grid-cols-2">
              {shown.map(({ draft, stage }) => (
                <DraftCard key={draft.id} draft={draft} stage={stage} mayIssue={mayIssue}
                           issueAction={issueInvoice} returnTo={BASE} />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-5">
          <Card title="How this works"
                description="One invoice per customer per period.">
            <ul className="space-y-2.5 text-sm text-muted-foreground">
              <li>Approving a job&apos;s charges puts them on that customer&apos;s draft for the
                  period the job finished in.</li>
              <li>Their next job joins the same draft. Two lots of the same item at the same
                  rate become one line, not two.</li>
              <li>Issue it when you are ready. The invoice is dated the day you issue it, and
                  the next job that customer sends in opens a fresh draft.</li>
            </ul>
          </Card>

          {mayBulk && selectable.length > 0 ? (
            <Card title="Issue several at once"
                  description="Issuing does not send. Each becomes a document you can email
                               afterwards.">
              <InvoiceSelection
                invoices={selectable}
                returnTo={BASE}
                action={issueSelectedInvoices}
                verb="Issue selected"
                pendingLabel="Issuing…"
                selectAllLabel="Select every draft on screen"
              />
            </Card>
          ) : null}

          {countOf("ready") > 0 ? (
            <Notice tone="warning" title="Some periods have finished">
              {counted(countOf("ready"), "draft")} cover a period that has already ended.
              Nothing more will join them.
            </Notice>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
