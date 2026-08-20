import Link from "next/link";
import type { ReactNode } from "react";
import {
  Check, ChevronLeft, CircleCheck, CircleX, Inbox, Info, TriangleAlert,
} from "lucide-react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ layout */

/**
 * The supporting-label voice: a small, sentence-case, muted line above or
 * beside the thing it names.
 *
 * It used to be 9px mono uppercase with wide tracking, which is what made the
 * app read as a developer console — and at 9px it was genuinely hard to read on
 * a counter tablet. Same component, same call sites, ordinary language now.
 */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("text-2xs font-medium text-muted-foreground", className)}>
      {children}
    </span>
  );
}

/**
 * The page shell. Caps the content width so a form does not stretch to 1900px
 * on a desk monitor, while lists and boards can opt out with `wide`.
 */
export function PageContainer({
  children, width = "default", className,
}: {
  children: ReactNode;
  /** `form` ≈ 1040px for entry screens, `default` ≈ 1280px, `wide` is unbounded. */
  width?: "form" | "default" | "wide";
  className?: string;
}) {
  const widths = {
    form: "max-w-[68rem]",
    default: "max-w-[84rem]",
    wide: "max-w-none",
  } as const;
  return <div className={cx("mx-auto w-full", widths[width], className)}>{children}</div>;
}

/**
 * Every major screen opens the same way: what this is, one line on what it is
 * for, and the action you most likely came to take.
 */
export function PageHeader({
  title, description, actions, eyebrow, back,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
  /** A "back to the list" affordance on detail and edit screens. */
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-6">
      {back ? (
        <Link href={back.href}
              className="mb-2 inline-flex min-h-9 items-center gap-1 text-sm font-medium
                         text-muted-foreground transition hover:text-foreground">
          <ChevronLeft className="size-4" aria-hidden />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? <div className="mb-1"><Eyebrow>{eyebrow}</Eyebrow></div> : null}
          <h1 className="text-2xl font-semibold sm:text-[1.75rem] sm:leading-tight">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

export function Card({
  title, description, actions, children, className, bodyClassName, icon,
}: {
  title?: string; description?: string; actions?: ReactNode;
  children: ReactNode; className?: string;
  /** Drop the default padding — for a card whose body is a full-bleed table. */
  bodyClassName?: string;
  icon?: ReactNode;
}) {
  return (
    /* `overflow-hidden` so a full-bleed body — a table, or a divided list in a
       card whose padding has been dropped — is clipped to the card's radius
       instead of poking square corners through it. Safe here because the one
       popover in the app (the customer picker) lives in a `FormSection`, which
       deliberately does not clip. */
    <section className={cx("overflow-hidden rounded-xl border bg-surface shadow-sm", className)}>
      {title || actions ? (
        <header className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2.5">
            {icon ? <span className="mt-0.5 text-muted-foreground" aria-hidden>{icon}</span> : null}
            <div className="min-w-0">
              {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
              {description ? (
                <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
              ) : null}
            </div>
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div className={bodyClassName ?? "p-5"}>{children}</div>
    </section>
  );
}

/**
 * A titled group of fields inside a long form.
 *
 * Breaking an entry screen into named sections — Customer, Order received,
 * Laundry, Delivery — is what turns one intimidating wall of inputs into a
 * short sequence of obvious questions.
 */
export function FormSection({
  title, description, children, actions, icon,
}: {
  title: string; description?: string; children: ReactNode;
  actions?: ReactNode; icon?: ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-surface shadow-sm">
      <header className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          {icon ? <span className="mt-0.5 text-primary" aria-hidden>{icon}</span> : null}
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex items-center gap-2 sm:shrink-0">{actions}</div> : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/**
 * A KPI cell. The number carries the fact and the hint underneath carries the
 * judgement — so `tone` colours the *hint*, and only colours the number when
 * the number itself is the exception (late, overdue).
 */
export function Stat({
  label, value, hint, tone = "default", href, icon,
}: {
  label: string; value: ReactNode; hint?: string;
  tone?: "default" | "success" | "warning" | "danger"; href?: string;
  icon?: ReactNode;
}) {
  const tones = {
    default: "text-muted-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  } as const;

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        {icon ? <span className="text-muted-foreground" aria-hidden>{icon}</span> : null}
      </div>
      <div className={cx(
        "mt-1.5 text-[1.75rem] font-semibold leading-none tabular-nums tracking-[-0.02em]",
        tone === "danger" && "text-danger",
      )}>
        {value}
      </div>
      {hint ? <div className={cx("mt-1.5 text-xs", tones[tone])}>{hint}</div> : null}
    </>
  );

  const className = cx(
    "block rounded-xl border bg-surface px-4 py-4 shadow-sm transition",
    href && "hover:border-strong hover:shadow-md",
  );
  return href
    ? <Link href={href} className={className}>{body}</Link>
    : <div className={className}>{body}</div>;
}

/**
 * One step of a guided sequence — the run screen's stage pattern, and the
 * app-wide guidance idiom. Render inside an <ol>; keep exactly one step
 * actionable at a time.
 */
export function Stage({
  index, label, detail, done, children,
}: {
  index: number; label: string; detail: string; done: boolean; children?: ReactNode;
}) {
  return (
    <li className={cx(
      "rounded-xl border p-4 transition",
      done ? "border-success/30 bg-success/5" : "bg-surface",
    )}>
      <div className="flex items-start gap-3">
        <span aria-hidden
              className={cx(
                "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                done ? "bg-success text-on-status" : "bg-surface-sunken text-muted-foreground",
              )}>
          {done ? <Check className="size-4" strokeWidth={3} /> : index}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{label}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
    </li>
  );
}

export function EmptyState({
  title, description, action, icon,
}: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed bg-surface px-6 py-12 text-center">
      <span aria-hidden
            className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full
                       bg-surface-sunken text-muted-foreground">
        {icon ?? <Inbox className="size-5" />}
      </span>
      <p className="text-base font-semibold">{title}</p>
      {description ? (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ status */

/* Soft-tinted pills. Every badge carries its label in words, so colour is
   reinforcement and never the only signal (WCAG 1.4.1). */
const BADGE_TONES = {
  neutral: "border-strong/60 bg-surface-muted text-muted-foreground",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-danger/25 bg-danger/10 text-danger",
  info: "border-info/25 bg-info/10 text-info",
  primary: "border-primary/25 bg-primary/10 text-primary",
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className={cx(
      "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5",
      "text-xs font-medium",
      BADGE_TONES[tone],
    )}>
      {children}
    </span>
  );
}

/** Status vocabularies are shared across modules so a colour always means one thing. */
const STATUS_TONES: Record<string, BadgeTone> = {
  active: "success", issued: "info", paid: "success", completed: "success",
  closed: "success", pass: "success", in_progress: "primary", assigned: "primary",
  travelling: "primary", at_customer: "primary", draft: "neutral", planned: "neutral",
  scheduled: "neutral", not_started: "neutral", inactive: "neutral", archived: "neutral",
  // Laundry jobs: "new" is colourless because a job just taken in is not yet a
  // status anyone acts on, and the two delivery states are on-track blues rather
  // than warnings — nothing is wrong with a job that is out on a van.
  new: "neutral", ready_for_delivery: "info", out_for_delivery: "primary",
  prospect: "info", on_hold: "warning", due: "warning", part_paid: "warning",
  pending: "warning", inspection_pending: "warning", returning: "warning",
  unloading: "warning", pass_with_defects: "warning", overdue: "danger",
  exception: "danger", cancelled: "danger", void: "danger", fail: "danger",
  overdue_service: "danger", out_of_service: "danger", suspended: "danger",
  terminated: "danger", expired: "neutral",
};

export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>—</Badge>;
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{humanise(status)}</Badge>;
}

/* ------------------------------------------------------------------ actions */

/*
 * The button system.
 *
 * `primary` is the brand blue and marks the one action a screen is for.
 * `secondary` is the outlined companion (Edit, Cancel, Back). `danger` is
 * destructive. `ghost` and `subtle` are for lightweight, repeated actions in
 * toolbars and table rows.
 */
const BUTTON_VARIANTS = {
  primary: "bg-action text-action-foreground shadow-xs hover:brightness-110 active:brightness-95",
  secondary: "border border-strong bg-surface text-foreground shadow-xs hover:bg-surface-muted",
  danger: "bg-danger text-on-status shadow-xs hover:brightness-110 active:brightness-95",
  ghost: "text-primary hover:bg-primary/8",
  subtle: "bg-surface-muted text-foreground hover:bg-surface-sunken",
} as const;

/* 40px standard, 44px for the touch-first `lg`. Nothing tappable goes below
   36px — a control a thumb misses on a loading dock is a defect, not density. */
const BUTTON_SIZES = {
  sm: "min-h-9 gap-1.5 px-3 text-xs",
  md: "min-h-10 gap-2 px-4 text-sm",
  lg: "min-h-11 gap-2 px-5 text-sm",
} as const;

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded-lg font-medium transition " +
  "disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0";

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

/**
 * The one entry-field skin: 44px tall, softly rounded, on a white fill with a
 * visible focus ring.
 *
 * Lives here rather than in `form.tsx` so the server-rendered filter bar and
 * the client form controls cannot drift apart — they did, and the filter bar
 * spent three releases in a different size and border than every other input.
 */
export const CONTROL =
  "min-h-11 w-full rounded-lg border border-strong bg-surface px-3 py-2 text-sm text-foreground " +
  "shadow-xs transition placeholder:text-muted-foreground " +
  "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25 " +
  "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-70";

/**
 * A chevron drawn as a background image, so a native <select> keeps its native
 * picker — the right control on a phone and on a tablet — while still matching
 * the other inputs.
 *
 * Lives here beside `CONTROL` rather than in `form.tsx` because server
 * components (the filter bar, several list pages) need it too, and a plain
 * string exported from a `"use client"` module reaches a server component as a
 * client reference rather than as its value.
 */
export const SELECT_CHEVRON =
  "appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22" +
  "%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%236b7280%22%20stroke-width%3D%222%22" +
  "%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22/%3E%3C/svg%3E')] " +
  "bg-[length:1.15rem] bg-[right_0.65rem_center] bg-no-repeat pr-10";

export function ButtonLink({
  href, children, variant = "secondary", size = "md", className,
}: {
  href: string; children: ReactNode; variant?: ButtonVariant;
  size?: ButtonSize; className?: string;
}) {
  return (
    <Link href={href} className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}>
      {children}
    </Link>
  );
}

export function Button({
  children, variant = "primary", type = "submit", name, value, disabled,
  size = "md", className, onClick,
}: {
  children: ReactNode; variant?: ButtonVariant;
  type?: "submit" | "button"; name?: string; value?: string; disabled?: boolean;
  size?: ButtonSize; className?: string;
  /**
   * Only meaningful from a client component — most buttons here submit a form
   * to a server action and need no handler at all.
   */
  onClick?: () => void;
}) {
  return (
    <button type={type} name={name} value={value} disabled={disabled} onClick={onClick}
            className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}>
      {children}
    </button>
  );
}

/** An icon-only control. `label` is required — it is the accessible name. */
export function IconButton({
  children, label, href, onClick, variant = "ghost", type = "button",
}: {
  children: ReactNode; label: string; href?: string;
  onClick?: () => void; variant?: ButtonVariant; type?: "submit" | "button";
}) {
  const className = cx(
    BUTTON_BASE, "size-10 shrink-0 p-0", BUTTON_VARIANTS[variant],
  );
  if (href) {
    return (
      <Link href={href} className={className} title={label} aria-label={label}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} className={className} title={label} aria-label={label}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- table */

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  /** Hide on smaller screens when the column is secondary detail. */
  hideBelow?: "sm" | "md" | "lg";
  align?: "left" | "right";
};

/**
 * The app's one table.
 *
 * Below `sm` it is not a table at all: each row becomes a card with every
 * column labelled. A grid of eight columns in a sideways-scrolling box on a
 * phone technically "adapts", but the operator has to discover the scroll and
 * then hold the header row in their head — so on a phone the columns stack and
 * nothing is hidden. Above `sm` it is the real table: soft row dividers rather
 * than a box round every cell, comfortable row height, and a hover state.
 * The scroll box is focusable so a keyboard user can reach a wide one (WCAG 2.1.1).
 */
export function DataTable<T>({
  rows, columns, empty, rowHref, rowClassName, label = "Results", stickyHeader = false,
  bare = false,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  empty: ReactNode;
  rowHref?: (row: T) => string;
  /** Per-row decoration — in practice the leading status rule marking urgency. */
  rowClassName?: (row: T) => string;
  /** Names the scrollable region for screen readers and keyboard users. */
  label?: string;
  /**
   * Pins the header while the rows scroll. Only meaningful for a long table:
   * it caps the body height, which is what gives the header something to stick
   * to. Off by default so short tables are not put in a box of their own.
   */
  stickyHeader?: boolean;
  /**
   * Drop the table's own frame, for a table that fills a `Card` which has
   * already drawn one. Without it the two rounded borders sit a pixel apart —
   * the doubled-hairline defect this design system has produced once before.
   * On a phone the row cards become plain divided rows for the same reason.
   */
  bare?: boolean;
}) {
  if (!rows.length) return <>{empty}</>;

  const hide = {
    sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell",
  } as const;
  const [first, ...rest] = columns;

  return (
    <>
      {/* Phone: one card per row, every column labelled. */}
      <ul className={cx("sm:hidden", bare ? "divide-y" : "space-y-3")}>
        {rows.map((row, index) => {
          const href = rowHref?.(row);
          const heading = first ? first.cell(row) : null;
          return (
            <li key={index}
                className={cx(
                  "overflow-hidden bg-surface",
                  bare ? "" : "rounded-xl border shadow-sm",
                  rowClassName?.(row),
                )}>
              <div className="border-b bg-surface-muted/60 px-4 py-3">
                {href ? (
                  <Link href={href} className="block min-h-6 font-semibold text-primary">
                    {heading}
                  </Link>
                ) : (
                  <span className="block font-semibold">{heading}</span>
                )}
              </div>
              <dl className="divide-y">
                {rest.filter((column) => column.header).map((column) => (
                  <div key={column.header}
                       className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                    <dt><Eyebrow>{column.header}</Eyebrow></dt>
                    <dd className="min-w-0 text-right text-sm">{column.cell(row)}</dd>
                  </div>
                ))}
                {/* Action cells carry a blank header; they get the full width. */}
                {rest.filter((column) => !column.header).map((column, columnIndex) => (
                  <div key={`action-${columnIndex}`} className="px-4 py-3">{column.cell(row)}</div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>

      <div className={cx(
             "hidden overflow-x-auto bg-surface sm:block",
             bare ? "" : "rounded-xl border shadow-sm",
             stickyHeader && "max-h-[70vh] overflow-y-auto",
           )}
           tabIndex={0} role="region" aria-label={label}>
        <table className="w-full border-collapse text-sm">
          <thead className={cx("bg-surface-muted text-left", stickyHeader && "sticky top-0 z-10")}>
            <tr>
              {columns.map((column) => (
                <th key={column.header} scope="col"
                    className={cx(
                      "whitespace-nowrap border-b px-4 py-3 text-xs font-semibold text-muted-foreground",
                      column.align === "right" && "text-right",
                      column.hideBelow && hide[column.hideBelow],
                    )}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => (
              <tr key={index}
                  className={cx("transition hover:bg-surface-muted/70", rowClassName?.(row))}>
                {columns.map((column, columnIndex) => {
                  const content = column.cell(row);
                  return (
                    <td key={column.header}
                        className={cx(
                          "px-4 py-3.5 align-middle",
                          column.align === "right" && "text-right tabular-nums",
                          column.hideBelow && hide[column.hideBelow],
                        )}>
                      {rowHref && columnIndex === 0 ? (
                        <Link href={rowHref(row)} className="font-semibold text-primary hover:underline">
                          {content}
                        </Link>
                      ) : content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ notices */

const NOTICE_ICONS = {
  info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleX,
} as const;

export function Notice({
  tone = "info", title, children,
}: { tone?: "info" | "success" | "warning" | "danger"; title?: string; children?: ReactNode }) {
  const tones = {
    info: "border-info/25 bg-info/8 text-info",
    success: "border-success/25 bg-success/8 text-success",
    warning: "border-warning/25 bg-warning/8 text-warning",
    danger: "border-danger/25 bg-danger/8 text-danger",
  } as const;
  const Icon = NOTICE_ICONS[tone];
  return (
    /* A failure interrupts; everything else waits its turn. `status` announces
       politely, which is right for "invoice emailed" and wrong for "this run
       cannot start yet" sitting above the control the user is about to press. */
    <div role={tone === "danger" ? "alert" : "status"}
         className={cx("flex gap-3 rounded-lg border px-4 py-3 text-sm", tones[tone])}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5" : undefined}>{children}</div> : null}
      </div>
    </div>
  );
}

/** Renders the `?error=` / `?ok=` messages our server actions redirect with. */
export function FlashMessages({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return (
    <div className="mb-5 space-y-3">
      {error ? <Notice tone="danger" title="Something went wrong">{error}</Notice> : null}
      {ok ? <Notice tone="success">{ok}</Notice> : null}
    </div>
  );
}

/* -------------------------------------------------------------- skeletons */

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-muted" />
      ))}
    </div>
  );
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-[104px] animate-pulse rounded-xl bg-surface-muted" />
      ))}
    </div>
  );
}
