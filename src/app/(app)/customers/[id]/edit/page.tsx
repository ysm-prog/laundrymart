import { ConfirmSubmit } from "@/components/confirm-submit";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import type { Customer } from "@/lib/db/types";
import { Card, PageHeader } from "@/components/ui";
import { listActiveBoards } from "@/lib/runs/my-runs";
import { CustomerForm } from "../../customer-form";
import { archiveCustomer, updateCustomer } from "../../actions";

export const metadata = { title: "Edit customer" };
export const dynamic = "force-dynamic";

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("customers.write");

  const supabase = await createClient();
  const [{ data: customer }, { data: depots }, boards] = await Promise.all([
    supabase.from("customers")
      .select(
        "id, customer_number, business_name, trading_name, abn, billing_address_line1, " +
        "billing_suburb, billing_state, billing_postcode, billing_email, phone, " +
        "payment_terms_days, purchase_order_number, special_instructions, notes, status, " +
        // Every column the form posts is read here, or a save would clear the
        // ones it did not: the drift §25 records `ITEM_COLUMNS` being written
        // for, and it is invisible to a typecheck.
        "depot_id, created_at, collection_weekday, collection_board_id",
      )
      .eq("id", id).maybeSingle<Customer>(),
    supabase.from("depots").select("id, name").eq("status", "active").order("name"),
    // Named rather than left to RLS (§23): a board id chosen here is posted
    // into a write scoped to the laundry this person is working in.
    listActiveBoards(supabase, session.tenantId),
  ]);

  if (!customer) notFound();

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={`Edit ${customer.business_name}`} description={customer.customer_number} />
      <CustomerForm
        action={updateCustomer}
        customer={customer}
        depots={depots ?? []}
        boards={boards}
        cancelHref={`/customers/${id}`}
        submitLabel="Save changes"
      />

      <Card title="Hide this customer"
            description={"Use this when you no longer deal with a customer. They come off your " +
                         "lists, and nothing is deleted \u2014 their laundry, their bills and their " +
                         "history are all kept, and an administrator can put them back."}>
        <form action={archiveCustomer}>
          <input type="hidden" name="id" value={id} />
          <ConfirmSubmit
            label="Hide this customer"
            eyebrow="This can be undone"
            consequence={"They will stop appearing anywhere in the app, including when you " +
                         "search. Nothing is deleted. Settings \u203a Your records puts them back."}
          />
        </form>
      </Card>
    </div>
  );
}
