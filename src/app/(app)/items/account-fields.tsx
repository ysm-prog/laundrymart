import { accountOptionLabel, type IncomeAccount } from "@/lib/accounts";
import { Field, Select } from "@/components/form";

/**
 * One of the item's four account fields, drawn from a list read once.
 *
 * 0044 gave an item three more accounts beside `income_account_id` — where the
 * cost of a sale is booked, where an expense lands, and where stock on hand sits
 * on the balance sheet. All four pick from the same postable accounts, so they
 * are one component over one read rather than four components each fetching the
 * chart. That is not only tidiness: `listIncomeAccounts` is a round trip, and
 * four of them on one page render is three more than the screen needs.
 *
 * **The list is handed in, never fetched here.** §23: a read that feeds a write
 * names its tenant, because a platform admin's session reads every laundry and
 * the id chosen here is posted straight back into a write scoped to one. Making
 * this component fetch would put that decision in four places.
 *
 * A laundry with no chart gets the reason rather than an empty select — the same
 * call `IncomeAccountField` already makes, and for the same reason: a picker
 * with nothing in it and no explanation reads as a broken screen.
 */
export function AccountField({
  accounts, name, label, hint, defaultValue,
}: {
  accounts: readonly IncomeAccount[];
  name: string;
  label: string;
  hint: string;
  defaultValue?: string | null;
}) {
  const empty = accounts.length === 0;
  return (
    <Field
      label={label} name={name}
      hint={empty ? "No chart of accounts on file yet, so nothing can be coded." : hint}
    >
      <Select
        name={name} defaultValue={defaultValue ?? ""}
        placeholder={empty ? "No accounts available" : "Not coded"}
        options={accounts.map((account) => ({
          value: account.id, label: accountOptionLabel(account),
        }))}
      />
    </Field>
  );
}
