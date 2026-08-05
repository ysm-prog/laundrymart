import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { FlashMessages, Notice, PageHeader } from "@/components/ui";
import type { CustomerLocation, Depot } from "@/lib/db/types";
import { AgreementForm } from "../agreement-form";
import { createAgreement } from "../actions";

export const metadata = { title: "New service agreement" };
export const dynamic = "force-dynamic";

export default async function NewAgreementPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; customer?: string }>;
}) {
  const params = await searchParams;
  await requireCapability("agreements.write");

  const supabase = await createClient();
  const [{ data: customers }, { data: locations }, { data: depots }] = await Promise.all([
    supabase.from("customers").select("id, business_name, customer_number")
      .is("deleted_at", null).neq("status", "archived").order("business_name"),
    supabase.from("customer_locations").select("id, name, customer_id")
      .is("deleted_at", null).order("name")
      .returns<Pick<CustomerLocation, "id" | "name" | "customer_id">[]>(),
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
  ]);

  return (
    <div className="max-w-4xl space-y-4">
      <FlashMessages error={params.error} />
      <PageHeader
        title="New service agreement"
        description="Saved as a draft — activate it once the priced lines are in place."
      />
      {!customers?.length ? (
        <Notice tone="warning" title="No customers yet">
          Create a customer first; an agreement always belongs to one.
        </Notice>
      ) : null}
      <AgreementForm
        action={createAgreement}
        customers={customers ?? []}
        locations={locations ?? []}
        depots={depots ?? []}
        defaultCustomerId={params.customer}
        cancelHref="/agreements"
        submitLabel="Create agreement"
      />
    </div>
  );
}
