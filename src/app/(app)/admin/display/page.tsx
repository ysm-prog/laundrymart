import { requireCapability } from "@/lib/auth/context";
import { advancedDestinations, navigationFor } from "@/lib/nav";
import { UI_MODES, UI_MODE_LABELS, UI_MODE_SUMMARY } from "@/lib/ui-mode";
import { Card, Eyebrow, Notice, PageHeader } from "@/components/ui";
import { FormActions, RadioCards, SubmitButton } from "@/components/form";
import { saveDisplayMode } from "./actions";

export const metadata = { title: "What you see · LaundryMart" };

/**
 * Simple mode (roadmap D2), stored in the `tenants.settings` jsonb column.
 *
 * The screen's whole job is to make the trade honest before it is made. It
 * therefore does two things a settings toggle usually does not: it names every
 * screen the short menu leaves out — read from the navigation map itself, so the
 * list cannot drift from the code — and it says plainly that none of them are
 * switched off. Simple mode shortens a menu. It is not a second, quieter
 * permission system sitting beside the roles.
 */
export default async function DisplaySettingsPage() {
  const session = await requireCapability("admin.write");
  const hidden = advancedDestinations();

  // What this person's own menu becomes. Counted rather than asserted, because
  // it depends on their role as much as on the mode.
  const rows = (mode: "simple" | "full") => navigationFor(session.role, mode).length;

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="What you see"
        description="How much of the app appears in the menu. This is set for the whole business, not per person."
      />

      <form action={saveDisplayMode} className="space-y-4">
        <Card
          title="The menu"
          description={`Yours has ${rows(session.uiMode)} rows in it today.`}
        >
          <RadioCards
            name="ui_mode"
            defaultValue={session.uiMode}
            options={UI_MODES.map((mode) => ({
              value: mode,
              label: UI_MODE_LABELS[mode],
              description: `${UI_MODE_SUMMARY[mode]} (${rows(mode)} rows for you.)`,
            }))}
          />
        </Card>

        <Card
          title="What the short menu leaves out"
          description="Every one of these still works. They stop appearing in the menu — nothing else changes."
        >
          <dl className="divide-y">
            {hidden.map(({ area, item }) => (
              <div key={item.href}
                   className="grid gap-0.5 py-2 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
                <dt>
                  <span className="block text-[13px] font-medium">{item.label}</span>
                  <Eyebrow>in {area}</Eyebrow>
                </dt>
                <dd className="text-xs text-muted-foreground">{item.blurb}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4">
            <Notice tone="info" title="Hidden is not switched off">
              Who can open what is decided by each person&rsquo;s role, on the People
              screen, and this setting does not touch it. A screen missing from the
              short menu still opens from a link, a bookmark or a saved address, and
              still checks the same role it always did. The plant screen keeps
              recording batches, the reports keep counting, and the activity log keeps
              its record whether or not either is in your menu.
            </Notice>
          </div>
        </Card>

        <FormActions>
          <SubmitButton>Save</SubmitButton>
        </FormActions>
      </form>
    </>
  );
}
