/**
 * What counts as an acceptable password when an administrator sets one.
 *
 * Adopted from `ysm-prog/ysm-hub`'s `api/create-staff.js`, which is where this
 * app's People screen got the "create with a password" path — but with the one
 * defect in it fixed rather than copied. **ysm-hub states the rule twice and the
 * two copies disagree**: `AddStaffForm` in `src/pages/Settings.jsx` refuses a
 * password under **6** characters and `api/create-staff.js` refuses one under
 * **10**, so a 7-character password passes the browser and is rejected by the
 * server with a message the form never predicted. One rule, one place, is the
 * whole reason this module exists — and it lives in `lib/` rather than beside
 * the action because a `"use server"` module can export nothing but server
 * actions, so a rule written there is unreachable from a unit test. That trap
 * has shipped broken code in this repo three times (§2).
 *
 * The rules, and why each one is here rather than assumed:
 */

/**
 * Ten, following ysm-hub's server (the half that actually binds).
 *
 * Comfortably above Supabase's own default minimum of 6, so GoTrue can never be
 * the thing that refuses a password this app has already accepted — a refusal
 * arriving from the auth API instead of from the form is how a user-facing
 * message ends up naming somebody else's product.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Seventy-two **bytes**, which is bcrypt's block limit and not a policy choice.
 *
 * bcrypt hashes at most 72 bytes and older implementations silently ignore
 * everything past that — so without this cap a long passphrase would be stored
 * with its tail discarded, and two different passwords would open the same
 * login. GoTrue rejects it outright rather than truncating; either way the
 * honest thing is to say so here, in the form, in the operator's own words.
 *
 * Counted in **bytes and not characters** deliberately: an emoji or an accented
 * letter is several bytes, so a 40-character password can be over the limit.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * The problem with this password, in a sentence the person typing it can act
 * on — or `null` when there is none.
 *
 * Returns the *first* problem rather than a list: there is one password box, so
 * a list of three faults is three things to read before fixing one.
 */
export function passwordProblem(password: string): string | null {
  if (password === "") {
    return "Enter a password, or press Send invitation to email them a link instead.";
  }

  // Deliberately NOT trimmed, and this is the decision worth keeping. A password
  // is the exact bytes somebody chose, so trimming one silently changes the
  // credential the app then stores — and the person is handed a password that
  // does not work. Nor is surrounding whitespace simply *allowed*: an
  // administrator pasting from a document brings a trailing space or newline
  // with it, types it back without, and cannot sign in, with nothing on any
  // screen explaining why. So the ambiguity is refused out loud instead of being
  // resolved silently in either direction.
  if (password !== password.trim()) {
    return "That password starts or ends with a space. Remove it — a space is easy to paste and impossible to see.";
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters — that one is ${password.length}.`;
  }

  // `Buffer` is not available in every runtime this could be imported from, and
  // `TextEncoder` is. Both Node and the browser have it.
  const bytes = new TextEncoder().encode(password).length;
  if (bytes > MAX_PASSWORD_BYTES) {
    return `That password is too long — ${MAX_PASSWORD_BYTES} bytes is the limit and that one is ${bytes}.`;
  }

  return null;
}

/**
 * Read a refusal from `admin.auth.admin.createUser()`.
 *
 * Deliberately **not** enumeration-guarded, unlike `classifyLinkError` on the
 * sign-in form. The reasoning §10c records for `inviteFailureMessage` applies
 * exactly: this runs behind `admin.write` on a screen listing the laundry's own
 * people, and the administrator typed the address in themselves — so there is
 * nothing here they could learn that the screen has not already told them, and
 * a vague message would only stop them fixing a typo.
 *
 * The already-registered case is the one worth naming precisely, because the
 * remedy is a different button on the same screen rather than a different
 * address.
 */
export function createLoginFailureMessage(reason: string | undefined): string {
  const text = (reason ?? "").toLowerCase();

  if (text.includes("already registered") || text.includes("already been registered")
      || text.includes("already exists") || text.includes("email_exists")) {
    return "That address already has a login. Add them with Send invitation instead, "
      + "or use Email sign-in link on their row if they are already on this list.";
  }
  if (text.includes("password")) {
    return `That password was refused. ${reason}`;
  }
  if (text.includes("invalid") && text.includes("email")) {
    return "That email address was refused — check it for a typo.";
  }
  return reason
    ? `That login could not be created. ${reason}`
    : "That login could not be created.";
}
