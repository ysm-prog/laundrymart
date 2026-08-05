/** Linen categories from spec §7.5. */
export const ITEM_CATEGORIES = [
  "bath_towel", "hand_towel", "tea_towel", "apron", "chef_uniform", "table_cloth",
  "napkin", "floor_mat", "laundry_bag", "uniform", "linen", "other",
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];
