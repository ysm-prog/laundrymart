"use server";

import { billingAddressFromSite } from "@/lib/domain/customers";

import { revalidatePath } from "next/cache";
import { BILLING_METHODS } from "@/lib/domain/billing";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { isValidAbn, normaliseAbn } from "@/lib/domain/abn";
import {
  checkbox, clearable, count, describeDbError, done, fail, firstIssue,
  optionalText, optionalUuid, returnTo, toObject,
} from "@/lib/actions";

const abn = optionalText
  .transform((value) => (value === undefined ? undefined : normaliseAbn(value)))
  .refine((value) => value === undefined || isValidAbn(value),
          "That ABN fails the ATO check-digit test");

const customerSchema = z.object({
  business_name: z.string().trim().min(2, "Business name is required"),
  trading_name: optionalText,
  abn,
  depot_id: optionalUuid,
  billing_address_line1: optionalText,
  billing_suburb: optionalText,
  billing_state: optionalText,
  billing_postcode: optionalText,
  billing_email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().email("Enter a valid email").optional(),
  ),
  phone: optionalText,
  payment_terms_days: count,
  purchase_order_number: optionalText,
  special_instructions: optionalText,
  notes: optionalText,
  status: z.enum(["prospect", "active", "on_hold", "inactive", "archived"]),

  /**
   * The standing weekly collection (0047).
   *
   * **`clearable`, not `optionalUuid`/`count`**, and this is the whole reason
   * that helper moved into `lib/actions.ts`: those fold an empty box to
   * `undefined`, supabase-js drops undefined keys, and the column is therefore
   * never written — so a customer put on a Tuesday round could never be taken
   * off one. Taking a customer *off* a standing collection is at least as
   * ordinary as putting them on.
   *
   * The range is stated here as well as in `chk_customers_collection_weekday`
   * because a refusal from Postgres names a constraint, and the person choosing
   * a day needs a sentence.
   */
  collection_weekday: clearable(
    z.coerce.number().int().min(1, "Choose a day of the week").max(7, "Choose a day of the week"),
  ),
  collection_board_id: clearable(z.string().uuid()),
  /**
   * How they are billed (brief 3.6). Asked on the new-customer form only; an
   * existing customer's method is changed on their Billing & pricing card,
   * under `billing.write`, which is why `updateCustomer` drops it.
   */
  billing_method: z.enum(BILLING_METHODS).optional(),
});

export async function createCustomer(formData: FormData): Promise<void> {
  const session = await assertCapability("customers.write");
  // The quick-create embedded in the contract wizard posts a return_to; the
  // failure path has to land back on it, not on /customers/new.
  const backTo = returnTo(formData, "/customers/new");
  const parsed = customerSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  // The quick-create's fourth field: one address line that becomes the first
  // site, so the customer is routable the moment they exist.
  const siteAddress = optionalText.parse(formData.get("site_address") ?? "");

  const supabase = await createClient();

  // Customer numbers are sequential per tenant and allocated in Postgres so
  // two dispatchers creating a customer at once can't collide.
  const { data: customerNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "customer", p: "CUST" });
  if (numberError) return fail(backTo, describeDbError(numberError));

  const { data, error } = await supabase
    .from("customers")
    .insert({
      // The site is the billing address too unless one was given — otherwise
      // a quick-created customer's invoices print no address (2026-10-12).
      ...billingAddressFromSite(parsed.data, siteAddress),
      tenant_id: session.tenantId,
      created_by: session.userId,
      customer_number: customerNumber as string,
    })
    .select("id, business_name, customer_number")
    .single();

  if (error) return fail(backTo, describeDbError(error));

  if (siteAddress) {
    const { error: locationError } = await supabase.from("customer_locations").insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      customer_id: data.id,
      name: "Main site",
      address_line1: siteAddress,
      is_pickup: true,
      is_delivery: true,
    });
    if (locationError) {
      return fail(`/customers/${data.id}`,
        `${data.customer_number} was created but its site could not be saved: ${describeDbError(locationError)}`);
    }
  }

  await recordAudit(session, {
    entity: "customer", entityId: data.id, action: "create",
    summary: `${data.customer_number} ${data.business_name}`,
  });

  revalidatePath("/customers");
  if (backTo !== "/customers/new") {
    // Back to the caller (the wizard) with the new customer preselected.
    const separator = backTo.includes("?") ? "&" : "?";
    return done(`${backTo}${separator}customer=${data.id}`,
      `Customer ${data.customer_number} created.`);
  }
  return done(`/customers/${data.id}`, `Customer ${data.customer_number} created.`);
}

export async function updateCustomer(formData: FormData): Promise<void> {
  const session = await assertCapability("customers.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/customers", "That customer could not be found.");

  const parsed = customerSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(`/customers/${id.data}/edit`, firstIssue(parsed.error));
  // The billing method is the Billing & pricing card's, not this form's.
  const { billing_method: _billingMethod, ...changes } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update(changes)
    .eq("id", id.data)
    // Belt and braces: RLS already scopes this, the filter documents the intent.
    .eq("tenant_id", session.tenantId);

  if (error) return fail(`/customers/${id.data}/edit`, describeDbError(error));

  await recordAudit(session, {
    entity: "customer", entityId: id.data, action: "update",
    summary: parsed.data.business_name,
  });

  revalidatePath(`/customers/${id.data}`);
  return done(`/customers/${id.data}`, "Customer updated.");
}

const locationSchema = z.object({
  customer_id: z.string().uuid(),
  name: z.string().trim().min(1, "Site name is required"),
  address_line1: optionalText,
  suburb: optionalText,
  state: optionalText,
  postcode: optionalText,
  access_notes: optionalText,
  is_pickup: checkbox,
  is_delivery: checkbox,
});

export async function addLocation(formData: FormData): Promise<void> {
  const session = await assertCapability("customers.write");
  const parsed = locationSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/customers", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.from("customer_locations").insert({
    ...parsed.data,
    tenant_id: session.tenantId,
    created_by: session.userId,
  });
  if (error) return fail(`/customers/${parsed.data.customer_id}`, describeDbError(error));

  await recordAudit(session, {
    entity: "customer_location", entityId: parsed.data.customer_id,
    action: "create", summary: parsed.data.name,
  });

  revalidatePath(`/customers/${parsed.data.customer_id}`);
  return done(`/customers/${parsed.data.customer_id}`, `Site "${parsed.data.name}" added.`);
}

const contactSchema = z.object({
  customer_id: z.string().uuid(),
  name: z.string().trim().min(1, "Contact name is required"),
  role: optionalText,
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().email("Enter a valid email").optional(),
  ),
  phone: optionalText,
  is_primary: checkbox,
});

export async function addContact(formData: FormData): Promise<void> {
  const session = await assertCapability("customers.write");
  const parsed = contactSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/customers", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.from("customer_contacts").insert({
    ...parsed.data,
    tenant_id: session.tenantId,
    created_by: session.userId,
  });
  if (error) return fail(`/customers/${parsed.data.customer_id}`, describeDbError(error));

  await recordAudit(session, {
    entity: "customer_contact", entityId: parsed.data.customer_id,
    action: "create", summary: parsed.data.name,
  });

  revalidatePath(`/customers/${parsed.data.customer_id}`);
  return done(`/customers/${parsed.data.customer_id}`, `Contact "${parsed.data.name}" added.`);
}

/** Soft delete (business rule §11) — history stays intact. */
export async function archiveCustomer(formData: FormData): Promise<void> {
  const session = await assertCapability("customers.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/customers", "That customer could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ status: "archived", deleted_at: new Date().toISOString() })
    .eq("id", id.data)
    .eq("tenant_id", session.tenantId);

  if (error) return fail(`/customers/${id.data}`, describeDbError(error));

  await recordAudit(session, { entity: "customer", entityId: id.data, action: "delete" });
  revalidatePath("/customers");
  return done("/customers", "Customer archived.");
}

/* ---------------------------------------------------------- set round, bulk */

/**
 * Put a selection of customers on a round and a weekday at once (brief 2.2).
 *
 * "Ready means assigned" only works for a customer who has a round, and on the
 * live laundry that was **2 of 513** — so without this the automatic
 * assignment would have had almost nothing to act on, and setting each one
 * meant opening 511 edit forms. One request, one UPDATE, capped at 200 like the
 * billing bulk actions and refused rather than truncated past it.
 *
 * `guard_customer_collection_board` (0047) still judges the board — another
 * laundry's, a retired one or an unknown id is refused out loud. Choosing "No
 * round" clears both columns, which is how a customer comes off a standing
 * collection.
 */
const MAX_ROUND_SELECTION = 200;

const setRoundSchema = z.object({
  board_id: z.union([z.literal(""), z.string().uuid("Choose a round.")]),
  weekday: z.union([z.literal(""), z.coerce.number().int().min(1).max(7)]),
});

export async function setCustomersRound(formData: FormData): Promise<void> {
  const session = await assertCapability("customers.write");
  const back = returnTo(formData, "/customers");

  const ids = z.array(z.string().uuid()).safeParse(
    formData.getAll("selected").filter((value): value is string => typeof value === "string"),
  );
  if (!ids.success) return fail(back, "That selection could not be read. Please try again.");
  const selected = [...new Set(ids.data)];
  if (selected.length === 0) return fail(back, "Tick at least one customer.");
  if (selected.length > MAX_ROUND_SELECTION) {
    return fail(back, `Set the round for ${MAX_ROUND_SELECTION} customers or fewer at a time.`);
  }

  const parsed = setRoundSchema.safeParse({
    board_id: formData.get("board_id") ?? "", weekday: formData.get("weekday") ?? "",
  });
  if (!parsed.success) return fail(back, firstIssue(parsed.error));
  const boardId = parsed.data.board_id || null;
  const weekday = parsed.data.weekday === "" ? null : parsed.data.weekday;
  if (boardId && weekday === null) {
    return fail(back, "Choose the day of the week this round calls.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .update({ collection_board_id: boardId, collection_weekday: boardId ? weekday : null })
    .in("id", selected)
    .eq("tenant_id", session.tenantId)
    .select("id");
  if (error) return fail(back, describeDbError(error));

  const changed = data?.length ?? 0;
  await recordAudit(session, {
    entity: "customer", action: "update",
    summary: boardId
      ? `round set for ${changed} customer(s)`
      : `round cleared for ${changed} customer(s)`,
    metadata: { boardId, weekday, customers: changed },
  });

  revalidatePath("/customers");
  revalidatePath("/runs/collections");
  if (changed === 0) return fail(back, "None of those customers could be changed.");
  return done(back, boardId
    ? `Round set for ${changed} ${changed === 1 ? "customer" : "customers"}. Their jobs now go onto it as soon as they are ready.`
    : `Round cleared for ${changed} ${changed === 1 ? "customer" : "customers"}.`);
}
