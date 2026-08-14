import { notFound, redirect } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import { createCustomer } from "@/app/(app)/customers/actions";
import type { LaundryOrder, LaundryOrderItem } from "@/lib/db/types";
import { updateOrder } from "../../actions";
import { loadJobFormData } from "../../form-data";
import { JobForm } from "../../job-form";

export const metadata = { title: "Edit job" };
export const dynamic = "force-dynamic";

/**
 * The same form as creation, filled in. Two doors are shut before it renders:
 * a cancelled job is history and cannot be edited at all, and a completed one
 * needs `orders.manage` — correcting a job after the customer has walked out
 * with it is a supervisor's job, not a counter one. Both are re-checked in
 * `updateOrder`, which is where it actually matters.
 */
export default async function EditJobPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ customer?: string }>;
}) {
  const { id } = await params;
  // Set when the customer quick-create has just returned, and when a rejected
  // `updateOrder` is coming back with the customer still chosen; see JobForm.
  const { customer } = await searchParams;
  const session = await requireCapability("orders.write");

  const supabase = await createClient();
  const [{ data: order }, { data: items }] = await Promise.all([
    supabase.from("laundry_orders").select("*").eq("id", id).maybeSingle<LaundryOrder>(),
    supabase.from("laundry_order_items")
      .select("id, order_id, item_type, custom_description, quantity_type, exact_quantity, bag_count, estimated_quantity, notes")
      .eq("order_id", id).order("created_at")
      .returns<LaundryOrderItem[]>(),
  ]);

  if (!order) notFound();
  if (order.status === "cancelled") redirect(`/orders/${id}`);
  if (order.status === "completed" && !can(session.role, "orders.manage")) redirect(`/orders/${id}`);

  const { customers, drivers, staff } = await loadJobFormData(customer ?? order.customer_id);

  return (
    <PageContainer width="form">
      <PageHeader
        back={{ href: `/orders/${id}`, label: `Back to ${order.order_number}` }}
        title={`Edit ${order.order_number}`}
        description="Change what was taken in, when it is due, and who is on it."
      />

      {order.status === "completed" ? (
        <div className="mb-5">
          <Notice tone="warning" title="This job is already completed">
            You are correcting a finished job. The change is recorded in its activity
            trail with your name on it.
          </Notice>
        </div>
      ) : null}

      <JobForm
        action={updateOrder}
        customerAction={createCustomer}
        customers={customers}
        drivers={drivers}
        staff={staff}
        order={order}
        items={items ?? []}
        defaultCustomerId={customer}
        canBackdate={can(session.role, "orders.manage")}
        returnPath={`/orders/${id}/edit`}
      />
    </PageContainer>
  );
}
