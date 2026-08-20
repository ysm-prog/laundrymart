"use client";

import { useEffect, useRef, useState } from "react";
import { Building2, ChevronDown, LogOut } from "lucide-react";
import { signOut } from "@/app/login/actions";
import { switchTenant } from "@/app/(app)/platform/actions";
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
  email, role, initials, tenantName, tenants = [],
}: {
  email: string; role: string; initials: string;
  /** The laundry currently being looked at. */
  tenantName?: string;
  /**
   * The laundries this person can switch between. Empty or single means the
   * question does not arise, and the switcher is not rendered at all — which is
   * everybody except a platform admin and the handful of people who hold a
   * membership in more than one laundry.
   */
  tenants?: ReadonlyArray<{ id: string; name: string }>;
}) {
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
            {tenantName ? (
              <p className="mt-1 truncate text-xs font-medium">{tenantName}</p>
            ) : null}
          </div>

          {tenants.length > 1 ? (
            <div className="border-b p-1.5">
              <p className="px-2.5 py-1 text-xs text-muted-foreground">Look at</p>
              {tenants.map((tenant) => (
                <form key={tenant.id} action={switchTenant}>
                  <input type="hidden" name="tenant_id" value={tenant.id} />
                  <button type="submit" role="menuitem"
                          aria-current={tenant.name === tenantName ? "true" : undefined}
                          className={cx(
                            "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left",
                            "text-sm transition hover:bg-surface-muted",
                            tenant.name === tenantName && "font-semibold",
                          )}>
                    <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{tenant.name}</span>
                  </button>
                </form>
              ))}
            </div>
          ) : null}

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
