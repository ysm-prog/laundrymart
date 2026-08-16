/**
 * Types for `role-profiles.mjs`. The module itself is plain JavaScript because
 * `scripts/seed-role-profiles.mjs` runs under bare Node with no build step in
 * front of it; this file is what lets the vitest suite (and `tsc --noEmit`)
 * read the same list without a second copy of it existing.
 */

export interface RoleProfile {
  /** A member of `ROLES` in `src/lib/roles.ts` — pinned by role-profiles.test.ts. */
  role: string;
  name: string;
  note: string;
  /** Needs a `drivers` row, or `current_driver_id()` is null. */
  driver?: boolean;
  /** Not a membership: a row in `platform_admins`, reaching every laundry. */
  platform?: boolean;
}

export declare const DEFAULT_EMAIL_DOMAIN: string;
export declare const DEFAULT_PASSWORD: string;
export declare const DEFAULT_TENANT: string;
export declare const ROLE_PROFILES: readonly RoleProfile[];

export declare function profileEmail(profile: RoleProfile, domain?: string): string;
export declare function selectedProfiles(
  options?: { includePlatformAdmin?: boolean },
): RoleProfile[];
