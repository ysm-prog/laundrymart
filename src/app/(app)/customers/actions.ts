"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { isValidAbn, normaliseAbn } from "@/lib/domain/abn";
import {
  checkbox, count, describeDbError, done, fail, firstIssue,
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
      ...parsed.data,
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

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update(parsed.data)
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
