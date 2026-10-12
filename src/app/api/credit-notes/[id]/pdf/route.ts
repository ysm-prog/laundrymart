import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { loadCreditNoteForPdf } from "@/lib/pdf/credit-note-data";
import { invoiceFileName, renderCreditNotePdf } from "@/lib/pdf/render";

/** Streams a credit note, the twin of `/api/invoices/:id/pdf`. */
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!can(session.role, "invoices.read")) {
    return NextResponse.json({ error: "Your role cannot view credit notes." }, { status: 403 });
  }
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const data = await loadCreditNoteForPdf(id, session.tenantId);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pdf = await renderCreditNotePdf(data);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${invoiceFileName(data.note.credit_note_number)}"`,
      "cache-control": "private, no-store",
    },
  });
}
