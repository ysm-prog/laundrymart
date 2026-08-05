/** Inventory states from spec §7.13, in the order stock flows through them. */
export const INVENTORY_STATES = [
  "at_customer", "in_transit", "at_depot", "washing", "drying", "folding", "packing",
  "ready_for_dispatch", "in_repair", "damaged", "lost", "written_off",
] as const;

export type InventoryState = (typeof INVENTORY_STATES)[number];

/** States that represent stock we still own and expect back. */
export const CIRCULATING_STATES: readonly InventoryState[] = [
  "at_customer", "in_transit", "at_depot", "washing", "drying",
  "folding", "packing", "ready_for_dispatch", "in_repair",
];

export const MOVEMENT_REASONS = [
  "pickup", "delivery", "unload", "wash", "dry", "fold", "pack", "dispatch",
  "repair", "damage", "loss", "write_off", "stock_count", "purchase", "manual",
] as const;
