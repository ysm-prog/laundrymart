/**
 * Who the laundry's people are, and what to call each of them.
 *
 * Every `assigned_to`, `created_by`, `actor_id` and `delivered_by` column in
 * this schema holds an `auth.users` id, and until now the screens rendered the
 * closest thing they could reach: an email address, or eight characters of a
 * UUID. Nobody in a laundry is called `8c2b996b…`, and a picker of them is not
 * a list of people — it is a list of database keys with a role beside each one.
 *
 * The rule is pure and lives here rather than in the query, for the reason §2
 * gives for every other shared decision: the job pickers, the People list, the
 * driver link and the activity log must all answer this the same way, and a
 * rule stated four times is four rules.
 *
 * Order of preference, and why:
 *   1. **The name they were invited under** (`user_metadata.full_name`). What a
 *      person is actually called, typed in by whoever added them.
 *   2. **The driver record their login is linked to.** A laundry that has
 *      linked a driver already typed that person's name in once; asking for it
 *      a second time to make a picker readable would be the app forgetting.
 *   3. **Their email address.** Meaningful, if long — and honest. A name is
 *      deliberately *not* invented out of the local part: `jsmith@` is not
 *      "Jsmith", and a wrong name reads as a different person rather than as a
 *      missing one.
 *   4. **A short id**, last, for a login with no name and no address at all.
 */

export type MemberNameParts = {
  id: string;
  /** `user_metadata.full_name`, where somebody has set one. */
  fullName?: string | null;
  /** `drivers.full_name`, where this login is linked to a driver record. */
  driverName?: string | null;
  email?: string | null;
};

/** Blank, whitespace and null are all the same answer: no name here. */
function present(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export function memberDisplayName(member: MemberNameParts): string {
  return present(member.fullName)
    ?? present(member.driverName)
    ?? present(member.email)
    ?? `User ${member.id.slice(0, 8)}…`;
}

/**
 * True when the best we can do is still not a name — an address or an id.
 *
 * The People screen uses it to offer the one thing that fixes it: somewhere to
 * type the person's name. A screen that shows an address and says nothing
 * leaves the operator with no way to know the app would rather have a name.
 */
export function hasRealName(member: MemberNameParts): boolean {
  return present(member.fullName) !== null || present(member.driverName) !== null;
}

/* -------------------------------------------------------------------------- */
/* Which of them a screen may offer                                            */
/* -------------------------------------------------------------------------- */

/**
 * The shape these rules need. Deliberately structural rather than the full
 * `Member`: they are pure list rules, they live in `domain/` so they can be
 * tested at all, and `lib/directory.ts` — which reaches `next/headers` through
 * the session — cannot be imported from a unit test. The same trap `plan.ts`
 * and `invoice-grouping.ts` already record.
 */
export type Pickable = { id: string; label: string; isPlatformAdmin: boolean };

/**
 * The laundry's own people — **platform administrators excluded**.
 *
 * A platform administrator administers the deployment, not this business
 * (0019): they hold a membership in every laundry so they can support one, and
 * belong to none of them. So a list of who to assign a job to, who to link a
 * driver login to, or who works here is not a list they are on — and that holds
 * for the signed-in platform administrator too. They are not offered to
 * themselves.
 *
 * This filters *lists people are picked from*, and deliberately not
 * `memberNames()` below: a job one of them created still has to say who created
 * it. Keeping them out of a picker keeps a staff list honest; keeping them out
 * of a record would falsify it.
 */
export function staffMembers<T extends Pickable>(members: readonly T[]): T[] {
  return members
    .filter((member) => !member.isPlatformAdmin)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** `id → what to call them`, for rendering a stored id without a second lookup. */
export function memberNames(
  members: readonly { id: string; label: string }[],
): Map<string, string> {
  return new Map(members.map((member) => [member.id, member.label]));
}

/**
 * The pickable list, with a record's own current holder added back.
 *
 * A job assigned before that person stopped being pickable — a platform
 * administrator, or somebody since taken off the list — must not open with
 * "Nobody" selected: a `defaultValue` matching no option quietly selects the
 * placeholder, and the next save would clear an assignment nobody meant to
 * touch. So the stored value is added back for the form that holds it, exactly
 * as `receivedViaOptions()` adds a legacy job's own received-via back rather
 * than rewriting how it arrived.
 */
export function withCurrentHolder<T extends { id: string }>(
  staff: readonly T[], all: readonly T[], currentId: string | null | undefined,
): T[] {
  if (!currentId || staff.some((member) => member.id === currentId)) return [...staff];
  const holder = all.find((member) => member.id === currentId);
  return holder ? [...staff, holder] : [...staff];
}

/**
 * A default that is actually in the list.
 *
 * The completion picker defaults to whoever the job is assigned to, falling
 * back to the person recording it — and either can be somebody the list does
 * not offer. A `defaultValue` naming an option that is not there selects the
 * first one instead, which is how a job gets recorded as handed over by
 * whoever happens to sort first.
 */
export function defaultStaffId(
  staff: readonly { id: string }[],
  ...preferred: readonly (string | null | undefined)[]
): string | undefined {
  return preferred.find((id) => !!id && staff.some((member) => member.id === id)) ?? undefined;
}
