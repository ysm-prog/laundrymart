/**
 * The credit-note PDF — MYOB's **adjustment note** — drawn to the same layout as
 * the tax invoice (brief 1.10), from the same building blocks, so the two
 * documents a customer keeps read as one laundry's paperwork.
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
import { auDate, pdfLineCells } from "./line-display";
import {
  BillToRow, DocFooter, DocHeader, LineTable, NotesAndTotals, TitleRow,
  formatAmount, formatQty, s,
  type TableLine,
} from "./myob-layout";
import type { CreditNotePdfData } from "./credit-note-data";

export function CreditNoteDocument({ data }: { data: CreditNotePdfData }) {
  const { tenant, customer, note, lines } = data;
  const cash = (value: number) => formatMoney(Number(value ?? 0));
  const title = "Adjustment note";

  const tableLines: TableLine[] = lines.map((line) => ({
    ...pdfLineCells(line),
    qty: formatQty(line.quantity),
    unitPrice: formatAmount(line.unit_price, 4),
    amount: formatAmount(line.amount),
  }));

  return (
    <Document title={`${title} ${note.credit_note_number}`} author={tenant.name}>
      <Page size="A4" style={s.page}>
        <DocHeader business={{
          name: tenant.name, abn: tenant.abn, addressLines: tenant.profile.addressLines,
          phone: tenant.profile.phone, email: tenant.profile.email,
          website: tenant.profile.website, logo: tenant.logo ?? null,
        }} />

        <TitleRow title={title} columns={[
          { label: "Credit note", value: note.credit_note_number, strong: true },
          { label: "Issue date", value: auDate(note.issue_date) },
          ...(note.invoice_number ? [{ label: "Against invoice", value: note.invoice_number }] : []),
        ]} />

        {note.status === "void" ? (
          <Text style={s.banner}>This credit note has been voided.</Text>
        ) : null}

        <BillToRow
          billTo={{
            contact: customer.contact_name ?? null,
            business: customer.business_name,
            lines: [
              ...customer.address,
              ...(customer.abn ? [`ABN: ${formatAbn(customer.abn)}`] : []),
            ],
          }}
          details={customer.customer_number ? [{ label: "Customer", value: customer.customer_number }] : []}
        />

        <LineTable lines={tableLines} empty="No lines on this credit note." />

        <NotesAndTotals
          notes={note.reason?.trim() ? [note.reason.trim()] : []}
          tax={cash(note.tax_amount)}
          total={cash(note.total)}
        />

        <DocFooter numberLabel="Credit note no" number={note.credit_note_number} total={cash(note.total)} />
      </Page>
    </Document>
  );
}
