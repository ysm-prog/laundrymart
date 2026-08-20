import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Refreshes the Supabase session cookie and gates unauthenticated navigations.
 * Next.js 16 renamed this convention from `middleware` to `proxy`.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Skip static assets so the auth gate only runs on real navigations.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
