/**
 * Sign-in links this app mints itself and sends through its own mail provider.
 *
 * ## Why this exists
 *
 * Every auth email used to come from Supabase's built-in mailer —
 * `inviteUserByEmail` for an invitation, `signInWithOtp` for a sign-in link.
 * That mailer only delivers to members of the Supabase organisation and is
 * capped at a couple of messages an hour, so a real deployment has to point it
 * at custom SMTP first. This one never had any, which is why **not one auth
 * email has ever left the project**: invitations could not be sent, the four
 * board logins had to be written by SQL (§24), and the sign-in form said a link
 * was on its way every single time without one ever being.
 *
 * The app already sends invoices and customer mail through Resend. So the fix
 * is to stop asking Supabase to send anything and use the sender we have:
 * `generateLink()` on the service-role client **mints a link and returns it
 * without sending it**, which is precisely what it is for.
 *
 * ## Two decisions worth keeping
 *
 * **The link points at this app, not at Supabase.** `generateLink` hands back
 * both an `action_link` (a Supabase `/auth/v1/verify?…&redirect_to=` URL) and
 * the `hashed_token` behind it. Building `<origin>/auth/invite?token_hash=…`
 * ourselves skips the redirect hop *and* the deployment step §10c records — the
 * project no longer has to list this origin under its allowed redirect URLs,
 * because Supabase is never the one doing the redirecting. A preview deployment
 * therefore works with no configuration at all.
 *
 * **A sign-in link is a `recovery` link.** The login page offers it under "No
 * password, or forgotten it?", so the person pressing it either has none or has
 * lost it — and `recovery` is the type that both signs them in and lets them
 * set one, which is the promise the button makes. It also cannot create an
 * account, so a mistyped address still cannot mint an orphan login the way
 * `signInWithOtp`'s default would.
 *
 * Pure and dependency-free on purpose: the fetch lives in `send-link.ts`, which
 * reaches `lib/env` and so cannot be imported by a unit test.
 */

/** The two links this app sends. */
export type AuthLinkKind = "invite" | "sign-in";

/** What `admin.generateLink()` is asked to mint. */
export const GENERATE_TYPE = {
  invite: "invite",
  "sign-in": "recovery",
} as const satisfies Record<AuthLinkKind, "invite" | "recovery">;

/**
 * What `verifyOtp()` is told at the other end. The same word both ways here,
 * but they are two different APIs and pinning them together in one table is
 * what stops a future third kind pairing the wrong halves.
 */
export const VERIFY_TYPE = {
  invite: "invite",
  "sign-in": "recovery",
} as const satisfies Record<AuthLinkKind, "invite" | "recovery">;

/**
 * Both kinds land on `/auth/invite`, which has read `?token_hash=&type=` since
 * it was built and already branches on `invite` vs `recovery`. One screen, and
 * it signs the person in before offering the password box — so "I'll do this
 * later" stays a real option for a sign-in link too.
 */
export const AUTH_LINK_PATH = "/auth/invite";

/**
 * The link to put in the email, or null if `origin` is not somewhere this app
 * is actually served from.
 *
 * Guarded rather than trusted because the origin is read off the request
 * header: an attacker who could set it would otherwise be choosing where a
 * genuine sign-in token gets sent. Same reasoning as `returnTo()` in
 * `lib/actions.ts`, one step further out — that one refuses a foreign *path*,
 * this one refuses a foreign *host*.
 */
export function authLinkUrl(
  origin: string, kind: AuthLinkKind, hashedToken: string,
): string | null {
  if (!hashedToken) return null;

  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;

  const url = new URL(AUTH_LINK_PATH, base.origin);
  url.searchParams.set("token_hash", hashedToken);
  url.searchParams.set("type", VERIFY_TYPE[kind]);
  return url.toString();
}

/**
 * This app's own web address, worked out from the request.
 *
 * Kept here, pure, so the derivation is testable — the `headers()` read that
 * feeds it is a three-line wrapper in `request-origin.ts`, which cannot be
 * imported by a unit test.
 *
 * **`Host` rather than `Origin`, deliberately.** The sign-in form used to read
 * the `Origin` header, which a browser sends on a form post but which a proxy
 * may strip and which nothing guarantees — and an absent origin here does not
 * fail loudly, it tells the person "this deployment could not work out its own
 * web address", which is a confusing thing to meet on your first attempt to
 * sign in. `Host` is always present, and on Vercel `x-forwarded-host` is set by
 * the platform from the domain it routed on, so it is the same string the
 * person is already looking at.
 *
 * The scheme is assumed to be https unless the host is plainly local, because
 * `x-forwarded-proto` is absent under a bare `next start` and a link built as
 * `https://localhost:3000` would not open.
 */
export function originFromRequest(
  host: string | null | undefined, proto: string | null | undefined,
): string {
  if (!host) return "";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  return `${proto ?? (local ? "http" : "https")}://${host}`;
}

/**
 * Why a link could not be sent.
 *
 * Split by **who it is true of**, not by which call failed, because that is the
 * only distinction the sign-in form is allowed to act on: a fault true of every
 * address reveals nothing and is named plainly; one true of *this* address is
 * exactly what an attacker is fishing for and stays behind the same answer as
 * success. `magic-link.ts` holds that rule; this is its vocabulary.
 */
export type LinkFailure =
  /** No mail provider wired up. True of every address. */
  | { reason: "not-configured" }
  /** The request arrived without an origin we could build a link on. */
  | { reason: "no-origin" }
  /** The service key is missing, so no link can be minted at all. */
  | { reason: "no-service-key" }
  /** Too many attempts — from here, or against the auth service. */
  | { reason: "rate-limited" }
  /** The auth service or the mail provider fell over. */
  | { reason: "unreachable" }
  /** The mail provider took the request and refused it. */
  | { reason: "send-refused"; detail: string }
  /** No login at that address. **True of this address alone.** */
  | { reason: "unknown-address" };

/** The Supabase error shape we actually read. */
export type AuthApiError = { code?: string; status?: number; message?: string };

/**
 * Faults of the deployment rather than of the address, by Supabase's own code.
 * Each names something only an administrator can put right.
 */
const DEPLOYMENT_CODES: Record<string, LinkFailure["reason"]> = {
  over_email_send_rate_limit: "rate-limited",
  over_request_rate_limit: "rate-limited",
  email_provider_disabled: "not-configured",
  validation_failed: "unreachable",
};

/**
 * Read a `generateLink` refusal.
 *
 * The default is **`unknown-address`**, and that is deliberate: an unrecognised
 * refusal is treated as being about the address, so the sign-in form hides it.
 * Guessing the other way would turn every new Supabase error code into an
 * account-enumeration oracle, and the cost of guessing this way is only that an
 * administrator inviting somebody sees a duller message — which the invite path
 * fixes by passing the provider's own words through (`inviteFailureMessage`).
 */
export function classifyLinkError(error: AuthApiError | null): LinkFailure | null {
  if (!error) return null;

  const named = error.code ? DEPLOYMENT_CODES[error.code] : undefined;
  if (named) return { reason: named } as LinkFailure;

  // A 5xx is the service falling over, whatever it called itself — and it
  // happens to every address alike.
  if (typeof error.status === "number" && error.status >= 500) {
    return { reason: "unreachable" };
  }

  return { reason: "unknown-address" };
}
