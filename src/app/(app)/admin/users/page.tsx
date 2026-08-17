import { cache, Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { memberEmails } from "@/lib/members";
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
import { inviteMember, removeMember, updateMembership } from "../actions";

export const metadata = { title: "People" };
export const dynamic = "force-dynamic";

type Row = { user_id: string; role: string; depot_id: string | null; created_at: string };

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
 * their own driver. Supabase sends the mail, so nothing here depends on the
 * Resend configuration the invoice emails use.
 */
async function InviteCard() {
  const depots = await activeDepots();

  return (
    <Card
      title="Invite someone"
      description="They get an email with a link to set a password. Their access starts as soon as they follow it."
    >
      <form action={inviteMember} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)]">
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
  const supabase = await createClient();
  const [{ data: memberships }, depots] = await Promise.all([
    supabase.from("memberships").select("user_id, role, depot_id, created_at").order("created_at")
      .returns<Row[]>(),
    activeDepots(),
  ]);

  const depotName = new Map(depots.map((depot) => [depot.id, depot.name]));
  const emails = await memberEmails((memberships ?? []).map((row) => row.user_id));

  return (
    <Card title="Members" description="Only administrators can see and change this list.">
      <DataTable
        rows={memberships ?? []}
        empty={<EmptyState title="No memberships visible"
                           description="Administrators see the full list; other roles only see themselves." />}
        columns={[
          {
            header: "Person",
            cell: (row) => (
              <span className="flex items-center gap-2">
                {emails.has(row.user_id) ? (
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{emails.get(row.user_id)}</span>
                    <span className="block text-3xs text-muted-foreground">
                      {row.user_id.slice(0, 8)}
                    </span>
                  </span>
                ) : (
                  <span className="text-xs">{row.user_id.slice(0, 8)}…</span>
                )}
                {row.user_id === currentUserId ? <Badge tone="primary">you</Badge> : null}
              </span>
            ),
          },
          {
            header: "Role",
            cell: (row) => (isRole(row.role) ? roleName(row.role) : row.role),
          },
          {
            header: "Site",
            cell: (row) => (row.depot_id ? depotName.get(row.depot_id) ?? "—" : "Every site"),
            hideBelow: "sm",
          },
          { header: "Added", cell: (row) => date(row.created_at), hideBelow: "md" },
          {
            header: "",
            align: "right",
            cell: (row) => (canWrite && row.user_id !== currentUserId ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <form action={updateMembership} className="flex items-center gap-2">
                  <input type="hidden" name="user_id" value={row.user_id} />
                  <Select name="role" defaultValue={row.role} groups={ROLE_GROUPS} />
                  <Select name="depot_id" placeholder="Every site" defaultValue={row.depot_id}
                          options={depots.map((depot) => ({ value: depot.id, label: depot.name }))} />
                  <SubmitButton variant="secondary" pendingLabel="Saving…">Save</SubmitButton>
                </form>
                <form action={removeMember}>
                  <input type="hidden" name="user_id" value={row.user_id} />
                  <ConfirmSubmit
                    label="Remove"
                    eyebrow="Removes their access"
                    consequence={`${emails.get(row.user_id) ?? "This person"} will no longer be able`
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
