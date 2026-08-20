import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import {
  Card, DataTable, EmptyState, Notice, PageHeader, Stat,
} from "@/components/ui";

export const metadata = { title: "Release" };
export const dynamic = "force-dynamic";

type Migration = { version: string; name: string };

/**
 * What this deployment is running.
 *
 * Read-only, and that is a decision rather than an omission. Applying a
 * migration is done by CI and the Supabase console: reviewed, version
 * controlled, and revertible. A button in a browser that runs DDL against a
 * database holding real customer records is a different kind of risk, and
 * answering "what schema are we on?" does not require taking it. There is no
 * server action behind this page and no function that applies anything —
 * `platform_migrations()` (0019) can only read.
 */
export default async function ReleasePage() {
  await requireCapability("platform.read");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_migrations");
  const migrations = (data ?? []) as Migration[];
  const latest = migrations.at(-1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Release"
        description="The database schema this deployment is running, and every migration applied to it."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Migrations applied" value={migrations.length ? String(migrations.length) : "—"} />
        <Stat label="Latest" value={latest ? (latest.name || latest.version) : "—"} />
        <Stat label="Applied at" value={latest ? formatVersion(latest.version) : "—"} />
      </div>

      {error ? (
        <Notice tone="warning" title="Could not read the migration ledger">
          {error.message}
        </Notice>
      ) : null}

      {!error && migrations.length === 0 ? (
        <Notice tone="info" title="No ledger on this database">
          This deployment keeps no Supabase migration ledger — which is normal for a
          local or self-hosted Postgres. The schema is whatever
          <code className="mx-1">supabase/migrations/</code> has been applied to it.
        </Notice>
      ) : null}

      <Card
        title="Applied migrations"
        description="Oldest first. Read only — migrations are applied by CI and the Supabase console, never from here."
        bodyClassName="p-0"
      >
        <DataTable
          bare
          label="Applied migrations"
          rows={migrations}
          empty={<EmptyState title="Nothing to show" description="No migration ledger on this database." />}
          columns={[
            { header: "Migration", cell: (row) => row.name || row.version },
            { header: "Applied", cell: (row) => formatVersion(row.version), align: "right" },
          ]}
        />
      </Card>
    </div>
  );
}

/**
 * Supabase stamps a migration `YYYYMMDDHHMMSS`. Rendered as a readable date;
 * anything that is not that shape is shown untouched rather than guessed at.
 */
function formatVersion(version: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version);
  if (!match) return version;
  const [, y, m, d, hh, mm] = match;
  return `${d}/${m}/${y} ${hh}:${mm}`;
}
