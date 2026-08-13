/**
 * Simple mode — how much of the app a tenant sees (roadmap D2).
 *
 * A three-person laundry and a multi-depot operator run the same code, and the
 * rail was written for the second one. Simple mode is the first one's answer:
 * the areas a small laundry uses every day, and nothing else.
 *
 * **It is a navigation filter, never a permission.** The capability model in
 * `roles.ts` is the only thing that decides who may open a screen, and it is
 * unchanged here — a screen hidden by simple mode is still reachable by URL, by
 * a link from the dashboard, and by every action that redirects to it, and it
 * still checks the same capability when it gets there. Two systems both able to
 * deny access is one more than a reader can hold in their head, so this one
 * denies nothing. It only decides what the rail offers.
 *
 * Stored in the `tenants.settings` jsonb column that 0013 added — the same bag
 * the notification preferences live in, which is why that migration carried
 * both. Read at the root of `settings`, beside `notifications`, so the two
 * never collide.
 */

import { z } from "zod";

export const UI_MODES = ["simple", "full"] as const;

export type UiMode = (typeof UI_MODES)[number];

/**
 * Full, deliberately.
 *
 * Every tenant that exists today has an empty or notifications-only settings
 * blob, so whatever this default is, they get it at the next page render with
 * nobody having chosen it. Defaulting to simple would silently take rows out of
 * a working operator's menu — including screens they use daily — and the first
 * thing they would know about it is a missing link. Simple mode is therefore
 * something a tenant turns on, on a screen that says exactly what it hides.
 */
export const DEFAULT_UI_MODE: UiMode = "full";

const schema = z.object({ ui_mode: z.enum(UI_MODES).optional() });

/** Never throws: an unrecognised or hand-edited value yields the default. */
export function parseUiMode(raw: unknown): UiMode {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return DEFAULT_UI_MODE;
  return parsed.data.ui_mode ?? DEFAULT_UI_MODE;
}

/**
 * The jsonb to store back, with the rest of the bag preserved.
 *
 * Same read-modify-write contract as `serialiseSettings()` in
 * `notifications/settings.ts`: saving one screen's preferences must not reset a
 * preference that screen does not show.
 */
export function serialiseUiMode(mode: UiMode, existing: unknown): Record<string, unknown> {
  const base = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? { ...(existing as Record<string, unknown>) }
    : {};
  base.ui_mode = mode;
  return base;
}

export const UI_MODE_LABELS: Record<UiMode, string> = {
  simple: "Just the everyday screens",
  full: "The whole app",
};

export const UI_MODE_SUMMARY: Record<UiMode, string> = {
  simple:
    "The menu shows what a small laundry does every day. The planning board, the "
    + "plant floor, the reports and the activity log come out of it — they still "
    + "work, they are just not in the menu.",
  full:
    "Every screen appears in the menu, including the planning board, the plant "
    + "floor, reports and the activity log.",
};
