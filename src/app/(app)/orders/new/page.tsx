import { requireCapability } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import { createCustomer } from "@/app/(app)/customers/actions";
import { createOrder } from "../actions";
import { CUSTOMER_LIMIT, loadJobFormData } from "../form-data";
import { JobForm } from "../job-form";

export const metadata = { title: "New job" };
export const dynamic = "force-dynamic";

/**
 * A dedicated page rather than a modal or drawer, matching how a customer and a
 * contract are created in this app — and matching a design system that has no
 * overlays at all.
 *
 * `?customer=<id>` is how the customer quick-create comes back: `createCustomer`
 * already honours `return_to` and appends the new id, so the counter lands here
 * again with the new customer selected instead of starting the job over. A
 * rejected `createOrder` uses the same door, so a validation message does not
 * also cost the counter the customer they had already found.
 */
export default async function NewJobPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const params = await searchParams;
  const session = await requireCapability("orders.write");
  const { customers, catalogue, drivers, staff, truncated } = await loadJobFormData(params.customer);

  return (
    /* Capped at ~1040px: an entry form stretched across a 1900px monitor puts
       the label at one end of the desk and its input at the other. */
    <PageContainer width="form">
      <PageHeader
        back={{ href: "/orders", label: "All jobs" }}
        title="Take in laundry"
        description="Pick the customer, list what they brought, say when they get it back."
      />

      {customers.length === 0 ? (
        <div className="mb-5">
          <Notice tone="warning" title="No customers yet">
            A job always belongs to a customer. Add one below and it will be selected
            for you, or set them up properly on the Customers screen first.
          </Notice>
        </div>
      ) : null}

      {truncated ? (
        <div className="mb-5">
          <Notice tone="info" title={`Showing your first ${CUSTOMER_LIMIT} customers`}>
            The search box below covers those. If someone is missing, open their
            record from Customers and start the job from there.
          </Notice>
        </div>
      ) : null}

      <JobForm
        action={createOrder}
        customerAction={createCustomer}
        customers={customers}
        catalogue={catalogue}
        drivers={drivers}
        staff={staff}
        defaultCustomerId={params.customer}
        canBackdate={can(session.role, "orders.manage")}
        returnPath="/orders/new"
      />
    </PageContainer>
  );
}
