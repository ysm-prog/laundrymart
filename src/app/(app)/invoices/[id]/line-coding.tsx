"use client";

import { useState } from "react";
import Link from "next/link";
import { accountLabel, type PickableAccount } from "@/lib/domain/accounts";
import { AccountPicker } from "@/components/coding-pickers";
import { Overlay } from "@/components/overlay";
import { Button, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";

/**
 * The Code cell on an invoice line, and the way to change it.
 *
 * **This replaces "Remove and re-add a line to give it a code."** — advice that
 * was wrong in a way nobody would have noticed until a customer queried a bill:
 * a job line removed and re-added comes back `origin = 'manual'`, and the next
 * rebuild re-derives the job line beside it, so the invoice carries the charge
 * twice. `setInvoiceLineAccount` is the replacement, and it writes the code to
 * whichever place the line's code is actually read from.
 *
 * **A picker in every row was the other option and is why this is an overlay.**
 * `DataTable` renders a real table from `sm` up and a stack of labelled cards
 * below it; a type-ahead with a results list and a checkbox inside a `<td>`
 * either forces the column wide enough to hold it or gets clipped by the row.
 * The cell stays what a bookkeeper reads — the code, one press from the account
 * it names — and the search is a detour, which is exactly what §10b keeps
 * `Overlay` for.
 */
export function LineCoding({
  lineId, invoiceId, accounts, accountId, code, description, action, returnTo,
}: {
  lineId: string;
  invoiceId: string;
  accounts: readonly PickableAccount[];
  accountId: string | null;
  code: string | null;
  description: string;
  action: (formData: FormData) => void | Promise<void>;
  returnTo?: string;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<PickableAccount | null>(
    () => accounts.find((account) => account.id === accountId) ?? null,
  );

  /*
   * The code the *chart* holds, not the snapshot on the line. They agree for
   * every line the trigger wrote, and they deliberately part company when an
   * account is deleted: `on delete set null` clears the link and leaves
   * `account_code` standing, so the cell keeps saying what the line was coded to
   * while this control correctly offers nothing as the current choice.
   */
  const linked = accountId ? accounts.find((account) => account.id === accountId) : undefined;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
              aria-label={code ? `Change the code on ${description}` : `Add a code to ${description}`}
              className={cx(
                "min-h-11 rounded-lg px-2 py-1 text-left transition hover:bg-surface-muted",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                code ? "font-mono" : "text-muted-foreground underline decoration-dotted")}>
        {code ?? "Add code"}
      </button>

      <Overlay open={open} onClose={() => setOpen(false)} size="sm"
               title={code ? "Change this line's code" : "Code this line"}
               description={description}>
        <form action={action} onSubmit={() => setOpen(false)} className="space-y-4">
          <input type="hidden" name="id" value={lineId} />
          <input type="hidden" name="invoice_id" value={invoiceId} />
          {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
          {/*
            Always posted, even when empty. The action reads an absent value as
            "clear the code" rather than as "leave it alone", so the Remove code
            button below has something to say.
          */}
          <input type="hidden" name="gl_account_id" value={chosen?.id ?? ""} />

          <AccountPicker
            idPrefix={`line-${lineId}`}
            accounts={accounts}
            chosen={chosen}
            noChart={accounts.length === 0}
            onChoose={setChosen}
            onClear={() => setChosen(null)}
          />

          {linked && !chosen ? (
            /*
              Named, not linked. A link here would navigate away from an open
              form and lose the choice somebody just made — and it is explanatory
              text rather than a destination anybody came for. It was a link, and
              measuring the gallery caught it at 23px against §10b's 36px floor,
              which is what prompted the second look.
            */
            <p className="text-2xs text-muted-foreground">
              Was <span className="font-mono">{accountLabel(linked)}</span>.
              {" "}Saving now removes the code from this line.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton>{chosen ? "Save code" : "Remove code"}</SubmitButton>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      </Overlay>
    </>
  );
}

/**
 * The same cell where nothing can be changed — an issued, sent or void invoice.
 *
 * A link rather than plain text wherever the account still exists, because "what
 * is 4-1200?" is the first question anybody reconciling asks and the answer is
 * one page away. An em dash rather than a blank: *not coded* is an answer, and
 * an empty cell reads as a rendering fault.
 */
export function LineCode({ accountId, code }: { accountId: string | null; code: string | null }) {
  if (!code) return <span className="text-muted-foreground">—</span>;
  if (!accountId) return <span className="font-mono">{code}</span>;
  return (
    // `inline-flex` with a height floor rather than a bare inline link: §10b puts
    // nothing tappable under 36px, and a bare `<a>` around a five-character code
    // measures 18px. Found by measuring the gallery, not by looking at it.
    <Link href={`/accounts/${accountId}`}
          className="inline-flex min-h-9 items-center font-mono underline decoration-dotted
                     underline-offset-2 hover:decoration-solid">
      {code}
    </Link>
  );
}
