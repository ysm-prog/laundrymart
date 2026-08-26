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
  /**
   * Whether this deployment runs one laundry and refuses a second.
   *
   * Unlike the two above it is **not** a default a new laundry starts with —
   * it is a statement about the deployment itself, which is why it sits in its
   * own card on the settings screen rather than under "New laundry defaults".
   *
   * The switch is only the readable half. `guard_single_laundry` (0041) is the
   * boundary, and it reads this same key: `tenants` carries 0019's
   * `tenants_platform` policy, so a platform admin can POST one straight to
   * `/rest/v1/tenants` without going near the screen. One answer, one flip.
   *
   * Defaults to **false**, and that is load-bearing rather than tidy: the seed
   * creates a laundry and the pgTAP proofs create two, so a mode that defaulted
   * on would take the whole suite down with it.
   */
  single_laundry: z.preprocess(
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
