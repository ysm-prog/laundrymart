import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import {
  formatAbn, invoiceProfileGaps, parseInvoiceProfile,
} from "@/lib/domain/invoice-profile";
import { CONTROL, Card, FormSection, Notice, PageHeader, cx } from "@/components/ui";
import { Checkbox, Field, FormActions, Input, SubmitButton } from "@/components/form";
import { BRANDING_BUCKET, isTenantLogoPath } from "@/lib/branding";
import { arTrustedFrom } from "@/lib/domain/receivables";
import { parseAutomation } from "@/lib/domain/automation";
import {
  removeInvoiceLogo, saveAutomationSettings, saveInvoiceProfile, saveReceivablesSettings,
  uploadInvoiceLogo,
} from "./actions";

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
  const automation = parseAutomation(tenant?.settings);

  // The logo is private (0054), so the preview is a short-lived signed URL.
  // A failure — the bucket not set up yet, the file gone — shows no preview,
  // never an error page.
  let logoUrl: string | null = null;
  if (isTenantLogoPath(session.tenantId, profile.logoPath)) {
    const { data: signed } = await supabase.storage.from(BRANDING_BUCKET)
      .createSignedUrl(profile.logoPath, 300);
    logoUrl = signed?.signedUrl ?? null;
  }

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
            <Field label="Website" name="website" hint="Printed under the email, the way it reads — no https://.">
              <Input name="website" defaultValue={profile.website ?? ""} placeholder="adelaidetowelservice.com.au" />
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
      <Card>
        <FormSection title="Logo"
                     description="Printed top-left on every invoice and credit note. A PNG or a JPEG, under 900 KB.">
          {logoUrl ? (
            <div className="flex flex-wrap items-center gap-4">
              {/* A signed URL to a private object, not a static asset, so next/image's optimiser has nothing to fetch. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt="Your invoice logo"
                   className="h-24 w-auto max-w-56 rounded-lg border border-strong bg-white object-contain p-2" />
              <form action={removeInvoiceLogo}>
                <SubmitButton variant="secondary" size="md" pendingLabel="Removing…">Remove logo</SubmitButton>
              </form>
            </div>
          ) : profile.logoPath ? (
            <Notice tone="warning">A logo is saved but could not be shown. Upload it again to replace it.</Notice>
          ) : (
            <p className="text-sm text-muted-foreground">No logo yet. Invoices print without one until you add it.</p>
          )}
          <form action={uploadInvoiceLogo} className="mt-4 space-y-3">
            <Field label={logoUrl ? "Replace the logo" : "Upload a logo"} name="logo">
              <input id="logo" name="logo" type="file" accept="image/png,image/jpeg" required
                     className={cx(CONTROL, "file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium")} />
            </Field>
            <SubmitButton variant="secondary" size="md" pendingLabel="Uploading…">Save logo</SubmitButton>
          </form>
        </FormSection>
      </Card>
      <Card>
        <form action={saveReceivablesSettings}>
          <FormSection title="Imported balances"
                       description="Invoices brought in from MYOB before this date are kept in the register, marked “Imported – not reconciled”, and left out of Today’s overdue figures until you have reconciled them. Move the date back once you have.">
            <Field label="Count imported invoices from" name="ar_trusted_from"
                   hint="1 October 2026 — the move to Xero — unless you change it.">
              <Input name="ar_trusted_from" type="date" defaultValue={arTrustedFrom(tenant?.settings)} />
            </Field>
            <SubmitButton variant="secondary" size="md" pendingLabel="Saving…">Save</SubmitButton>
          </FormSection>
        </form>
      </Card>
      <Card>
        <form action={saveAutomationSettings}>
          <FormSection title="Automation"
                       description="What the app does by itself, so a job goes from the counter to the invoice without anybody having to remember a step.">
            <Checkbox name="autoAssignOnReady" defaultChecked={automation.autoAssignOnReady}
                      label="When a delivery job is ready, put it on the customer's round for the next delivery day" />
            <Checkbox name="autoApproveCleanJobs" defaultChecked={automation.autoApproveCleanJobs}
                      label="Approve a finished job automatically when every line comes from a rate card or the price list" />
            <Checkbox name="autoIssuePerJob" defaultChecked={automation.autoIssuePerJob}
                      label="Issue a per-job customer's invoice as soon as the job is approved (and send it to Xero)" />
            <Checkbox name="emailOnIssue" defaultChecked={automation.emailOnIssue}
                      label="Email those invoices, and the ones Issue and send all issues, to the customer's invoice email" />
            <p className="text-sm text-muted-foreground">
              A customer can be kept out of automatic approval on their Billing &amp; pricing card.
              Issuing stays blocked until your invoice details above are complete.
            </p>
            <SubmitButton variant="secondary" size="md" pendingLabel="Saving…">Save automation</SubmitButton>
          </FormSection>
        </form>
      </Card>
    </div>
  );
}
