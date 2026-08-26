import { z } from "zod";

/**
 * The deployment-wide settings bag.
 *
 * Outside the `"use server"` module on purpose, and for the reason §2 of
 * CLAUDE.md gives: a `"use server"` file can export nothing but server actions,
 * so a schema declared inside one is unreachable from a unit test — which is
 * exactly how two shipped payload contracts in this repo stayed broken behind a
 * green `verify`. Anything with a shape worth asserting on lives out here.
 *
 * Every field is optional and every read is defaulted, so a settings row
 * written before a switch existed still parses.
 */
export const platformSettingsSchema = z.object({
  /** What a laundry created from the Laundries screen starts with. */
  default_timezone: z.string().trim().min(3).default("Australia/Adelaide"),
  default_gst_rate: z.coerce.number().min(0).max(1).default(0.1),
  /**
   * Whether a newly created laundry starts with customer emails switched on.
   * The per-laundry switch in `tenants.settings` (0013) still wins afterwards —
   * this only decides where that switch starts.
   */
  new_tenant_customer_emails: z.preprocess(
    // An unchecked HTML checkbox posts nothing at all, so absence is `false`
    // rather than "leave it alone" — the same rule every other checkbox in the
    // app follows.
    (value) => value === "on" || value === "true" || value === true,
    z.boolean(),
  ).default(false),
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

/** Read a stored bag, filling in anything a newer switch added. */
export function readPlatformSettings(value: unknown): PlatformSettings {
  const parsed = platformSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : platformSettingsSchema.parse({});
}
