/**
 * The rules a list page's filter bar obeys.
 *
 * Pure, and here rather than inside the components, for the reason this repo has
 * recorded three times: a rule stated inside a component (or worse, inside a
 * `"use server"` module, which can export nothing but server actions) is a rule
 * no unit test can reach — and two of the three payload contracts written that
 * way shipped broken behind a green `verify`.
 *
 * **Every filter lives in the URL.** Not in React state, not in a cookie: a
 * filtered list has to survive a refresh, a bookmark, a page of results and a
 * link pasted to somebody else, and on this app's list pages — which are async
 * server components reading Supabase — a URL is also the only state a server
 * render can see. So the chips below are links and the bar is a `GET` form.
 */

/** A request's query parameters, as a page receives them. */
export type FilterParams = Record<string, string | undefined>;

/**
 * The values a multi-select filter is holding.
 *
 * Spelled as one comma-joined parameter (`?status=new,in_progress`) rather than
 * a repeated key, because `searchParams` in a Next page hands a repeated key
 * back as `string | string[]` and every reader would then have to cope with both
 * shapes. Anything not in `allowed` is dropped rather than passed to the
 * database — these arrive off a URL somebody can type, and an unrecognised value
 * reaching a query is either an error or a filter silently matching nothing.
 */
export function parseMulti(value: string | undefined, allowed: readonly string[]): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed && allowed.includes(trimmed)) seen.add(trimmed);
  }
  // Ordered by `allowed` rather than by what the URL happened to say, so two
  // links that pick the same set are the same link.
  return allowed.filter((option) => seen.has(option));
}

/**
 * The parameter value after a chip is pressed: adds it if absent, removes it if
 * present. An empty selection is `undefined`, so the key drops out of the URL
 * entirely — "no filter" and "filtering by nothing" must not be two URLs.
 */
export function toggleMulti(
  current: readonly string[], value: string, allowed: readonly string[],
): string | undefined {
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
  const ordered = allowed.filter((option) => next.includes(option));
  return ordered.length ? ordered.join(",") : undefined;
}

/**
 * A link to the same list with some parameters changed.
 *
 * `undefined` clears a key. **`page` is always dropped**, because page 3 of an
 * old filter is rarely page 3 of a new one and is quite often past the end of it
 * — an empty list that reads as "nothing matches".
 */
export function filterHref(
  basePath: string, params: FilterParams, changes: FilterParams = {},
): string {
  const search = new URLSearchParams();
  const merged = { ...params, ...changes };
  for (const [key, value] of Object.entries(merged)) {
    if (!value || key === "page" || key === "error" || key === "ok") continue;
    search.set(key, value);
  }
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * How many of `keys` a request is actually filtering by.
 *
 * Drives both the "Clear filters" link (shown only when there is something to
 * clear) and the empty state, which has to say *no rows match those filters*
 * rather than *there is nothing here* — the two need different next steps, and
 * telling a new laundry its customer list is empty when it has simply searched
 * for a typo is how somebody concludes the app has lost their data.
 */
export function activeFilterCount(params: FilterParams, keys: readonly string[]): number {
  return keys.filter((key) => {
    const value = params[key];
    return typeof value === "string" && value.trim() !== "";
  }).length;
}

/** Whether any of `keys` is set — the question the empty state and Clear both ask. */
export function isFiltered(params: FilterParams, keys: readonly string[]): boolean {
  return activeFilterCount(params, keys) > 0;
}
