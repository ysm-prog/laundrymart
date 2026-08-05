import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import type { Customer } from "@/lib/db/types";
import { Button, Card, FlashMessages, PageHeader } from "@/components/ui";
import { CustomerForm } from "../../customer-form";
import { archiveCustomer, updateCustomer } from "../../actions";

export const metadata = { title: "Edit customer" };
export const dynamic = "force-dynamic";

export default async function EditCustomerPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const flash = await searchParams;
  await requireCapability("customers.write");

  const supabase = await createClient();
  const [{ data: customer }, { data: depots }] = await Promise.all([
    supabase.from("customers")
      .select(
        "id, customer_number, business_name, trading_name, abn, billing_address_line1, " +
        "billing_suburb, billing_state, billing_postcode, billing_email, phone, " +
        "payment_terms_days, purchase_order_number, special_instructions, notes, status, " +
        "depot_id, created_at",
      )
      .eq("id", id).maybeSingle<Customer>(),
    supabase.from("depots").select("id, name").eq("status", "active").order("name"),
  ]);

  if (!customer) notFound();

  return (
    <div className="max-w-3xl space-y-6">
      <FlashMessages error={flash.error} />
      <PageHeader title={`Edit ${customer.business_name}`} description={customer.customer_number} />
      <CustomerForm
        action={updateCustomer}
        customer={customer}
        depots={depots ?? []}
        cancelHref={`/customers/${id}`}
        submitLabel="Save changes"
      />

      <Card title="Danger zone"
            description="Archiving hides the customer from lists. History, jobs and invoices are kept.">
        <form action={archiveCustomer}>
          <input type="hidden" name="id" value={id} />
          <Button variant="danger">Archive customer</Button>
        </form>
      </Card>
    </div>
  );
}
