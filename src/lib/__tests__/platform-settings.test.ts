import { describe, expect, it } from "vitest";
import { readPlatformSettings, platformSettingsSchema } from "@/app/(app)/platform/settings-shape";

/**
 * The deployment-wide settings bag, and in particular the single-laundry switch
 * added on 2026-08-26.
 *
 * The bag is read by a screen, by a server action and — through
 * `single_laundry_mode()` — by a database trigger, so the one thing that must
 * never drift is what an *absent* key means. Everything here is about that.
 */
describe("platform settings", () => {
  it("defaults the single-laundry switch to off", () => {
    // Load-bearing rather than tidy: `supabase/seed.sql` creates a laundry and
    // twenty-six pgTAP proofs create two. A mode that read "on" from an absent
    // key would fail the whole suite and the seed with it, which is why this is
    // the first assertion in the file.
    expect(readPlatformSettings({}).single_laundry).toBe(false);
    expect(readPlatformSettings(undefined).single_laundry).toBe(false);
    expect(readPlatformSettings(null).single_laundry).toBe(false);
  });

  it("reads a bag written before the switch existed", () => {
    // The reason every field is optional and every read defaulted (0013's rule,
    // kept by 0019): a settings row saved by a form that predates a switch has
    // to keep working, not throw.
    const legacy = readPlatformSettings({
      default_timezone: "Australia/Adelaide",
      default_gst_rate: 0.1,
      new_tenant_customer_emails: true,
    });
    expect(legacy.single_laundry).toBe(false);
    expect(legacy.new_tenant_customer_emails).toBe(true);
  });

  it("treats a ticked checkbox as on and an absent one as off", () => {
    // An unchecked HTML checkbox posts nothing at all, so absence is `false`
    // rather than "leave it alone" — the rule every other checkbox in the app
    // follows, and the reason `savePlatformSettings` read-merge-writes.
    expect(platformSettingsSchema.parse({ single_laundry: "on" }).single_laundry).toBe(true);
    expect(platformSettingsSchema.parse({ single_laundry: true }).single_laundry).toBe(true);
    expect(platformSettingsSchema.parse({ single_laundry: "true" }).single_laundry).toBe(true);
    expect(platformSettingsSchema.parse({}).single_laundry).toBe(false);
  });

  it("does not read a stray value as on", () => {
    // The database guard compares `settings->>'single_laundry' = 'true'`, so
    // anything that is not the string "true" is off there. These two must agree
    // or the screen and the trigger would disagree about the same key.
    expect(readPlatformSettings({ single_laundry: "false" }).single_laundry).toBe(false);
    expect(readPlatformSettings({ single_laundry: "yes" }).single_laundry).toBe(false);
    expect(readPlatformSettings({ single_laundry: 1 }).single_laundry).toBe(false);
  });

  it("falls back rather than throwing on junk", () => {
    // These are read inside server components. A throw there is a 500 on the
    // Platform screen, which is the one screen somebody would be on when trying
    // to fix a bad settings row.
    expect(readPlatformSettings("not a bag").single_laundry).toBe(false);
    expect(readPlatformSettings(42).default_timezone).toBe("Australia/Adelaide");
  });

  it("keeps the new-laundry defaults it always had", () => {
    const settings = readPlatformSettings({});
    expect(settings.default_timezone).toBe("Australia/Adelaide");
    expect(settings.default_gst_rate).toBe(0.1);
    expect(settings.new_tenant_customer_emails).toBe(false);
  });
});
