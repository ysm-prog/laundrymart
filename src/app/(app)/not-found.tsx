import { FileQuestion } from "lucide-react";
import { BoundaryScreen } from "@/components/boundary-screen";
import { ButtonLink } from "@/components/ui";

export const metadata = { title: "Not found" };

/**
 * What the eighteen `notFound()` calls inside the shell land on — a customer, a
 * job, an invoice, an item, a run — instead of Next's bare default page. It
 * renders inside `(app)/layout.tsx`, so the rail and the header stay put and the
 * next thing to try is one click away.
 *
 * **It says the record does not exist, and stops there.** Most of these calls
 * cannot tell "no such row" from "a row RLS will not show you", and the ones
 * that can have deliberately chosen this answer anyway — see
 * `my-runs/jobs/[id]/page.tsx`, where the reasoning is written down: *"a 404
 * tells an attacker nothing a 403 would not."* So the copy must not soften into
 * "or you may not have permission", which would confirm to anyone probing an id
 * that something is there. A genuine permission refusal is a different screen
 * with different words: `requireCapability()` redirects to
 * `/dashboard?error=forbidden`, which says "You do not have access to that area."
 */
export default function AppNotFound() {
  return (
    <BoundaryScreen
      icon={<FileQuestion className="size-6" />}
      title="That record does not exist"
      description={
        "Nothing in this laundry matches that address. It may have been deleted or hidden "
        + "since the link was made — either way, there is nothing here to open."
      }
      actions={<ButtonLink href="/dashboard" size="lg" variant="primary">Go to today</ButtonLink>}
    />
  );
}
