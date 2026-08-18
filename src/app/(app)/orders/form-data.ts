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
 */
const CUSTOMER_LIMIT = 500;

const CUSTOMER_COLUMNS =
  "id, customer_number, business_name, trading_name, phone, billing_email, " +
  "billing_address_line1, billing_suburb, billing_state, billing_postcode";

export type JobFormData = {
  customers: JobCustomer[];
  drivers: JobDriver[];
  staff: JobStaff[];
  /** True when more customers exist than the picker loaded. */
  truncated: boolean;
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
  const supabase = await createClient();

  const [customersResult, locationsResult, driversResult, staff] = await Promise.all([
    supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS, { count: "exact" })
      .is("deleted_at", null)
      .in("status", ["active", "prospect", "on_hold"])
      .order("business_name")
      .limit(CUSTOMER_LIMIT)
      .returns<{
        id: string; customer_number: string; business_name: string;
        trading_name: string | null; phone: string | null; billing_email: string | null;
        billing_address_line1: string | null; billing_suburb: string | null;
        billing_state: string | null; billing_postcode: string | null;
      }[]>(),
    supabase
      .from("customer_locations")
      .select("customer_id, address_line1, suburb, state, postcode, is_primary")
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
      .eq("status", "active")
      .is("deleted_at", null)
      .order("full_name")
      .returns<JobDriver[]>(),
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

  const toJobCustomer = (customer: {
    id: string; customer_number: string; business_name: string;
    trading_name: string | null; phone: string | null; billing_email: string | null;
    billing_address_line1: string | null; billing_suburb: string | null;
    billing_state: string | null; billing_postcode: string | null;
  }): JobCustomer => ({
    id: customer.id,
    customer_number: customer.customer_number,
    business_name: customer.business_name,
    trading_name: customer.trading_name,
    phone: customer.phone,
    billing_email: customer.billing_email,
    billing_address: [
      customer.billing_address_line1, customer.billing_suburb,
      customer.billing_state, customer.billing_postcode,
    ].filter(Boolean).join(", ") || null,
    delivery_address: deliveryAddress.get(customer.id) ?? null,
  });

  const customers: JobCustomer[] = (customersResult.data ?? []).map(toJobCustomer);
  const total = customersResult.count ?? 0;

  // The one the form is about to show as chosen, when the capped, status-filtered
  // list above did not carry them — a customer past the 500th by name, or one
  // since put on hold under a job that already exists. One row, only when needed.
  if (ensureCustomerId && !customers.some((customer) => customer.id === ensureCustomerId)) {
    const { data: missing } = await supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .eq("id", ensureCustomerId)
      .is("deleted_at", null)
      .maybeSingle<Parameters<typeof toJobCustomer>[0]>();
    if (missing) customers.push(toJobCustomer(missing));
  }

  return {
    customers,
    drivers: driversResult.data ?? [],
    staff: pickableStaff,
    // Measured against what the search box actually covers, not against
    // `customers` — the row appended above is reachable only by already being
    // selected, so it must not make a truncated list look complete.
    truncated: total > (customersResult.data?.length ?? 0),
  };
}
