// RLS-BOUND client: safe by default. Use for all normal reads/writes; Postgres
// RLS enforces tenant isolation. Prefer this over the admin client.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
export async function createClient() {
  const cookieStore = await cookies();
  // Via `env` rather than `process.env.X!`: a missing variable then fails loudly
  // at boot instead of constructing a client against `undefined` and surfacing
  // as an unrelated "credentials not recognised" much later.
  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => { try { list.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); } catch {} },
    } }
  );
}
