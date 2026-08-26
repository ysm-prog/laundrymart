import { listIncomeAccounts, type IncomeAccount } from "@/lib/accounts";
import { createClient } from "@/lib/supabase/server";
import { Field, Input } from "@/components/form";
import { AccountField } from "./account-fields";

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
 *
 * **`accounts` is optional and the detail page passes it.** That page now draws
 * four account pickers (0044 added the cost-of-sales, expense and asset
 * accounts), and each fetching its own chart would be four round trips for one
 * list. Left out, this reads its own — which is what the add form wants, since
 * it is rendered only for a role that can see this form at all.
 */
export async function IncomeAccountField({
  tenantId, accounts, defaultValue, defaultXeroItemCode,
}: {
  tenantId: string;
  accounts?: readonly IncomeAccount[];
  defaultValue?: string | null;
  defaultXeroItemCode?: string | null;
}) {
  const chart = accounts ?? await listIncomeAccounts(await createClient(), tenantId);

  return (
    <>
      <AccountField
        accounts={chart} name="income_account_id" label="Income account"
        hint="Where an invoice line for this item is coded. Carried through to Xero."
        defaultValue={defaultValue}
      />
      <Field
        label="Xero item code" name="xero_item_code"
        hint="This item's code in Xero, if it has one. Blank means no ItemCode is sent — nothing is guessed, because Xero refuses an invoice naming a code it does not have."
      >
        <Input name="xero_item_code" defaultValue={defaultXeroItemCode ?? ""} />
      </Field>
    </>
  );
}
