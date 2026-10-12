/**
 * What the round has to be told at the door, gathered from the three places a
 * laundry writes it down.
 *
 * The instructions were never *missing* — they were spread across three columns
 * and, on the round's own screens, two of the three were never read at all.
 * `laundry_orders.delivery_instructions` was rendered as an unlabelled grey
 * paragraph at the foot of a job card; `laundry_orders.special_instructions` was
 * selected and dropped; and `customers.special_instructions` — the standing
 * "gate code is 1234, leave it with reception" that applies to *every* delivery
 * — was not even fetched for My Runs. A driver reading the card had no way to
 * tell which of those they were looking at, or that two more existed.
 *
 * So the rule is here, pure and tested, and the components are the thin part:
 * a rule stated inside a card is a rule no unit test can reach, which is the
 * trap this repo records shipping three times.
 *
 * **Order is by how specific the instruction is**, because that is the order a
 * person needs them in. What was said about *this* delivery beats how *this
 * laundry* is handled, which beats how to get into *this site*, which beats what
 * is always true of *this customer*. A driver who reads only the first line
 * still reads the one written most recently and most deliberately.
 *
 * **Identical text is said once.** A counter hand copying the customer's
 * standing note onto the job is ordinary, and rendering the same sentence twice
 * under two headings reads as two different instructions — which is worse than
 * rendering it once, because the second one implies something was added.
 */

/** One instruction, with the heading that says where it came from. */
export type DriverInstruction = {
  /** Stable key for a React list, and what the tests assert on. */
  kind: "delivery" | "handling" | "access" | "standing";
  /** The heading, in the round's words rather than the column's. */
  label: string;
  text: string;
};

/**
 * Only what the rule reads. Deliberately less than a `DayJob` or a run stop, so
 * one rule serves the day list, the job page and the depot screen — the three
 * places a driver is told something, which until now told them three different
 * subsets of it.
 */
export type InstructedJob = {
  delivery_instructions?: string | null;
  special_instructions?: string | null;
  customers?: { special_instructions?: string | null } | null;
  /**
   * The site's own access note (`customer_locations.access_notes`) — "park in
   * the rear lane, door 3". The depot screen has **selected this column and
   * never rendered it** since it was written.
   */
  customer_locations?: { access_notes?: string | null } | null;
};

const LABELS: Record<DriverInstruction["kind"], string> = {
  // Named for the delivery rather than for the column: "delivery instructions"
  // is what the office typed into, "For this delivery" is what the driver is
  // being told.
  delivery: "For this delivery",
  // "Machine instructions" and not a driver-flavoured rewording: it is what the
  // counter form calls that box and what `/orders/:id` prints it under, so a
  // manager on the phone to a round is naming the same field. §6's one-label-per-
  // thing rule, applied to a column rather than to a rail row.
  handling: "Machine instructions",
  access: "Getting in",
  standing: "Always for this customer",
};

/**
 * The instructions to put in front of the round, most specific first.
 *
 * Returns an empty array when there is nothing to say, so a caller can render
 * nothing at all rather than an empty box headed "Instructions" — which reads as
 * an instruction that failed to load.
 */
export function driverInstructions(job: InstructedJob): DriverInstruction[] {
  const candidates: Array<{ kind: DriverInstruction["kind"]; raw: string | null | undefined }> = [
    { kind: "delivery", raw: job.delivery_instructions },
    { kind: "handling", raw: job.special_instructions },
    // The site's note sits above the customer's: a business with three sites
    // has one standing instruction and three different back doors.
    { kind: "access", raw: job.customer_locations?.access_notes },
    { kind: "standing", raw: job.customers?.special_instructions },
  ];

  const out: DriverInstruction[] = [];
  const seen = new Set<string>();

  for (const { kind, raw } of candidates) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") continue;
    // Case- and whitespace-insensitive, because the duplicate this guards
    // against is a copy-paste and a copy-paste picks up a trailing newline or a
    // capital as often as not.
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, label: LABELS[kind], text });
  }

  return out;
}

/** Whether there is anything to show — so a card can skip the block entirely. */
export function hasDriverInstructions(job: InstructedJob): boolean {
  return driverInstructions(job).length > 0;
}

/* ------------------------------------------------------ the note at assign */

/**
 * The longest note the assign forms accept. A note at assign time is a line
 * for the door ("ring twice, leave with reception"), not a letter; a cap that
 * is said out loud beats a column that quietly accepts an essay nobody reads
 * standing on a doorstep.
 */
export const DRIVER_NOTE_MAX = 280;

/** The field the assign forms post the note in. One name, so form and action cannot drift. */
export const DRIVER_NOTE_FIELD = "driver_note";

export type DriverNote =
  | { kind: "absent" }
  | { kind: "set"; value: string | null }
  | { kind: "too_long" };

/**
 * Read the "Note for the driver" field off an assign form (Jay's change,
 * 2026-10-12). It is saved into `laundry_orders.delivery_instructions`, which is
 * the job's own instruction the `DriverInstructions` block already shows first,
 * so a note written while assigning reaches the round with no new column.
 *
 * Three answers, because they want three different writes:
 * - **absent**: the form did not carry the field, so nothing is written;
 * - **set**: write this value, where `null` clears it. Blank clears only where
 *   the caller says blank is meaningful, which is the single-job form: it opens
 *   showing the current instruction, so emptying the box is a decision;
 * - **too_long**: refused, with the cap named.
 *
 * `blankClears` is false for the bulk move. That form shows no one job's
 * instruction, so an empty box there means "no note", and reading it as "clear"
 * would wipe forty jobs' instructions because somebody left a box empty.
 */
export function readDriverNote(
  raw: FormDataEntryValue | null,
  options: { blankClears: boolean },
): DriverNote {
  if (raw === null || typeof raw !== "string") return { kind: "absent" };
  const value = raw.trim();
  if (value === "") return options.blankClears ? { kind: "set", value: null } : { kind: "absent" };
  if (value.length > DRIVER_NOTE_MAX) return { kind: "too_long" };
  return { kind: "set", value };
}
