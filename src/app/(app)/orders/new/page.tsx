import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { ButtonLink, Notice, PageContainer, PageHeader } from "@/components/ui";
import { counted, date as formatDate, number } from "@/lib/format";
import { createCustomer } from "@/app/(app)/customers/actions";
import { PICKUP_INTAKE_EXCLUSIONS, describeSkipped } from "@/lib/domain/pickup-intake";
import { collectionToTakeIn, type CollectionToTakeIn } from "@/lib/runs/pickup-intake";
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
 *
 * `?pickup=<id>` is the collection loop (0050). A driver captured what came off
 * the shelf; this seeds the same form with the customer, how it arrived, who
 * collected it and what was counted, and the counter confirms it and presses
 * Save. The form is the point: a collection carries no promised return date and
 * `chk_laundry_orders_delivery_date` requires one, so somebody has to say when
 * it goes back — and the counter is the one who knows.
 */
export default async function NewJobPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; pickup?: string }>;
}) {
  const params = await searchParams;
  const session = await requireCapability("orders.write");

  const collection = params.pickup
    ? await collectionToTakeIn(await createClient(), session.tenantId, params.pickup)
    : null;

  // A collection that is not this laundry's reads exactly as one that does not
  // exist. The counter can act on neither, and telling them apart would confirm
  // that something is behind an id they were never given.
  if (params.pickup && !collection) {
    return (
      <PageContainer width="form">
        <PageHeader back={{ href: "/operations/pickups", label: "Collections" }}
                    title="Take in laundry" />
        <Notice tone="warning" title="That collection could not be found">
          It may have been removed, or it belongs to another business. Open the
          Collections list and pick it from there.
        </Notice>
        <div className="mt-4">
          <ButtonLink href="/orders/new">Take in laundry without it</ButtonLink>
        </div>
      </PageContainer>
    );
  }

  // Already on a live job. Refused here rather than on save, because the guard's
  // sentence arrives after the counter has re-confirmed a screenful of counts —
  // and because the answer they actually want is the job, not an apology.
  if (collection?.takenInAs) {
    return (
      <PageContainer width="form">
        <PageHeader back={{ href: "/operations/pickups", label: "Collections" }}
                    title="Already taken in" />
        <Notice tone="info" title={`This collection is on job ${collection.takenInAs.orderNumber}`}>
          {collection.customerName}&rsquo;s collection was taken in already.
          Taking it in a second time would bill them twice for the same linen.
        </Notice>
        <div className="mt-4 flex flex-wrap gap-3">
          <ButtonLink href={`/orders/${collection.takenInAs.id}`}>
            Open {collection.takenInAs.orderNumber}
          </ButtonLink>
          <ButtonLink href="/orders/new" variant="secondary">Take in other laundry</ButtonLink>
        </div>
      </PageContainer>
    );
  }

  // The customer to show as chosen: the one a rejected save or the quick-create
  // is coming back with, otherwise the collection's own.
  const chosenCustomer = params.customer ?? collection?.customerId;
  const { customers, catalogue, drivers, staff, truncated } = await loadJobFormData(chosenCustomer);

  // Back to *this* form, seed and all. A rejection redirects, so the browser's
  // copy is gone either way; coming back to the seeded address at least restores
  // the collection's own rows rather than the single blank one an unseeded form
  // starts with.
  const returnPath = collection ? `/orders/new?pickup=${collection.id}` : "/orders/new";

  return (
    /* Capped at ~1040px: an entry form stretched across a 1900px monitor puts
       the label at one end of the desk and its input at the other. */
    <PageContainer width="form">
      <PageHeader
        back={collection
          ? { href: `/jobs/${collection.stopId}`, label: "The collection" }
          : { href: "/orders", label: "All jobs" }}
        title={collection ? "Take in this collection" : "Take in laundry"}
        description={collection
          ? "Checked at the door by the driver. Confirm the counts and say when it goes back."
          : "Pick the customer, list what they brought, say when they get it back."}
      />

      {collection ? <CollectionSummary collection={collection} /> : null}

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
        items={collection?.items}
        seed={collection ? {
          received_via: "driver_pickup",
          pickup_date: collection.pickupDate,
          pickup_driver_id: collection.driverId,
          source_pickup_id: collection.id,
        } : undefined}
        defaultCustomerId={chosenCustomer}
        canBackdate={can(session.role, "orders.manage")}
        returnPath={returnPath}
      />
    </PageContainer>
  );
}

/**
 * What the driver recorded, and — the half that matters — what deliberately did
 * not come across.
 *
 * The damaged and missing counts are already billed off `pickup_lines` by the
 * month-end run, so a counter who saw the numbers here and added them to the
 * laundry list would bill the customer twice. Saying so where they would
 * otherwise notice the totals do not add up is the whole point of this card.
 */
function CollectionSummary({ collection }: { collection: CollectionToTakeIn }) {
  const facts = [
    collection.pickupDate ? formatDate(collection.pickupDate) : null,
    collection.driverName,
    collection.bagCount > 0 ? counted(collection.bagCount, "bag") : null,
    collection.totalWeightKg ? `${number(collection.totalWeightKg)} kg` : null,
  ].filter(Boolean);
  const skipped = describeSkipped(collection.skipped);

  return (
    <div className="mb-5 space-y-3">
      <Notice tone="info" title={`Collected from ${collection.customerName}`}>
        <p>{facts.length ? facts.join(" · ") : "No collection details were recorded."}</p>
        {collection.notes ? (
          <p className="mt-1">Driver&rsquo;s note: {collection.notes}</p>
        ) : null}
        <p className="mt-1">{PICKUP_INTAKE_EXCLUSIONS}</p>
        <p className="mt-1">
          <Link href={`/jobs/${collection.stopId}`} className="underline">
            See the collection as it was recorded
          </Link>
        </p>
      </Notice>

      {collection.items.length === 0 ? (
        <Notice tone="warning" title="Nothing from this collection could be listed">
          {/* Not a refusal: the job still records that this collection was taken
              in, so it cannot be taken in again. What is missing is the laundry,
              which has to be added by hand below. */}
          Add what was collected below. The job will still be linked to this
          collection, so it will not come up as waiting to be taken in again.
        </Notice>
      ) : null}

      {skipped.length ? (
        <Notice tone="warning" title={`${counted(skipped.length, "line")} could not be carried over`}>
          <ul className="list-disc space-y-0.5 pl-4">
            {skipped.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}
