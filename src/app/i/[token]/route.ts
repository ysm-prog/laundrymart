import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { readInvoiceToken } from "@/lib/invoices/link-token";
import { loadInvoiceForPdf } from "@/lib/pdf/invoice-data";
import { invoiceFileName, renderInvoicePdf } from "@/lib/pdf/render";

/**
 * The invoice a text message links to.
 *
 * The one reader of an invoice with no session, so the service-role client is the
 * only client that can answer: the token is the authority, and it names exactly one
 * invoice. The tenant comes off that invoice's own row and every read below is
 * filtered by it, which is the rule for the admin client (§2).
 *
 * A draft or a void is refused even with a good token. A draft can still change and
 * a void is not owed. Every refusal reads the same, so an address cannot be probed
 * for which invoices exist.
 */

export const dynamic = "force-dynamic";

const HEADERS = {
  // Customer financial data: no shared cache, and no search engine.
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

function refused(status: number, message: string) {
  return new NextResponse(message, {
    status, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

const NOT_AVAILABLE = "This invoice is not available. Please contact us for a copy.";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const read = readInvoiceToken(token, env.SUPABASE_SERVICE_ROLE_KEY);
  if (!read.ok) {
    return read.reason === "expired"
      ? refused(410, "This link has expired. Please contact us for a copy of your invoice.")
      : refused(404, NOT_AVAILABLE);
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("invoices")
    .select("tenant_id, status, archived_at, deleted_at")
    .eq("id", read.invoiceId)
    .maybeSingle<{
      tenant_id: string; status: string; archived_at: string | null; deleted_at: string | null;
    }>();
  if (!row || row.status === "draft" || row.status === "void" || row.archived_at || row.deleted_at) {
    return refused(404, NOT_AVAILABLE);
  }

  const data = await loadInvoiceForPdf(read.invoiceId, row.tenant_id, admin);
  if (!data) return refused(404, NOT_AVAILABLE);

  const pdf = await renderInvoicePdf(data);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      ...HEADERS,
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${invoiceFileName(data.invoice.invoice_number)}"`,
    },
  });
}
