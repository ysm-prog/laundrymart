/**
 * Reading comfort: how big the application draws itself.
 *
 * A person who cannot read 15px text cannot use this app, and the two ways out
 * that already existed — the browser's zoom and its default-font-size setting —
 * are both things you have to know about before you can use them. The people
 * this is for do not. So the preference is in the application, in words, where
 * somebody meets it.
 *
 * The rule lives here rather than in the component for the reason this repo
 * keeps rediscovering: a `"use client"` module is awkward to unit-test and a
 * `"use server"` one cannot export anything but actions, so a rule written
 * inside either is a rule nothing proves. `globals.css` turns the value into a
 * root font size; everything else in the app is `rem` and follows.
 */

/** Smallest first. The order is the order the header button cycles in. */
export const TEXT_SIZES = ["normal", "large", "xlarge"] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

export const DEFAULT_TEXT_SIZE: TextSize = "normal";

/**
 * The key in `localStorage`, and the attribute on `<html>`.
 *
 * Stored in `localStorage` beside `theme` rather than in a cookie beside the
 * rail's collapsed state, because both of those are read before paint by the
 * bootstrap script in the root layout — and this has to be, or the page draws
 * at one size and jumps to another while somebody is reading it.
 */
export const TEXT_SIZE_STORAGE_KEY = "textSize";
export const TEXT_SIZE_ATTRIBUTE = "data-text-size";

/**
 * What each step is called, in the words of somebody who has never used the
 * word "typography".
 *
 * `hint` is what actually changes, said plainly. "115%" would be accurate and
 * useless — nobody chooses a font size by percentage.
 */
export const TEXT_SIZE_LABELS: Record<TextSize, { label: string; hint: string }> = {
  normal: { label: "Normal", hint: "The usual size." },
  large: { label: "Large", hint: "A bit bigger. Easier on the eyes." },
  xlarge: { label: "Biggest", hint: "As big as it goes." },
};

/**
 * Read a stored value back.
 *
 * Anything unrecognised — an older release's value, a hand-edited entry, a
 * `null` from a browser with storage switched off — comes back as the default
 * rather than throwing. A preference is never worth an error page.
 */
export function parseTextSize(value: unknown): TextSize {
  return TEXT_SIZES.includes(value as TextSize) ? (value as TextSize) : DEFAULT_TEXT_SIZE;
}

/**
 * The next size round the loop, so one button can serve all three.
 *
 * It wraps rather than stopping at the largest: a control that silently stops
 * responding reads as broken, and there is no room in the header to explain
 * that you have reached the end.
 */
export function nextTextSize(current: TextSize): TextSize {
  const index = TEXT_SIZES.indexOf(current);
  return TEXT_SIZES[(index + 1) % TEXT_SIZES.length] ?? DEFAULT_TEXT_SIZE;
}

/**
 * What the header button promises it will do, named for the size it will move
 * *to* rather than the one you are on — the same contract `ThemeToggle` uses
 * ("Switch to dark mode" while you are in light).
 */
export function textSizeActionLabel(current: TextSize): string {
  return `Make text ${TEXT_SIZE_LABELS[nextTextSize(current)].label.toLowerCase()}`;
}
