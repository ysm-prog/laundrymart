import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import type { Board, Depot, Vehicle } from "@/lib/db/types";
import {
  Badge, Card, DataTable, EmptyState, Notice, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import { listMembers, staffMembers, type Member } from "@/lib/directory";
import { createBoard, linkBoardLogin } from "./actions";
import { counted } from "@/lib/format";

export const metadata = { title: "Boards" };
export const dynamic = "force-dynamic";

/**
 * Boards — the rounds work is assigned to.
 *
 * A laundry runs a handful of standing rounds, and the person on each changes:
 * somebody resigns, somebody is sick, somebody covers for a fortnight. Work is
 * therefore given to **Board 1**, not to a named employee, and whoever is
 * operating Board 1 that day signs in as Board 1 and does its work.
 *
 * Drivers still exist beside this, on their own screen, and still record who
 * actually drove — which is the point of keeping both. What changed is what a
 * job is filed under.
 *
 * **The login column is the whole screen.** `current_board_id()` matches
 * `boards.user_id` to the caller, so a board with no login is a round that
 * nobody can work: the account signs in and sees an empty application, which
 * reads as a broken app rather than as a missing link. That failure has shipped
 * here once already with an unlinked driver, so the state is called out rather
 * than left as a blank cell.
 */
type Search = { q?: string; status?: string; link?: string };
const FILTER_KEYS = ["q", "status", "link"] as const;

export default async function BoardsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("fleet.read");
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Boards"
        description="The delivery rounds. Jobs are assigned to a board, and whoever is running that board today signs in as it."
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={4} />}>
        <BoardList params={params} canWrite={can(session.role, "fleet.write")} />
      </Suspense>

      {can(session.role, "fleet.write") ? (
        <Suspense fallback={null}>
          <NewBoardForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function BoardList({ params, canWrite }: { params: Search; canWrite: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("boards")
    .select("id, code, name, user_id, depot_id, default_vehicle_id, notes, status")
    .is("deleted_at", null)
    .order("code")
    .returns<Board[]>();

  const all = data ?? [];
  // Every board, not the filtered view: a login is taken whether or not the
  // board holding it is on screen, and the warning below is about the laundry
  // rather than about what somebody has narrowed to.
  const linkable = canWrite ? await linkableMembers(all) : [];
  const unlinked = all.filter((board) => !board.user_id && board.status === "active").length;

  const matches = (row: Board, override: Partial<Search> = {}) => {
    const f = { ...params, ...override };
    const term = f.q?.trim().toLowerCase();
    if (term && !`${row.name} ${row.code}`.toLowerCase().includes(term)) return false;
    if (f.status && row.status !== f.status) return false;
    if (f.link === "unlinked" && row.user_id) return false;
    if (f.link === "linked" && !row.user_id) return false;
    return true;
  };
  const boards = all.filter((row) => matches(row));
  const filtered = isFiltered(params, FILTER_KEYS);
  const countWith = (override: Partial<Search>) =>
    all.filter((row) => matches(row, override)).length;

  return (
    <div className="space-y-3">
      {unlinked > 0 ? (
        <Notice tone="warning" title={`${counted(unlinked, "delivery round")} ${unlinked === 1 ? "has" : "have"} no login yet`}>
          Nobody can work a round without one: the account would sign in and see nothing.
          {linkable.length === 0
            ? " Invite somebody on the People screen first, then link them here."
            : " Link a login in the table below."}
        </Notice>
      ) : null}

      {/* Only worth a bar once there are enough rounds to hunt through. Four
          chips over four boards is more furniture than filter. */}
      {all.length > 4 ? (
        <ListControls
          action="/boards"
          q={params.q}
          params={params}
          filterKeys={FILTER_KEYS}
          placeholder="Board name or code…"
          chips={
            <FilterChips
              basePath="/boards" params={params} name="link" label="Board login"
              allLabel="All boards" allCount={countWith({ link: undefined, status: undefined })}
              options={[
                { value: "unlinked", label: "No login yet", count: countWith({ link: "unlinked" }),
                  title: "Nobody can work these rounds — the account signs in and sees nothing" },
                { value: "linked", label: "Has a login", count: countWith({ link: "linked" }) },
              ]}
            />
          }
          filters={[{
            name: "status", label: "Status", value: params.status,
            options: [
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ],
          }]}
          summary={
            <FilterSummary basePath="/boards" shown={boards.length} total={all.length}
                           noun="board" filtered={filtered} />
          }
        />
      ) : null}

      <DataTable
        rows={boards}
        empty={filtered
          ? <EmptyState title="No boards match those filters"
                        description="Try a broader search, or clear the filters above." />
          : <EmptyState
            title="No boards yet"
            description="Create one board per delivery round — most laundries run three or four. Jobs are assigned to a board, not to a person."
          />}
        columns={[
          {
            header: "Board",
            cell: (row) => (
              <div>
                <span className="font-medium">{row.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{row.code}</span>
              </div>
            ),
          },
          {
            header: "Login",
            cell: (row) => {
              if (row.user_id) return <Badge tone="success">Linked</Badge>;
              if (!canWrite || linkable.length === 0) {
                return <Badge tone="warning">No login</Badge>;
              }
              return (
                <form action={linkBoardLogin} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={row.id} />
                  <Select name="user_id" placeholder="Choose a login…" required
                          options={linkable.map((member) => ({
                            value: member.id, label: `${member.label} · ${member.role}`,
                          }))} />
                  <SubmitButton variant="secondary" pendingLabel="Linking…">Link</SubmitButton>
                </form>
              );
            },
          },
          { header: "Notes", cell: (row) => row.notes ?? "—", hideBelow: "lg" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
    </div>
  );
}

async function NewBoardForm() {
  const supabase = await createClient();
  const [{ data: depots }, { data: vehicles }, { data: existing }] = await Promise.all([
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
    supabase.from("vehicles").select("id, registration").is("deleted_at", null).order("registration")
      .returns<Pick<Vehicle, "id" | "registration">[]>(),
    supabase.from("boards").select("user_id").is("deleted_at", null)
      .returns<Pick<Board, "user_id">[]>(),
  ]);
  const linkable = await linkableMembers(existing ?? []);

  return (
    <Card
      title="Add a board"
      description="One per round. The code is short and typed — BOARD1, NORTH, CITY — and the name is what every screen shows."
    >
      <form action={createBoard} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Code" name="code" required hint="Short and unique, e.g. BOARD1.">
          <Input name="code" required placeholder="BOARD1" />
        </Field>
        <Field label="Board name" name="name" required>
          <Input name="name" required placeholder="Board 1" />
        </Field>
        <Field label="Depot" name="depot_id" hint="Where this round loads.">
          <Select name="depot_id" placeholder="Unassigned"
                  options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
        </Field>
        <Field label="Usual vehicle" name="default_vehicle_id"
               hint="A default for the day's run. Nothing is booked.">
          <Select name="default_vehicle_id" placeholder="None"
                  options={(vehicles ?? []).map((vehicle) => ({
                    value: vehicle.id, label: vehicle.registration,
                  }))} />
        </Field>
        <Field
          label="Login" name="user_id"
          hint="Whoever runs this board signs in with it. Without one the round cannot be worked."
        >
          <Select name="user_id" placeholder="Link later"
                  options={linkable.map((member) => ({
                    value: member.id, label: `${member.label} · ${member.role}`,
                  }))} />
        </Field>
        <Field label="Status" name="status">
          <Select name="status" defaultValue="active" options={[
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]} />
        </Field>
        <Field label="Notes" name="notes" className="sm:col-span-2 lg:col-span-3">
          <Textarea name="notes" rows={2} placeholder="Which suburbs this round covers, and anything the office should remember." />
        </Field>
        <div className="flex items-end lg:col-span-3">
          <SubmitButton>Add board</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

/**
 * The laundry's people who are not already operating a board.
 *
 * Deliberately **not** filtered to the `board` role, for the same reason the
 * driver picker is not filtered to `driver`: a laundry whose owner runs a round
 * at the weekend is ordinary, and refusing to link them would leave the app
 * insisting they cannot drive while they are out driving. Roles decide what
 * somebody may *do*; this link decides *which round they are*.
 *
 * Platform administrators are out, like everywhere else people are picked from.
 */
async function linkableMembers(boards: readonly Pick<Board, "user_id">[]): Promise<Member[]> {
  const taken = new Set(boards.map((board) => board.user_id).filter(Boolean) as string[]);
  return staffMembers(await listMembers()).filter((member) => !taken.has(member.id));
}
