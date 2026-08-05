// SERVICE-ROLE client: BYPASSES RLS. Every query MUST filter tenant_id from the
// session — never trust a client-supplied id. The tenant-audit skill scans for misuse.
import { createClient } from "@supabase/supabase-js";
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
