/**
 * Production stages for the plant (spec §7.16).
 *
 * A separate module because `actions.ts` is `"use server"` and may only export
 * async functions — the same split as `items/categories.ts` and `run/checklist.ts`.
 *
 * Every processing stage maps onto an inventory state that already existed in
 * 0005, so advancing a batch is a real stock movement rather than a status
 * column that drifts away from the ledger.
 */

import type { InventoryState } from "../inventory/states";

/** The stages a batch walks through, in order. Terminal stages excluded. */
export const BATCH_FLOW = [
  "received", "washing", "drying", "folding", "packing", "ready_for_dispatch",
] as const;

/** A stage that stock actually sits in — every one maps to an inventory state. */
export type FlowStage = (typeof BATCH_FLOW)[number];

export const BATCH_STAGES = [...BATCH_FLOW, "completed", "cancelled"] as const;

export type BatchStage = (typeof BATCH_STAGES)[number];

export const BATCH_STAGE_LABELS: Record<BatchStage, string> = {
  received: "Counted in",
  washing: "Washing",
  drying: "Drying",
  folding: "Folding",
  packing: "Packing",
  ready_for_dispatch: "Ready to go out",
  completed: "Finished",
  cancelled: "Cancelled",
};

/**
 * The button that leaves each stage, written as the thing the operator just
 * finished doing. "Washing done — start drying" tells you what the press means
 * without knowing the word for the state you are in; "Move to drying" does not.
 */
export const STAGE_ACTION_LABELS: Record<FlowStage, string> = {
  received: "Start washing",
  washing: "Washing done — start drying",
  drying: "Drying done — start folding",
  folding: "Folding done — start packing",
  packing: "Packing done — mark ready to go out",
  ready_for_dispatch: "Finish this batch",
};

/**
 * Where a batch's stock physically sits at each stage. Receiving holds it at the
 * depot — it has arrived off a run but no machine has claimed it yet.
 */
export const STAGE_INVENTORY_STATE: Record<FlowStage, InventoryState> = {
  received: "at_depot",
  washing: "washing",
  drying: "drying",
  folding: "folding",
  packing: "packing",
  ready_for_dispatch: "ready_for_dispatch",
};

/** The ledger reason recorded when stock enters each stage. */
export const STAGE_MOVEMENT_REASON: Record<FlowStage, string> = {
  received: "manual",
  washing: "wash",
  drying: "dry",
  folding: "fold",
  packing: "pack",
  ready_for_dispatch: "dispatch",
};

export function isFlowStage(stage: string): stage is FlowStage {
  return (BATCH_FLOW as readonly string[]).includes(stage);
}

/** The stage after this one, or null at the end of the line. */
export function nextStage(stage: string): FlowStage | null {
  const index = (BATCH_FLOW as readonly string[]).indexOf(stage);
  if (index < 0 || index >= BATCH_FLOW.length - 1) return null;
  return BATCH_FLOW[index + 1] ?? null;
}

/** Where rejected stock goes: repairable, or written down as damaged. */
export const REJECT_DESTINATIONS = [
  { value: "in_repair", label: "Send for repair", reason: "repair" },
  { value: "damaged", label: "Mark damaged", reason: "damage" },
] as const;

export type RejectDestination = (typeof REJECT_DESTINATIONS)[number]["value"];
