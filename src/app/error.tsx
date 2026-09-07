"use client";

import { TriangleAlert } from "lucide-react";
import { BoundaryScreen, SupportReference } from "@/components/boundary-screen";
import { Button, ButtonLink } from "@/components/ui";

/**
 * The boundary for everything outside the application shell: the landing page,
 * `/login`, `/auth/*`, `/offline` and `/design-preview`.
 *
 * It also catches a failure in `(app)/layout.tsx` itself — resolving the
 * session, the rail's counts, the bell — because a segment's own `error.tsx`
 * never catches its own layout. That is why this one is standalone rather than
 * shell-shaped: when it renders, there may be no shell to render inside.
 *
 * `reset()` re-renders the segment. It is worth offering because most of what
 * reaches here is transient — a dropped database connection, a request that
 * timed out — and pressing it costs nothing when it is not.
 */
export default function RootError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <BoundaryScreen
      standalone
      tone="danger"
      icon={<TriangleAlert className="size-6" />}
      title="Something went wrong"
      description={
        "This screen could not be loaded. Nothing you had already saved is affected — "
        + "the failure was in showing the page, not in recording your work."
      }
      actions={
        <>
          <Button type="button" size="lg" onClick={reset}>Try again</Button>
          <ButtonLink href="/dashboard" size="lg">Go to today</ButtonLink>
        </>
      }
      footer={<SupportReference digest={error.digest} />}
    />
  );
}
