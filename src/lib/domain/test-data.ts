/**
 * The pure half of the test-data clean-up (brief 1.8, gap G10): reading the
 * list a person typed, matching it to customers, and the rule for what looks
 * like test data. No database, so it is tested.
 *
 * **The list is never decided here.** The brief names candidates — Test1, Jay,
 * ZZ TEST Demo Laundry, ZZ TEST – Claude BA, Core IT — and says Darshan must
 * confirm them before anything runs on production. So nothing in this repo
 * carries a customer's name: the screen suggests customers whose own names look
 * like test data, and the person types the list the clean-up acts on.
 */

/** A name or customer number as typed, made comparable: case, spacing and dashes. */
export function normaliseCustomerKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-") // en and em dashes, minus → hyphen
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** One entry per line (or comma), trimmed, de-duplicated, blanks dropped. */
export function parseCustomerList(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of (text ?? "").split(/[\n,]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const key = normaliseCustomerKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.slice(0, 50);
}

export type CustomerRef = { id: string; customer_number: string; business_name: string };

/**
 * Which customers the typed entries name — **exactly**, by name or by customer
 * number. Never a partial match: "Jay" must not also catch "Jay's Bakery",
 * because the clean-up voids invoices and cancels jobs.
 */
export function matchCustomers<T extends CustomerRef>(
  entries: readonly string[], customers: readonly T[],
): { matched: T[]; notFound: string[] } {
  const byKey = new Map<string, T[]>();
  for (const customer of customers) {
    for (const key of [normaliseCustomerKey(customer.business_name), normaliseCustomerKey(customer.customer_number)]) {
      const bucket = byKey.get(key) ?? [];
      bucket.push(customer);
      byKey.set(key, bucket);
    }
  }
  const matched = new Map<string, T>();
  const notFound: string[] = [];
  for (const entry of entries) {
    const hits = byKey.get(normaliseCustomerKey(entry)) ?? [];
    if (hits.length === 0) notFound.push(entry);
    for (const hit of hits) matched.set(hit.id, hit);
  }
  return { matched: [...matched.values()], notFound };
}

/**
 * A suggestion, never a decision: a customer whose own name says it is a test —
 * the word "test", or the `ZZ` prefix used to sort test records to the bottom.
 */
export function looksLikeTestCustomer(name: string): boolean {
  const key = normaliseCustomerKey(name);
  return /\btest\d*\b/.test(key) || /^zz\b/.test(key);
}

/** The reason every voided invoice and written-off job carries. */
export const TEST_DATA_REASON = "Test data";
