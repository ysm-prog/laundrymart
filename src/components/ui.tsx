import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ layout */

/** Mono, uppercase, wide-tracked — the pack's label voice, used throughout. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx(
      "font-mono text-3xs uppercase tracking-[0.12em] text-muted-foreground",
      className,
    )}>
      {children}
    </span>
  );
}

export function PageHeader({
  title, description, actions, eyebrow,
}: { title: string; description?: string; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1"><Eyebrow>{eyebrow}</Eyebrow></div> : null}
        <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title, description, actions, children, className,
}: {
  title?: string; description?: string; actions?: ReactNode;
  children: ReactNode; className?: string;
}) {
  return (
    <section className={cx("border bg-surface", className)}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b px-4 py-2.5">
          <div>
            {title ? <h2 className="text-[13px] font-semibold">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * A KPI cell. The pack's rule is that the number carries the fact and the hint
 * underneath carries the judgement — so `tone` colours the *hint*, and only
 * colours the number when the number itself is the exception (late, overdue).
 */
export function Stat({
  label, value, hint, tone = "default", href, flush = false,
}: {
  label: string; value: ReactNode; hint?: string;
  tone?: "default" | "success" | "warning" | "danger"; href?: string;
  /**
   * Drop the cell's own border. The pack's KPI row is one joined strip divided
   * by hairlines, not a row of separate boxes — without this the cell border
   * and the strip's divider stack into a doubled rule.
   */
  flush?: boolean;
}) {
  const tones = {
    default: "text-muted-foreground",
    success: "text-primary",
    warning: "text-warning",
    danger: "text-danger",
  } as const;

  const body = (
    <>
      <Eyebrow>{label}</Eyebrow>
      <div className={cx(
        "mt-1 font-semibold tabular-nums tracking-[-0.02em] text-2xl",
        tone === "danger" && "text-danger",
      )}>
        {value}
      </div>
      {hint ? <div className={cx("mt-0.5 text-[11px]", tones[tone])}>{hint}</div> : null}
    </>
  );

  const className = cx(
    "block bg-surface px-4 py-3 transition",
    flush ? "" : "border hover:border-strong",
  );
  return href ? <Link href={href} className={className}>{body}</Link> : <div className={className}>{body}</div>;
}

/**
 * One step of a guided sequence — the run screen's stage pattern, promoted to
 * the app-wide guidance idiom: a numbered square that becomes a tick, a label,
 * a one-line detail, and (for the step that is live right now) its controls.
 * Render inside an <ol>; keep exactly one step actionable at a time.
 */
export function Stage({
  index, label, detail, done, children,
}: {
  index: number; label: string; detail: string; done: boolean; children?: ReactNode;
}) {
  return (
    <li className="border p-3">
      <div className="flex items-start gap-3">
        <span aria-hidden
              className={cx(
                "flex h-6 w-6 shrink-0 items-center justify-center text-xs font-semibold",
                done ? "bg-success/15 text-success" : "bg-surface-muted text-muted-foreground",
              )}>
          {done ? "✓" : index}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
    </li>
  );
}

export function EmptyState({
  title, description, action,
}: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="border border-dashed px-6 py-10 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ status */

/* Square, hairline-bordered chips. Per the pack, colour here means status and
   nothing else — so `neutral` is deliberately colourless rather than grey-blue. */
const BADGE_TONES = {
  neutral: "border-border text-muted-foreground",
  success: "border-success/40 bg-success/5 text-success",
  warning: "border-warning/40 bg-warning/5 text-warning",
  danger: "border-danger/40 bg-danger/5 text-danger",
  info: "border-info/40 bg-info/5 text-info",
  primary: "border-primary/40 bg-primary/5 text-primary",
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className={cx(
      "inline-flex items-center whitespace-nowrap border px-1.5 py-0.5",
      "font-mono text-2xs font-medium uppercase tracking-[0.06em]",
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

/* `primary` is the near-black action, not the teal accent. In this design teal
   means "on track", so a teal button would read as a status rather than a
   control — the pack is explicit that colour carries status only. */
const BUTTON_VARIANTS = {
  primary: "bg-action text-action-foreground hover:opacity-90",
  secondary: "border border-strong bg-surface hover:bg-surface-muted",
  danger: "bg-danger text-white hover:opacity-90",
  ghost: "text-primary hover:underline",
} as const;

/* `min-h-9` (36px) is the floor for anything tappable. The pack's chrome is
   small by design, but a control a thumb misses on a loading dock is not a
   design decision — it is a defect. */
const BUTTON_BASE =
  "inline-flex min-h-9 items-center justify-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium " +
  "transition disabled:pointer-events-none disabled:opacity-60";

/**
 * The one entry-field skin: flat, square, a stronger hairline than the
 * surrounding rules, on the muted fill the pack uses for inputs. Lives here
 * rather than in `form.tsx` so the server-rendered filter bar and the client
 * form controls cannot drift apart — they did, and the filter bar spent three
 * releases in a different size and a different border than every other input.
 */
export const CONTROL =
  "min-h-9 w-full border border-strong bg-surface-muted px-2.5 py-1.5 text-[12.5px] text-foreground " +
  "placeholder:text-muted-foreground disabled:opacity-60";

export function ButtonLink({
  href, children, variant = "secondary",
}: { href: string; children: ReactNode; variant?: keyof typeof BUTTON_VARIANTS }) {
  return (
    <Link href={href} className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant])}>
      {children}
    </Link>
  );
}

export function Button({
  children, variant = "primary", type = "submit", name, value, disabled,
}: {
  children: ReactNode; variant?: keyof typeof BUTTON_VARIANTS;
  type?: "submit" | "button"; name?: string; value?: string; disabled?: boolean;
}) {
  return (
    <button type={type} name={name} value={value} disabled={disabled}
            className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant])}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- table */

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  /** Hide on small screens when the column is secondary detail. */
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
 * nothing is hidden. Above `sm` it is the real table, and the scroll box is
 * focusable so a keyboard user can reach a wide one (WCAG 2.1.1).
 */
export function DataTable<T>({
  rows, columns, empty, rowHref, rowClassName, label = "Results",
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  empty: ReactNode;
  rowHref?: (row: T) => string;
  /**
   * Per-row decoration — in practice the leading status rule the dashboard
   * marks urgency with. Exposed so a screen that needs it does not have to
   * hand-roll a second table (the dashboard did, and its copy never got the
   * responsive treatment, the keyboard-reachable scroll box, or the header
   * styling this one grew).
   */
  rowClassName?: (row: T) => string;
  /** Names the scrollable region for screen readers and keyboard users. */
  label?: string;
}) {
  if (!rows.length) return <>{empty}</>;

  const hide = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" } as const;
  const [first, ...rest] = columns;

  return (
    <>
      <ul className="space-y-2 sm:hidden">
        {rows.map((row, index) => {
          const href = rowHref?.(row);
          const heading = first ? first.cell(row) : null;
          return (
            <li key={index} className={cx("border bg-surface", rowClassName?.(row))}>
              <div className="border-b px-3 py-2">
                {href ? (
                  <Link href={href} className="block min-h-6 font-medium text-primary hover:underline">
                    {heading}
                  </Link>
                ) : (
                  <span className="block font-medium">{heading}</span>
                )}
              </div>
              <dl className="divide-y">
                {rest.filter((column) => column.header).map((column) => (
                  <div key={column.header} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                    <dt><Eyebrow>{column.header}</Eyebrow></dt>
                    <dd className="min-w-0 text-right text-[12.5px]">{column.cell(row)}</dd>
                  </div>
                ))}
                {/* Action cells carry a blank header; they get the full width. */}
                {rest.filter((column) => !column.header).map((column, columnIndex) => (
                  <div key={`action-${columnIndex}`} className="px-3 py-2">{column.cell(row)}</div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto border sm:block"
           tabIndex={0} role="region" aria-label={label}>
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="bg-surface-muted text-left">
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col"
                  className={cx(
                    "px-3 py-1.5 font-mono text-3xs font-normal uppercase",
                    "tracking-[0.08em] text-muted-foreground",
                    column.align === "right" && "text-right",
                    column.hideBelow && hide[column.hideBelow],
                  )}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}
                className={cx("border-t transition hover:bg-surface-muted", rowClassName?.(row))}>
              {columns.map((column, columnIndex) => {
                const content = column.cell(row);
                return (
                  <td key={column.header}
                      className={cx(
                        "px-3 py-2 align-middle",
                        column.align === "right" && "text-right font-mono tabular-nums",
                        column.hideBelow && hide[column.hideBelow],
                      )}>
                    {rowHref && columnIndex === 0 ? (
                      <Link href={rowHref(row)} className="font-medium text-primary hover:underline">
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

export function Notice({
  tone = "info", title, children,
}: { tone?: "info" | "success" | "warning" | "danger"; title?: string; children?: ReactNode }) {
  const tones = {
    info: "border-info/40 bg-info/5 text-info",
    success: "border-success/40 bg-success/5 text-success",
    warning: "border-warning/40 bg-warning/5 text-warning",
    danger: "border-danger/40 bg-danger/5 text-danger",
  } as const;
  /* Left rule rather than a full box — the pack marks status with a bar on the
     leading edge and keeps the surface itself plain. */
  const rules = {
    info: "border-l-info", success: "border-l-success",
    warning: "border-l-warning", danger: "border-l-danger",
  } as const;
  return (
    /* A failure interrupts; everything else waits its turn. `status` announces
       politely, which is right for "invoice emailed" and wrong for "this run
       cannot start yet" sitting above the control the user is about to press. */
    <div role={tone === "danger" ? "alert" : "status"}
         className={cx("border border-l-[5px] px-3 py-2 text-[12.5px]", tones[tone], rules[tone])}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-0.5" : undefined}>{children}</div> : null}
    </div>
  );
}

/** Renders the `?error=` / `?ok=` messages our server actions redirect with. */
export function FlashMessages({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return (
    <div className="mb-4 space-y-2">
      {error ? <Notice tone="danger" title="Something went wrong">{error}</Notice> : null}
      {ok ? <Notice tone="success">{ok}</Notice> : null}
    </div>
  );
}

/* -------------------------------------------------------------- skeletons */

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse bg-surface-muted" />
      ))}
    </div>
  );
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-[76px] animate-pulse bg-surface-muted" />
      ))}
    </div>
  );
}
