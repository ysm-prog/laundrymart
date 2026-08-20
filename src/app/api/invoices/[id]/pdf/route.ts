import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { loadInvoiceForPdf } from "@/lib/pdf/invoice-data";
import { invoiceFileName, renderInvoicePdf } from "@/lib/pdf/render";

/**
 * Streams the rendered tax invoice (spec §7.14).
 *
 * A route handler rather than a server action because the browser needs to
 * navigate to it — a server action cannot hand back a file. Rendered on demand
 * rather than cached: an invoice's lines can still change while it is a draft,
 * and a stale PDF is worse than a slightly slower one.
 */

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

  // RLS-bound read: another tenant's invoice simply does not resolve.
  const data = await loadInvoiceForPdf(id, session.tenantId);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pdf = await renderInvoicePdf(data);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition":
        `inline; filename="${invoiceFileName(data.invoice.invoice_number)}"`,
      // Invoices are customer financial data; never let a shared cache hold one.
      "cache-control": "private, no-store",
    },
  });
}
