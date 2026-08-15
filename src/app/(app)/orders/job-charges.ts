import { z } from "zod";
import { lineAmount, round2, CHARGE_TYPES, type ChargeType } from "@/lib/domain/pricing";
import type { JobChargeLine } from "@/lib/domain/job-pricing";

/**
 * The charge lines the review screen posts, and the one place their shape is
 * stated.
 *
 * **Outside `"use server"` on purpose.** A `"use server"` module can export
 * nothing but server actions, so a payload schema living in one is unreachable
 * from a unit test — and this repo has shipped two such contracts broken and
 * green (the job form's items, the whole dispatch planner). The rule since is
 * that every compose-locally-commit-once payload gets a plain module and tests
 * written against what its producer really emits. This is that module for the
 * job charge editor.
 *
 * The producer is `JobChargesEditor`, which builds each row in the browser and
 * posts the array as JSON in one hidden field. That means **absence is spelled
 * `null`, not `""`** — `JSON.stringify` drops `undefined` keys — which is
 * exactly the trap that took the job form down, so every optional field here
 * goes through the shared `absent` preprocessing via `optionalText`-style
 * `.nullish()` handling rather than a bare `.optional()`.
 */

/** Absence, in both the spellings a JSON payload can carry it in. */
const nullableText = z.preprocess(
  (value) => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value),
  z.string().trim().optional(),
);

const nullableUuid = z.preprocess(
  (value) => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value),
  z.string().uuid().optional(),
);

/** A number that may arrive as a string from an `<input type="number">`. */
const numeric = z.preprocess(
  (value) => {
    if (value === null || value === undefined || value === "") return 0;
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : value;
  },
  z.number().finite(),
);

const chargeSchema = z.object({
  description: z.string().trim().min(2, "Describe what is being charged"),
  charge_type: z.enum(CHARGE_TYPES).catch("other"),
  quantity: numeric.pipe(z.number().min(0, "Quantity cannot be negative")),
  unit_price: numeric.pipe(z.number().min(0, "A rate cannot be negative")),
  taxable: z.preprocess((value) => value !== false, z.boolean()),
  source_agreement_id: nullableUuid,
  source_agreement_line_id: nullableUuid,
  source_item_id: nullableUuid,
  source_laundry_item_type: nullableText,
  pricing_model: nullableText,
});

export const jobChargesSchema = z.array(chargeSchema);

/**
 * One row exactly as the editor posts it.
 *
 * Stated rather than inferred with `z.input`, because every field above goes
 * through `z.preprocess` and `z.input` of a preprocess is `unknown` — which
 * would type the editor's own rows as `unknown` and hide precisely the drift
 * this type exists to catch. The numbers are `number | string` because an
 * `<input type="number">` hands back a string and the schema coerces it.
 */
export type JobChargeInput = {
  description: string;
  charge_type: ChargeType;
  quantity: number | string;
  unit_price: number | string;
  taxable: boolean;
  source_agreement_id: string | null;
  source_agreement_line_id: string | null;
  source_item_id: string | null;
  source_laundry_item_type: string | null;
  pricing_model: string | null;
};

export type ParsedJobCharges =
  | { ok: true; lines: JobChargeLine[] }
  | { ok: false; problem: string };

/**
 * Read the posted charge list, or say why it could not be read.
 *
 * Returning the *reason* rather than an empty array is the lesson from the job
 * form outage: an unreadable payload that degrades to `[]` surfaces to the user
 * as "this job has no charges", which is a sentence they can see is untrue and
 * cannot act on. A parse fault says it is a parse fault.
 *
 * Amounts are computed here and never trusted from the browser. The editor shows
 * a running total for the operator's benefit; what gets written is
 * `quantity × unit_price`, rounded once, on the server.
 */
export function parseJobCharges(raw: FormDataEntryValue | null): ParsedJobCharges {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: true, lines: [] };

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, problem: "The charge list could not be read. Please try again." };
  }

  const parsed = jobChargesSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const row = typeof issue?.path[0] === "number" ? `Charge ${issue.path[0] + 1}: ` : "";
    return { ok: false, problem: `${row}${issue?.message ?? "that charge could not be read."}` };
  }

  return {
    ok: true,
    lines: parsed.data.map((line, index) => ({
      sequence: index + 1,
      description: line.description,
      charge_type: line.charge_type,
      quantity: round2(line.quantity),
      unit_price: round2(line.unit_price),
      // The browser's arithmetic is a preview. This is the number.
      amount: lineAmount(line.quantity, line.unit_price),
      taxable: line.taxable,
      source_agreement_id: line.source_agreement_id ?? null,
      source_agreement_line_id: line.source_agreement_line_id ?? null,
      source_item_id: line.source_item_id ?? null,
      source_laundry_item_type: line.source_laundry_item_type ?? null,
      pricing_model: line.pricing_model ?? null,
    })),
  };
}
