import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { dateTime } from "@/lib/format";
import { xeroConfig } from "@/lib/xero/config";
import { Badge, ButtonLink, Card, Notice, PageHeader, Stat } from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { disconnectXero } from "./actions";

export const metadata = { title: "Xero" };
export const dynamic = "force-dynamic";

type Status = {
  xero_tenant_name: string | null;
  connected_at: string;
  expires_at: string;
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
              An issued invoice is sent automatically. If Xero refuses one, the invoice stays
              issued and the register offers to try again — the money record is this app&apos;s,
              and Xero is a copy of it.
            </p>
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
