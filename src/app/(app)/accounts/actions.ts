"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, optionalText, toObject } from "@/lib/actions";
import { ACCOUNT_TYPES } from "./account-types";

/**
 * Adding to the chart of accounts.
 *
 * **Why this did not exist before.** The chart arrived whole from the MYOB
 * import and the screen said so — "appears here once it is imported from your
 * accounting system" — so a laundry wanting one more revenue code had nowhere
 * to put it. The import is a one-off; the chart is not.
 *
 * `purchases.write` rather than a new capability: this is the same set of
 * people who already write supplier bills and purchase orders, and the chart of
 * accounts is what those are coded against. `can_write_purchases()` (0036) is
 * the database's copy of the same sentence — and it is the boundary, because
 * before that migration `gl_accounts` carried `apply_tenant_policy`'s single
 * permissive `for all` policy and **every member of the laundry could rewrite
 * the chart straight off PostgREST**.
 */

const accountSchema = z.object({
  // Uniqueness is the database's (`uq_gl_accounts_code`), because two people
  // can type the same code at the same moment and only one can be told by a
  // screen. The 23505 is turned into a sentence below.
  code: z.string().trim().min(1, "An account code is required").max(20)
    .refine((value) => !/\s/.test(value), "An account code cannot contain spaces"),
  name: z.string().trim().min(2, "Name is required").max(120),
  account_type: z.enum(ACCOUNT_TYPES),
  tax_code: optionalText,
  // The code as it is in **Xero**, which is deliberately a separate field from
  // `code` above. Xero refuses an invoice naming a code its own chart does not
  // carry, so defaulting this to our code would turn one mismatch into every
  // invoice failing to push. Blank means "do not code Xero lines to this".
  xero_account_code: optionalText,
  is_header: z.preprocess((v) => v === "true" || v === true, z.boolean()),
  level: z.coerce.number().int().min(1).max(4),
});

type Account = { id: string; code: string; name: string };

export async function createAccount(formData: FormData): Promise<void> {
  const session = await assertCapability("purchases.write");
  const parsed = accountSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/accounts", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("gl_accounts")
    .insert({ ...parsed.data, tenant_id: session.tenantId, created_by: session.userId })
    .select("id, code, name")
    .single<Account>();

  if (error) {
    return fail("/accounts", error.code === "23505"
      ? `The account code ${parsed.data.code} is already in use.`
      : describeDbError(error));
  }

  await recordAudit(session, {
    entity: "gl_account", entityId: data.id, action: "create",
    summary: `${data.code} ${data.name}`,
    metadata: { code: data.code, xeroAccountCode: parsed.data.xero_account_code },
  });

  revalidatePath("/accounts");
  return done("/accounts", `Account ${data.code} created.`);
}

export async function updateAccount(formData: FormData): Promise<void> {
  const session = await assertCapability("purchases.write");
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/accounts", "That account could not be found.");

  const parsed = accountSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(`/accounts/${id.data}`, firstIssue(parsed.error));

  const supabase = await createClient();
  // Filtered by tenant as well as by id (§23): a platform admin's session reads
  // every laundry, and this id arrives from the browser.
  const { data, error } = await supabase
    .from("gl_accounts")
    .update(parsed.data)
    .eq("id", id.data).eq("tenant_id", session.tenantId)
    .select("id, code, name")
    .maybeSingle<Account>();

  if (error) {
    return fail(`/accounts/${id.data}`, error.code === "23505"
      ? `The account code ${parsed.data.code} is already in use.`
      : describeDbError(error));
  }
  // An UPDATE matching nothing is not an error to PostgREST, and in a role-gated
  // table that silence is the outcome most needing a name.
  if (!data) return fail("/accounts", "That account is not in this laundry.");

  await recordAudit(session, {
    entity: "gl_account", entityId: data.id, action: "update",
    summary: `${data.code} ${data.name}`,
    metadata: { code: data.code, xeroAccountCode: parsed.data.xero_account_code },
  });

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${id.data}`);
  return done(`/accounts/${id.data}`, `Account ${data.code} saved.`);
}
