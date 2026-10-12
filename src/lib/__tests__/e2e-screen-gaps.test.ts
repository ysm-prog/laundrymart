// Source-level guards for the 12 October end-to-end screen fixes. These live in
// async server components and client components that reach Supabase or
// `next/headers`, which vitest cannot import — the `one-door.test.ts` pattern.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_EVENTS, NOTIFICATION_KINDS, audienceWords, AUDIENCE_WORDS } from "@/lib/notifications/kinds";
import { ROLE_SUMMARY } from "@/lib/roles";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("12 October screen gaps", () => {
  it("the toast sits at the top, never over the bottom-right action column", () => {
    const toast = read("components/flash-toast.tsx");
    expect(toast).toMatch(/top-\[4\.5rem\]/);
    expect(toast).not.toMatch(/bottom-3|bottom-5/);
  });

  it("Mark Delivered returns to the job's own board", () => {
    expect(read("app/(app)/my-runs/jobs/[id]/page.tsx")).toMatch(/&board=\$\{job\.assigned_board_id\}/);
  });

  it("My Runs names the board rather than 'you' on somebody else's day", () => {
    expect(read("app/(app)/my-runs/page.tsx")).toMatch(/assignee=\{isSelf \? "you" : boardName\}/);
  });

  it("global search looks up laundry jobs by number and by customer", () => {
    const search = read("app/(app)/search/page.tsx");
    expect(search).toMatch(/from\("laundry_orders"\)[\s\S]*ilike\("order_number"/);
    expect(search).toMatch(/ilike\("customers\.business_name"/);
  });

  it("the daily operations report counts laundry jobs, labelled as such", () => {
    const reports = read("app/(app)/reports/page.tsx");
    expect(reports).toMatch(/from\("laundry_orders"\)/);
    expect(reports).toMatch(/Laundry jobs taken in/);
    expect(reports).not.toMatch(/<Stat label="Jobs"/);
  });

  it("the job form summarises every row, not the first", () => {
    expect(read("app/(app)/orders/job-form.tsx")).toMatch(/summariseItems\(rows\.map/);
  });

  it("notifications are described in words, and the retired inspection alert is not offered", () => {
    for (const kind of NOTIFICATION_KINDS) {
      if (NOTIFICATION_EVENTS[kind].retired) continue;
      expect(AUDIENCE_WORDS[NOTIFICATION_EVENTS[kind].audience]).toBeTruthy();
      expect(audienceWords(NOTIFICATION_EVENTS[kind].audience)).not.toMatch(/\./);
    }
    expect(NOTIFICATION_EVENTS.inspection_failed.retired).toBe(true);
    expect(read("app/(app)/admin/notifications/page.tsx")).not.toMatch(/audience\.replace/);
  });

  it("customer service is no longer described as not taking jobs in", () => {
    expect(ROLE_SUMMARY.customer_service).not.toMatch(/not taking jobs in/);
  });

  it("the customer page does not claim jobs are priced by hand without a rate card", () => {
    expect(read("app/(app)/customers/[id]/billing-section.tsx")).not.toMatch(/priced by hand/);
    expect(read("app/(app)/customers/[id]/page.tsx")).not.toMatch(/derive from the agreement/);
  });

  it("the Owner's settings writes go through save_tenant_settings, not an UPDATE that writes nothing", () => {
    const notifications = read("app/(app)/admin/notifications/actions.ts");
    expect(notifications).toMatch(/rpc\("save_tenant_settings"/);
    expect(notifications).not.toMatch(/from\("tenants"\)\s*\.update/);
  });
});
