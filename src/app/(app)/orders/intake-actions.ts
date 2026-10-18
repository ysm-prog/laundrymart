"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { matchQuoteLines } from "@/lib/domain/intake";
import { priceItemsForCustomer } from "@/lib/orders/job-billing";
import { intakeDefaultsFor, type IntakeDefaults } from "@/lib/orders/intake";
import { parseOrderItems } from "./order-items";

/**
 * The two reads behind taking a job in quickly (brief 3.4), called from the
 * job form as the counter picks a customer and fills the rows.
 *
 * Server actions rather than API routes because they are this form's own and
 * nothing else calls them. Both name the tenant on every read (§23) and both
 * answer something harmless — no defaults, no prices — rather than throwing,
 * because the form must keep working whatever happens to a nicety.
 */

export type { IntakeDefaults } from "@/lib/orders/intake";

export async function loadIntakeDefaults(customerId: string): Promise<IntakeDefaults | null> {
  const session = await requireSession();
  if (!can(session.role, "orders.write")) return null;
  if (!z.uuid().safeParse(customerId).success) return null;
  return intakeDefaultsFor(session.tenantId, customerId);
}

export type IntakeQuote = {
  /** Per non-blank form row, in order: what it will be charged, or null where nothing prices it yet. */
  rows: Array<{ unitPrice: number; amount: number } | null>;
  /** Everything on the job, a fuel levy included, GST included. */
  total: number;
  unpricedCount: number;
};

/**
 * What the rows on the form will be charged, by the same pricer that prices
 * the job when it is finished (brief 1.3) — so the counter is shown the price
 * the customer will see. Only for a role that may read prices; anybody else
 * gets null and the form shows no money at all.
 */
export async function quoteIntake(customerId: string, itemsJson: string): Promise<IntakeQuote | null> {
  const session = await requireSession();
  if (!can(session.role, "pricing.read")) return null;
  if (!z.uuid().safeParse(customerId).success) return null;

  // The form's own parser, so a row is read here exactly as `createOrder` will
  // read it. It drops blank rows; the form drops them the same way
  // (`isBlankItem`) before matching the answer back to its rows.
  const parsed = parseOrderItems(itemsJson);
  if (!parsed.ok) return null;
  const items = parsed.items;
  if (items.length === 0) return { rows: [], total: 0, unpricedCount: 0 };

  try {
    const supabase = await createClient();
    const { lines, unpriced } = await priceItemsForCustomer(supabase, session.tenantId, customerId, items);
    const total = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
    return { rows: matchQuoteLines(items, lines), total, unpricedCount: unpriced.length };
  } catch {
    return null;
  }
}
