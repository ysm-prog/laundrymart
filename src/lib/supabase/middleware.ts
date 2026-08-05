// Session refresh + auth gate via getClaims() = LOCAL JWT verification (no network
// round-trip when asymmetric signing keys are enabled — the perf lesson).
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
// `/design-preview` is the static component gallery. It holds no data and 404s
// in production, so it does not need the auth gate — and gating it would make
// it unreachable from a build box, which is the only place it is any use.
const PUBLIC = ["/", "/login", "/auth", "/design-preview"];
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
