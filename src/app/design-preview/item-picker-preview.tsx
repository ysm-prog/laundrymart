"use client";

import { useState } from "react";
import { ItemPicker, type PickerItem } from "@/components/coding-pickers";

/**
 * The shared item picker, holding its own selection so the gallery can show it.
 *
 * `ItemPicker` is controlled — the real call sites keep the chosen item in the
 * row they belong to — so it cannot be rendered from a server component without
 * something to hold that state. This is that something and nothing else: no
 * fixtures of its own, because a second copy of the item list beside
 * `PREVIEW_LINE_ITEMS` is exactly the drift this repo keeps recording.
 */
export function ItemPickerPreview({
  items, idPrefix, purpose,
}: {
  items: readonly PickerItem[];
  idPrefix: string;
  purpose: "coding" | "laundry";
}) {
  const [chosen, setChosen] = useState<PickerItem | null>(null);
  return (
    <ItemPicker
      items={items}
      chosen={chosen}
      onChoose={setChosen}
      onClear={() => setChosen(null)}
      idPrefix={idPrefix}
      purpose={purpose}
    />
  );
}
