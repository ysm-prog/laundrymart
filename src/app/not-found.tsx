import { FileQuestion } from "lucide-react";
import { BoundaryScreen } from "@/components/boundary-screen";
import { ButtonLink } from "@/components/ui";

export const metadata = { title: "Page not found" };

/**
 * The answer to a URL that matches no route at all, at any depth. Next resolves
 * an unmatched address against the root, so this is the one that renders — and
 * it renders without the shell, because there is no segment to have drawn one.
 *
 * A Server Component: there is nothing to reset and no state to hold.
 *
 * **It says the page does not exist, and stops there.** It deliberately does not
 * hedge with "or you may not have permission to see it": a signed-in person who
 * lacks a capability is redirected to `/dashboard?error=forbidden` and told so
 * plainly, which is a different answer to a different question. Blurring the two
 * would mean every 404 in the product quietly confirmed that the thing behind
 * the address might be real.
 */
export default function RootNotFound() {
  return (
    <BoundaryScreen
      standalone
      icon={<FileQuestion className="size-6" />}
      title="That page does not exist"
      description={
        "The address you followed matches nothing in Electro Services. It may have been "
        + "mistyped, or the screen may have moved since the link was made."
      }
      actions={<ButtonLink href="/dashboard" size="lg" variant="primary">Go to today</ButtonLink>}
    />
  );
}
