import { can, type Capability, type Role } from "@/lib/roles";

/**
 * Today as an inbox (Darshan's review, brief 3.2, G5).
 *
 * Five sections, in the order the brief lists them, each a list of things that
 * are waiting on a person with the one action that clears a row beside it.
 * Stated here rather than in the page so which role sees which section is a
 * tested rule: a section is drawn only for a role that can act on it, and a
 * section that can only be looked at is not an inbox.
 */
export type InboxSection =
  | "needs_price" | "needs_driver" | "ready_to_complete" | "problems" | "drafts_ready" | "overdue";

export const INBOX_SECTIONS: ReadonlyArray<{
  key: InboxSection;
  title: string;
  /** What clearing a row needs. The section is not drawn without it. */
  capability: Capability;
  /** Said when the section is empty, so an empty inbox reads as good news. */
  empty: string;
}> = [
  {
    key: "needs_price", title: "Needs a price", capability: "billing.write",
    empty: "Every finished job has its charges.",
  },
  {
    key: "needs_driver", title: "Needs a driver", capability: "routes.write",
    empty: "Every ready delivery is on a round.",
  },
  {
    // The simplified workflow's counterpart (2026-11-24): there a job still in
    // the plant is completed off the shelf, not put on a round.
    key: "ready_to_complete", title: "Ready to complete", capability: "orders.status",
    empty: "No job is waiting to be completed.",
  },
  {
    key: "problems", title: "Problems and failed deliveries", capability: "operations.read",
    empty: "No stop is waiting on a decision.",
  },
  {
    key: "drafts_ready", title: "Drafts ready to issue", capability: "invoices.read",
    empty: "No draft from a finished period is waiting.",
  },
  {
    key: "overdue", title: "Overdue", capability: "invoices.read",
    empty: "Nothing you can trust is past its terms.",
  },
];

/**
 * The sections this role is shown, in order. The workflow decides which of the
 * two job sections is drawn: the full process puts a ready delivery on a round
 * ("Needs a driver"), the simplified one completes a job off the shelf ("Ready
 * to complete"), and offering the other would send somebody the wrong way.
 */
export function inboxSectionsFor(role: Role, options: { simplified?: boolean } = {}): InboxSection[] {
  const hidden: InboxSection = options.simplified ? "needs_driver" : "ready_to_complete";
  return INBOX_SECTIONS
    .filter((section) => section.key !== hidden && can(role, section.capability))
    .map((section) => section.key);
}

/** At most this many rows per section; the rest are a count and a link. */
export const INBOX_ROWS = 8;

/** "and 4 more" under a capped section, or nothing. */
export function moreThan(total: number, shown: number): string | null {
  const more = total - shown;
  return more > 0 ? `and ${more} more` : null;
}
