/**
 * The credit-note PDF — an **Adjustment Note** — drawn on the same standard
 * template as the tax invoice and from the same blocks, so the documents a
 * customer keeps read as one laundry's paperwork.
 *
 * A credit note is a document the customer is sent and keeps, so it gets its
 * own file rather than living only as a row on the invoice page (2026-10-12).
 * The same rules as the invoice: GST-inclusive amounts (0046 totals it on the
 * invoice's basis), no ledger codes, and nothing about the laundry's identity
 * written here rather than read from Settings › Invoicing.
 */

import { Document, Page, Text } from "@react-pdf/renderer";
import { formatMoney } from "@/lib/domain/pricing";
import { formatAbn } from "@/lib/domain/invoice-profile";
import { longDate, pdfLineCells } from "./line-display";
import {
  Addresses, DocFooter, DocHeader, LineTable, LowerBlock, SummaryStrip,
  formatAmount, formatQty, s,
  type TableLine,
} from "./standard-layout";
import type { CreditNotePdfData } from "./credit-note-data";

export function CreditNoteDocument({ data }: { data: CreditNotePdfData }) {
  const { tenant, customer, note, lines } = data;
  const cash = (value: number) => formatMoney(Number(value ?? 0));
  const title = "Adjustment Note";

  const tableLines: TableLine[] = lines.map((line) => ({
    ...pdfLineCells(line),
    qty: formatQty(line.quantity),
    unitPrice: formatAmount(line.unit_price, 4),
    amount: formatAmount(line.amount),
  }));

  return (
    <Document title={`${title} ${note.credit_note_number}`} author={tenant.name}>
      <Page size="A4" style={s.page}>
        <DocHeader title={title} logo={tenant.logo ?? null} />

        <Addresses
          billTo={{
            contact: customer.contact_name ?? null,
            business: customer.business_name,
            lines: customer.address,
            details: customer.abn ? [`ABN: ${formatAbn(customer.abn)}`] : [],
          }}
          business={{
            name: tenant.name, abn: tenant.abn, addressLines: tenant.profile.addressLines,
            phone: tenant.profile.phone, email: tenant.profile.email, website: tenant.profile.website,
          }}
        />

        <SummaryStrip columns={[
          { label: "Credit total", value: cash(note.total), strong: true },
          { label: "Issue date", value: longDate(note.issue_date) },
          { label: "Credit note", value: note.credit_note_number },
          ...(note.invoice_number ? [{ label: "Against invoice", value: note.invoice_number }] : []),
        ]} />

        {note.status === "void" ? (
          <Text style={s.banner}>This credit note has been voided.</Text>
        ) : null}

        <LineTable lines={tableLines} empty="No lines on this credit note." />

        <LowerBlock
          sections={[]}
          notes={note.reason?.trim() ? [note.reason.trim()] : []}
          totals={[
            { label: "Subtotal", value: formatAmount(note.subtotal) },
            ...(Number(note.tax_amount) > 0
              ? [{ label: "Includes GST of", value: formatAmount(note.tax_amount), note: true }]
              : []),
            { label: "Total credit", value: cash(note.total), rule: true, strong: true },
          ]}
        />

        <DocFooter numberLabel="Credit note" number={note.credit_note_number} />
      </Page>
    </Document>
  );
}
