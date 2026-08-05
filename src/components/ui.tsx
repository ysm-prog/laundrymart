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

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium " +
  "transition disabled:pointer-events-none disabled:opacity-60";

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

export function DataTable<T>({
  rows, columns, empty, rowHref,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  empty: ReactNode;
  rowHref?: (row: T) => string;
}) {
  if (!rows.length) return <>{empty}</>;

  const hide = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" } as const;

  return (
    <div className="overflow-x-auto border">
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
            <tr key={index} className="border-t transition hover:bg-surface-muted">
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
    <div role="status"
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
