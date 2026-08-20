"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "./ui";

/**
 * The app's one overlay.
 *
 * A centred dialog from `sm` up; a bottom sheet on a phone, because a desktop
 * modal squeezed onto a 375px screen puts its actions somewhere between the
 * keyboard and the fold. Both are the same component and the same markup — only
 * the position and the entry animation differ.
 *
 * Focus moves in on open, is trapped while it is up, and returns to whatever
 * opened it on close. Escape and a click on the scrim both dismiss.
 *
 * This is deliberately *not* the confirm affordance: destructive confirmation
 * stays inline (`ConfirmSubmit`) so the consequence sits beside the control.
 * Use this for a genuine detour — a picker, a form that is not the page.
 */
export function Overlay({
  open, onClose, title, description, children, footer, size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    returnFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    // The page behind must not scroll under the sheet.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
        'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const sizes = { sm: "sm:max-w-md", md: "sm:max-w-xl", lg: "sm:max-w-3xl" } as const;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" tabIndex={-1} aria-hidden onClick={onClose}
              className="absolute inset-0 animate-fade-in bg-foreground/40 backdrop-blur-[2px]" />
      {/* The dialog role belongs on the panel, not on the full-screen wrapper —
          otherwise the scrim counts as dialog content. */}
      <div ref={panelRef}
           role="dialog" aria-modal="true" aria-labelledby={titleId}
           className={cx(
             "relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface",
             "shadow-2xl animate-sheet-up sm:rounded-2xl sm:animate-slide-up",
             sizes[size],
           )}>
        {/* The grab handle reads as "this sheet moves" on a phone. */}
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-strong sm:hidden" />
        <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button ref={closeRef} type="button" onClick={onClose}
                  className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-lg
                             text-muted-foreground transition hover:bg-surface-muted">
            <X className="size-[1.15rem]" aria-hidden />
            <span className="sr-only">Close</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap items-center gap-3 border-t bg-surface-muted/50 px-5 py-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
