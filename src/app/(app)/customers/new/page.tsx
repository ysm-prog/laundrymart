import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { CustomerForm } from "../customer-form";
import { createCustomer } from "../actions";

export const metadata = { title: "New customer" };
export const dynamic = "force-dynamic";

export default async function NewCustomerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  await requireCapability("customers.write");

  const supabase = await createClient();
  const { data: depots } = await supabase
    .from("depots").select("id, name").eq("status", "active").order("name");

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="New customer"
        description="Four things get you started. Everything else can wait until you need it."
      />
      <CustomerForm
        action={createCustomer}
        depots={depots ?? []}
        cancelHref="/customers"
        submitLabel="Create customer"
      />
    </div>
  );
}
