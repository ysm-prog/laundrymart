import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { can, COMMON_ROLES, ROLES, ROLE_LABELS, ROLE_SUMMARY, type Role } from "@/lib/roles";
import { date } from "@/lib/format";
import type { Depot } from "@/lib/db/types";
import {
  Badge, Card, DataTable, EmptyState, Notice, PageHeader, SkeletonRows,
} from "@/components/ui";
import { emailIsConfigured } from "@/lib/email/send";
import { Field, FormActions, Input, Select, SubmitButton } from "@/components/form";
import { inviteMember, updateMembership } from "../actions";

export const metadata = { title: "People" };
export const dynamic = "force-dynamic";

type Row = { user_id: string; role: string; depot_id: string | null; created_at: string };

export default async function UsersPage() {
  const session = await requireCapability("admin.read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description="Who can sign in, and which parts of the app each person sees."
      />

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <MembershipList canWrite={can(session.role, "admin.write")} currentUserId={session.userId} />
      </Suspense>

      <Card
        title="What each role can do"
        description="Most laundries only ever need the first four."
      >
        <dl className="divide-y">
          {ROLE_ORDER.map((role) => (
            <div key={role}
                 className="grid gap-0.5 py-2 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-[13px] font-medium">{ROLE_LABELS[role]}</dt>
              <dd className="text-xs text-muted-foreground">{ROLE_SUMMARY[role]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

/** Everyday roles first, the specialist seven after them, in one list. */
const ROLE_ORDER: readonly Role[] = [
  ...COMMON_ROLES,
  ...ROLES.filter((role) => !(COMMON_ROLES as readonly string[]).includes(role)),
];

/**
 * The same split inside the picker. An `<optgroup>` rather than an "advanced"
 * toggle: the four everyday answers are read first, and the other seven are one
 * scroll away instead of behind a control the user has to discover.
 */
const ROLE_GROUPS = [
  {
    label: "Common",
    options: COMMON_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
  },
  {
    label: "Specialist",
    options: ROLES
      .filter((role) => !(COMMON_ROLES as readonly string[]).includes(role))
      .map((role) => ({ value: role, label: ROLE_LABELS[role] })),
  },
];

/**
 * Emails for the tenant's members, from the service-role auth API. The lookup
 * starts from this tenant's membership rows and asks for each id — the admin
 * client bypasses RLS, so it must never list globally and filter afterwards.
 * Any failure (no service key in a local build, auth API down) degrades to
 * the short id rather than an error: a less readable list beats no list.
 */
async function memberEmails(userIds: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  if (userIds.length === 0) return emails;
  try {
    const admin = createAdminClient();
    const results = await Promise.all(userIds.map(async (id) => {
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        return [id, data.user?.email ?? null] as const;
      } catch {
        return [id, null] as const; // One unresolvable id must not blank the rest.
      }
    }));
    for (const [id, email] of results) {
      if (email) emails.set(id, email);
    }
  } catch {
    // Fall through with whatever resolved; the cell renders short ids instead.
  }
  return emails;
}

async function MembershipList({
  canWrite, currentUserId,
}: { canWrite: boolean; currentUserId: string }) {
  const supabase = await createClient();
  const [{ data: memberships }, { data: depots }] = await Promise.all([
    supabase.from("memberships").select("user_id, role, depot_id, created_at").order("created_at")
      .returns<Row[]>(),
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
  ]);

  const depotName = new Map((depots ?? []).map((depot) => [depot.id, depot.name]));
  const emails = await memberEmails((memberships ?? []).map((row) => row.user_id));
  const depotOptions = (depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }));

  return (
    <div className="space-y-6">
      {canWrite ? <InviteForm depots={depotOptions} /> : null}

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
                    <span className="block font-mono text-3xs text-muted-foreground">
                      {row.user_id.slice(0, 8)}
                    </span>
                  </span>
                ) : (
                  <span className="font-mono text-xs">{row.user_id.slice(0, 8)}…</span>
                )}
                {row.user_id === currentUserId ? <Badge tone="primary">you</Badge> : null}
              </span>
            ),
          },
          { header: "Role", cell: (row) => ROLE_LABELS[row.role as Role] ?? row.role },
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
              <form action={updateMembership} className="flex items-center justify-end gap-2">
                <input type="hidden" name="user_id" value={row.user_id} />
                <Select name="role" defaultValue={row.role} groups={ROLE_GROUPS} />
                <Select name="depot_id" placeholder="Every site" defaultValue={row.depot_id}
                        options={depotOptions} />
                <SubmitButton variant="secondary" pendingLabel="Saving…">Save</SubmitButton>
              </form>
            ) : null),
          },
        ]}
      />
      </Card>
    </div>
  );
}

/**
 * Invite a teammate (roadmap D5).
 *
 * Three fields, because that is the whole decision: who, what they can do, and
 * which site they belong to. What happens next depends on whether this
 * deployment has an email provider, and the form says which it is rather than
 * leaving the administrator to find out from the person not arriving.
 */
function InviteForm({ depots }: { depots: Array<{ value: string; label: string }> }) {
  const mailReady = emailIsConfigured();

  return (
    <Card
      title="Invite someone"
      description="Creates their sign-in and puts them on your team. You can change the role afterwards."
    >
      <form action={inviteMember} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Email" name="email" required
                 hint="The address they will sign in with.">
            <Input name="email" type="email" inputMode="email" required
                   placeholder="name@business.com.au" />
          </Field>
          <Field label="What they can do" name="role" required
                 hint="Most laundries only need the first four.">
            <Select name="role" required placeholder="Choose a role" groups={ROLE_GROUPS} />
          </Field>
          <Field label="Site" name="depot_id" hint="Leave blank for every site.">
            <Select name="depot_id" placeholder="Every site" options={depots} />
          </Field>
        </div>

        <Notice tone="info" title={mailReady ? "What they will get" : "There is no email provider yet"}>
          {mailReady ? (
            <>
              An email with a sign-in link that works once. If it expires before they
              use it, they can get another from the sign-in page at any time.
            </>
          ) : (
            <>
              Their sign-in will be created, but nothing will be emailed — tell them to
              go to the sign-in page, type this address and choose &ldquo;Email me a
              sign-in link&rdquo;. That works today and needs nothing configured.
            </>
          )}
        </Notice>

        <FormActions>
          <SubmitButton pendingLabel="Inviting…">Invite</SubmitButton>
        </FormActions>
      </form>

      <p className="mt-3 text-xs text-muted-foreground">
        Drivers need one more step: link them to their driver record on the Drivers
        screen, or their run will not show up on their phone.
      </p>
    </Card>
  );
}
