// Session refresh + auth gate via getClaims() = LOCAL JWT verification (no network
// round-trip when asymmetric signing keys are enabled — the perf lesson).
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
const PUBLIC = ["/", "/login", "/auth"];
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
