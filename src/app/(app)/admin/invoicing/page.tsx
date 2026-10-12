import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import {
  formatAbn, invoiceProfileGaps, parseInvoiceProfile,
} from "@/lib/domain/invoice-profile";
import { Card, FormSection, Notice, PageHeader } from "@/components/ui";
import { Field, FormActions, Input, SubmitButton } from "@/components/form";
import { saveInvoiceProfile } from "./actions";

export const metadata = { title: "Invoicing" };

/**
 * What every tax invoice says about the business that issued it (2026-10-12).
 * The ABN makes it a valid tax invoice; the address and the bank details are
 * what a customer needs to know who it is from and how to pay it.
 */
export default async function InvoicingSettingsPage() {
  const session = await requireCapability("admin.write");
  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants").select("name, abn, settings").eq("id", session.tenantId)
    .maybeSingle<{ name: string; abn: string | null; settings: unknown }>();
  const profile = parseInvoiceProfile(tenant?.settings);
  const gaps = invoiceProfileGaps(tenant?.abn ?? null, profile);

  return (
    <div className="space-y-6">
      <PageHeader title="Invoicing"
                  description="What prints at the top and the foot of every invoice and credit note." />
      {gaps.length > 0 ? (
        <Notice tone="warning" title="Your invoices are missing details">
          Add {gaps.join(", ")}.
        </Notice>
      ) : (
        <Notice tone="success">Every invoice carries your ABN, address and bank details.</Notice>
      )}
      <Card>
        <form action={saveInvoiceProfile} className="space-y-6">
          <FormSection title="Business" description={tenant?.name ?? undefined}>
            <Field label="ABN" name="abn" hint="11 digits. Required for a valid tax invoice.">
              <Input name="abn" inputMode="numeric"
                     defaultValue={tenant?.abn ? formatAbn(tenant.abn) : ""} placeholder="12 345 678 901" />
            </Field>
            <Field label="Address line 1" name="address_1">
              <Input name="address_1" defaultValue={profile.addressLines[0] ?? ""} placeholder="12 Example Street" />
            </Field>
            <Field label="Address line 2" name="address_2">
              <Input name="address_2" defaultValue={profile.addressLines[1] ?? ""} placeholder="Adelaide SA 5000" />
            </Field>
            <Field label="Address line 3" name="address_3">
              <Input name="address_3" defaultValue={profile.addressLines[2] ?? ""} />
            </Field>
            <Field label="Phone" name="phone">
              <Input name="phone" type="tel" defaultValue={profile.phone ?? ""} />
            </Field>
            <Field label="Accounts email" name="email">
              <Input name="email" type="email" defaultValue={profile.email ?? ""} />
            </Field>
          </FormSection>
          <FormSection title="How customers pay you"
                       description="Printed on every issued invoice, with a line asking the customer to quote the invoice number.">
            <Field label="Account name" name="bank_account_name">
              <Input name="bank_account_name" defaultValue={profile.bankAccountName ?? ""} />
            </Field>
            <Field label="BSB" name="bsb">
              <Input name="bsb" inputMode="numeric" defaultValue={profile.bsb ?? ""} placeholder="062-000" />
            </Field>
            <Field label="Account number" name="account_number">
              <Input name="account_number" inputMode="numeric" defaultValue={profile.accountNumber ?? ""} />
            </Field>
          </FormSection>
          <FormActions>
            <SubmitButton pendingLabel="Saving…">Save invoice details</SubmitButton>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
