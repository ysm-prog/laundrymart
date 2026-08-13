"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { signOut } from "@/app/login/actions";
import { cx } from "./ui";

/**
 * The account menu in the header.
 *
 * Identity lives in exactly one place. It used to sit in the sidebar footer,
 * which meant it disappeared entirely on a phone (where the rail is a drawer
 * you have to open) and again on a collapsed desktop rail. In the header it is
 * reachable at every width.
 *
 * `signOut` is a server action imported straight into this client component, so
 * the menu is still a real form post and works with JavaScript disabled once
 * open.
 */
export function UserMenu({
  email, role, initials,
}: { email: string; role: string; initials: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((value) => !value)}
              aria-expanded={open} aria-haspopup="menu"
              className={cx(
                "flex min-h-10 items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 transition",
                "hover:bg-surface-muted",
                open && "bg-surface-muted",
              )}>
        <span aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full
                         bg-primary/12 text-xs font-semibold text-primary">
          {initials}
        </span>
        <ChevronDown className="hidden size-4 text-muted-foreground sm:block" aria-hidden />
        <span className="sr-only">Account menu for {email}</span>
      </button>

      {open ? (
        <div role="menu"
             className="absolute right-0 top-full z-50 mt-1.5 w-64 animate-slide-up overflow-hidden
                        rounded-xl border bg-surface shadow-lg">
          <div className="border-b px-4 py-3">
            <p className="truncate text-sm font-semibold">{email}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{role}</p>
          </div>
          <form action={signOut} className="p-1.5">
            <button type="submit" role="menuitem"
                    className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm
                               font-medium transition hover:bg-surface-muted">
              <LogOut className="size-4 text-muted-foreground" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
