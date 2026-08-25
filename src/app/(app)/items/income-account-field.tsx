import { createClient } from "@/lib/supabase/server";
import { REVENUE_ACCOUNT_TYPES, accountLabel, type PickableAccount } from "@/lib/domain/accounts";
import { Field, Select } from "@/components/form";

/**
 * "Which account do this item's sales go to?" — MYOB's *Income Account for
 * Tracking Sales*, under the same words a bookkeeper already uses.
 *
 * **This one field is what makes picking an item on an invoice produce a code.**
 * Without it the item master and the chart of accounts are two lists that never
 * meet, and every line has to be coded by hand however it was added.
 *
 * A plain `<Select>` rather than the invoice composer's type-ahead, deliberately:
 * there are two dozen income accounts and this sits in a grid of twenty other
 * fields, so a list that opens and closes beats a search box that needs a
 * keystroke before it says anything. The invoice line is the opposite case —
 * one field, in a hurry, over the whole chart — and gets the type-ahead.
 *
 * Grouped by side of the ledger and **not filtered to income only**: the chart
 * carries "Vehicle sale" under both Income and Other income, and a laundry that
 * tracks an item's sales to `8-9000 Rebates` is not making a mistake this screen
 * should refuse.
 */
export async function IncomeAccountField({ defaultValue }: { defaultValue?: string | null }) {
  const supabase = await createClient();

  // Returns nothing rather than throwing when the caller cannot read the chart.
  // Since 0036 it is gated on `purchases.read`, and a role split later must
  // degrade to "no accounts offered" rather than to a 500 on the items screen.
  const { data } = await supabase
    .from("gl_accounts")
    .select("id, code, name, account_type, tax_code, is_header")
    .is("deleted_at", null)
    .eq("is_header", false)
    .in("account_type", [...REVENUE_ACCOUNT_TYPES])
    .order("code")
    .limit(500)
    .returns<PickableAccount[]>();

  const accounts = data ?? [];

  if (accounts.length === 0) {
    return (
      <Field label="Income account" name="income_account_id"
             hint="No chart of accounts on file yet. Import one and this item's sales can be coded.">
        <Select name="income_account_id" options={[]} placeholder="No accounts available" />
      </Field>
    );
  }

  const group = (type: string) => ({
    label: type,
    options: accounts
      .filter((account) => account.account_type === type)
      .map((account) => ({ value: account.id, label: accountLabel(account) })),
  });

  return (
    <Field label="Income account" name="income_account_id"
           hint="Where sales of this item land in your books. An invoice line naming this item is coded here.">
      <Select
        name="income_account_id" defaultValue={defaultValue ?? ""}
        placeholder="Not tracked to an account"
        groups={REVENUE_ACCOUNT_TYPES.map(group).filter((one) => one.options.length > 0)}
      />
    </Field>
  );
}
