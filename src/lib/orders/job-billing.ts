import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import {
  jobChargeSubtotal, priceJob, pricingSourceLabel, type JobChargeLine, type RateLine,
} from "@/lib/domain/job-pricing";
import { priceListFor, type LaundryPriceRow } from "@/lib/domain/laundry-billing";
import type { OrderItemInput } from "@/lib/domain/laundry-orders";
import { checkBillingTransition, isBillingStatus, type BillingStatus } from "@/lib/domain/billing";
import { logOrderActivity } from "@/lib/orders/activity";

/**
 * Reading a job's money, in one place.
 *
 * Shared by the job page, the review queue and every action that prices or
 * approves — the same reason `lib/orders/complete.ts` exists. When "what does
 * this job cost?" has two implementations, the screen and the action eventually
 * disagree and the customer is the one who finds out.
 *
 * Everything here uses the caller's RLS-bound client. Since migration 0017 the
 * read policies on `job_charge_snapshots` and `service_agreement_lines` go
 * through `can_read_billing()` / `can_read_pricing()`, so an operational role
 * calling any of this gets empty results rather than a leak — the capability
 * check in front of the action is the courtesy, and the policy is the boundary.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type JobForBilling = {
  id: string;
  order_number: string;
  customer_id: string;
  status: string;
  billing_status: BillingStatus;
  completed_at: string | null;
  delivery_required: boolean;
};

/** The job, with the two facts every billing guard needs, or null. */
export async function loadJobForBilling(
  supabase: Client, id: string,
): Promise<JobForBilling | null> {
  const { data } = await supabase
    .from("laundry_orders")
    .select("id, order_number, customer_id, status, billing_status, completed_at, delivery_required")
    .eq("id", id)
    .maybeSingle<{
      id: string; order_number: string; customer_id: string; status: string;
      billing_status: string; completed_at: string | null; delivery_required: boolean;
    }>();
  if (!data) return null;
  return {
    ...data,
    // A value the enum does not know is treated as `pending` rather than cast
    // blindly: an unrecognised billing state must not read as "approved".
    billing_status: isBillingStatus(data.billing_status) ? data.billing_status : "pending",
  };
}

export type StoredCharge = {
  id: string;
  sequence: number;
  description: string;
  charge_type: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
  source_agreement_id: string | null;
  source_agreement_line_id: string | null;
  source_item_id: string | null;
  source_laundry_item_type: string | null;
  pricing_model: string | null;
  frozen_at: string | null;
};

/** The charges already on a job, in order. */
export async function loadJobCharges(supabase: Client, orderId: string): Promise<StoredCharge[]> {
  const { data } = await supabase
    .from("job_charge_snapshots")
    .select("id, sequence, description, charge_type, quantity, unit_price, amount, taxable, " +
            "source_agreement_id, source_agreement_line_id, source_item_id, " +
            "source_laundry_item_type, pricing_model, frozen_at")
    .eq("order_id", orderId)
    .order("sequence")
    .returns<StoredCharge[]>();
  return data ?? [];
}

/** The same, for many jobs at once — the queue and the generator both need it. */
export async function loadChargesForJobs(
  supabase: Client, orderIds: readonly string[],
): Promise<Map<string, StoredCharge[]>> {
  const byJob = new Map<string, StoredCharge[]>();
  if (orderIds.length === 0) return byJob;

  const { data } = await supabase
    .from("job_charge_snapshots")
    .select("id, order_id, sequence, description, charge_type, quantity, unit_price, amount, " +
            "taxable, source_agreement_id, source_agreement_line_id, source_item_id, " +
            "source_laundry_item_type, pricing_model, frozen_at")
    .in("order_id", [...orderIds])
    .order("sequence")
    .returns<Array<StoredCharge & { order_id: string }>>();

  for (const row of data ?? []) {
    const bucket = byJob.get(row.order_id) ?? [];
    bucket.push(row);
    byJob.set(row.order_id, bucket);
  }
  return byJob;
}

export type RateCardContext = {
  card: { id: string; fuel_levy_pct: number; agreement_number: string; version: number } | null;
  lines: RateLine[];
};

/**
 * The rate card a customer is priced on right now, and its lines.
 *
 * "Right now" is the point: this is read at review time and copied into the
 * snapshot. Nothing re-reads it afterwards, so tomorrow's rate change cannot
 * reach back into an approved job.
 */
export async function loadRateCard(supabase: Client, customerId: string): Promise<RateCardContext> {
  const { data: customer } = await supabase
    .from("customers")
    .select("rate_card_agreement_id")
    .eq("id", customerId)
    .maybeSingle<{ rate_card_agreement_id: string | null }>();

  const agreementId = customer?.rate_card_agreement_id ?? null;
  if (!agreementId) return { card: null, lines: [] };

  const [{ data: agreement }, { data: lines }] = await Promise.all([
    supabase
      .from("service_agreements")
      .select("id, agreement_number, version, fuel_levy_pct")
      .eq("id", agreementId)
      .maybeSingle<{ id: string; agreement_number: string; version: number; fuel_levy_pct: number }>(),
    supabase
      .from("service_agreement_lines")
      .select("id, agreement_id, item_id, laundry_item_type, charge_type, pricing_model, " +
              "unit_price, percentage, included_quantity, taxable")
      .eq("agreement_id", agreementId)
      .returns<RateLine[]>(),
  ]);

  return {
    card: agreement
      ? {
          id: agreement.id,
          agreement_number: agreement.agreement_number,
          version: agreement.version,
          fuel_levy_pct: Number(agreement.fuel_levy_pct ?? 0),
        }
      : null,
    lines: (lines ?? []).map((line) => ({
      ...line,
      unit_price: Number(line.unit_price ?? 0),
      included_quantity: Number(line.included_quantity ?? 0),
    })),
  };
}

/** The job's laundry, in the shape the pricer reads. */
export async function loadJobItems(supabase: Client, orderId: string): Promise<OrderItemInput[]> {
  const { data } = await supabase
    .from("laundry_order_items")
    .select("item_type, custom_description, quantity_type, exact_quantity, bag_count, estimated_quantity, notes")
    .eq("order_id", orderId)
    .order("created_at")
    .returns<OrderItemInput[]>();
  return data ?? [];
}

export type PricedJob = {
  lines: JobChargeLine[];
  unpriced: Array<{ itemType: string; label: string; description: string }>;
  card: RateCardContext["card"];
};

/**
 * Price one job from its customer's current rate card.
 *
 * Never throws and never partially prices: laundry the card cannot cover comes
 * back in `unpriced` for a person to deal with, and the caller decides what to
 * do about it. At review time the answer is "show it beside the charges", never
 * "refuse the whole job" — a reviewer with one unrateable bag still needs to see
 * and approve the other five.
 */
export async function priceJobFromRateCard(
  supabase: Client, tenantId: string, job: Pick<JobForBilling, "id" | "customer_id">,
): Promise<PricedJob> {
  const [items, rateCard, priceRows] = await Promise.all([
    loadJobItems(supabase, job.id),
    loadRateCard(supabase, job.customer_id),
    // The tier beneath the card (0018). Read unconditionally rather than only
    // when the card is missing, because a card that covers towels and says
    // nothing about sheets is the ordinary case — the fallback is per kind of
    // laundry, not per customer.
    //
    // **The tenant is named rather than left to RLS** (§23), and `tenantId` is a
    // required argument so a new call site cannot forget it. `is_member()` is
    // true of every laundry for a platform admin, and the default list is the
    // row with `customer_id is null` — so unfiltered, two laundries' defaults
    // both come back and `priceListFor` takes whichever the plan happened to
    // return first. This read feeds a write (the frozen snapshot), which is
    // exactly the case that rule exists for.
    supabase
      .from("laundry_prices")
      .select("customer_id, item_type, unit_price, bag_price, taxable")
      .eq("tenant_id", tenantId)
      .returns<LaundryPriceRow[]>(),
  ]);

  const { lines, unpriced } = priceJob({
    items,
    rateLines: rateCard.lines,
    rateCard: rateCard.card ? { id: rateCard.card.id, fuel_levy_pct: rateCard.card.fuel_levy_pct } : null,
    priceList: priceListFor(job.customer_id, priceRows.data ?? []),
  });

  return { lines, unpriced, card: rateCard.card };
}

/**
 * Price one job and write the result — the whole of the Price button.
 *
 * Lives here rather than in either `"use server"` file for the reason
 * `approveJob` does: a `"use server"` module can export nothing but server
 * actions, so a helper there becomes a POST endpoint of its own. Shared by the
 * single Price button on the job page and Price Selected on the queue, so a
 * selection of twenty cannot take a different path from a selection of one.
 *
 * **What it will and will not refuse.** It refuses a job that is not awaiting
 * review, a job with no laundry on it, and a job where *nothing at all* could be
 * priced. It does **not** refuse a customer who holds no rate card: the laundry
 * price list (0018) is a real pricing tier and not a consolation prize — on the
 * live deployment no customer holds a card, so refusing on that basis made the
 * button useless for every job and left hand-entry as the only path, while the
 * list-priced lines were computed and thrown away a few statements later.
 *
 * Laundry that neither tier covers still comes back in `unpriced`, because that
 * is a gap somebody must decide about rather than a zero line.
 */
export async function priceAndSaveJob(
  supabase: Client, session: Session, orderId: string,
): Promise<
  | {
      ok: true; orderNumber: string; customerId: string;
      lines: number; unpriced: number; subtotal: number; source: string;
    }
  | { ok: false; orderNumber: string | null; customerId: string | null; card: RateCardContext["card"]; error: string }
> {
  const job = await loadJobForBilling(supabase, orderId);
  if (!job) {
    return { ok: false, orderNumber: null, customerId: null, card: null, error: "That job could not be found." };
  }

  const refuse = (error: string, card: RateCardContext["card"] = null) =>
    ({ ok: false as const, orderNumber: job.order_number, customerId: job.customer_id, card, error });

  if (job.billing_status !== "awaiting_review") {
    return refuse(`${job.order_number}: charges can only be changed while a job is awaiting review.`);
  }

  const { lines, unpriced, card } = await priceJobFromRateCard(supabase, session.tenantId, job);

  if (lines.length === 0 && unpriced.length === 0) {
    return refuse(`${job.order_number}: there is no laundry on this job, so there is nothing to price.`, card);
  }
  if (lines.length === 0) {
    return refuse(
      `${job.order_number}: nothing on this job could be priced — `
      + (card
        ? "neither the rate card nor the laundry price list has a rate for what is on it."
        : "this customer has no rate card and the laundry price list has no rate for what is on it."),
      card,
    );
  }

  const saved = await saveJobCharges(supabase, job.id, lines);
  if (!saved.ok) return refuse(`${job.order_number}: ${saved.error}`, card);

  const source = pricingSourceLabel(lines, card);
  const subtotal = jobChargeSubtotal(lines);

  await logOrderActivity(supabase, session, job.id, {
    activity_type: "updated",
    next: { billing: "priced", priced_from: source, lines: lines.length, subtotal },
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: job.id, action: "update",
    summary: `${job.order_number}: priced from ${source}`,
    metadata: { lines: lines.length, unpriced: unpriced.length },
  });

  return {
    ok: true,
    orderNumber: job.order_number,
    customerId: job.customer_id,
    lines: lines.length,
    unpriced: unpriced.length,
    subtotal,
    source,
  };
}

/**
 * Write a job's charge lines, replacing whatever was there.
 *
 * One RPC, one transaction — the same reason `save_laundry_order_items` exists.
 * A delete-then-insert over PostgREST has a window in which the job costs
 * nothing, and nothing to roll back if the second call fails.
 *
 * The function refuses outright unless the job is `awaiting_review`, so this
 * cannot re-price an approved job even if a caller forgets to check.
 */
export async function saveJobCharges(
  supabase: Client, orderId: string, lines: readonly JobChargeLine[],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("save_job_charge_snapshot", {
    p_order_id: orderId,
    p_lines: lines,
  });
  if (error) {
    return { ok: false, error: error.message.replace(/^ERROR:\s*/, "") };
  }
  return { ok: true, count: Number(data ?? 0) };
}

/**
 * Approve one job's charges — the freeze itself.
 *
 * Lives here, in a plain module, rather than in either `"use server"` file that
 * calls it: a `"use server"` module can export nothing but server actions, so an
 * exported helper there becomes a POST endpoint of its own. It is shared by the
 * single approval on the job page and the bulk approval on the queue, so a
 * selection of twenty cannot take a different path from a selection of one.
 */
export async function approveJob(
  supabase: Client, session: Session, orderId: string,
): Promise<{ ok: true; orderNumber: string; subtotal: number } | { ok: false; error: string }> {
  const job = await loadJobForBilling(supabase, orderId);
  if (!job) return { ok: false, error: "That job could not be found." };

  const charges = await loadJobCharges(supabase, orderId);
  const allowed = checkBillingTransition(job.billing_status, "approved", {
    operationalStatus: job.status,
    chargeCount: charges.length,
  });
  if (!allowed.ok) return { ok: false, error: `${job.order_number}: ${allowed.reason}` };

  // Freeze first. If the status write then fails, the job is still awaiting
  // review with frozen lines — which reads as "approved but not recorded" and
  // is recoverable. The other order would leave an approved job whose charges
  // were still editable, which is the one state this feature exists to prevent.
  const { error: freezeError } = await supabase.rpc("freeze_job_charges", { p_order_id: orderId });
  if (freezeError) return { ok: false, error: describeDbError(freezeError) };

  const { error } = await supabase
    .from("laundry_orders")
    .update({
      billing_status: "approved",
      billing_approved_at: new Date().toISOString(),
      billing_approved_by: session.userId,
    })
    .eq("id", orderId)
    .eq("tenant_id", session.tenantId)
    // Re-stated as a filter as well as checked above: two reviewers pressing
    // Approve at the same moment must not both write, or the second would move
    // a job that had already left review.
    .eq("billing_status", "awaiting_review");
  if (error) return { ok: false, error: describeDbError(error) };

  const subtotal = jobChargeSubtotal(charges);
  await logOrderActivity(supabase, session, orderId, {
    activity_type: "status_changed",
    previous: { billing_status: job.billing_status },
    next: { billing_status: "approved", subtotal },
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: orderId, action: "status_change",
    summary: `${job.order_number}: charges approved`,
    metadata: { subtotal, lines: charges.length },
  });

  return { ok: true, orderNumber: job.order_number, subtotal };
}
