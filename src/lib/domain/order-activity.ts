import { formatAdelaideDate } from "./timezone";

/**
 * One line of a job's timeline, in a sentence (Darshan's review, brief 3.8).
 *
 * The stored jsonb carries whatever the change touched. This reads the fields
 * it knows and falls back to the activity type rather than printing raw values
 * at anybody. It moved here from the job page so the wording is tested — the
 * review found assignments reading "run assigned", a load confirmation reading
 * "moved it from assigned to out for delivery", and a board stored as an id.
 */

export type ActivityRecord = {
  activity_type: string;
  previous_value?: Record<string, unknown> | null;
  new_value?: Record<string, unknown> | null;
};

/** Names for the ids an older entry stored where a name now goes. */
export type ActivityLookups = {
  board?: (id: string) => string | undefined;
  driver?: (id: string) => string | undefined;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A board as stored: a name since 2026-10-18, an id on an older entry. */
function boardName(value: unknown, lookups: ActivityLookups): string | null {
  const stored = text(value);
  if (!stored) return null;
  if (UUID.test(stored)) return lookups.board?.(stored) ?? "a board";
  return stored;
}

function day(value: unknown): string | null {
  const stored = text(value);
  return stored && /^\d{4}-\d{2}-\d{2}$/.test(stored) ? formatAdelaideDate(stored, "medium") : null;
}

const STATUS_WORDS: Record<string, string> = {
  new: "new", in_progress: "in progress", ready_for_delivery: "ready",
  assigned: "on a round", out_for_delivery: "out for delivery",
  completed: "completed", cancelled: "cancelled",
};
const word = (status: unknown) => STATUS_WORDS[String(status ?? "")] ?? String(status ?? "").replace(/_/g, " ");

export function describeOrderActivity(entry: ActivityRecord, lookups: ActivityLookups = {}): string {
  const previous = entry.previous_value ?? {};
  const next = entry.new_value ?? {};

  switch (entry.activity_type) {
    case "created": {
      const count = typeof next.items === "number" ? next.items : null;
      const from = next.from_collection ? " from a collection" : "";
      return `took this job in${from}${count === null ? "" : ` with ${count} laundry ${count === 1 ? "item" : "items"}`}.`;
    }
    case "status_changed": {
      // Start my day (2.4) records the load and the departure in one entry.
      if (previous.status === "assigned" && next.status === "out_for_delivery" && next.load_confirmed_at) {
        const board = boardName(next.board, lookups);
        const date = day(next.date);
        const driver = text(next.driver) ? lookups.driver?.(String(next.driver)) : undefined;
        return `confirmed the load${board ? ` on ${board}` : ""}${date ? ` for ${date}` : ""}`
          + `${driver ? `, driven by ${driver}` : ""}, and it went out for delivery.`;
      }
      return `moved it from ${word(previous.status)} to ${word(next.status)}.`;
    }
    case "run_assigned": {
      const board = boardName(next.board, lookups) ?? "a board";
      const date = day(next.assigned_delivery_date);
      return `put it on ${board}${date ? ` for ${date}` : ""}.`;
    }
    case "run_reassigned": {
      const from = boardName(previous.board, lookups);
      const fromDate = day(previous.assigned_delivery_date);
      const to = boardName(next.board, lookups) ?? "another board";
      const date = day(next.assigned_delivery_date);
      return `moved it${from ? ` from ${from}${fromDate ? ` (${fromDate})` : ""}` : ""} to ${to}`
        + `${date ? ` for ${date}` : ""}.`;
    }
    case "run_removed": {
      const from = boardName(previous.board, lookups);
      return `took it off ${from ?? "its round"}; it is waiting for a driver again.`;
    }
    case "delivered": {
      // Brief 2.4/3.8: which round handed it over, and who was driving it.
      const board = boardName(next.board, lookups);
      const driver = text(next.driver) ? lookups.driver?.(String(next.driver)) : undefined;
      const receivedBy = text(next.received_by);
      const by = [board ? `on ${board}` : null, driver ? `driven by ${driver}` : null].filter(Boolean).join(", ");
      return `delivered it${by ? ` ${by}` : ""}${receivedBy ? `, received by ${receivedBy}` : ""}`
        + `${next.short ? " (short)" : ""} and completed the job.`;
    }
    case "collected":
      return "handed it back to the customer and completed the job.";
    case "cancelled":
      return "cancelled this job.";
    case "assigned":
      return next.assigned_to ? "put somebody in the office in charge of it." : "took the office owner off it.";
    case "items_changed":
      return "changed the laundry list.";
    case "updated":
      return "edited this job.";
    default:
      return `${entry.activity_type.replace(/_/g, " ")}.`;
  }
}
