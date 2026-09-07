"use client";

import { TriangleAlert } from "lucide-react";
import { BoundaryScreen, SupportReference } from "@/components/boundary-screen";
import { Button, ButtonLink } from "@/components/ui";

/**
 * The boundary for every signed-in screen.
 *
 * It exists separately from the root one for a single reason worth the file: a
 * boundary renders inside the layouts *above* it, so this one keeps the rail,
 * the header, the search field and the bell. A person whose customer page threw
 * is still standing in the application and can click somewhere else, rather than
 * being dropped onto a bare page whose only way out is a link.
 *
 * It does not catch a failure in `(app)/layout.tsx` itself — the shell it would
 * render inside is the thing that broke — and those fall through to
 * `src/app/error.tsx`, which draws the same screen standalone.
 */
export default function AppError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <BoundaryScreen
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
