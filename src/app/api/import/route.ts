import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import { buildPlan } from "@/lib/domain/myob";
import { parseUploads, type UploadedFile } from "@/lib/import/parse";
import { commitPlan, readExistingParties } from "@/lib/import/commit";

/**
 * Upload a MYOB export and load it, from the app (§7.19).
 *
 * Two modes over one code path, which is the point: `analyse` builds the plan
 * and returns what it would do, `commit` builds the *same* plan and executes it.
 * A preview that came from different code than the write would be a preview of
 * nothing. Books are the one kind of data where a plausible wrong number costs
 * more than a loud failure, so nothing is written until somebody has read the
 * summary and pressed the second button.
 *
 * A route handler rather than a server action because this carries files: server
 * actions cap the request body an order of magnitude below what a year of
 * invoices weighs.
 */

export const maxDuration = 300;

/** Vercel refuses a request body over 4.5 MB before it reaches this code. */
const MAX_BYTES = 4_000_000;
const MAX_FILES = 12;

export async function POST(request: NextRequest) {
  const session = await requireSession();
  // The strongest capability there is, because this writes the whole ledger:
  // customers, suppliers, the chart of accounts, and every document against them.
  if (!can(session.role, "admin.write")) {
    return NextResponse.json(
      { error: "Only an administrator can import a set of books." }, { status: 403 },
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });

  const mode = form.get("mode") === "commit" ? "commit" : "analyse";
  const invoiceScope = form.get("invoiceScope") === "all" ? "all" : "outstanding";

  const uploads: UploadedFile[] = [];
  let total = 0;
  for (const entry of form.getAll("files")) {
    if (!(entry instanceof File) || entry.size === 0) continue;
    total += entry.size;
    if (total > MAX_BYTES) {
      return NextResponse.json({
        error: "That is more than 4 MB of files at once. Upload a few at a time — it is safe to, "
          + "because each upload is matched to what is already here rather than added to it.",
      }, { status: 413 });
    }
    uploads.push({ name: entry.name, bytes: Buffer.from(await entry.arrayBuffer()) });
    if (uploads.length > MAX_FILES) {
      return NextResponse.json({ error: `Up to ${MAX_FILES} files at a time.` }, { status: 413 });
    }
  }
  if (uploads.length === 0) {
    return NextResponse.json({ error: "No files were attached." }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseUploads(uploads);
  } catch (cause) {
    return NextResponse.json(
      { error: `Could not read those files: ${(cause as Error).message}` }, { status: 400 },
    );
  }

  const supabase = await createClient();
  let existing;
  try {
    existing = await readExistingParties(supabase, session.tenantId);
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }

  const plan = buildPlan(parsed.files, existing, { tenantId: session.tenantId, invoiceScope });
  const problems = [...parsed.problems, ...plan.problems];
  const fatal = problems.filter((problem) => problem.fatal);
  const preview = {
    summaries: parsed.summaries,
    notes: plan.notes,
    problems: problems.slice(0, 50),
    problemCount: problems.length,
    tables: plan.tables.map(({ table, label, rows }) => ({ table, label, rows: rows.length })),
    parties: plan.parties,
    totals: plan.totals,
    canCommit: fatal.length === 0 && plan.tables.length > 0,
  };

  if (mode === "analyse") {
    return NextResponse.json({ mode, ...preview });
  }

  if (fatal.length > 0) {
    return NextResponse.json(
      { error: "Nothing was written — the files still have problems that have to be fixed first.", ...preview },
      { status: 422 },
    );
  }
  if (plan.tables.length === 0) {
    return NextResponse.json(
      { error: "Nothing in those files needed writing.", ...preview }, { status: 422 },
    );
  }

  try {
    const result = await commitPlan(supabase, session.tenantId, plan);
    await recordAudit(session, {
      entity: "import",
      action: "sync",
      summary: `Imported a MYOB export: ${result.written.map((w) => `${w.rows} ${w.label.toLowerCase()}`).join(", ")}.`,
      metadata: {
        files: parsed.summaries.map(({ name, kind, rows }) => ({ name, kind, rows })),
        written: result.written,
        openingsCleared: result.openingsCleared,
        invoiceScope,
      },
    });
    return NextResponse.json({ mode, ...preview, ...result });
  } catch (cause) {
    // Every statement is an upsert on a natural key, so re-uploading the same
    // files is the repair. Say so rather than leaving the operator guessing.
    await recordAudit(session, {
      entity: "import", action: "sync",
      summary: `A MYOB import failed part-way: ${(cause as Error).message}`,
    });
    return NextResponse.json({
      error: `${(cause as Error).message} — some rows may already be in. Upload the same files again to `
        + "finish: every row is matched on its own number, so nothing will be duplicated.",
      ...preview,
    }, { status: 500 });
  }
}
