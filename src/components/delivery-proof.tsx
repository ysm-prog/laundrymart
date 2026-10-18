import { Badge, Card } from "@/components/ui";
import { ProofOfService } from "@/components/proof-of-service";
import { formatAdelaideDateTime } from "@/lib/domain/timezone";
import type { DeliveryQuantity } from "@/lib/runs/my-runs";

/**
 * What a delivery proves, on the job's page (brief 2.4, G23).
 *
 * The signature and the photo, who took the laundry at the door, which round
 * and which driver handed it over — not only the shared board login — and the
 * count that came back, with a short delivery called out. Renders nothing for a
 * job that has not been delivered, or for one delivered before 0056 recorded any
 * of this, so older jobs read exactly as they did.
 *
 * A server component, because the media URLs are signed per request and expire.
 */
export async function DeliveryProof({
  tenantId, deliveredAt, receivedBy, signaturePath, photoPaths, short, quantities,
  boardName, driverName,
}: {
  tenantId: string;
  deliveredAt: string | null;
  receivedBy: string | null;
  signaturePath: string | null;
  photoPaths: string[] | null;
  short: boolean | null;
  quantities: DeliveryQuantity[] | null;
  boardName: string | null;
  driverName: string | null;
}) {
  const recorded = Boolean(receivedBy || signaturePath || (photoPaths?.length ?? 0) > 0
    || boardName || driverName || (quantities?.length ?? 0) > 0);
  if (!deliveredAt || !recorded) return null;

  return (
    <Card
      title="Proof of delivery"
      actions={short ? <Badge tone="warning">Short delivery</Badge> : <Badge tone="success">Delivered</Badge>}
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Fact label="Delivered">{formatAdelaideDateTime(deliveredAt)}</Fact>
        <Fact label="Received by">{receivedBy ?? "Not recorded"}</Fact>
        <Fact label="Round">{boardName ?? "Not recorded"}</Fact>
        <Fact label="Driver">{driverName ?? "Not recorded"}</Fact>
      </dl>

      {quantities && quantities.length > 0 ? (
        <ul className="mt-4 divide-y rounded-lg border">
          {quantities.map((line) => {
            const shortLine = line.taken_in !== null && line.delivered !== null && line.delivered < line.taken_in;
            return (
              <li key={line.item_row_id} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                <span>{line.description}</span>
                <span className={shortLine ? "font-semibold text-warning" : "tabular-nums"}>
                  {line.delivered ?? "—"}
                  {line.taken_in !== null ? ` of ${line.taken_in}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ProofOfService
        tenantId={tenantId}
        signaturePath={signaturePath}
        photoPaths={photoPaths}
        signedBy={receivedBy}
      />
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}
