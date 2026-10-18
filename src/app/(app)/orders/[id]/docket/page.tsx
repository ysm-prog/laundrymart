import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { ButtonLink } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { Code128 } from "@/components/barcode";
import { describeItem, ownershipLabel, type OrderItemInput } from "@/lib/domain/laundry-orders";
import { formatAdelaideDate, toZonedDate } from "@/lib/domain/timezone";

export const metadata = { title: "Docket" };
export const dynamic = "force-dynamic";

/**
 * The job docket (brief 3.4): what goes in the bag with the laundry. The job
 * number is printed big and as a Code 128 barcode, so on the way out of the
 * plant one scan on the Laundry board marks the job ready.
 *
 * Printed by the browser like the route sheet — no PDF renderer in the
 * request path, and it prints from the counter tablet as easily as a desk.
 * Carries no price: a docket travels through the plant.
 */
export default async function DocketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireCapability("orders.read");
  const supabase = await createClient();

  const [{ data: order }, { data: items }, { data: tenant }] = await Promise.all([
    supabase.from("laundry_orders")
      .select("id, order_number, received_at, delivery_required, due_date, special_instructions, " +
              "customers(business_name, customer_number), " +
              "board:boards!laundry_orders_assigned_board_id_fkey(name), assigned_delivery_date")
      .eq("tenant_id", session.tenantId).eq("id", id)
      .maybeSingle<{
        id: string; order_number: string; received_at: string; delivery_required: boolean;
        due_date: string | null; special_instructions: string | null;
        customers: { business_name: string; customer_number: string } | null;
        board: { name: string } | null; assigned_delivery_date: string | null;
      }>(),
    supabase.from("laundry_order_items")
      .select("item_id, item_type, custom_description, quantity_type, exact_quantity, bag_count, estimated_quantity, notes, ownership, items(item_code, name)")
      .eq("tenant_id", session.tenantId).eq("order_id", id).order("created_at")
      .returns<Array<OrderItemInput & { items: { item_code: string | null; name: string } | null }>>(),
    supabase.from("tenants").select("name").eq("id", session.tenantId).maybeSingle<{ name: string }>(),
  ]);
  if (!order) notFound();

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex gap-2 print:hidden">
        <PrintButton label="Print docket" />
        <ButtonLink href={`/orders/${order.id}`} variant="secondary">Back to the job</ButtonLink>
      </div>

      <article className="rounded-xl border bg-white p-6 text-black print:rounded-none print:border-0 print:p-0">
        <header className="flex items-start justify-between gap-4 border-b border-black/20 pb-3">
          <div>
            <p className="text-sm">{tenant?.name}</p>
            <h1 className="text-3xl font-bold tracking-wide">{order.order_number}</h1>
          </div>
          <Code128 value={order.order_number} />
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 py-3 text-sm">
          <div><dt className="text-black/60">Customer</dt>
            <dd className="font-semibold">{order.customers?.business_name ?? "—"}</dd></div>
          <div><dt className="text-black/60">Customer no.</dt>
            <dd>{order.customers?.customer_number ?? "—"}</dd></div>
          <div><dt className="text-black/60">Received</dt>
            <dd>{formatAdelaideDate(toZonedDate(order.received_at), "medium")}</dd></div>
          <div><dt className="text-black/60">{order.delivery_required ? "Back by" : "Collect by"}</dt>
            <dd className="font-semibold">{order.due_date ? formatAdelaideDate(order.due_date, "medium") : "—"}</dd></div>
          <div className="col-span-2"><dt className="text-black/60">Going back</dt>
            <dd>{order.delivery_required
              ? order.board?.name
                ? `On ${order.board.name}${order.assigned_delivery_date ? `, ${formatAdelaideDate(order.assigned_delivery_date, "medium")}` : ""}`
                : "Delivered — round not set yet"
              : "Customer collects from the counter"}</dd></div>
        </dl>

        <table className="w-full border-t border-black/20 text-sm">
          <thead><tr className="text-left text-black/60"><th className="py-2">Item</th><th className="py-2">Laundry</th></tr></thead>
          <tbody>
            {(items ?? []).map((item, index) => (
              <tr key={index} className="border-t border-black/10">
                <td className="py-1.5 pr-3 align-top font-mono">{item.items?.item_code ?? ""}</td>
                <td className="py-1.5 align-top">
                  {describeItem(item, item.items?.name ?? null)}
                  {ownershipLabel(item.ownership) ? ` (${ownershipLabel(item.ownership)})` : ""}
                  {item.notes ? <span className="block text-black/60">{item.notes}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {order.special_instructions ? (
          <p className="mt-3 border-t border-black/20 pt-3 text-sm">
            <span className="font-semibold">Machine instructions: </span>{order.special_instructions}
          </p>
        ) : null}
      </article>
    </div>
  );
}
