import { describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, ROLES } from "@/lib/roles";
import {
  DEFAULT_EMAIL_DOMAIN, ROLE_PROFILES, profileEmail, selectedProfiles, type RoleProfile,
  // The provisioning script's own module, imported rather than restated: a
  // second copy of this list is a second thing to keep in step, and the point
  // of the test is that `roles.ts` and the script cannot drift apart.
} from "../../../scripts/role-profiles.mjs";

const profiles: readonly RoleProfile[] = ROLE_PROFILES;

describe("test role profiles", () => {
  it("gives every role in the app a login to test it with", () => {
    // The one that matters. A twelfth role added to `roles.ts` with no profile
    // here would ship a role nobody can sign in as — which looks exactly like a
    // role that works, because nothing exercises it.
    expect(profiles.map((p) => p.role).sort()).toEqual([...ROLES].sort());
  });

  it("invents no role the database would refuse", () => {
    // Everything except `platform_admin` becomes a `memberships.role`, and that
    // column's check constraint (0001) accepts exactly MEMBERSHIP_ROLES.
    for (const profile of profiles) {
      if (profile.platform) continue;
      expect(MEMBERSHIP_ROLES as readonly string[], profile.role).toContain(profile.role);
    }
  });

  it("marks platform_admin as the one profile that is not a membership", () => {
    // 0019: it is a row in `platform_admins`, and `memberships.role` refuses the
    // value outright. Provisioning it as a membership would fail at the insert.
    const platform = profiles.filter((p) => p.platform);
    expect(platform.map((p) => p.role)).toEqual(["platform_admin"]);
  });

  it("holds platform_admin back unless it is asked for", () => {
    // It reaches every laundry on the project, including a real one sitting
    // beside the demo tenant — so it is opt-in, not part of "all the roles".
    expect(selectedProfiles().map((p) => p.role)).toEqual([...MEMBERSHIP_ROLES]);
    expect(selectedProfiles({ includePlatformAdmin: true })).toHaveLength(ROLES.length);
  });

  it("gives the driver profile a driver record, since RLS reads one", () => {
    // `current_driver_id()` resolves `drivers.user_id`; without a row it is
    // null and every driver-scoped policy matches nothing. The login would work
    // and My Runs would be empty, which reads as a bug in My Runs.
    expect(profiles.filter((p) => p.driver).map((p) => p.role)).toEqual(["driver"]);
  });

  it("addresses one login per role, and none of them can receive mail", () => {
    const emails = profiles.map((p) => profileEmail(p));
    expect(new Set(emails).size).toBe(profiles.length);
    // example.com is reserved (RFC 2606), so a stray invitation or an overdue
    // chase aimed at a test profile can never leave the building.
    expect(DEFAULT_EMAIL_DOMAIN.endsWith("example.com")).toBe(true);
    for (const email of emails) expect(email).toMatch(/^[a-z-]+@[a-z.]+$/);
    expect(emails).toContain(`super-admin@${DEFAULT_EMAIL_DOMAIN}`);
    expect(emails).toContain(`warehouse-operator@${DEFAULT_EMAIL_DOMAIN}`);
  });

  it("says what each profile is for", () => {
    // The note travels into user_metadata, so the reason a login exists is
    // readable from the login itself rather than only from this file.
    for (const profile of profiles) {
      expect(profile.name.length, profile.role).toBeGreaterThan(3);
      expect(profile.note.length, profile.role).toBeGreaterThan(20);
    }
  });
});
