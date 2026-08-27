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
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import {
  createMemberWithPassword, inviteMember, removeMember, sendMemberSignInLink, updateMembership,
} from "../actions";
import { FormDisclosure } from "@/app/(app)/customers/customer-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/passwords";

export const metadata = { title: "People" };
export const dynamic = "force-dynamic";

type Search = { q?: string; role?: string; named?: string };
const FILTER_KEYS = ["q", "role", "named"] as const;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("admin.read");
  const params = await searchParams;
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
          Administrators can add people here — by emailing them a link, or by setting a
          password and handing it over. Ask one of them for anyone who needs a login.
        </Notice>
      )}

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={5} />}>
        <MembershipList params={params} canWrite={canWrite} currentUserId={session.userId} />
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
/**
 * The two ways somebody gets onto this list, in one card.
 *
 * They ask the **same four questions** and differ only in how the person gets
 * in, so they are one form with two submit buttons rather than two cards asking
 * for a name and an email twice. `SubmitButton`'s `formAction` is the mechanism
 * and the billing queue's Price / Approve pair is the precedent: one set of
 * answers, two verbs over it.
 *
 * **The invitation stays the default and the visible path.** It is the safer of
 * the two — the person chooses their own password and nothing has to be handed
 * over — so it keeps the primary button, and setting a password is one
 * disclosure away for the cases where a link is no use: a counter hand with no
 * work email, somebody being set up in the room, a round's shared tablet.
 *
 * Nothing inside the disclosure is `required`. That is not incidental: a
 * `required` control inside a closed `<details>` fails native validation with
 * nothing to focus and no way for the operator to find out why the form will
 * not submit — the constraint the 2026-08-24 pass recorded when the job form's
 * optional sections became disclosures. The password is validated on the
 * server, by `passwordProblem`, which is also where its rules are stated.
 */
async function InviteCard() {
  return <AddPersonCard depots={await activeDepots()} />;
}

/**
 * The card itself, with no data read in it, so `/design-preview` can render it.
 *
 * §10b's rule: every real screen here is an async server component reading
 * Supabase, so none of them render without a live project — which is how a
 * doubled hairline and an invisible dark-mode edge both survived a green
 * `verify`. Splitting the one query out is what lets the gallery show this form
 * (and its disclosure, and both buttons) against fixtures.
 */
export function AddPersonCard({ depots }: { depots: Pick<Depot, "id" | "name">[] }) {
  return (
    <Card
      title="Add someone"
      description="Email them a link to set their own password, or set one now and hand it over."
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

        <FormDisclosure
          summary="Set a password instead"
          hint="For somebody with no email, or who is standing next to you"
        >
          <div className="space-y-4">
            <Field
              label="Password"
              name="password"
              /* Generated from the constant the server enforces, so the form
                 cannot promise a rule the action then refuses. That is exactly
                 the defect this was adopted from: ysm-hub's form accepts six
                 characters and its API demands ten. */
              hint={`At least ${MIN_PASSWORD_LENGTH} characters. They can change it once they are in.`}
            >
              {/* `new-password`, not `off`: password managers ignore `off` and
                  would happily fill the administrator's own credential into a
                  box that creates somebody else's login. */}
              <Input name="password" type="password" autoComplete="new-password" />
            </Field>
            <p className="text-xs text-muted-foreground">
              No email is sent. Give them the password yourself, and ask them to change
              it — anyone on the list below can be sent a sign-in link to do that.
            </p>
            <div className="flex justify-end">
              <SubmitButton
                variant="secondary"
                formAction={createMemberWithPassword}
                pendingLabel="Creating…"
              >
                Create login
              </SubmitButton>
            </div>
          </div>
        </FormDisclosure>

        <div className="flex justify-end">
          <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

async function MembershipList({
  params, canWrite, currentUserId,
}: { params: Search; canWrite: boolean; currentUserId: string }) {
  const [members, depots] = await Promise.all([listMembers(), activeDepots()]);
  const depotName = new Map(depots.map((depot) => [depot.id, depot.name]));

  // Platform administrators are not this laundry's people. They hold a
  // membership in every laundry on the deployment (0019) so that they can
  // support one, and listing them here reads as two strangers on the payroll —
  // the owner's decision. Platform → Administrators is where that list lives,
  // and it is the only screen that shows it.
  const all = staffMembers(members);

  const term = params.q?.trim().toLowerCase();
  const rows = all.filter((row) => {
    if (term && !`${row.label} ${row.email ?? ""}`.toLowerCase().includes(term)) return false;
    if (params.role && row.roleValue !== params.role) return false;
    if (params.named === "unnamed" && row.named) return false;
    return true;
  });
  const filtered = isFiltered(params, FILTER_KEYS);
  const roleCount = (role: string) => all.filter((row) => row.roleValue === role).length;
  const unnamed = all.filter((row) => !row.named).length;

  return (
    <Card title="Members" description="Only administrators can see and change this list.">
      {/* Worth a bar once the list is long enough to hunt through. A laundry
          with five people can read five rows. */}
      {all.length > 6 ? (
        <ListControls
          action="/admin/users"
          q={params.q}
          params={params}
          filterKeys={FILTER_KEYS}
          placeholder="Name or email address…"
          filters={[{
            name: "role", label: "Role", value: params.role,
            options: MEMBERSHIP_ROLES
              .filter((role) => roleCount(role) > 0)
              .map((role) => ({ value: role, label: roleName(role) })),
          }]}
          chips={unnamed > 0 ? (
            /* A person with no name renders as an address or a short id in every
               picker in the app, which reads as a different person each time —
               so "who still needs one?" is worth one press. */
            <FilterChips
              basePath="/admin/users" params={params} name="named" label="Names"
              allLabel="Everyone" allCount={all.length}
              options={[{
                value: "unnamed", label: "No name yet", count: unnamed,
                title: "These people show as an email address or a short id wherever they appear",
              }]}
            />
          ) : null}
          summary={
            <FilterSummary basePath="/admin/users" shown={rows.length} total={all.length}
                           noun="person" nouns="people" filtered={filtered} />
          }
        />
      ) : null}
      <DataTable
        rows={rows}
        empty={filtered
          ? <EmptyState title="Nobody matches those filters"
                        description="Try a broader search, or clear the filters above." />
          : <EmptyState title="Nobody on the list yet"
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
                  {/* Ids are per row, not per field name. `Input`/`Select`
                      default their id to the field name, and this form is
                      rendered once *per member* — so on a laundry with twenty
                      people the page carried twenty elements each called
                      `full_name`, `role` and `depot_id`. Invalid HTML, and
                      every `<label for>` in the document resolves to whichever
                      one happens to come first. The same fix the charges editor
                      needed when the gallery put two of them on one page. */}
                  <Input name="full_name" id={`full_name-${row.id}`} defaultValue={row.fullName ?? ""}
                         aria-label={`Name for ${row.label}`} placeholder="Their name" />
                  <Select name="role" id={`role-${row.id}`} defaultValue={row.roleValue}
                          aria-label={`Role for ${row.label}`} groups={ROLE_GROUPS} />
                  <Select name="depot_id" id={`depot_id-${row.id}`} placeholder="Every site"
                          aria-label={`Site for ${row.label}`} defaultValue={row.depotId}
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
