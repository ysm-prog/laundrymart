/**
 * The plant strip on Today, shown only while the laundry records production
 * batches (brief 3.9). The "Needs a decision" table that used to live here was
 * replaced by the inbox sections in `inbox.tsx` (brief 3.2).
 */

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
