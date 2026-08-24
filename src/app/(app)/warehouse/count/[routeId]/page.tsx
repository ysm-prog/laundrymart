import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { counted, date, dateTime } from "@/lib/format";
import {
  ButtonLink, Card, EmptyState, FlashMessages, Notice, PageHeader,
} from "@/components/ui";
import { Field, Input, SubmitButton } from "@/components/form";
import { CountRow } from "../../count-row";
import { driverCountsForRoute } from "../../returns";
import { countReturn } from "../../actions";

export const dynamic = "force-dynamic";

type RouteRow = {
  id: string;
  code: string;
  name: string | null;
  route_date: string;
  unloaded_at: string | null;
  depots: { name: string } | null;
  vehicles: { registration: string } | null;
};

export default async function CountReturnPage({
  params, searchParams,
}: {
  params: Promise<{ routeId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { routeId } = await params;
  const flash = await searchParams;
  await requireCapability("warehouse.write");

  const supabase = await createClient();
  const { data: route } = await supabase
    .from("daily_routes")
    // Two FKs to vehicles, so the embed names the constraint (CLAUDE.md §10a).
    .select("id, code, name, route_date, unloaded_at, depots(name), " +
            "vehicles!daily_routes_vehicle_id_fkey(registration)")
    .eq("id", routeId)
    .maybeSingle<RouteRow>();

  if (!route) notFound();

  const [expected, { data: already }] = await Promise.all([
    driverCountsForRoute(route.id),
    supabase
      .from("production_batches")
      .select("id, batch_number").eq("route_id", route.id).is("deleted_at", null)
      .maybeSingle<{ id: string; batch_number: string }>(),
  ]);

  const expectedTotal = expected.reduce((total, item) => total + item.driverQuantity, 0);

  return (
    <div className="space-y-6">
      <FlashMessages error={flash.error} ok={flash.ok} />
      <PageHeader
        title={`Count run ${route.code}`}
        description={[
          route.name,
          route.vehicles?.registration,
          route.depots?.name,
          date(route.route_date),
        ].filter(Boolean).join(" · ")}
        actions={<ButtonLink href="/warehouse">Back to the warehouse</ButtonLink>}
      />

      {already ? (
        <Notice tone="warning" title="This run has already been counted">
          It went into batch {already.batch_number}.{" "}
          <a href={`/warehouse/${already.id}`} className="underline">Open that batch</a>.
        </Notice>
      ) : null}

      {!route.unloaded_at ? (
        <Notice tone="warning" title="The van has not been unloaded yet">
          The driver finishes the run and unloads before the depot counts it.
        </Notice>
      ) : null}

      {expected.length === 0 ? (
        <Card title="Nothing to count">
          <EmptyState
            title="The driver did not record any collections on this run"
            description="There is nothing to check the count against. If linen did come back, open a batch by hand from the warehouse page and type what is on the trolley."
          />
        </Card>
      ) : (
        <form action={countReturn} className="space-y-6">
          <input type="hidden" name="route_id" value={route.id} />

          <Card
            title="What came back"
            description={`The driver booked ${counted(expectedTotal, "item")} on this run. Change only the lines that do not match the trolley.`}
          >
            <div className="-mx-4 -mb-4 border-t border-border">
              {expected.map((item) => (
                <CountRow
                  key={item.itemId}
                  itemId={item.itemId}
                  name={item.name}
                  sku={item.sku}
                  driverQuantity={item.driverQuantity}
                />
              ))}
            </div>
          </Card>

          <Card
            title="Anything else?"
            description="Both optional — leave them blank if you are not sure."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Washer or line" name="machine">
                <Input name="machine" placeholder="Washer 3" />
              </Field>
              <Field label="Notes" name="notes">
                <Input name="notes" placeholder="Two bags very heavy" />
              </Field>
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton>Save this count</SubmitButton>
            <p className="text-xs text-muted-foreground">
              Anything short is recorded as lost so the numbers stay right.
              {route.unloaded_at ? ` Van unloaded ${dateTime(route.unloaded_at)}.` : ""}
            </p>
          </div>
        </form>
      )}
    </div>
  );
}
