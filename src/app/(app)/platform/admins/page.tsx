import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { date } from "@/lib/format";
import {
  Badge, Card, DataTable, EmptyState, Notice, PageHeader, SkeletonRows,
} from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Field, Input, SubmitButton } from "@/components/form";
import { addPlatformAdmin, removePlatformAdmin } from "../actions";

export const metadata = { title: "Platform administrators" };
export const dynamic = "force-dynamic";

type Row = { user_id: string; note: string | null; created_at: string };

export default async function PlatformAdminsPage() {
  const session = await requireCapability("platform.write");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Administrators"
        description="These people can reach every laundry on this system, and change who else can."
      />

      <Notice tone="warning" title="This is the widest access there is">
        A platform administrator sees every business on this deployment and everything
        in them. Nobody here is limited to one laundry, and no laundry owner can remove
        them. Add someone only if they run the system itself.
      </Notice>

      <Card
        title="Add an administrator"
        description="They must already be able to sign in. Invite them to a laundry first if they cannot."
      >
        <form action={addPlatformAdmin} className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto]">
          <Field label="Email address" name="email" required
                 hint="The address they already sign in with.">
            <Input name="email" type="email" required inputMode="email"
                   autoComplete="off" placeholder="name@example.com.au" />
          </Field>
          <Field label="Note" name="note" hint="Optional. Who they are, for the list below.">
            <Input name="note" placeholder="Runs the deployment" />
          </Field>
          <div className="flex items-end">
            <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
          </div>
        </form>
      </Card>

      <Suspense fallback={<SkeletonRows rows={3} />}>
        <AdminList currentUserId={session.userId} />
      </Suspense>
    </div>
  );
}

/**
 * Addresses for the platform admins, from the service-role auth API — the same
 * arrangement, and the same degradation, as the People screen: the lookup
 * starts from the rows we already hold and asks for each id, never lists
 * globally and filters afterwards.
 */
async function adminEmails(userIds: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  if (userIds.length === 0) return emails;
  try {
    const admin = createAdminClient();
    const results = await Promise.all(userIds.map(async (id) => {
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        return [id, data.user?.email ?? null] as const;
      } catch {
        return [id, null] as const;
      }
    }));
    for (const [id, email] of results) if (email) emails.set(id, email);
  } catch {
    // Fall through: the list renders short ids rather than nothing.
  }
  return emails;
}

async function AdminList({ currentUserId }: { currentUserId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id, note, created_at")
    .order("created_at")
    .returns<Row[]>();

  const rows = data ?? [];
  const emails = await adminEmails(rows.map((row) => row.user_id));
  const isLast = rows.length <= 1;

  return (
    <Card bodyClassName="p-0">
      <DataTable
        bare
        label="Platform administrators"
        rows={rows}
        empty={<EmptyState title="Nobody yet" description="Add the first administrator above." />}
        columns={[
          {
            header: "Person",
            cell: (row) => (
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {emails.get(row.user_id) ?? `${row.user_id.slice(0, 8)}…`}
                  </span>
                  {row.user_id === currentUserId ? <Badge tone="primary">you</Badge> : null}
                </div>
                {row.note ? (
                  <span className="block text-xs text-muted-foreground">{row.note}</span>
                ) : null}
              </div>
            ),
          },
          { header: "Added", cell: (row) => date(row.created_at), hideBelow: "sm" },
          {
            header: "",
            align: "right",
            cell: (row) => (isLast ? (
              <span className="text-xs text-muted-foreground">Last administrator</span>
            ) : (
              <form action={removePlatformAdmin}>
                <input type="hidden" name="user_id" value={row.user_id} />
                <ConfirmSubmit
                  label="Remove"
                  eyebrow="This can be undone"
                  consequence={`${emails.get(row.user_id) ?? "This person"} will lose access to every laundry on this system. Their login and their own laundry memberships are untouched.`}
                />
              </form>
            )),
          },
        ]}
      />
    </Card>
  );
}
