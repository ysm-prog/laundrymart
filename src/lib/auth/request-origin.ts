/**
 * The web address this deployment is being reached on, for building a sign-in
 * link that points back at it.
 *
 * Read off the request rather than out of an environment variable, so a preview
 * deployment invites into itself instead of mailing a link to production — and
 * so nothing new has to be configured for the feature to work at all.
 *
 * The rule is in `auth-links.ts` with its tests; this is only the `headers()`
 * read, which no unit test can reach.
 */

import { headers } from "next/headers";
import { originFromRequest } from "@/lib/auth/auth-links";

export async function requestOrigin(): Promise<string> {
  const requestHeaders = await headers();
  return originFromRequest(
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
    requestHeaders.get("x-forwarded-proto"),
  );
}
