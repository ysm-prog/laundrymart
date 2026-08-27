import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { listMembers, listStaff, withCurrentHolder } from "@/lib/directory";
import type { JobCustomer, JobDriver, JobStaff } from "./job-form";

/**
 * Everything the create and edit forms need to render, loaded once.
 *
 * The customer list is fetched whole (capped, see below) and searched in the
 * browser. That is deliberate: the counter is typing a name while a customer
 * waits, and a round trip per keystroke is the difference between a five-second
 * lookup and a fifteen-second one. The cap is the honest limit of the approach —
 * past it the picker would need a server-side search, which is what `/search`
 * already does for the rest of the app.
 *
 * **1000, not 500, and the difference is not theoretical.** This laundry's own
 * customer base is 511 businesses, so the old cap sat *inside* a real list: the
 * eleven at the end of the alphabet — five Zink Hair salons among them — would
 * have been unfindable here while sitting on the Customers screen, which is the
 * exact complaint this file was opened to fix, arriving a second time by another
 * route. 511 rows measure 157 kB of JSON before compression, so the doubling
 * costs a counter tablet one more page of a payload it already carries.
 */
export const CUSTOMER_LIMIT = 1000;

const CUSTOMER_COLUMNS =
  "id, customer_number, business_name, trading_name, phone, billing_email, status, " +
  "billing_address_line1, billing_suburb, billing_state, billing_postcode";

/** The columns above, as they come back. Stated once — it is read three times. */
type CustomerRow = {
  id: string; customer_number: string; business_name: string;
  trading_name: string | null; phone: string | null; billing_email: string | null;
  status: string; billing_address_line1: string | null; billing_suburb: string | null;
  billing_state: string | null; billing_postcode: string | null;
};

export type JobFormData = {
  customers: JobCustomer[];
  /** The item master, code-first. Empty for a laundry that has not set one up. */
  catalogue: JobCatalogueItem[];
  drivers: JobDriver[];
  staff: JobStaff[];
  /** True when more customers exist than the picker loaded. */
  truncated: boolean;
};

export type JobCatalogueItem = {
  id: string;
  item_code: string | null;
  name: string;
  description: string | null;
  laundry_category: string | null;
};

/**
 * @param ensureCustomerId a customer the form is about to show as chosen — the
 *   one on the job being edited, or the one a rejected post is coming back
 *   with. It is fetched on its own if the capped list above did not include it,
 *   because a picker that cannot find the id it was handed renders as though
 *   nothing were selected while the hidden field still posts that customer.
 * @param ensureStaffId whoever the job being edited is already assigned to. The
 *   list is this laundry's people, which no longer includes platform
 *   administrators — so without this, editing a job one of them holds would
 *   open showing "Nobody yet" and clear the assignment on save.
 */
export async function loadJobFormData(
  ensureCustomerId?: string, ensureStaffId?: string,
): Promise<JobFormData> {
  const session = await requireSession();
  const supabase = await createClient();

  const [customersResult, locationsResult, driversResult, catalogueResult, staff] = await Promise.all([
    supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS, { count: "exact" })
      // This laundry's customers. RLS says so for ten of the eleven roles, and
      // does not for a platform admin (0019) — whose picker offered the other
      // laundry's customers, which is how a job came to be raised in one
      // business against a customer of another.
      .eq("tenant_id", session.tenantId)
      .is("deleted_at", null)
      // Everyone but an archived customer, which is the same line the invoice
      // and contract pickers draw (`lib/domain/customers.ts` holds the rule).
      // This used to be an allow-list of three, which hid every `inactive`
      // customer from the counter while the Customers screen went on listing
      // them — 508 of this laundry's 511 the day its MYOB import landed, and
      // sixty of them still. Nothing was refusing the *work*: `createOrder`
      // takes any of them, and a job started from the customer's own record
      // saved perfectly well. Only the search box disagreed, and it said
      // nothing, so a missing customer read as a missing customer.
      .neq("status", "archived")
      .order("business_name")
      .limit(CUSTOMER_LIMIT)
      .returns<CustomerRow[]>(),
    supabase
      .from("customer_locations")
      .select("customer_id, address_line1, suburb, state, postcode, is_primary")
      .eq("tenant_id", session.tenantId)
      .eq("is_delivery", true)
      .is("deleted_at", null)
      .order("is_primary", { ascending: false })
      .returns<{
        customer_id: string; address_line1: string | null; suburb: string | null;
        state: string | null; postcode: string | null; is_primary: boolean;
      }[]>(),
    supabase
      .from("drivers")
      .select("id, full_name")
      .eq("tenant_id", session.tenantId)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("full_name")
      .returns<JobDriver[]>(),
    // The item master, for the counter's code-first picker (0032). Active only:
    // an inactive item cannot be taken in, so offering it is offering a dead end.
    //
    // Tenant named rather than left to RLS (§23) — a platform admin's session
    // reads every laundry's items, and the id is posted back into a job whose
    // trigger checks the item belongs to *this* laundry, so an unfiltered list
    // would offer choices that can only fail.
    supabase
      .from("items")
      .select("id, item_code, name, description, laundry_category")
      .eq("tenant_id", session.tenantId)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("item_code", { nullsFirst: false })
      .limit(500)
      .returns<JobCatalogueItem[]>(),
    listStaff(),
  ]);
  const pickableStaff = withCurrentHolder(staff, await listMembers(), ensureStaffId);

  // First delivery site per customer wins; the query already sorts primaries up.
  const deliveryAddress = new Map<string, string>();
  for (const location of locationsResult.data ?? []) {
    if (deliveryAddress.has(location.customer_id)) continue;
    const address = [location.address_line1, location.suburb, location.state, location.postcode]
      .filter(Boolean).join(", ");
    if (address) deliveryAddress.set(location.customer_id, address);
  }

  const toJobCustomer = (customer: CustomerRow): JobCustomer => ({
    id: customer.id,
    customer_number: customer.customer_number,
    business_name: customer.business_name,
    trading_name: customer.trading_name,
    phone: customer.phone,
    billing_email: customer.billing_email,
    // Carried so the picker can say "On hold" or "Inactive" beside the name
    // rather than leaving the counter to find out from somebody in the office.
    status: customer.status,
    billing_address: [
      customer.billing_address_line1, customer.billing_suburb,
      customer.billing_state, customer.billing_postcode,
    ].filter(Boolean).join(", ") || null,
    delivery_address: deliveryAddress.get(customer.id) ?? null,
  });

  const customers: JobCustomer[] = (customersResult.data ?? []).map(toJobCustomer);
  const total = customersResult.count ?? 0;

  // The one the form is about to show as chosen, when the capped list above did
  // not carry them — a customer past the thousandth by name, or one archived
  // under a job that already exists. One row, only when needed, and deliberately
  // unfiltered by status: this is a customer the form is *already* pointed at,
  // and dropping them here is what turns a picker into one that looks untouched
  // while the hidden field still posts that id.
  if (ensureCustomerId && !customers.some((customer) => customer.id === ensureCustomerId)) {
    const { data: missing } = await supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .eq("tenant_id", session.tenantId)
      .eq("id", ensureCustomerId)
      .is("deleted_at", null)
      .maybeSingle<CustomerRow>();
    if (missing) customers.push(toJobCustomer(missing));
  }

  return {
    customers,
    catalogue: catalogueResult.data ?? [],
    drivers: driversResult.data ?? [],
    staff: pickableStaff,
    // Measured against what the search box actually covers, not against
    // `customers` — the row appended above is reachable only by already being
    // selected, so it must not make a truncated list look complete.
    truncated: total > (customersResult.data?.length ?? 0),
  };
}
