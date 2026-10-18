/**
 * The rules that let the flow run itself (Darshan's BA review, Phase 2).
 *
 * Pure, so the four decisions the app now takes on its own — which board and
 * which day a ready job goes to, whether a priced job is clean enough to
 * approve without a person, what a delivery recorded, and which drafts a
 * month-end press covers — are tested rather than inferred from watching it
 * happen. The writers live in `lib/runs/auto-assign.ts`,
 * `lib/orders/auto-approve.ts`, `my-runs/actions.ts` and
 * `invoices/bulk-actions.ts`; none of them decides anything this file does not.
 *
 * The switches live in `tenants.settings.automation`, written through
 * `save_tenant_settings` (0056 adds the key). Like every other settings bag
 * here, nothing throws on a bad stored value: it falls back to the default.
 */

import { addDays } from "./dates";

/* ---------------------------------------------------------------- settings */

export type AutomationSettings = {
  /** 2.2 — a delivery job that becomes Ready goes to its customer's round. Default on. */
  autoAssignOnReady: boolean;
  /** 2.3 — a job priced entirely from a rate card or price list is approved. Default on. */
  autoApproveCleanJobs: boolean;
  /**
   * 2.3 — a per-job customer's draft is issued (and pushed to Xero) the moment
   * its job is approved. **Default off**: issuing is the step that creates a
   * tax invoice, and turning that on is the owner's decision.
   */
  autoIssuePerJob: boolean;
  /**
   * 2.3 / 2.5 — email an invoice to the customer's billing address when it is
   * issued by one of the automatic paths or by Issue and send all. Default off,
   * separately from issuing, because mail leaves the building.
   */
  emailOnIssue: boolean;
};

export const DEFAULT_AUTOMATION: AutomationSettings = {
  autoAssignOnReady: true,
  autoApproveCleanJobs: true,
  autoIssuePerJob: false,
  emailOnIssue: false,
};

export const AUTOMATION_KEYS = [
  "autoAssignOnReady", "autoApproveCleanJobs", "autoIssuePerJob", "emailOnIssue",
] as const satisfies readonly (keyof AutomationSettings)[];

export function parseAutomation(settings: unknown): AutomationSettings {
  const bag = settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).automation : undefined;
  const stored = bag && typeof bag === "object" && !Array.isArray(bag)
    ? bag as Record<string, unknown> : {};
  const out = { ...DEFAULT_AUTOMATION };
  for (const key of AUTOMATION_KEYS) {
    if (typeof stored[key] === "boolean") out[key] = stored[key] as boolean;
  }
  return out;
}

/* ----------------------------------------------------- 2.2 next delivery day */

/** ISO weekday, Monday 1 … Sunday 7, of a calendar date. Zone-free by construction. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The first day on or after `max(expected, today)` that a round delivers.
 *
 * The brief's rule: not a Sunday and not a public holiday. Nothing in this
 * schema says which days a *board* runs — `customers.collection_weekday` is the
 * customer's collection day, a different promise — so the rule is the brief's
 * own fallback and is stated once here. A job with no expected date goes on the
 * first delivering day from today.
 *
 * Bounded at 31 steps so a holiday calendar that somehow covers a month cannot
 * loop; past that it answers the plain later date rather than nothing.
 */
export function nextDeliveryDay(
  expected: string | null, today: string, holidays: ReadonlySet<string>,
): string {
  let day = expected && expected > today ? expected : today;
  for (let step = 0; step < 31; step += 1) {
    if (isoWeekday(day) !== 7 && !holidays.has(day)) return day;
    day = addDays(day, 1);
  }
  return day;
}

/** Why a job that has just become Ready was not given to a round automatically. */
export type AutoAssignSkip =
  | "setting_off" | "not_delivery" | "no_round" | "not_ready" | "already_assigned";

export function autoAssignDecision(input: {
  settings: AutomationSettings;
  status: string;
  deliveryRequired: boolean;
  assignedBoardId: string | null;
  customerBoardId: string | null;
}): { assign: true; boardId: string } | { assign: false; skip: AutoAssignSkip } {
  if (!input.settings.autoAssignOnReady) return { assign: false, skip: "setting_off" };
  if (!input.deliveryRequired) return { assign: false, skip: "not_delivery" };
  if (input.status !== "ready_for_delivery") return { assign: false, skip: "not_ready" };
  if (input.assignedBoardId) return { assign: false, skip: "already_assigned" };
  if (!input.customerBoardId) return { assign: false, skip: "no_round" };
  return { assign: true, boardId: input.customerBoardId };
}

/* --------------------------------------------------- 2.3 clean auto-pricing */

/** The charge as the pricer wrote it — the four facts the rule reads. */
export type PricedLine = {
  pricing_model: string | null;
  source_agreement_id: string | null;
  unit_price: number | string | null;
  amount: number | string | null;
};

/**
 * Lines a rate card or the laundry price list wrote.
 *
 * Rate card: the line names its agreement (`source_agreement_id`). Price list:
 * no agreement and a per-unit model (`per_item`, `per_bag`). The item's own
 * selling price (`item_price`, the 1.3 fallback) is **neither** — it is a list
 * price somebody keyed into MYOB, not a rate agreed for this customer — so a job
 * priced from it waits for a person.
 */
const LIST_MODELS = new Set(["per_item", "per_bag"]);

export type CleanVerdict =
  | { clean: true }
  | { clean: false; reason: "no_lines" | "unpriced" | "zero_priced" | "not_from_rates" };

export function cleanPricingVerdict(
  lines: readonly PricedLine[], unpricedCount: number,
): CleanVerdict {
  if (lines.length === 0) return { clean: false, reason: "no_lines" };
  if (unpricedCount > 0) return { clean: false, reason: "unpriced" };
  for (const line of lines) {
    if (!(Number(line.unit_price ?? 0) > 0) || !(Number(line.amount ?? 0) > 0)) {
      return { clean: false, reason: "zero_priced" };
    }
    const fromCard = Boolean(line.source_agreement_id);
    const fromList = !line.source_agreement_id && LIST_MODELS.has(line.pricing_model ?? "");
    if (!fromCard && !fromList) return { clean: false, reason: "not_from_rates" };
  }
  return { clean: true };
}

export const NOT_CLEAN_TEXT: Record<Exclude<CleanVerdict, { clean: true }>["reason"], string> = {
  no_lines: "nothing on it was priced",
  unpriced: "some of its laundry has no price",
  zero_priced: "a line is priced at $0.00",
  not_from_rates: "a line was priced from the item's own selling price, not a rate card or price list",
};

/** Whether this job may be approved without a person (2.3). */
export function autoApproveDecision(input: {
  settings: AutomationSettings;
  customerAutoApprove: boolean;
  verdict: CleanVerdict;
}): { approve: true } | { approve: false; why: string } {
  if (!input.settings.autoApproveCleanJobs) {
    return { approve: false, why: "automatic approval is off for this laundry" };
  }
  if (!input.customerAutoApprove) {
    return { approve: false, why: "this customer's jobs are always checked by a person" };
  }
  if (!input.verdict.clean) return { approve: false, why: NOT_CLEAN_TEXT[input.verdict.reason] };
  return { approve: true };
}

/* ---------------------------------------------------------- 2.4 delivery */

export const RECEIVED_BY_MAX = 120;
export const DELIVERY_NOTE_MAX = 500;

export type DeliveredItem = { id: string; takenIn: number | null };

/**
 * What the round says it handed over, line by line, and whether that is short.
 *
 * The sheet prefills each line with what was taken in; a lower number is a
 * short delivery whether or not the round also ticked the box, because the
 * count is the evidence and the box is a summary of it. A number above what was
 * taken in is refused — a laundry cannot return more than it received — and an
 * unreadable number is refused rather than read as zero, which would mark the
 * whole delivery short over a typing slip.
 */
export function readDeliveredQuantities(
  items: readonly DeliveredItem[], posted: Record<string, unknown>, shortTicked: boolean,
): { ok: true; quantities: Map<string, number | null>; short: boolean } | { ok: false; error: string } {
  const quantities = new Map<string, number | null>();
  let short = shortTicked;
  for (const item of items) {
    const raw = posted[`delivered_${item.id}`];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      quantities.set(item.id, item.takenIn);
      continue;
    }
    const text = String(raw).trim();
    if (!/^\d{1,6}$/.test(text)) return { ok: false, error: "A delivered quantity must be a whole number." };
    const value = Number(text);
    if (item.takenIn !== null && value > item.takenIn) {
      return { ok: false, error: `You cannot deliver more than was taken in (${item.takenIn}).` };
    }
    if (item.takenIn !== null && value < item.takenIn) short = true;
    quantities.set(item.id, value);
  }
  return { ok: true, quantities, short };
}

/**
 * A proof file path the browser posted back after uploading it through
 * `/api/media`. Only ever this job's own delivery folder in this laundry's
 * tenant segment: a path naming anything else is somebody else's evidence.
 */
export function isDeliveryProofPath(path: string, tenantId: string, orderId: string): boolean {
  return path.startsWith(`${tenantId}/delivery/${orderId}/`)
    && !path.includes("..")
    && /^[A-Za-z0-9/_.-]+$/.test(path);
}

/* ------------------------------------------------- 2.5 issue and send all */

/** A draft whose billing period has finished, with something on it to issue. */
export function isReadyDraft(
  draft: { periodEnd: string | null; lineCount: number }, today: string,
): boolean {
  return Boolean(draft.periodEnd) && (draft.periodEnd as string) < today && draft.lineCount > 0;
}

export type MonthEndOutcome = {
  invoiceNumber: string;
  issued: "issued" | "already" | "failed";
  emailed: "sent" | "off" | "no_address" | "failed" | "not_issued";
  xero: "pushed" | "skipped" | "failed" | "not_issued";
  note?: string;
};

/** The one-line toast over a month-end run's per-invoice results. */
export function summariseMonthEnd(outcomes: readonly MonthEndOutcome[]): string {
  const issued = outcomes.filter((o) => o.issued === "issued").length;
  const already = outcomes.filter((o) => o.issued === "already").length;
  const failed = outcomes.filter((o) => o.issued === "failed").length;
  const emailed = outcomes.filter((o) => o.emailed === "sent").length;
  const xeroFailed = outcomes.filter((o) => o.xero === "failed").length;
  const parts = [`Issued ${issued} of ${outcomes.length}.`];
  if (already > 0) parts.push(`${already} had already been issued.`);
  if (emailed > 0) parts.push(`Emailed ${emailed}.`);
  if (failed > 0) parts.push(`${failed} could not be issued.`);
  if (xeroFailed > 0) parts.push(`${xeroFailed} could not be sent to Xero — open them to retry.`);
  return parts.join(" ");
}

/** One invoice's line in the month-end result (2.5): what happened, in words. */
export function describeMonthEndLine(outcome: MonthEndOutcome): string {
  if (outcome.issued === "already") return `${outcome.invoiceNumber}: already issued, left alone`;
  if (outcome.issued === "failed") return `${outcome.invoiceNumber}: not issued — ${outcome.note ?? "it could not be issued"}`;
  const parts = ["issued"];
  if (outcome.emailed === "sent") parts.push("emailed");
  if (outcome.emailed === "no_address") parts.push("no invoice email on file");
  if (outcome.emailed === "failed") parts.push("the email did not go");
  if (outcome.xero === "pushed") parts.push("sent to Xero");
  if (outcome.xero === "failed") parts.push("Xero refused it");
  return `${outcome.invoiceNumber}: ${parts.join(", ")}`;
}

/** At most this many invoices are named in the toast; the rest are counted. */
export const MONTH_END_LINES_SHOWN = 12;

export function monthEndReport(outcomes: readonly MonthEndOutcome[]): string {
  const named = outcomes.slice(0, MONTH_END_LINES_SHOWN).map(describeMonthEndLine);
  const more = outcomes.length - named.length;
  return [summariseMonthEnd(outcomes), ...named, ...(more > 0 ? [`…and ${more} more.`] : [])].join(" · ");
}
