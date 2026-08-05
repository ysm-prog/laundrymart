const LOCALE = "en-AU";

export function money(value: number | string | null | undefined, currency = "AUD"): string {
  const amount = typeof value === "string" ? Number(value) : (value ?? 0);
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency })
    .format(Number.isFinite(amount) ? amount : 0);
}

export function number(value: number | string | null | undefined): string {
  const amount = typeof value === "string" ? Number(value) : (value ?? 0);
  return new Intl.NumberFormat(LOCALE).format(Number.isFinite(amount) ? amount : 0);
}

/** Date-only values are calendar facts — render them in UTC to avoid off-by-one. */
export function date(value: string | null | undefined): string {
  if (!value) return "—";
  const iso = value.slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(LOCALE, {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export function dateTime(value: string | null | undefined, timeZone = "Australia/Sydney"): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString(LOCALE, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone,
  });
}

export function time(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 5);
}

export function today(timeZone = "Australia/Sydney"): string {
  // `en-CA` formats as YYYY-MM-DD, which is exactly the shape Postgres wants.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function relativeDays(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00.000Z`).getTime();
  const b = new Date(`${to.slice(0, 10)}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}
