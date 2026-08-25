import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import type { GlAccount } from "@/lib/db/types";
import { Card, Notice, PageContainer, PageHeader } from "@/components/ui";
import { Field, FormActions, Input, Select, SubmitButton } from "@/components/form";
import { updateAccount } from "../actions";
import { ACCOUNT_TYPES } from "../account-types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account" };

/**
 * One account in the chart.
 *
 * Gated on `purchases.write` rather than `purchases.read`, because this page is
 * the edit form and nothing else — an auditor reading the chart has the list,
 * which shows every column this does.
 */
export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireCapability("purchases.write");
  const supabase = await createClient();

  // Named rather than left to RLS (§23): a platform admin's session reads every
  // laundry, and this id comes from the address bar.
  const { data: account } = await supabase
    .from("gl_accounts")
    .select("id, code, name, account_type, tax_code, xero_account_code, " +
            "is_linked, is_header, level, current_balance")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle<GlAccount>();

  if (!account) notFound();

  return (
    <PageContainer width="form">
      <PageHeader
        title={`${account.code} — ${account.name}`}
        description={`${account.account_type} · balance ${money(account.current_balance)}`}
        back={{ href: "/accounts", label: "Accounts" }}
      />

      {account.is_linked ? (
        <Notice tone="info" title="This is a linked account">
          Your accounting system uses this account for something specific. Renaming or
          re-coding it here changes what this app shows, and nothing in your books.
        </Notice>
      ) : null}

      <Card title="Account">
        <form action={updateAccount} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="id" value={account.id} />
          <Field label="Code" name="code" required hint="As it is in your books.">
            <Input name="code" required defaultValue={account.code} />
          </Field>
          <Field label="Name" name="name" required>
            <Input name="name" required defaultValue={account.name} />
          </Field>
          <Field label="Type" name="account_type">
            <Select name="account_type" defaultValue={account.account_type}
                    options={ACCOUNT_TYPES.map((value) => ({ value, label: value }))} />
          </Field>
          <Field label="Tax code" name="tax_code" hint="As it is in your books — GST, FRE, N-T.">
            <Input name="tax_code" defaultValue={account.tax_code ?? ""} />
          </Field>
          <Field
            label="Xero code"
            name="xero_account_code"
            className="sm:col-span-2"
            hint="The matching code in Xero. Leave it blank and no invoice line is coded to this account in Xero — nothing is guessed, because Xero refuses an invoice naming a code it does not have."
          >
            <Input name="xero_account_code" defaultValue={account.xero_account_code ?? ""} />
          </Field>
          <Field label="Heading" name="is_header"
                 hint="A heading groups the accounts under it and is never coded to.">
            <Select name="is_header" defaultValue={String(account.is_header)}
                    options={[{ value: "false", label: "No" }, { value: "true", label: "Yes" }]} />
          </Field>
          <Field label="Indent" name="level" hint="1 is top level. Presentation only.">
            <Input name="level" type="number" min={1} max={4} defaultValue={String(account.level)} />
          </Field>
          <FormActions>
            <SubmitButton>Save account</SubmitButton>
          </FormActions>
        </form>
      </Card>
    </PageContainer>
  );
}
