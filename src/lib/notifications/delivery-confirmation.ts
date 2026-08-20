/**
 * Sending a customer their proof of service, the moment a delivery lands
 * (roadmap C3; acceptance: "a delivered customer receives proof of service
 * without staff action").
 *
 * Called from both writers — the office's `recordDelivery` and the driver's
 * offline batch through `/api/sync` — so a stop captured on a phone in a car
 * park produces the same email as one typed at a desk.
 *
 * It never throws and never fails the caller. The delivery is the record that
 * matters; an email that could not go out is worth an audit row and a line in
 * the log, not a rolled-back drop-off. Every send is audited either way, exactly
 * as invoice email already is — "we tried and it bounced" is the thing someone
 * needs when a customer says they were never told.
 */

import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { sendEmail, emailIsConfigured } from "@/lib/email/send";
import { buildDeliveryEmail, type DeliveredLine } from "@/lib/email/delivery-email";
import { signMedia } from "@/lib/media-urls";
import { MEDIA_EMAIL_TTL_SECONDS } from "@/lib/media";
import { tenantSettings } from "@/lib/notifications/notify";
import type { Session } from "@/lib/auth/context";

type DeliveryRow = {
  id: string;
  completed_at: string | null;
  signed_by: string | null;
  photo_urls: string[] | null;
  signature_url: string | null;
  customers: { business_name: string; billing_email: string | null } | null;
  delivery_lines: { quantity: number; items: { name: string } | null }[] | null;
};

/**
 * Fire-and-forget from the caller's point of view.
 *
 * Ordering note: this runs *after* the delivery and its lines are committed, so
 * the email describes what was actually saved rather than what was about to be.
 */
export async function sendDeliveryConfirmation(
  session: Session,
  deliveryId: string,
): Promise<void> {
  try {
    const settings = await tenantSettings(session.tenantId);
    if (!settings.customerEmail.deliveryConfirmation) return;
    // Nothing to say and nothing to audit: the tenant has no mail provider.
    if (!emailIsConfigured()) return;

    const supabase = await createClient();

    // `deliveries` has a single FK to each of these, so the embeds are
    // unambiguous — none of the PGRST201 pairs listed in CLAUDE.md §10b.
    const { data: delivery } = await supabase
      .from("deliveries")
      .select(
        "id, completed_at, signed_by, photo_urls, signature_url, " +
        "customers(business_name, billing_email), " +
        "delivery_lines(quantity, items(name))",
      )
      .eq("id", deliveryId)
      .eq("tenant_id", session.tenantId)
      .maybeSingle<DeliveryRow>();

    if (!delivery) return;

    const recipient = delivery.customers?.billing_email;
    if (!recipient) {
      // Worth a trail: the setting is on, so someone expects these to go out,
      // and the reason this one did not is a missing address on the customer.
      await recordAudit(session, {
        entity: "delivery", entityId: deliveryId, action: "send_failed",
        summary: "no billing email on the customer — delivery confirmation not sent",
      });
      return;
    }

    const lines: DeliveredLine[] = (delivery.delivery_lines ?? [])
      .map((line) => ({ name: line.items?.name ?? "Item", quantity: line.quantity }))
      .filter((line) => line.quantity > 0);

    // Signed for the inbox rather than the screen; signMedia drops any key that
    // is not this tenant's before it signs anything.
    const [photos, signatures] = await Promise.all([
      signMedia(delivery.photo_urls ?? [], session.tenantId, MEDIA_EMAIL_TTL_SECONDS),
      signMedia([delivery.signature_url], session.tenantId, MEDIA_EMAIL_TTL_SECONDS),
    ]);

    const { subject, html, text } = buildDeliveryEmail({
      tenantName: session.tenantName,
      customerName: delivery.customers?.business_name ?? "there",
      locationName: null,
      completedAt: delivery.completed_at ?? new Date().toISOString(),
      signedBy: delivery.signed_by,
      lines,
      photoUrls: photos.map((photo) => photo.url),
      signatureUrl: signatures[0]?.url ?? null,
    });

    const result = await sendEmail({ to: recipient, subject, html, text });

    await recordAudit(session, {
      entity: "delivery",
      entityId: deliveryId,
      action: result.ok ? "send" : "send_failed",
      summary: result.ok
        ? `delivery confirmation sent to ${recipient}`
        : `${recipient}: ${result.error}`,
      metadata: result.ok ? { providerId: result.id } : {},
    });
  } catch (cause) {
    console.error("delivery confirmation threw", cause);
  }
}
