import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { loadStatement } from "@/lib/invoices/statement";
import { renderStatementPdf, statementFileName } from "@/lib/pdf/render";

/** Streams a customer's statement, as `/api/invoices/:id/pdf` streams an invoice. */

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
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
  const data = await loadStatement(supabase, session.tenantId, id);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pdf = await renderStatementPdf(data);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition":
        `inline; filename="${statementFileName(data.customer.customer_number, data.statement.asAt)}"`,
      "cache-control": "private, no-store",
    },
  });
}
