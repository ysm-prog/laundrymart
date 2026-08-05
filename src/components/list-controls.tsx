import Link from "next/link";
import { cx } from "./ui";

/** GET form — filters live in the URL so a filtered list is shareable. */
export function ListControls({
  action, q, filters,
}: {
  action: string;
  q?: string;
  filters?: ReadonlyArray<{
    name: string;
    label: string;
    value?: string;
    options: ReadonlyArray<{ value: string; label: string }>;
  }>;
}) {
  return (
    <form method="get" action={action} className="mb-4 flex flex-wrap items-end gap-2">
      <div className="min-w-[12rem] flex-1">
        <label htmlFor="q" className="sr-only">Search</label>
        <input
          id="q" name="q" type="search" defaultValue={q} placeholder="Search…"
          className="w-full rounded-md border bg-surface px-3 py-2 text-sm"
        />
      </div>
      {filters?.map((filter) => (
        <div key={filter.name}>
          <label htmlFor={filter.name} className="sr-only">{filter.label}</label>
          <select
            id={filter.name} name={filter.name} defaultValue={filter.value ?? ""}
            className="rounded-md border bg-surface px-3 py-2 text-sm"
          >
            <option value="">{filter.label}: any</option>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      ))}
      <button type="submit" className="rounded-md border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted">
        Apply
      </button>
    </form>
  );
}

export const PAGE_SIZE = 25;

export function Pagination({
  page, total, params, basePath, pageSize = PAGE_SIZE,
}: {
  page: number;
  total: number;
  params: Record<string, string | undefined>;
  basePath: string;
  pageSize?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "page") search.set(key, value);
    }
    search.set("page", String(target));
    return `${basePath}?${search.toString()}`;
  };

  const link = "rounded-md border px-3 py-1.5 text-sm";
  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">
        Page {page} of {pages} · {total} record{total === 1 ? "" : "s"}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={link}>Previous</Link>
        ) : (
          <span className={cx(link, "opacity-40")}>Previous</span>
        )}
        {page < pages ? (
          <Link href={href(page + 1)} className={link}>Next</Link>
        ) : (
          <span className={cx(link, "opacity-40")}>Next</span>
        )}
      </div>
    </nav>
  );
}

/** `?page=` → a 1-based integer, tolerant of junk. */
export function pageFrom(value: string | undefined): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function rangeFor(page: number, pageSize = PAGE_SIZE): [number, number] {
  const from = (page - 1) * pageSize;
  return [from, from + pageSize - 1];
}
