/**
 * The chart of accounts, said the way a bookkeeper says it. No database in sight.
 *
 * The business keeps its books against 268 accounts and every sale has to land on
 * one of them. Staff read them by code — `4-1100`, not "the black towel income
 * account" — for the same reason they read items as TOW001, so an account reads
 *
 *     4-1100 — Towels - Black
 *
 * everywhere it appears, and a search matches the code before the name.
 *
 * Deliberately a sibling of `items.ts` rather than a generalisation of it. The two
 * rank differently (an account code is hierarchical and a prefix search over
 * `4-1` is meaningful; an item code is not), and folding them into one
 * `searchThings` would buy four saved lines at the cost of the one place either
 * rule can be stated plainly.
 */

/** What these rules need to know about an account. Deliberately less than a row. */
export type PickableAccount = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  tax_code?: string | null;
  is_header?: boolean;
};

/**
 * The account types a *sale* belongs on.
 *
 * MYOB's chart splits trading income (`4-…`) from other income (`8-…`), and both
 * are places a customer invoice can legitimately land — a rent recharge is
 * `4-4001`, an insurance recovery is `8-8400`. Everything else is the other side
 * of the books.
 *
 * This is what the picker **offers first**, not what the database allows. Coding
 * a recharge against an expense account to offset it is a real thing a bookkeeper
 * does, and a screen that refuses it teaches people to keep a spreadsheet beside
 * the app. So the list narrows the default and the "show every account" escape is
 * always there — the only hard rule is the header one below, which is structural.
 */
export const REVENUE_ACCOUNT_TYPES = ["Income", "Other income"] as const;

/**
 * Can anything at all be coded to this account?
 *
 * The six MYOB classification rows — Assets, Liability, Equity, Income, Cost of
 * Sales, Expenses — carry no code of their own; the importer gives them a
 * synthetic `0-INCOME` so the table's natural key works. They are headings, not
 * accounts, and nothing may post to one. The database says the same thing in
 * `sync_invoice_line_account()`, because this rule has to hold for the month-end
 * roll-up and any future import as well as for the screen.
 */
export function isPostableAccount(account: PickableAccount): boolean {
  return account.is_header !== true;
}

/** Is this one of the accounts a sale would ordinarily land on? */
export function isRevenueAccount(account: PickableAccount): boolean {
  return isPostableAccount(account)
    && (REVENUE_ACCOUNT_TYPES as readonly string[]).includes(account.account_type);
}

/**
 * `4-1100 — Towels - Black`.
 *
 * The code leads for the same reason it does on an item: it is the shorter, more
 * certain half. Two accounts can be called "Vehicle Sale" — this chart has
 * exactly that, at `4-5000` and `8-1000` — and only one of them is `4-5000`.
 */
export function accountLabel(account: Pick<PickableAccount, "code" | "name">): string {
  return `${account.code} — ${account.name}`;
}

/**
 * Does this account match what somebody typed?
 *
 * Matched against the code and the name, case- and space-insensitively. A blank
 * query matches everything, so the picker opens on the full list rather than
 * empty.
 */
export function accountMatches(account: PickableAccount, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [account.code, account.name].some((field) => field.toLowerCase().includes(needle));
}

/**
 * The accounts matching a query, code matches first.
 *
 * Ranked rather than merely filtered, and for accounts the ranking earns its keep
 * twice over: typing `4-1` should bring back the eleven towel and linen income
 * accounts in code order, and typing `towel` should put `4-1000 Sales of Towels`
 * above `5-1000 Towel Purchases`, which is the other side of the books and the
 * wrong answer to a question asked on an invoice.
 *
 * Headings are dropped outright — they are never an answer.
 */
export function searchAccounts<T extends PickableAccount>(
  accounts: readonly T[], query: string, limit = 20,
): T[] {
  const postable = accounts.filter(isPostableAccount);
  const needle = query.trim().toLowerCase();
  if (!needle) return postable.slice(0, limit);

  const rank = (account: PickableAccount): number => {
    const code = account.code.toLowerCase();
    const name = account.name.toLowerCase();

    // An exact code beats everything, whichever side of the books it is on.
    // Somebody who types `5-1000` in full has named the account they want, and
    // burying it under the sales accounts would be the app arguing with them.
    if (code === needle) return 0;

    const tier = code.startsWith(needle) ? 1
      : name.startsWith(needle) ? 2
      : code.includes(needle) ? 3
      : name.includes(needle) ? 4
      : 5;

    // **A whole tier, not a nudge within one.** This chart contains
    // `5-1000 Towel Purchases`, whose name *starts with* "towel" where
    // `4-1000 Sales of Towels` merely contains it — so any within-tier bonus
    // leaves the purchase account answering a question asked on a sales
    // invoice. Non-revenue accounts sort after every revenue match instead,
    // and stay one exact code away.
    return isRevenueAccount(account) ? tier : 5 + tier;
  };

  return postable
    .filter((account) => accountMatches(account, query))
    .map((account, index) => ({ account, index, rank: rank(account) }))
    // `index` keeps the caller's order inside a rank, so the list does not
    // reshuffle as somebody types a longer prefix of the same code.
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.account);
}

/**
 * Does GST apply to a line coded to this account?
 *
 * The chart carries the answer per account in the bookkeeper's own vocabulary —
 * `GST` at 10%, `FRE` for GST-free, `N-T` for not reportable — so picking an
 * account can tick the box rather than asking a counter hand a tax question.
 *
 * **Returns `null` for anything it does not recognise, and that is the point.**
 * A tax code is somebody else's vocabulary (0021 deliberately left the column
 * unchecked so a bookkeeper can add one), so an unknown code means "this rule has
 * no opinion — leave the operator's answer alone". Guessing `true` would put GST
 * on a line nobody agreed to charge it on, and guessing `false` would quietly
 * under-collect it.
 */
export function taxableFromTaxCode(taxCode: string | null | undefined): boolean | null {
  const code = taxCode?.trim().toUpperCase();
  if (!code) return null;
  if (code === "GST") return true;
  if (code === "FRE" || code === "N-T" || code === "NT") return false;
  return null;
}

/**
 * How many lines on an invoice have not been coded to an account.
 *
 * Counted rather than prevented. A free-text line with no code is explicitly
 * asked for — it is how something that is in neither the item list nor the chart
 * gets onto an invoice at all — so the app's job is to make the gap **visible**,
 * not to refuse the work. This is the same call the pricer makes about laundry
 * nobody has priced: report it and name it, because a silently missing code looks
 * exactly like one that was chosen.
 */
export function uncodedLineCount(
  lines: readonly { account_code?: string | null }[],
): number {
  return lines.filter((line) => !line.account_code?.trim()).length;
}
