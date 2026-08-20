import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, type Role } from "@/lib/roles";
import { money, dateTime } from "@/lib/format";
import {
  BILLING_STATUS_BLURBS, BILLING_STATUS_LABELS, chargesAreEditable, type BillingStatus,
} from "@/lib/domain/billing";
import { CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import { jobChargeSubtotal } from "@/lib/domain/job-pricing";
import { loadJobCharges, loadRateCard } from "@/lib/orders/job-billing";
import { Badge, Card, DataTable, EmptyState, Notice } from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/form";
import { JobChargesEditor } from "./job-charges-editor";
import {
  approveJobCharges, markJobNotBillable, priceJobCharges, reopenJobCharges, updateJobCharges,
} from "../billing-actions";

/**
 * What this job costs, and where it is in the billing lifecycle.
 *
 * Rendered only for `billing.read`, and RLS says the same thing independently —
 * `job_charge_snapshots` is readable through `can_read_billing()` only, so a
 * driver or a dispatcher reads no rows from it even holding a valid session.
 *
 * The card changes shape with the state, because the question changes with it:
 * awaiting review is a working surface with editable lines, and everything after
 * approval is a read-only record with the frozen numbers on it.
 */
export async function ChargesCard({
  orderId, billingStatus, operationalStatus, customerId, role, approvedAt,
}: {
  orderId: string;
  billingStatus: BillingStatus;
  operationalStatus: string;
  customerId: string;
  role: Role;
  approvedAt: string | null;
}) {
  const supabase = await createClient();
  const [charges, rateCard] = await Promise.all([
    loadJobCharges(supabase, orderId),
    loadRateCard(supabase, customerId),
  ]);

  const subtotal = jobChargeSubtotal(charges);
  const editable = chargesAreEditable(billingStatus) && can(role, "billing.write");
  const canApprove = can(role, "invoices.approve");

  return (
    <Card
      title="Charges"
      description={BILLING_STATUS_BLURBS[billingStatus]}
      actions={<Badge tone={TONES[billingStatus]}>{BILLING_STATUS_LABELS[billingStatus]}</Badge>}
    >
      {billingStatus === "pending" ? (
        <Notice tone="info">
          This job is priced once the work is finished. Completing it puts it in the review
          queue — it never generates an invoice on its own.
        </Notice>
      ) : null}

      {billingStatus === "not_billable" ? (
        <Notice tone="warning">This job has been taken out of the billing queue.</Notice>
      ) : null}

      {/* The rate card in play, named. "Why was it this much?" should be
          answerable from the screen the number is on. */}
      {rateCard.card ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Priced from{" "}
          <Link href={`/agreements/${rateCard.card.id}`} className="text-primary hover:underline">
            {rateCard.card.agreement_number} v{rateCard.card.version}
          </Link>
          {approvedAt ? ` · approved ${dateTime(approvedAt)}` : null}
        </p>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">
          {/* The price list is the tier beneath the card (§21), and this line
              used to deny it existed — which was the same mistake the Price
              button made: it refused outright without a card, and every customer
              on this deployment has none. */}
          This customer has no rate card, so pricing falls back to your{" "}
          <Link href="/invoices/prices" className="text-primary hover:underline">
            laundry price list
          </Link>
          . Anything neither covers is added by hand.{" "}
          <Link href={`/customers/${customerId}`} className="text-primary hover:underline">
            Set a rate card
          </Link>
          .
        </p>
      )}

      {editable ? (
        <>
          <JobChargesEditor
            orderId={orderId}
            action={updateJobCharges}
            initial={charges.map((row) => ({
              key: row.id,
              description: row.description,
              charge_type: row.charge_type as ChargeType,
              quantity: Number(row.quantity),
              unit_price: Number(row.unit_price),
              taxable: row.taxable,
              source_agreement_id: row.source_agreement_id,
              source_agreement_line_id: row.source_agreement_line_id,
              source_item_id: row.source_item_id,
              source_laundry_item_type: row.source_laundry_item_type,
              pricing_model: row.pricing_model,
            }))}
          />

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
            <form action={priceJobCharges}>
              <input type="hidden" name="id" value={orderId} />
              {/* Replaces every line with today's rate card. Said plainly on the
                  button, because a reviewer who has hand-edited a line needs to
                  know this is not an "update the ones I haven't touched". */}
              {/* Named by tier rather than by "rate card", because the button
                  works for a customer who has none — the price list answers. */}
              <SubmitButton variant="secondary" size="md" pendingLabel="Pricing…">
                {charges.length > 0 ? "Re-price this job" : "Price this job"}
              </SubmitButton>
            </form>

            {canApprove ? (
              <form action={approveJobCharges}>
                <input type="hidden" name="id" value={orderId} />
                <SubmitButton size="md" pendingLabel="Approving…">
                  Approve {charges.length > 0 ? money(subtotal) : "charges"}
                </SubmitButton>
              </form>
            ) : null}

            <form action={markJobNotBillable} className="ml-auto">
              <input type="hidden" name="id" value={orderId} />
              <ConfirmSubmit
                label="Not billable"
                eyebrow="Are you sure?"
                consequence="This job will not appear in the invoice queue and no invoice will be raised for it. Nothing is deleted — the job, its laundry and its history all stay."
                reasonName="billing_exclusion_reason"
                reasonLabel="Why is this not billable?"
              />
            </form>
          </div>
        </>
      ) : (
        <>
          <DataTable
            bare
            label="Charges"
            rows={charges}
            empty={
              <EmptyState
                title="No charges recorded"
                description={
                  billingStatus === "awaiting_review"
                    ? "Somebody with billing permission needs to price this job."
                    : "Nothing was charged for this job."
                }
              />
            }
            columns={[
              { header: "Description", cell: (row) => row.description },
              {
                header: "Charge",
                cell: (row) => CHARGE_TYPE_LABELS[row.charge_type as ChargeType] ?? row.charge_type,
                hideBelow: "md",
              },
              { header: "Qty", cell: (row) => String(row.quantity), align: "right", hideBelow: "sm" },
              { header: "Rate", cell: (row) => money(row.unit_price), align: "right", hideBelow: "sm" },
              { header: "Amount", cell: (row) => money(row.amount), align: "right" },
            ]}
          />

          {charges.length > 0 ? (
            <div className="mt-4 flex justify-end border-t pt-4 text-sm">
              <span className="text-muted-foreground">
                Subtotal{" "}
                <span className="ml-2 font-semibold text-foreground tabular-nums">{money(subtotal)}</span>
                <span className="ml-1">before GST</span>
              </span>
            </div>
          ) : null}

          {/* Sending back is the only way out of `approved` short of an
              invoice, and it exists because a reviewer needs one before the
              numbers reach a customer. Once an invoice is generated the way
              back is to void it, which is said in the guard's own message. */}
          {billingStatus === "approved" && canApprove ? (
            <form action={reopenJobCharges} className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
              <input type="hidden" name="id" value={orderId} />
              <ConfirmSubmit
                label="Send back for review"
                eyebrow="Are you sure?"
                consequence="The approved lines are cleared so the job can be priced again, and it leaves the ready-to-invoice queue. No invoice has been raised yet, so nothing a customer has seen changes."
                reasonName="note"
                reasonLabel="Why is it going back?"
                reasonRequired={false}
              />
            </form>
          ) : null}

          {billingStatus === "awaiting_review" && !can(role, "billing.write") ? (
            <Notice tone="info">
              You can see these charges but not change them. Pricing and approval sit with finance.
            </Notice>
          ) : null}
        </>
      )}

      {operationalStatus !== "completed" && billingStatus === "awaiting_review" ? (
        <div className="mt-4">
          <Notice tone="warning">
            This job is not marked completed, so its charges cannot be approved yet.
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

const TONES: Record<BillingStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  awaiting_review: "warning",
  approved: "info",
  invoice_generated: "info",
  invoice_sent: "info",
  paid: "success",
  not_billable: "neutral",
};
