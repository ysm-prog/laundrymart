import { describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, ROLES } from "@/lib/roles";
import {
  DEFAULT_EMAIL_DOMAIN, ROLE_PROFILES, formerProfileEmail, profileEmail, selectedProfiles,
  type RoleProfile,
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
    expect(emails).toContain(`warehouse-operator@${DEFAULT_EMAIL_DOMAIN}`);
  });

  it("addresses the owner as the owner, which is what every screen calls them", () => {
    // The regression this pins. `ROLE_PRESETS` labels `super_admin` "Owner",
    // the People picker offers it that way and this profile is named "Test
    // Owner" — but the address was derived from the role *identifier*, so the
    // one string an operator has to type was the only place in the app that
    // said "super-admin". An owner working from a list of test logins typed
    // `owner@` and was told their details were invalid, which was true and
    // useless: no such login existed.
    const owner = profiles.find((p) => p.role === "super_admin");
    expect(profileEmail(owner!)).toBe(`owner@${DEFAULT_EMAIL_DOMAIN}`);
  });

  it("remembers an address a profile has moved away from", () => {
    // Without this the rename leaves the old login in the laundry holding the
    // same membership: two owner logins, one of them at an address nothing
    // tells you about, and `--remove` cleaning up neither.
    const owner = profiles.find((p) => p.role === "super_admin");
    expect(formerProfileEmail(owner!)).toBe(`super-admin@${DEFAULT_EMAIL_DOMAIN}`);

    // Nobody else has moved, so nobody else claims an old address — a stale
    // `formerly` would have the runner adopt a login it does not own.
    const moved = profiles.filter((p) => formerProfileEmail(p) !== null);
    expect(moved.map((p) => p.role)).toEqual(["super_admin"]);
  });

  it("never lets a former address collide with a current one", () => {
    // Two profiles cannot both answer to one login: whichever ran second would
    // rename the other's account out from under it.
    const current = new Set(profiles.map((p) => profileEmail(p)));
    for (const profile of profiles) {
      const former = formerProfileEmail(profile);
      if (former) expect(current.has(former), profile.role).toBe(false);
    }
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
