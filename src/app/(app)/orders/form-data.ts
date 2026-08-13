import { createClient } from "@/lib/supabase/server";
import { listStaff } from "@/lib/staff";
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

export type JobFormData = {
  customers: JobCustomer[];
  drivers: JobDriver[];
  staff: JobStaff[];
  /** True when more customers exist than the picker loaded. */
  truncated: boolean;
};

export async function loadJobFormData(): Promise<JobFormData> {
  const supabase = await createClient();

  const [customersResult, locationsResult, driversResult, staff] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "id, customer_number, business_name, trading_name, phone, billing_email, " +
        "billing_address_line1, billing_suburb, billing_state, billing_postcode",
        { count: "exact" },
      )
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

  // First delivery site per customer wins; the query already sorts primaries up.
  const deliveryAddress = new Map<string, string>();
  for (const location of locationsResult.data ?? []) {
    if (deliveryAddress.has(location.customer_id)) continue;
    const address = [location.address_line1, location.suburb, location.state, location.postcode]
      .filter(Boolean).join(", ");
    if (address) deliveryAddress.set(location.customer_id, address);
  }

  const customers: JobCustomer[] = (customersResult.data ?? []).map((customer) => ({
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
  }));

  return {
    customers,
    drivers: driversResult.data ?? [],
    staff,
    truncated: (customersResult.count ?? 0) > customers.length,
  };
}
