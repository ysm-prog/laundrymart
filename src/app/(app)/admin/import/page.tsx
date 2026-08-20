import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { Card, PageHeader } from "@/components/ui";
import { MYOB_FILES, MYOB_KINDS, REDUNDANT_FILES } from "@/lib/domain/myob";
import { ImportUploader } from "./import-uploader";

export const metadata = { title: "Bring in your books · LaundryMart" };

/**
 * Carrying a set of books in from MYOB, from the app.
 *
 * This replaces handing an export to `scripts/import/myob-import.py` and running
 * the SQL it prints. The rules are the same ones, ported to
 * `src/lib/domain/myob` and unit-tested there — including the identity function,
 * which is pinned against ids the database already holds, so an upload updates
 * the rows a previous load created rather than making a second copy of them.
 *
 * Gated on `admin.write`: this writes customers, suppliers, the chart of
 * accounts and every document coded against them, which is the whole ledger.
 */
export default async function ImportPage() {
  const session = await requireCapability("admin.write");

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants").select("name").eq("id", session.tenantId).maybeSingle<{ name: string }>();

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Bring in your books"
        description="Upload the reports your accounting system exports. They are read, checked and shown to you before anything is written."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ImportUploader tenantName={tenant?.name ?? "this business"} />

        <div className="space-y-4">
          <Card
            title="Files it reads"
            description="Export these from MYOB and upload them together, or a few at a time."
          >
            <ul className="space-y-2 text-[12.5px]">
              {MYOB_KINDS.map((kind) => (
                <li key={kind}>
                  <p className="font-mono text-2xs break-all">{MYOB_FILES[kind].suffix}</p>
                  <p className="text-xs text-muted-foreground">{MYOB_FILES[kind].fills}</p>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Files it will skip" description="Everything in these is already in one of the above.">
            <ul className="space-y-2 text-[12.5px]">
              {REDUNDANT_FILES.map((file) => (
                <li key={file.suffix}>
                  <p className="font-mono text-2xs break-all">{file.suffix}</p>
                  <p className="text-xs text-muted-foreground">Skipped — {file.because}.</p>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="What it will not do">
            <ul className="space-y-1.5 text-[12.5px] text-muted-foreground">
              <li>Nothing is ever deleted. A row that is no longer in the export is left alone.</li>
              <li>
                A party already here who is only named by a document keeps their details and their
                balance — an upload of invoices alone will not blank out your customer list.
              </li>
              <li>
                Opening balances go to zero as soon as a document carrying the same money arrives,
                so a debt is never counted twice.
              </li>
              <li>Running the same files twice changes nothing the first run did not already do.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
