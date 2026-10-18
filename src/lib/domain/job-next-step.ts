import type { Capability } from "@/lib/roles";

/**
 * The one next step on a job's page (Darshan's review, brief 3.7, G12).
 *
 * The status track lets a person move a job anywhere, which is right for a
 * correction and wrong as the way the ordinary day is driven: five pressable
 * stages and a row of buttons read as five decisions. This is the single
 * primary button — what normally happens next to *this* job, given who is
 * looking — and the track stays beneath it for everything else.
 */
export type NextStep =
  | { kind: "advance"; label: string; to: "in_progress" | "ready_for_delivery"; capability: Capability }
  | { kind: "complete"; label: string; capability: Capability }
  | { kind: "assign"; label: string; capability: Capability }
  | { kind: "charges"; label: string; capability: Capability }
  | { kind: "wait"; sentence: string };

export function nextStepFor(job: {
  status: string;
  billingStatus: string;
  deliveryRequired: boolean;
  /** "Board 1" when the job is on a round. */
  boardName: string | null;
  /** "Tue 21 Oct" when the job is on a round. */
  deliveryDay: string | null;
  needsPrice: boolean;
}): NextStep | null {
  switch (job.status) {
    case "new":
      return { kind: "advance", label: "Start work on it", to: "in_progress", capability: "orders.status" };
    case "in_progress":
      return { kind: "advance", label: "Mark it ready", to: "ready_for_delivery", capability: "orders.status" };
    case "ready_for_delivery":
      return job.deliveryRequired
        ? { kind: "assign", label: "Put it on a round", capability: "routes.write" }
        : { kind: "complete", label: "Customer has collected it", capability: "orders.status" };
    case "assigned":
      return {
        kind: "wait",
        sentence: `On ${job.boardName ?? "a round"}${job.deliveryDay ? ` for ${job.deliveryDay}` : ""}. `
          + "It goes out when the round presses Start my day.",
      };
    case "out_for_delivery":
      return { kind: "complete", label: "Mark it delivered", capability: "orders.status" };
    case "completed":
      if (job.billingStatus === "awaiting_review") {
        return {
          kind: "charges",
          label: job.needsPrice ? "Price it" : "Check and approve the charges",
          capability: job.needsPrice ? "billing.write" : "invoices.approve",
        };
      }
      return null;
    default:
      return null;
  }
}
