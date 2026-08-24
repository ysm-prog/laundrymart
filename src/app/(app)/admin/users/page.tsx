import { cache, Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { listMembers, staffMembers } from "@/lib/directory";
import {
  can, isRole, presetForRole, MEMBERSHIP_ROLES, PRESET_ROLES, ROLE_LABELS, ROLE_PRESETS, ROLE_SUMMARY,
  type Role,
} from "@/lib/roles";
import { date } from "@/lib/format";
import type { Depot } from "@/lib/db/types";
import {
  Badge, Card, DataTable, EmptyState, Notice, PageHeader, SkeletonRows,
} from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import {
  inviteMember, removeMember, sendMemberSignInLink, updateMembership,
} from "../actions";

export const metadata = { title: "People" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await requireCapability("admin.read");
  const canWrite = can(session.role, "admin.write");

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description="Who can sign in, and which parts of the app each person sees."
      />

      {canWrite ? (
        <Suspense fallback={<SkeletonRows rows={2} />}>
          <InviteCard />
        </Suspense>
      ) : (
        <Notice tone="info" title="Adding someone new">
          Administrators can invite people here by email. Ask one of them to add anyone
          who needs a login.
        </Notice>
      )}

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <MembershipList canWrite={canWrite} currentUserId={session.userId} />
      </Suspense>

      <Card
        title="What each role can do"
        description="Most laundries only ever need the first three."
      >
        <dl className="divide-y">
          {ROLE_ORDER.map((role) => (
            <div key={role}
                 className="grid gap-0.5 py-2 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-[13px] font-medium">{roleName(role)}</dt>
              <dd className="text-xs text-muted-foreground">{ROLE_SUMMARY[role]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

/**
 * The role as a person picking it should read it: the everyday word first for
 * the three a small laundry uses, and the stored role in brackets so the choice
 * can be matched to the members list and the activity log, which both show the
 * role itself. The other eight keep their own label and nothing else.
 */
function roleName(role: Role): string {
  const preset = presetForRole(role);
  return preset ? `${preset.label} (${ROLE_LABELS[role]})` : ROLE_LABELS[role];
}

/** The three everyday answers first, the specialist eight after them. */
const ROLE_ORDER: readonly Role[] = [
  ...PRESET_ROLES,
  ...MEMBERSHIP_ROLES.filter((role) => !PRESET_ROLES.includes(role)),
];

/**
 * The same split inside the picker. An `<optgroup>` rather than an "advanced"
 * toggle: the three everyday answers are read first, and the other eight are one
 * scroll away instead of behind a control the user has to discover.
 */
const ROLE_GROUPS = [
  {
    label: "Most laundries",
    options: ROLE_PRESETS.map((preset) => ({ value: preset.role, label: roleName(preset.role) })),
  },
  {
    label: "Specialist",
    // MEMBERSHIP_ROLES, not ROLES: `platform_admin` is not a membership and the
    // check constraint on the column refuses it (0019). Offering it here would
    // be a picker entry that always fails to save.
    options: MEMBERSHIP_ROLES
      .filter((role) => !PRESET_ROLES.includes(role))
      .map((role) => ({ value: role, label: ROLE_LABELS[role] })),
  },
];

/**
 * Active sites, for the "one site only" choice on both forms. Memoised per
 * request: the invite card and the members list each need the same list, and
 * they stream independently, so without this the page issues the query twice.
 */
const activeDepots = cache(async (): Promise<Pick<Depot, "id" | "name">[]> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("depots").select("id, name").eq("status", "active").order("name")
    .returns<Pick<Depot, "id" | "name">[]>();
  return data ?? [];
});

/**
 * Invite by email (roadmap D5).
 *
 * The screen used to say accounts were "set up by your system administrator" —
 * true, and useless to an owner who needs to add their own counter staff and
 * their own driver.
 *
 * The invitation goes out through **this app's own mail provider**, the one the
 * invoices already use. It used to be Supabase's built-in sender, which needs
 * custom SMTP nobody had configured — so every invitation this screen has ever
 * reported as sent was a form saying so and sending nothing.
 */
async function InviteCard() {
  const depots = await activeDepots();

  return (
    <Card
      title="Invite someone"
      description="They get an email with a link to set a password. Their access starts as soon as they follow it."
    >
      <form action={inviteMember} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)]">
          {/* Asked for first, and required. This is the name the job pickers,
              the completion form and the activity log will show — the screens
              that had nothing but an address to put beside a person. */}
          <Field label="Full name" name="full_name" required
                 hint="How they appear on jobs and runs.">
            <Input name="full_name" required autoComplete="off" placeholder="Mario Forte" />
          </Field>
          <Field label="Email address" name="email" required
                 hint="The address they will sign in with.">
            <Input name="email" type="email" required autoComplete="off"
                   inputMode="email" placeholder="name@example.com.au" />
          </Field>
          <Field label="What they do" name="role" required
                 hint="You can change this at any time.">
            <Select name="role" required defaultValue="driver" groups={ROLE_GROUPS} />
          </Field>
          <Field label="Site" name="depot_id"
                 hint="Leave blank if they work across every site.">
            <Select name="depot_id" placeholder="Every site"
                    options={depots.map((depot) => ({ value: depot.id, label: depot.name }))} />
          </Field>
        </div>
        <div className="flex justify-end">
          <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
        </div>
      </form>
    </Card>
  );
}


async function MembershipList({
  canWrite, currentUserId,
}: { canWrite: boolean; currentUserId: string }) {
  const [members, depots] = await Promise.all([listMembers(), activeDepots()]);
  const depotName = new Map(depots.map((depot) => [depot.id, depot.name]));

  // Platform administrators are not this laundry's people. They hold a
  // membership in every laundry on the deployment (0019) so that they can
  // support one, and listing them here reads as two strangers on the payroll —
  // the owner's decision. Platform → Administrators is where that list lives,
  // and it is the only screen that shows it.
  const rows = staffMembers(members);

  return (
    <Card title="Members" description="Only administrators can see and change this list.">
      <DataTable
        rows={rows}
        empty={<EmptyState title="Nobody on the list yet"
                           description="Invite your staff above. Platform administrators are not shown here — they support every laundry on this system rather than working in one." />}
        columns={[
          {
            header: "Person",
            cell: (row) => (
              <span className="flex items-center gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{row.label}</span>
                  {/* The address underneath, because this is the one screen
                      that is about logins rather than about people. When it is
                      all we have, the label above is already showing it, so
                      repeating it would just say the same thing twice. */}
                  {row.named && row.email ? (
                    <span className="block truncate text-xs text-muted-foreground">{row.email}</span>
                  ) : null}
                </span>
                {row.id === currentUserId ? <Badge tone="primary">you</Badge> : null}
                {row.named ? null : <Badge tone="warning">no name</Badge>}
              </span>
            ),
          },
          {
            header: "Role",
            cell: (row) => (isRole(row.roleValue) ? roleName(row.roleValue) : row.roleValue),
          },
          {
            header: "Site",
            cell: (row) => (row.depotId ? depotName.get(row.depotId) ?? "—" : "Every site"),
            hideBelow: "sm",
          },
          { header: "Added", cell: (row) => date(row.joinedAt), hideBelow: "md" },
          {
            header: "",
            align: "right",
            cell: (row) => (canWrite && row.id !== currentUserId ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <form action={updateMembership} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="user_id" value={row.id} />
                  {/* A name can be corrected here, which is what makes the rest
                      of the app able to show one: eleven of the logins on this
                      deployment predate ever being asked for a name, and a
                      picker showing an address is not a list of people. */}
                  <Input name="full_name" defaultValue={row.fullName ?? ""}
                         aria-label={`Name for ${row.label}`} placeholder="Their name" />
                  <Select name="role" defaultValue={row.roleValue} groups={ROLE_GROUPS} />
                  <Select name="depot_id" placeholder="Every site" defaultValue={row.depotId}
                          options={depots.map((depot) => ({ value: depot.id, label: depot.name }))} />
                  <SubmitButton variant="secondary" pendingLabel="Saving…">Save</SubmitButton>
                </form>
                {/* The missing rung between "change their role" and "take
                    their access away": an invitation only goes out once, so
                    somebody who never opened theirs — or who has lost their
                    password — had no way back in that an owner could offer.
                    It is here now because it needs no SMTP (see
                    `lib/auth/auth-links.ts`), and it is how a shared bootstrap
                    password gets replaced one person at a time. */}
                <form action={sendMemberSignInLink}>
                  <input type="hidden" name="user_id" value={row.id} />
                  <SubmitButton variant="ghost" pendingLabel="Sending…">
                    Email sign-in link
                  </SubmitButton>
                </form>
                <form action={removeMember}>
                  <input type="hidden" name="user_id" value={row.id} />
                  <ConfirmSubmit
                    label="Remove"
                    eyebrow="Removes their access"
                    consequence={`${row.label} will no longer be able`
                      + " to sign in to this laundry. Their login and everything they recorded stay"
                      + " as they are, and you can invite them back later."}
                    pendingLabel="Removing…"
                  />
                </form>
              </div>
            ) : null),
          },
        ]}
      />
    </Card>
  );
}
