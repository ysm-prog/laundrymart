import { listIncomeAccounts, accountOptionLabel } from "@/lib/accounts";
import { createClient } from "@/lib/supabase/server";
import { Field, Input, Select } from "@/components/form";

/**
 * The two coding fields on an item: which account its sales land in, and what
 * that item is called in Xero.
 *
 * **One component for both item forms**, because they are the same two questions
 * and a picker rendered twice drifts — which is exactly what happened here: this
 * screen was built independently on two branches the same afternoon, and the two
 * versions disagreed about whether the account list is tenant-filtered. It is
 * (§23: a read that feeds a write names its tenant, because a platform admin's
 * session reads every laundry and the id chosen here is posted back into a write
 * scoped to one).
 *
 * `income_account_id` is what makes picking an item on an invoice fill the code
 * in by itself. `xero_item_code` is deliberately separate from `item_code`: that
 * is the code staff type here, and Xero refuses an invoice naming an `ItemCode`
 * its own inventory does not carry, so the two are never assumed to match.
 */
export async function IncomeAccountField({
  tenantId, defaultValue, defaultXeroItemCode,
}: {
  tenantId: string;
  defaultValue?: string | null;
  defaultXeroItemCode?: string | null;
}) {
  const accounts = await listIncomeAccounts(await createClient(), tenantId);

  return (
    <>
      <Field
        label="Income account" name="income_account_id"
        hint={accounts.length === 0
          // Said out loud rather than rendered as an empty select: a picker with
          // nothing in it and no explanation reads as a broken screen.
          ? "No chart of accounts on file yet. Import one and this item's sales can be coded."
          : "Where an invoice line for this item is coded. Carried through to Xero."}
      >
        <Select
          name="income_account_id" defaultValue={defaultValue ?? ""}
          placeholder={accounts.length === 0 ? "No accounts available" : "Not coded"}
          options={accounts.map((account) => ({
            value: account.id, label: accountOptionLabel(account),
          }))}
        />
      </Field>
      <Field
        label="Xero item code" name="xero_item_code"
        hint="This item's code in Xero, if it has one. Blank means no ItemCode is sent — nothing is guessed, because Xero refuses an invoice naming a code it does not have."
      >
        <Input name="xero_item_code" defaultValue={defaultXeroItemCode ?? ""} />
      </Field>
    </>
  );
}
