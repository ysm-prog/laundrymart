/**
 * What the app says when something does not work.
 *
 * Every server action refuses through `fail()`, which redirects and shows a
 * toast — so this text is often the *only* thing a person has to go on, and the
 * form they filled in is already gone. Two rules follow from that:
 *
 *  - **Name the thing on screen, not the thing in the database.** A message
 *    reading `expected_delivery_date: Invalid input` is addressed to whoever
 *    wrote the schema. The person reading it filled in a box labelled "Delivery
 *    date" and has no way to connect the two.
 *  - **Never relay text we did not write.** A raw Postgres message is a fact
 *    about a constraint, not an instruction to a person, and it can carry table
 *    and column names out to a screen.
 *
 * This lives in its own module rather than in `lib/actions.ts` because that
 * file imports `next/headers` and is therefore unreachable from a unit test —
 * the trap `plan.ts` and `order-items.ts` both record, and both of those
 * shipped broken behind a green `verify`.
 */

/**
 * The words on the label, keyed by the field name the schema uses.
 *
 * Only fields a person actually fills in need an entry; `fieldLabel` derives a
 * readable name for the rest, so a field added tomorrow degrades to "Delivery
 * window" rather than to nothing. Entries here exist where the derived name
 * would be wrong, cryptic, or an abbreviation nobody outside the trade knows.
 */
export const FIELD_LABELS: Record<string, string> = {
  abn: "ABN (the business tax number)",
  agreement_id: "Contract",
  assigned_delivery_date: "Delivery date",
  assigned_to: "Who is looking after it",
  bag_count: "Number of bags",
  billing_email: "Email for bills",
  billing_frequency: "How often to bill",
  billing_method: "How they get billed",
  billing_postcode: "Postcode for bills",
  billing_state: "State for bills",
  billing_suburb: "Suburb for bills",
  board_id: "Delivery round",
  business_name: "Business name",
  cancel_reason: "Reason for cancelling",
  cancellation_reason: "Reason for cancelling",
  client_ref: "Reference",
  contact_email: "Contact email",
  contact_name: "Contact name",
  contact_phone: "Contact phone number",
  custom_description: "Description",
  customer_id: "Customer",
  default_gst_rate: "Usual GST rate",
  default_vehicle_id: "Usual vehicle",
  depot_id: "Site",
  delivery_address: "Delivery address",
  delivery_instructions: "Delivery instructions",
  delivery_window: "Time of day for delivery",
  employee_number: "Staff number",
  exception_notes: "What went wrong",
  exception_reason: "What went wrong",
  expected_collection_date: "Collection date",
  expected_delivery_date: "Delivery date",
  full_name: "Full name",
  holiday_date: "Public holiday date",
  included_quantity: "How many are included",
  invoice_id: "Bill",
  item_code: "Stock code",
  item_id: "Item",
  item_type: "Kind of laundry",
  job_id: "Job",
  laundry_category: "Kind of laundry",
  licence_expiry: "Licence expiry date",
  licence_number: "Licence number",
  linen_ownership: "Whose linen it is",
  location_id: "Address",
  odometer_end_km: "Kilometres on the dashboard",
  odometer_km: "Kilometres on the dashboard",
  order_id: "Job",
  ownership_type: "Whose linen it is",
  owner_type: "Whose linen it is",
  paid_on: "Date paid",
  period_end: "Last day of the period",
  period_start: "First day of the period",
  pickup_date: "Pickup date",
  pickup_driver_id: "Who collected it",
  pricing_model: "How it is priced",
  purchase_order_number: "Their order number",
  quantity_type: "How it is counted",
  rate_card_agreement_id: "Agreed price list",
  received_date: "Date it came in",
  received_via: "How it came in",
  return_board: "Delivery round",
  route_id: "Delivery round",
  signed_by: "Who signed for it",
  sku: "Stock code",
  special_instructions: "Machine instructions",
  standard_quantity: "Usual quantity",
  tax_code: "Tax type",
  taxable: "GST applies",
  tenant_id: "Business",
  total_weight_kg: "Total weight in kilograms",
  trading_name: "Trading name",
  unit_price: "Price each",
  user_id: "Person",
  vehicle_id: "Vehicle",
  vehicle_type: "Kind of vehicle",
  vin: "VIN (the vehicle's serial number)",
  void_reason: "Reason for cancelling",
  xero_contact_id: "Xero contact",
  xero_contact_name: "Xero contact name",
};

/**
 * A readable name for a field, from the schema path Zod hands back.
 *
 * Nested and array paths (`items.2.quantity`) keep only their last named
 * segment: "Quantity" is what the person sees on the row they are looking at,
 * and "Items 2 quantity" is an index nobody counted.
 */
export function fieldLabel(path: ReadonlyArray<PropertyKey>): string {
  const named = path.filter((part) => typeof part === "string") as string[];
  const last = named[named.length - 1];
  if (!last) return "";
  const mapped = FIELD_LABELS[last];
  if (mapped) return mapped;
  const words = last.replace(/_id$/, "").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * The half-sentence that follows the field name, as a complete clause.
 *
 * Zod's own defaults ("Required", "Invalid input", "Expected string, received
 * null") are accurate and tell nobody what to do, so they are replaced. A
 * message somebody wrote on purpose in the schema — "Use the date picker",
 * "Cannot be negative" — already says the useful thing and is passed through.
 *
 * The two cases are phrased differently on purpose. A replacement reads as a
 * statement about the box ("it needs to be filled in"); ours reads as an
 * instruction ("use the date picker"), and prefixing that with "it" would
 * produce "it use the date picker".
 */
function readableReason(message: string): string {
  const normalised = message.trim().toLowerCase();
  const isZodDefault =
    normalised === "required" ||
    normalised === "invalid input" ||
    normalised.startsWith("invalid input:") ||
    normalised.startsWith("expected ") ||
    normalised.includes("received undefined") ||
    normalised.includes("received null");

  if (isZodDefault) {
    return normalised === "required" || normalised.includes("received undefined")
      ? "it needs to be filled in."
      : "it does not look right.";
  }
  const trimmed = message.trim();
  const sentence = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

type Issue = { path: ReadonlyArray<PropertyKey>; message: string };

/**
 * The first validation failure, said as a sentence about a labelled box.
 *
 * One failure rather than all of them, deliberately: the toast is a single
 * line, and a list of six problems in a strip at the corner of the screen is
 * read by nobody. The first is the one to fix first.
 */
export function validationMessage(issues: ReadonlyArray<Issue>): string {
  const issue = issues[0];
  if (!issue) return "Something on that form was not right. Please check it and try again.";
  const reason = readableReason(issue.message);
  const label = fieldLabel(issue.path);
  // A top-level refinement has no path — there is no one box to point at, so
  // the reason has to carry the message on its own.
  if (!label) return reason;
  return `Please check "${label}" — ${reason}`;
}

/**
 * What to say about a database refusal.
 *
 * The default case is the important one. It used to return `error.message`,
 * which is Postgres talking to whoever wrote the migration: it names tables,
 * columns and constraints, and there is nothing in it a person at a counter can
 * act on. Anything unrecognised now gets a sentence that says the two things
 * that actually matter — nothing was saved, and here is what to do next.
 */
export function databaseMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "23505":
      return "That value is already in use. Please use a different one.";
    case "23503":
      return "Something else is still using this, so it cannot be removed. " +
        "Try hiding it instead.";
    case "42501":
      return "You are not allowed to do that. Ask whoever set up your account if you need to be.";
    case "P0001":
      // Our own business-rule triggers, which raise sentences meant for people.
      // They can still carry a raw status value (`ready_for_delivery`) picked up
      // from the row, so those are spaced out on the way past.
      return humaniseTokens(error.message.replace(/^ERROR:\s*/, ""));
    default:
      return "That did not save, and nothing was changed. " +
        "Please try again, and ask for help if it keeps happening.";
  }
}

/**
 * Space out `snake_case` values embedded in a message.
 *
 * A trigger reporting a status does it in the database's spelling, because that
 * is the value in the row. `out_for_delivery` is a word nobody says out loud.
 */
function humaniseTokens(message: string): string {
  return message.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (token) => token.replace(/_/g, " "));
}
