import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/passwords";

/**
 * The People screen's form and the actions behind it agree about their seam.
 *
 * Read the **source**, for the reason `one-door.test.ts` gives: `actions.ts` is
 * a `"use server"` module reaching `next/headers` through `assertCapability`,
 * and `page.tsx` reaches Supabase at module scope, so neither can be imported
 * into vitest and their behaviour is unreachable. The property here is
 * structural, so source is enough.
 *
 * It is worth guarding at all because this exact seam — a field a form posts
 * and an action reads by name — has shipped broken in this repository three
 * times behind a green `verify`: the job form's laundry items, the dispatch
 * planner's entire board, and the run sequencer's `return_to`. Each typechecked,
 * linted and tested clean, because a form field name is a string on one side and
 * a string on the other and nothing compares them.
 */

const admin = join(__dirname, "..");
const read = (file: string) => readFileSync(join(admin, file), "utf8");

/** Strip comments, or the prose *describing* a field would satisfy the search. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const page = code(read("users/page.tsx"));
const actions = code(read("actions.ts"));

describe("the add-someone form and its two actions", () => {
  it("posts every field both actions read, under the same names", () => {
    // Non-vacuous: prove the search finds a field that is certainly there
    // before trusting it to report on the others.
    expect(page).toMatch(/name="full_name"/);

    for (const field of ["full_name", "email", "role", "depot_id", "password"]) {
      expect(page, `the form must post ${field}`).toMatch(
        new RegExp(`name=["']${field}["']`),
      );
    }
  });

  it("offers both verbs from one form, so one set of answers serves both", () => {
    // Two <form>s would mean the four questions asked twice — the thing this
    // design exists to avoid. `formAction` is what makes one form carry two.
    expect(page).toMatch(/formAction=\{createMemberWithPassword\}/);
    expect(page).toMatch(/action=\{inviteMember\}/);
  });

  it("never marks the password required in HTML", () => {
    // It lives inside a <details>, and a `required` control inside a closed
    // disclosure fails native validation with nothing to focus — the form
    // simply refuses to submit and says nothing. The 2026-08-24 pass recorded
    // this when the job form's optional sections became disclosures.
    const passwordInput = page.match(/<Input\s+name="password"[^/]*\/>/)?.[0] ?? "";
    expect(passwordInput).not.toBe("");
    expect(passwordInput).not.toMatch(/\brequired\b/);
    expect(passwordInput).toMatch(/type="password"/);
    // `off` is widely ignored by password managers, which would then offer to
    // fill the administrator's *own* credential into a box that makes somebody
    // else's login.
    expect(passwordInput).toMatch(/autoComplete="new-password"/);
  });

  it("states the length rule from the constant the server enforces", () => {
    // The defect this was adopted from: ysm-hub's form refuses under 6 and its
    // API refuses under 10, so a 7-character password passes the browser and is
    // rejected by the server. One rule, one place, interpolated — not typed
    // out, which is how the two drift apart.
    expect(page).toMatch(/\$\{MIN_PASSWORD_LENGTH\}/);
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(10);
  });

  it("makes the invitation refuse a typed password rather than dropping it", () => {
    // The one hazard of putting both verbs in one form: a password typed into
    // the box and then "Send invitation" pressed. Silently ignoring it is the
    // worst outcome available — the invitation goes, and the administrator
    // hands over a credential this app never stored.
    expect(actions).toMatch(/formData\.get\(["']password["']\)/);
    const invite = actions.slice(
      actions.indexOf("export async function inviteMember"),
      actions.indexOf("export async function createMemberWithPassword"),
    );
    expect(invite).not.toBe("");
    expect(invite, "inviteMember must notice a typed password").toMatch(
      /formData\.get\(["']password["']\)/,
    );
    expect(invite, "and refuse rather than continue").toMatch(/return fail\(/);
  });

  it("cleans up the login it just made if the membership does not land", () => {
    // An auth.users row with no membership is a login that signs in and
    // dead-ends, and whose retry answers "that address already has a login" —
    // the one message that stops an administrator finishing the job. ysm-hub
    // leaves this orphan behind; §10c settled the same question for the
    // invitation path, which deletes the login a refused send had minted.
    const create = actions.slice(actions.indexOf("export async function createMemberWithPassword"));
    expect(create).toMatch(/deleteUser\(/);
    // ...and the membership goes in on the caller's RLS-bound client, not the
    // admin one, so which laundry somebody joins stays the database's decision.
    expect(create).toMatch(/from\(["']memberships["']\)/);
    expect(create).toMatch(/tenant_id:\s*session\.tenantId/);
  });

  it("never puts the password into the flash message or the audit trail", () => {
    // `done()`/`fail()` ride a cookie that is not httpOnly (§2) and survives a
    // redirect, and the audit trail is read by four roles.
    const create = actions.slice(actions.indexOf("export async function createMemberWithPassword"));
    const done = create.match(/return done\([\s\S]*?\);/)?.[0] ?? "";
    const audit = create.match(/recordAudit\([\s\S]*?\}\);/)?.[0] ?? "";
    expect(done).not.toBe("");
    expect(audit).not.toBe("");
    // The property is that the *value* never appears — not the word, which the
    // success message says on purpose ("the password you set"). So look for the
    // binding being interpolated or concatenated in, which is the only way it
    // could reach either place.
    for (const block of [done, audit]) {
      expect(block).not.toMatch(/\$\{\s*password\s*[}.]/);
      expect(block).not.toMatch(/[+,]\s*password\b/);
    }
  });
});

describe("the members list", () => {
  it("gives every row's controls an id of their own", () => {
    // `Input`/`Select` default their id to the field name and this form is
    // rendered once per member, so without an explicit id a laundry with twenty
    // people emitted twenty elements called `role`. Invalid HTML, and every
    // `<label for>` in the document resolves to whichever came first.
    for (const field of ["full_name", "role", "depot_id"]) {
      expect(page, `${field} needs a per-row id`).toMatch(
        new RegExp(`id=\\{\`${field}-\\$\\{row\\.id\\}\``),
      );
    }
  });
});
