import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { createCustomer } from "@/app/(app)/customers/actions";
import type { CustomerLocation, Depot, Item } from "@/lib/db/types";
import { AgreementWizard } from "../agreement-wizard";
import { createAgreement } from "../actions";

export const metadata = { title: "New contract" };
export const dynamic = "force-dynamic";

export default async function NewAgreementPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const params = await searchParams;
  await requireCapability("agreements.write");

  const supabase = await createClient();
  const [{ data: customers }, { data: locations }, { data: depots }, { data: items }] =
    await Promise.all([
      supabase.from("customers").select("id, business_name, customer_number")
        .is("deleted_at", null).neq("status", "archived").order("business_name"),
      supabase.from("customer_locations").select("id, name, customer_id")
        .is("deleted_at", null).order("name")
        .returns<Pick<CustomerLocation, "id" | "name" | "customer_id">[]>(),
      supabase.from("depots").select("id, name").eq("status", "active").order("name")
        .returns<Pick<Depot, "id" | "name">[]>(),
      supabase.from("items").select("id, name, sku, rental_price")
        .eq("status", "active").is("deleted_at", null).order("name")
        .returns<Pick<Item, "id" | "name" | "sku" | "rental_price">[]>(),
    ]);

  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader
        eyebrow="Contracts"
        title="New contract"
        description="Three steps: who and when, service days, what and price. One save at the end."
      />
      <AgreementWizard
        action={createAgreement}
        customerAction={createCustomer}
        customers={customers ?? []}
        locations={locations ?? []}
        depots={depots ?? []}
        items={items ?? []}
        defaultCustomerId={params.customer}
      />
    </div>
  );
}
