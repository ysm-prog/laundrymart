import type { SupabaseClient } from "@supabase/supabase-js";
import { BRANDING_BUCKET, isTenantLogoPath } from "@/lib/branding";
import { imageFormat } from "./line-display";

/**
 * The laundry's logo, as bytes a PDF can embed (brief 1.10).
 *
 * Read at render time through the caller's RLS-bound client — 0054 lets any
 * member read their own laundry's branding, which is everybody who can open an
 * invoice — and embedded, so the PDF needs no URL that could expire in a
 * customer's inbox. Never throws: a logo that cannot be read prints an invoice
 * without one, not a 500 on every invoice.
 */
export type PdfLogo = { data: Buffer; format: "png" | "jpg" };

export async function loadTenantLogo(
  supabase: SupabaseClient, tenantId: string, path: string | null,
): Promise<PdfLogo | null> {
  if (!isTenantLogoPath(tenantId, path)) return null;
  try {
    const { data, error } = await supabase.storage.from(BRANDING_BUCKET).download(path);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    const format = imageFormat(bytes);
    return format ? { data: Buffer.from(bytes), format } : null;
  } catch {
    return null;
  }
}
