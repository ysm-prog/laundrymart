import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { loadStatement } from "@/lib/invoices/statement";
import { parseStatementDate } from "@/lib/domain/statement";
import { businessToday } from "@/lib/domain/timezone";
import { renderStatementPdf, statementFileName } from "@/lib/pdf/render";

/**
 * Streams a customer's statement, as `/api/invoices/:id/pdf` streams an invoice.
 *
 * `?as_at=` dates it (a future or unreadable date is today), `?upto=0` keeps
 * invoices issued after that date, and `?download=1` asks the browser to save it
 * rather than show it — the Statements screen's View and Download.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!can(session.role, "invoices.read")) {
    return NextResponse.json({ error: "Your role cannot view invoices." }, { status: 403 });
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const supabase = await createClient();
  const query = request.nextUrl.searchParams;
  const data = await loadStatement(supabase, session.tenantId, id, {
    asAt: parseStatementDate(query.get("as_at"), businessToday()),
    upToAsAt: query.get("upto") !== "0",
  });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pdf = await renderStatementPdf(data);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition":
        `${query.get("download") === "1" ? "attachment" : "inline"}; ` +
        `filename="${statementFileName(data.customer.customer_number, data.statement.asAt)}"`,
      "cache-control": "private, no-store",
    },
  });
}
