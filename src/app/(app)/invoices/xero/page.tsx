import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { dateTime } from "@/lib/format";
import { xeroConfig } from "@/lib/xero/config";
import { listXeroBankAccounts } from "@/lib/xero/accounts";
import { Badge, ButtonLink, Card, Notice, PageHeader, Stat } from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Field, Select, SubmitButton } from "@/components/form";
import { disconnectXero, setXeroPaymentAccount } from "./actions";

export const metadata = { title: "Xero" };
export const dynamic = "force-dynamic";

type Status = {
  xero_tenant_name: string | null;
  connected_at: string;
  expires_at: string;
  payment_account_code: string | null;
  payment_account_name: string | null;
  connected: boolean;
};

export default async function XeroPage() {
  const session = await requireCapability("invoices.write");
  const configured = xeroConfig() !== null;

  // Through the definer function, not the table: `xero_connections` grants
  // `authenticated` nothing at all, because the row holds bearer credentials
  // for somebody's accounting system (0026).
  const supabase = await createClient();
  const { data } = await supabase.rpc("xero_connection_status", { t: session.tenantId });
  // A set-returning function comes back as an array; `.returns<Status[]>()`
  // confuses the client's single-object inference, so the cast is here instead.
  const status = ((data ?? []) as Status[])[0] ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Xero"
        description={`Send ${session.tenantName}'s issued invoices straight into its Xero organisation.`}
      />

      {!configured ? (
        <Notice tone="warning" title="Xero is not set up on this deployment">
          Add <code>XERO_CLIENT_ID</code> and <code>XERO_CLIENT_SECRET</code>, and register{" "}
          <code>/api/xero/callback</code> as a redirect URI on the Xero app. Until then invoices
          are issued exactly as before and nothing is sent.
        </Notice>
      ) : null}

      <Card
        title="Connection"
        description="Each laundry connects its own Xero organisation, so its invoices only ever reach its own books."
      >
        {status ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label="Organisation" value={status.xero_tenant_name ?? "Connected"} />
              <Stat label="Connected" value={dateTime(status.connected_at)} />
              <Stat label="Access renews" value={dateTime(status.expires_at)} />
            </div>
            <p className="text-xs text-muted-foreground">
              An issued invoice is sent automatically, and a payment is posted against it. If
              Xero refuses either, the record here stays exactly as it is and the register offers
              to try again — the money record is this app&apos;s, and Xero is a copy of it.
            </p>
            <PaymentAccount status={status} tenantId={session.tenantId} />

            <form action={disconnectXero}>
              <ConfirmSubmit
                label="Disconnect"
                eyebrow="This can be undone"
                consequence="New invoices will stop being sent to Xero. Invoices already sent stay in Xero and keep their link, so reconnecting later does not send them twice."
              />
            </form>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge tone="warning">Not connected</Badge>
              <span className="text-sm text-muted-foreground">
                Issued invoices are not being sent anywhere.
              </span>
            </div>
            {configured ? (
              <ButtonLink href="/api/xero/connect" variant="primary">
                Connect to Xero
              </ButtonLink>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Which Xero bank account payments land in.
 *
 * A picker of the laundry's real accounts rather than a text box: an account
 * code is an arbitrary number in somebody else's system, and typing it from
 * memory posts real money against the wrong account with nothing to notice it.
 */
async function PaymentAccount({ status, tenantId }: { status: Status; tenantId: string }) {
  const accounts = await listXeroBankAccounts(tenantId);

  if (accounts.length === 0) {
    return (
      <Notice tone="warning" title="Payments are not being sent">
        No bank accounts could be read from Xero, so there is nothing to choose. Payments are
        recorded here as normal and simply not posted — reconnect if this persists.
      </Notice>
    );
  }

  const current = status.payment_account_code
    ? `${status.payment_account_code}|${status.payment_account_name ?? ""}`
    : "";

  return (
    <form action={setXeroPaymentAccount} className="flex flex-wrap items-end gap-3">
      <Field label="Post payments to" name="account"
             hint="The Xero bank account a customer's payment is recorded against.">
        <Select name="account" defaultValue={current} placeholder="Do not send payments"
                options={accounts.map((account) => ({
                  value: `${account.code}|${account.name}`,
                  label: `${account.name} (${account.code})`,
                }))} />
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Saving…">Save</SubmitButton>
    </form>
  );
}
