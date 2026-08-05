// Session refresh + auth gate for the Next 16 `proxy` convention. getClaims()
// verifies the JWT locally — no network round-trip per navigation once
// asymmetric signing keys are enabled on the Supabase project.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
const PUBLIC = ["/", "/login", "/auth"];
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
    } }
  );
  const { data } = await supabase.auth.getClaims();
  const p = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((x) => p === x || p.startsWith(x + "/"));
  if (!data?.claims && !isPublic) {
    const url = request.nextUrl.clone(); url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return response;
}
