import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { number } from "@/lib/format";
import { archiveTableLabel } from "@/lib/archive";
import { Card, Eyebrow, Notice, PageHeader, Stat } from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { archiveRecords, restoreRecords } from "./actions";

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
export default async function DataPage() {
  const session = await requireCapability("admin.write");

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
        description="Put the customers, jobs and invoices out of sight while you show the app around — and bring them back when you are done."
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
