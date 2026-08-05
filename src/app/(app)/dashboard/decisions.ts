/**
 * The dashboard's work surface (design pack, screen 02).
 *
 * The pack's point about this screen is that the surface is a list of things
 * that need a decision, not a wall of charts. So this module answers one
 * question — what is currently wrong — by merging the places the system already
 * records trouble, rather than inventing a new "exceptions" table.
 *
 * A `"use server"` sibling may only export async functions, hence the split.
 */

export type DecisionSeverity = "late" | "warning" | "resolved";

export type Decision = {
  /** Stable key for React, and the reference shown in the first column. */
  reference: string;
  severity: DecisionSeverity;
  /** Who it concerns, and what is wrong — one sentence, no jargon. */
  summary: string;
  customer: string;
  /** Where it currently sits: a job status, an invoice status, a stage. */
  state: string;
  /** Count that makes the size obvious: items, bags, days overdue. */
  measure: string;
  /** When it was promised or when it went wrong. */
  when: string;
  /** The one thing to do about it. */
  action: string;
  href: string;
};

const SEVERITY_ORDER: Record<DecisionSeverity, number> = {
  late: 0, warning: 1, resolved: 2,
};

/** Most severe first; within a severity, oldest first — it has waited longest. */
export function sortDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.when.localeCompare(b.when);
  });
}

export const SEVERITY_RULE: Record<DecisionSeverity, string> = {
  late: "border-l-danger",
  warning: "border-l-warning",
  resolved: "border-l-success",
};

export const SEVERITY_TEXT: Record<DecisionSeverity, string> = {
  late: "text-danger",
  warning: "text-warning",
  resolved: "text-success",
};

/** The processing states a batch walks through, in the pack's stage order. */
export const PLANT_STAGES = [
  { state: "at_depot", label: "Received" },
  { state: "washing", label: "Washing" },
  { state: "drying", label: "Drying" },
  { state: "folding", label: "Folding" },
  { state: "packing", label: "Packing" },
  { state: "ready_for_dispatch", label: "Ready" },
  { state: "in_transit", label: "Dispatched" },
] as const;
