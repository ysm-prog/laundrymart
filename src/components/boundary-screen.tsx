import type { ReactNode } from "react";
import { cx } from "./ui";

/**
 * The screen a route boundary draws — `error.tsx` and `not-found.tsx`, at the
 * root and inside the application shell.
 *
 * Presentational only, and deliberately so: the four boundaries differ in their
 * words and their one action, never in their markup, so the markup lives here
 * once. Shaped after `/offline`, which is the app's existing answer to "a whole
 * screen that is not a screen of data" — a circled icon, a heading, one short
 * paragraph, the way out.
 *
 * It carries no `"use client"` of its own. `error.tsx` must be a Client
 * Component and pulls this into the client bundle with it; `not-found.tsx`
 * stays a Server Component and renders it on the server. Nothing in here reads
 * a cookie, a session or the database, so it works either way.
 *
 * `standalone` is the whole difference between the two levels. Inside `(app)`
 * the boundary renders within `AppShell`'s own `<main id="main">`, which already
 * owns the page padding and the skip-link target; at the root there is no shell,
 * so this supplies both.
 */
export function BoundaryScreen({
  icon, title, description, actions, footer, tone = "neutral", standalone = false,
}: {
  /** A Lucide element, sized by the caller. */
  icon: ReactNode;
  title: string;
  description: ReactNode;
  /** Buttons and links. `Try again` first where there is one. */
  actions?: ReactNode;
  /** Small print under the actions — the support reference, where there is one. */
  footer?: ReactNode;
  /** `danger` for a failure, `neutral` for a record that is simply not there. */
  tone?: "neutral" | "danger";
  /** True when nothing above this is drawing the page shell. */
  standalone?: boolean;
}) {
  const body = (
    <div className={cx(
      "mx-auto flex max-w-md flex-col text-center",
      standalone ? "min-h-screen justify-center px-6 py-16" : "px-4 py-12 sm:py-20",
    )}>
      <span aria-hidden
            className={cx(
              "mx-auto flex size-14 items-center justify-center rounded-full",
              tone === "danger"
                ? "bg-danger/10 text-danger"
                : "bg-surface-sunken text-muted-foreground",
            )}>
        {icon}
      </span>
      <h1 className="mt-5 text-2xl font-semibold">{title}</h1>
      <div className="mx-auto mt-2 max-w-sm text-[0.9375rem] leading-relaxed text-muted-foreground">
        {description}
      </div>
      {actions ? (
        <div className="mt-7 flex flex-wrap justify-center gap-3">{actions}</div>
      ) : null}
      {footer ? <div className="mt-10">{footer}</div> : null}
    </div>
  );

  return standalone ? <main id="main">{body}</main> : body;
}

/**
 * The one line an error boundary is allowed to say about the error itself.
 *
 * **The error is never rendered — not its message, not its stack.** A server
 * error's message can carry a connection string, a row a customer should not
 * see or the shape of a query, and none of it is anything the person reading
 * the screen can act on. Next hashes the real error into `digest` and logs the
 * original on the server, so the digest is the whole of what belongs here: the
 * thing to quote when reporting it.
 *
 * A digest is issued only for an error thrown on the server. When one is thrown
 * in the browser there is nothing to quote, and this says that rather than
 * printing a blank reference or inventing one.
 */
export function SupportReference({ digest }: { digest?: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {digest ? (
        <>
          {"Quote support reference "}
          <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-foreground">
            {digest}
          </span>
          {" if you report this."}
        </>
      ) : (
        "This one has no support reference: it happened in the browser rather than on the server."
      )}
    </p>
  );
}
