import Link from "next/link";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Button } from "@/components/ui";
import { money } from "@/lib/format";

/**
 * The Issue control, drawn the same way everywhere a single draft can be issued
 * — the invoice page, the register's working pane and a card on the drafts board.
 *
 * Two states, and both are the brief's (2026-10-18):
 *
 *   **Blocked** (1.1). The laundry has no ABN, address or bank details yet, so
 *   nothing it issues would be a valid tax invoice. The button is drawn disabled
 *   rather than left off, with the sentence saying what to add and — for the
 *   one role that can open it — a link to Settings › Invoicing. A missing button
 *   reads as "this invoice cannot be issued"; a disabled one with a reason reads
 *   as "the laundry is not set up yet", which is the truth.
 *
 *   **Open** (1.6). Issuing cannot be undone: the invoice is dated today, its
 *   lines freeze, and it becomes a document the customer can be sent. So the
 *   first press asks, beside the button, with the number and the total — the
 *   inline confirm every other final action here uses (`ConfirmSubmit`).
 *
 * `issueOneInvoice` and `guard_invoice_issue` (0053) refuse a blocked issue
 * whatever this draws; the control is the courtesy, not the boundary.
 */
export function IssueControl({
  invoiceId, invoiceNumber, total, action, returnTo, blocked, settingsHref, label = "Issue invoice",
}: {
  invoiceId: string;
  invoiceNumber: string;
  total: number;
  action: (formData: FormData) => void | Promise<void>;
  returnTo?: string;
  /** Why issuing is closed for this laundry, or null when it is open. */
  blocked: string | null;
  /** Where to fix it — only for a role that can open Settings › Invoicing. */
  settingsHref?: string | null;
  label?: string;
}) {
  if (blocked) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="primary" disabled>{label}</Button>
        <p className="text-sm text-muted-foreground">
          {blocked}
          {settingsHref ? (
            <>
              {" "}
              <Link href={settingsHref} className="font-medium text-primary underline">
                Open Settings › Invoicing
              </Link>
            </>
          ) : null}
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="w-full">
      <input type="hidden" name="id" value={invoiceId} />
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
      <ConfirmSubmit
        variant="primary"
        label={label}
        eyebrow="This can't be undone"
        consequence={`Issue ${invoiceNumber} for ${money(total)}? It can't be undone — it is dated today, its lines are frozen, and it becomes the tax invoice the customer is sent.`}
        pendingLabel="Issuing…"
      />
    </form>
  );
}
